"""把 CK3 的原始数据生成前端能直接吃的缓存。

跑一次就好： ``python build_data.py``
换 CK3 版本或加了 mod 之后再跑一次。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import zlib
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # CK3 的地图比 Pillow 的默认上限大得多

from parsers.ck3 import locator
from parsers.ck3.parser import (
    TIER_NAME,
    TIER_ORDER,
    Title,
    parse_de_jure_history,
    parse_definition,
    parse_governments,
    parse_landed_titles,
    parse_localisation,
    parse_title_history,
    top_liege,
)

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"

#: 没有头衔的省份在 titlemap 里用这个值。正常情况下只有既没有头衔、
#: 又没被 default.map 归入任何地形类别的像素才会落到这里。
NO_TITLE = 0xFFFF

#: 省份图里用了 definition.csv 未登记颜色的像素，构建期间临时标这个
UNKNOWN_COLOR = 0xFFFE

#: **1066 剧本地图**那一层的名字 —— 放在层级栈**最上面**（比帝国还粗）✓
#: 它显示的不是法理，而是"这块地 1066 年归哪个**非封臣**政权"（见 build_realm_layer ✓）
#: ⚠ 它**不是** landed_titles 的一级 ✗，所以 TIER_ORDER（法理那五级）不动，
#:   只有"地图上有几层"这件事变多了一层 ✓ 想关掉就 --no-bookmark ✓
ERA_TIER = "1066"
#: 地图从上到下的层级：1066 剧本 → 帝国 → 王国 → 公爵领 → 伯爵领 → 男爵领
#: （跑 --no-bookmark 时 main() 会把 1066 那一项摘掉 ✓ 一切下标都现查 ✓）
MAP_ORDER: list[str] = [ERA_TIER, *TIER_ORDER]
#: 那一层在层级按钮上写的字
ERA_LABEL = "1066"

#: **剧本地图上那几个要"点名改"的政权**（用户指定的值 ✓ 不是自动推的 ✓）
#: key = (借的那个头衔 key, 剧本层名) → 新名字 / 新颜色
#: ⚠ 名字为什么要写死：游戏里那套是**动态国名**（按朝代/家族 ✓ 见
#:   `government_rules` 的 `uses_culture_and_house_head_named_realms` ✓），
#:   编辑器还没做动态国名 ✗ 只好按用户点名的值来 ✓
#: ⚠ 颜色为什么是这个：中华霸权的五行色在
#:   `common/situation/situations/tgp_dynastic_cycle.txt` 的 `map_color` 里
#:   （木 128,255,128 · **火 220,20,0** · 土 255,234,64 · 金 240,240,240 · 水 50,120,255 ✓）。
#:   1066 是**宋**，宋为**火德** → 红 220,20,0 ✓
REALM_OVERRIDE: dict[tuple[str, str], dict] = {
    ("h_china", "1066"): {"name": "宋", "color": (220, 20, 0)},
    # ⚠ 下面这四个**只改显示名** ✗（用户点名："头衔保持不变" ✓）
    #   也就是说：底下的头衔、法理、颜色一律照旧 ✓ 只是地图上/悬停里显示的名字换掉 ✓
    #   —— 「塞尔柱」不是「塞尔柱帝国」✓ 「库曼」不是「库曼汗国」✓ 就照用户给的写 ✓
    ("e_persia", "1066"): {"name": "塞尔柱"},
    ("e_goryeo", "1066"): {"name": "高丽"},
    ("k_dzungaria", "1066"): {"name": "高昌"},
    ("e_caspian-pontic_steppe", "1066"): {"name": "库曼"},
}


#: 1066 的开局日期（common/bookmarks 里那批 bm_1066_* 都是这一天 ✓）
BOOKMARK_DATE = (1066, 9, 15)

_T0 = time.time()


def log(msg: str) -> None:
    print(f"[{time.time() - _T0:6.1f}s] {msg}", flush=True)


def _parse_date(s: str) -> tuple[int, int, int]:
    """``"1066.9.15"`` → ``(1066, 9, 15)``（缺的按月日补 1 ✓）"""
    parts = (str(s).split(".") + ["1", "1", "1"])[:3]
    return (int(parts[0]), int(parts[1]), int(parts[2]))


# ------------------------------------------------------------------ 省份图


def build_province_map(png_path: Path, defs: dict[int, tuple[int, int, int, str]]):
    """把 provinces.png 的每个像素换算成 province id。

    CK3 用的是「颜色查表」而不是调色板索引：图片里的 RGB 直接等于
    definition.csv 第三列的颜色。所以先建一张 24 位色 → id 的查找表。
    """
    log(f"读取 {png_path.name} …")
    im = Image.open(png_path)
    if im.mode != "RGB":
        im = im.convert("RGB")
    w, h = im.size

    max_pid = max(defs)
    # 没在 definition.csv 里出现过的颜色一律记成 UNKNOWN，好在最后数出来
    lut = np.full(1 << 24, UNKNOWN_COLOR, dtype=np.uint16)
    for pid, (r, g, b, _name) in defs.items():
        lut[(r << 16) | (g << 8) | b] = pid if pid <= 0xFFFD else NO_TITLE

    ids = np.zeros((h, w), dtype=np.uint16)
    chunk = 384
    for y0 in range(0, h, chunk):
        y1 = min(y0 + chunk, h)
        block = np.asarray(im.crop((0, y0, w, y1)), dtype=np.uint32)
        key = (block[:, :, 0] << 16) | (block[:, :, 1] << 8) | block[:, :, 2]
        ids[y0:y1] = lut[key]
        if y0 % (chunk * 16) == 0:
            log(f"  省份图 {y1}/{h} 行")

    unknown = int(np.count_nonzero(ids == UNKNOWN_COLOR))
    covered = int(np.count_nonzero(ids))
    log(f"省份图完成：{w}×{h}，已识别像素 {covered / ids.size:.1%}")
    if unknown:
        log(f"  注意：{unknown} 个像素用了 definition.csv 里没有的颜色")
        ids[ids == UNKNOWN_COLOR] = 0

    # 每个省份的像素数与质心（后面给头衔算标注位置用）
    n = max_pid + 1
    counts = np.zeros(n, dtype=np.int64)
    xsum = np.zeros(n, dtype=np.float64)
    ysum = np.zeros(n, dtype=np.float64)
    xs_row = np.arange(w, dtype=np.float64)
    for y0 in range(0, h, chunk):
        y1 = min(y0 + chunk, h)
        flat = ids[y0:y1].ravel().astype(np.int64)
        counts += np.bincount(flat, minlength=n)[:n]
        ysum += np.bincount(flat, weights=np.repeat(
            np.arange(y0, y1, dtype=np.float64), w), minlength=n)[:n]
        xsum += np.bincount(flat, weights=np.tile(xs_row, y1 - y0), minlength=n)[:n]

    counts = counts[:n]
    cx = np.where(counts > 0, xsum / np.maximum(counts, 1), 0.0)
    cy = np.where(counts > 0, ysum / np.maximum(counts, 1), 0.0)
    log(f"算出 {int((counts > 0).sum())} 个省份的质心")
    return ids, w, h, counts, cx, cy


# ------------------------------------------------------------------ 省份邻接


def build_adjacency(ids: np.ndarray, n_prov: int) -> bytes:
    """省份邻接表（4 连通），CSR 格式。

    存两段：前 n_prov+1 个 uint32 是每个省份邻居列表的起止下标，
    后面是 uint16 的邻居。

    常规模式下标"连通色块"的名字要靠它 —— 一整个连成片的色块，
    哪怕跨了一百个帝国，也只该有一个名字。
    """
    chunks = []
    for a, b in ((ids[:, :-1], ids[:, 1:]), (ids[:-1, :], ids[1:, :])):
        u = a.ravel()
        v = b.ravel()
        m = (u != v) & (u > 0) & (v > 0)
        uu = u[m].astype(np.int64)
        vv = v[m].astype(np.int64)
        lo = np.minimum(uu, vv)
        hi = np.maximum(uu, vv)
        chunks.append(lo * np.int64(n_prov) + hi)   # 编码成一个整数好去重

    code = np.unique(np.concatenate(chunks))
    lo = (code // n_prov).astype(np.int64)
    hi = (code % n_prov).astype(np.int64)

    # 无向图，两个方向都记
    src = np.concatenate([lo, hi])
    dst = np.concatenate([hi, lo])
    order = np.argsort(src, kind="stable")
    src = src[order]
    dst = dst[order]

    offsets = np.zeros(n_prov + 1, dtype=np.uint32)
    np.cumsum(np.bincount(src, minlength=n_prov), out=offsets[1:])
    return offsets.tobytes() + dst.astype(np.uint16).tobytes()


# ------------------------------------------------------------------ 地形类别

#: 海、湖、河、不可通行区域在 CK3 里也是 province，只是没有头衔，所以游戏
#: 拿它们自己的渲染去画。编辑器这边把它们各做成一个"伪头衔"，就能跟真头衔
#: 走完全同一套着色/取色/涂色逻辑，前端一行都不用改。
#: key 以 # 开头，跟 CK3 的 e_/k_/d_/c_/b_ 永远撞不上。
#: 判定按列表顺序来，先命中的赢。
SPECIAL_CATEGORIES: list[tuple[str, str, tuple[int, int, int], tuple[str, ...]]] = [
    ("#river",          "河流",         ( 62, 136, 181), ("river_provinces",)),
    ("#lake",           "湖泊",         ( 47, 110, 150), ("lakes",)),
    ("#sea",            "海洋",         ( 32,  57,  92), ("sea_zones",)),
    ("#impassable_sea", "不可通行海域", ( 26,  46,  71), ("impassable_seas",)),
    ("#impassable",     "不可通行山地", (94, 94, 94), ("impassable_mountains",)),
    ("#wasteland",      "无归属荒地",   (150, 150, 150), ()),
]


def parse_default_map(path: Path) -> dict[str, set[int]]:
    """读 default.map 里的地形分类。

    格式就两种：``key = RANGE { 632 641 }`` 和 ``key = LIST { 943 955 }``。
    """
    out: dict[str, set[int]] = {}
    if not path.is_file():
        return out
    for raw in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw.split("#")[0].strip()
        if not line:
            continue
        m = re.match(r"^([a-z_]+)\s*=\s*(.+?)\s*$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        nums = [int(n) for n in re.findall(r"\d+", val)]
        if not nums:
            continue
        bucket = out.setdefault(key, set())
        if val.upper().startswith("RANGE") and len(nums) >= 2:
            bucket.update(range(nums[0], nums[1] + 1))
        else:
            bucket.update(nums)
    return out


#: 这些类别**每块地单独一个节点**（可以一块块涂色），其余地形仍旧一类一个伪头衔。
#: 都是"不可通行的陆地 / 无归属荒地"—— 玩家会想按周边国家给它们上色。
SETTABLE_CATEGORIES = ("#impassable", "#wasteland")


def build_special_titles(
    terrain: dict[str, set[int]],
    n_prov: int,
    blank: np.ndarray,
    base_index: int,
    special_names: dict[str, str] | None = None,
) -> tuple[list[Title], np.ndarray, list[str], np.ndarray, list[int], np.ndarray, list[int]]:
    """给制不出头衔的地块分类；海/湖/河一类一个伪头衔，**荒地每块一个**。

    :param blank: 长度 n_prov 的 bool 表，True 表示这个省份在**所有**层级
                  都没有头衔（也就是海、湖、河、山这些）。
    :returns: (伪头衔列表, 全层共用的归属数组, 分类统计文字,
               只落在最细那层的归属数组, 逐块荒地的地块号,
               逐块荒地的**真实节点号**（与地块号一一对应）)
    """
    assign = np.full(n_prov, -1, dtype=np.int64)
    fine_assign = np.full(n_prov, -1, dtype=np.int64)   # 只有"逐块荒地"会用到
    titles: list[Title] = []
    stats: list[str] = []
    waste_pids: list[int] = []
    waste_tids: list[int] = []   # 跟 waste_pids 一一对应：建一个节点记一个序号

    for key, label, rgb, sources in SPECIAL_CATEGORIES:
        wanted: set[int] = set()
        for s in sources:
            wanted |= terrain.get(s, set())
        candidates = np.fromiter((p for p in wanted if 0 < p < n_prov), dtype=np.int64)
        if candidates.size:
            candidates = candidates[blank[candidates] & (assign[candidates] < 0)]
        if key == "#wasteland":
            # 兜底：前面都没认领的空白地块
            rest = np.nonzero(blank & (assign < 0))[0]
            candidates = rest
        if candidates.size == 0:
            continue
        # 共享的粗层伪头衔（照旧：海/湖/河/荒地的**粗层**都是它）
        assign[candidates] = base_index + len(titles)
        t = Title(key, tier="@")
        t.color = rgb
        titles.append(t)
        if special_names is not None:
            special_names[t.key] = label
        stats.append(f"{label} {candidates.size}")
        # ② 荒地额外：**每块地一个节点**，只占最细那一层
        if key in SETTABLE_CATEGORIES:
            for pid in candidates.tolist():
                _tid = base_index + len(titles)   # 序号在建节点时记下，别事后反推
                fine_assign[pid] = _tid
                wt = Title(f"wl_{pid}", tier=TIER_ORDER[-1])
                wt.color = rgb
                titles.append(wt)
                waste_pids.append(int(pid))
                waste_tids.append(_tid)
            stats.append(f"→ 逐块 {len(candidates)} 个")

    return titles, assign, stats, fine_assign, waste_pids, waste_tids


# ------------------------------------------------------------------ 头衔


def rank_titles(titles: dict[str, Title]) -> list[Title]:
    """排个稳定顺序，顺便把父子关系固化。父永远排在子前面。

    ⚠ **`h_`（霸权）那种不进这一栈** ✗ —— 它是 2026 那版 CK3 新加的顶层层级
      （`h_china` / `h_india` / `h_roman_empire` … 一共 6 个 ✓ 见 parser 里的说明 ✓），
      编辑器只画法理那五级（帝国~男爵领 ✓ 层级栈不动 ✓）。
      但它们在 `titles` 里**要留着** ✓ —— 1066 那条封君链会经过它们
      （885 条 `liege = h_china` 那种 ✓）要是这里把它们丢掉，链就断了 ✓
    """
    by_tier: dict[str, list[Title]] = {t: [] for t in MAP_ORDER}
    for t in titles.values():
        if t.tier not in by_tier:
            continue                    # h_ 之类：不进层级栈，但仍在 titles 里给链用 ✓
        by_tier[t.tier].append(t)
    out: list[Title] = []
    for tier in MAP_ORDER:  # （1066 那一层没有真头衔，是空的）e → k → d → c → b
        out.extend(sorted(by_tier[tier], key=lambda x: x.key))
    return out


def collect_provinces(titles: dict[str, Title], ordered: list[Title]) -> dict[str, list[int]]:
    """每个头衔真正覆盖的省份 = 自己的 + 所有后代的。由内往外累加。"""
    own: dict[str, list[int]] = {}
    for t in reversed(ordered):  # b → e
        acc = list(t.direct_provinces)
        for ck in t.children:
            ct = titles.get(ck)
            if ct is not None:
                acc.extend(own.get(ck, ()))
        own[t.key] = acc
    return own


def build_titlemap(
    ordered: list[Title],
    index_of: dict[str, int],
    owned: dict[str, list[int]],
    n_prov: int,
) -> np.ndarray:
    """给每个省份、每个层级找出它归属的头衔，做成 len(MAP_ORDER)×n_prov 的表。

    这一张表就是前端着色的全部依据：查到 province id，再去对应层级取头衔，
    最后取头衔的颜色。

    ⚠ 第 0 行（**1066 剧本**那一层）不在这里填 ✗ —— 它要等伪头衔建好
      （"无主"要挂到无归属荒地上 ✓），由 build_realm_layer 收尾 ✓
    """
    table = np.full((len(MAP_ORDER), n_prov), NO_TITLE, dtype=np.uint16)
    per_pid: dict[int, dict[str, int]] = {}
    for t in ordered:
        ti = index_of[t.key]
        for pid in owned[t.key]:
            if 0 < pid < n_prov:
                per_pid.setdefault(pid, {})[t.tier] = ti

    filled = 0
    for pid, tiers in per_pid.items():
        for tier, ti in tiers.items():
            table[MAP_ORDER.index(tier), pid] = ti
            filled += 1
    log(f"头衔归属表完成：{filled} 个 (省份, 层级) 对")
    return table


def build_realm_layer(
    ordered: list[Title],
    titles: dict[str, Title],
    titlemap: np.ndarray,
    n_prov: int,
    holders: dict[str, int | str],
    lieges: dict[str, str | None],
    governments: dict[str, str] | None = None,
    obedient: set[str] | None = None,
    tributaries: set[str] | None = None,
    dejure_size: dict[str, int] | None = None,
) -> tuple[dict[str, list[int]], int]:
    """算出**1066 剧本**每一格归谁：每块地归到它的**非封臣**（独立政权）✓

    用户要的那张地图就是这一层：**封臣的地盘算进宗主那一块**（CK3 的领地地图 ✓），
    所以先把每块地判给"最细那一级有持有者的头衔"，再顺 liege 一路往上 ✓

    ① 法理链从最细往上找**第一层有持有者**的头衔 ✓
       （男爵领常年没人持 —— 那就是伯爵自己拿着 ✓）
       ⚠ 男爵领缺、拿伯爵领顶替过的那些地（degraded），b 那一行填的就是 c 的头衔 ✓
         所以从 b 往上扫一遍就够了 ✓
    ② 拿到人以后顺着 ``liege`` 往上，走到没有封君的那一级 = **非封臣** ✓
       那个顶层头衔的 key 就是"这一块 1066 归谁"的答案 ✓
    ③ 整条链**都没人持** → 1066 年那会儿没人占 → **这一层就留空**（NO_TITLE ✓）
       ⚠ 别给它造伪头衔、别起名字 ✗（用户点名的：跟 EU4 的无主地一个待遇 ✓
         着色器里 NONE 本来就画成那块灰（150,150,150 ✓）· 悬停不列它 ·
         也没有"无主"这种身份可以认族 ✓ 见 gl.js 那段 NONE 的说明 ✓）
       ⚠ 这一版游戏数据里其实**一块都没有**（萨米、撒哈拉也各有酋长 / 部落 ✓），
         别的版本 / 别的剧本才可能出现 ✓ 所以这条路要留着、但要**安静** ✓

    ⚠ 只碰**真有头衔的陆地** ✗ —— 海/湖/山/逐块荒地在各层都是伪头衔，
      第 0 行早就在地形那一步填好了，别覆盖 ✓

    :returns: (``{顶层头衔 key: [省份号]}``, 无主（留空）的省份数)
    """
    keys = [t.key for t in ordered]
    n_none = 0
    raw: dict[str, list[int]] = {}
    rows = {tier: MAP_ORDER.index(tier) for tier in TIER_ORDER}
    # ⚠ **从伯爵领（c）开始往上找，不看男爵领** ✗ ——
    #   用户点名的："男爵领本来就没法在 CK3 进行细分，全都应该属于伯爵领才对" ✓
    #   男爵领只是伯爵领**里面的地产** ✓ 它自己那条 liege / holder 不该决定
    #   "这块地归谁政权" ✗（辽东范围不对就是这个：那几块地的男爵领挂着别的 liege ✓）
    fine_first = [rows[tier] for tier in reversed(TIER_ORDER) if tier != "b"]   # c → e
    for pid in range(1, n_prov):
        start = -1
        for r in fine_first:
            tid = int(titlemap[r, pid])
            if 0 < tid < len(ordered):
                start = tid
                break
        if start < 0:
            continue                       # 背景地形：这一层照地形那套走 ✓
        top = top_liege(keys[start], titles, holders, lieges, governments, obedient,
                        tributaries)
        if top is None:
            n_none += 1                    # 留空：什么都不写 ✓（那一格就是 NONE ✓）
        else:
            raw.setdefault(top, []).append(pid)

    # 🔴 **同一个人手里的头衔算一个政权** ✗ —— 用户报的"西夏的河西变成独立领地"
    #   就是这么来的：西夏那位（角色 206651）**同时**拿着 `k_xia` 和 `k_hexi` ✓
    #   而他俩法理上的共同上级 `e_yongliang` 在 1066 **没人持** ✗
    #   → 两个头衔就各自成了一个政权 ✗（同一个人的两块地 ✓）
    #   所以第二步：按**持有者**把顶层头衔归并 ✓
    #   国号取"层级最粗 → **法理地盘最大** → key"（三级都比一遍，结果稳定 ✓）
    #   → 西夏 = `k_xia`（法理 70 省）胜过 `k_hexi`（59 省）✓ 国号就是「夏」✓
    #     （他那 6 个直辖县也全在 `k_xia` 法理下 ✓ 两点指向同一个 ✓）
    #   ⚠ 别拿"1066 那层的省份数"当尺 ✗ —— 那是自己刚算出来的结果，
    #     自我指涉（河西那层算出来反而更大 ✗ 会把国号叫成「河西」✓ 踩过 ✓）
    holders_of_top = {k2: holders.get(k2) for k2 in raw}
    _ds = dejure_size or {}
    # **这个人手里的全部头衔**（不只是链的终点 ✓）—— 国号要挑他最高的那一级 ✗
    # 用户点名的："库曼汗国的主头衔不是里海草原，应该是帝国级的" ✓
    # 那位可汗同时拿着 `k_caspian_steppe`（里海草原 ✓）和 `e_caspian-pontic_steppe`（帝国 ✓）
    # 只看链的终点（草原那些游牧县 ✓ obedience → 链停在县/公国 ✗）
    # → 国号会挑到一个公爵领 ✗ 甚至一个县 ✗；把他手里的头衔全摆出来才对 ✓
    mine_of: dict[str, list[str]] = {}
    for _k2, _v2 in holders.items():
        if _v2:
            mine_of.setdefault(str(_v2), []).append(_k2)
    by_holder: dict[object, list[str]] = {}
    for k2 in raw:
        by_holder.setdefault(holders_of_top[k2], []).append(k2)
    out: dict[str, list[int]] = {}
    for _h, group in by_holder.items():
        if _h is None:
            for k2 in group:
                out[k2] = raw[k2]
            continue
        _rank = {"h": 0, "e": 1, "k": 2, "d": 3, "c": 4, "b": 5}
        _cands = [k2 for k2 in mine_of.get(str(_h), []) if k2 in titles] or group

        def _cap_ok(k2: str) -> int:
            """他手里**拿着那个头衔的首都**吗 —— 拿着 = 0（优先 ✓）

            主头衔就是这么认的 ✓（用户点名的 ✓）：
            · 教宗：`k_papal_state` 的 capital = `c_roma` ✓ 他拿着 ✓ → 教宗国 ✓
              （`k_romagna` 不占他的首都 ✓ → 排序输 ✓）
            · 西夏：`k_xia` 的 capital = `c_lingzhou` ✓ 他拿着 ✓ → 西夏 ✓
              （`k_hexi` 没写 capital ✗ → 输 ✓）
            """
            _t = titles.get(k2)
            _cap = _t.capital if _t is not None else None
            if _cap and holders.get(_cap) and str(holders.get(_cap)) == str(_h):
                return 0
            return 1

        # 层级最粗 → **拿着首都的那个** → **不占法理地的（无地名誉头衔 ✓）优先**
        # → 法理地盘最大 → key（五级都比一遍 ✓ 稳定 ✓）
        # ⚠ 为什么要"无地优先"：教宗手里 `k_papal_state`（landless ✓ 法理 0 省 ✓）
        #   和 `k_romagna`（正经王国 ✓ 21 省 ✓）**capital 都写着 c_roma** ✓ 都拿着 ✓
        #   光比 capital 分不出来 ✗ → 加了这条才挑到「教宗国」✓（用户点名的 ✓）
        best = min(_cands, key=lambda k2: (_rank.get(k2[0], 9), _cap_ok(k2),
                                           0 if _ds.get(k2, 0) == 0 else 1,
                                           -_ds.get(k2, 0), k2))
        # ⚠ 国号那个头衔**自己还有封君**的话，这个政权其实挂在别人名下 ✓（实控 ✓）
        #   例：西夏那位公爵（拿着 d_xiasui + 几个县 ✓）→ d_xiasui 的 liege = k_xia ✓
        #   → 那些县并进他的同时，整个政权算进 k_xia 的势力 ✓（= 西夏 ✓）
        _up = top_liege(best, titles, holders, lieges, governments, obedient, tributaries)
        if _up:
            best = _up
        pids: list[int] = []
        for k2 in group:
            pids.extend(raw[k2])
        # ⚠ 好几个持有者的组可能会并到**同一个国号**上（他们都挂在同一位君主名下 ✓）
        #   所以这里要**累加** ✗ 不能直接赋值（赋值会把前一组的地盘冲掉 ✗ 我踩过 ✓）
        out.setdefault(best, []).extend(pids)
    for _k2 in out:
        out[_k2] = sorted(out[_k2])
    return out, n_none


def centroids_for_titles(
    ordered: list[Title],
    owned: dict[str, list[int]],
    counts: np.ndarray,
    cx: np.ndarray,
    cy: np.ndarray,
    ids: np.ndarray,
    index_of: dict[str, int],
):
    """给每个头衔挑一个放名字的点。

    直接拿所有像素求重心，结果常常落在海里或者隔壁地块上（环形的伯爵领
    尤其严重）。这里退一步：先算重心，若重心不在自家地盘上，就用面积最大
    的自家省份的中心。名字能落在自家地面上，就够用了。
    """
    label_x = np.full(len(ordered), np.nan, dtype=np.float32)
    label_y = np.full(len(ordered), np.nan, dtype=np.float32)

    n = len(counts)
    h, w = ids.shape
    for t in ordered:
        pids = [p for p in owned[t.key] if 0 < p < n]
        if not pids:
            continue
        arr = np.array(pids, dtype=np.int64)
        wsum = float(counts[arr].sum())
        if wsum <= 0:
            continue
        bx = float((cx[arr] * counts[arr]).sum() / wsum)
        by = float((cy[arr] * counts[arr]).sum() / wsum)

        gi = index_of[t.key]

        def _on_own(x: float, y: float) -> bool:
            """这个点是不是落在自家地盘上（水面 / 隔壁地块都算不算 ✓）"""
            ix, iy = int(x), int(y)
            return 0 <= ix < w and 0 <= iy < h and int(ids[iy, ix]) in set(pids)

        # ① 重心落在自家地盘上 → 就用它
        # ② 否则按面积从大到小找**第一个重心确实落在自家地盘上**的省份 ✓
        #    （只退到"最大省份"不够：细长岛屿、环状伯爵领自己的重心也在水上 ✗）
        # ③ 都没有 → 退回最大省份的（保底 ✓）
        if not _on_own(bx, by):
            # 按"**离重心最近**"排，拉回自家离它最近的那块地的重心
            # （以前按面积从大到小扫，环形领地会跳到很远的一块上：
            #   拜占庭的重心落进爱琴海，被跳到多瑙河口的图尔恰，偏北 300 像素 ✗）
            _d2 = (cx[arr] - bx) ** 2 + (cy[arr] - by) ** 2
            _order = arr[np.argsort(_d2)]
            for p in _order:
                if _on_own(float(cx[p]), float(cy[p])):
                    bx, by = float(cx[p]), float(cy[p])
                    break
            else:
                p = int(_order[0])
                bx, by = float(cx[p]), float(cy[p])
        label_x[gi] = bx
        label_y[gi] = by
    return label_x, label_y


# ------------------------------------------------------------------ 主流程


def main() -> int:
    global DATA
    ap = argparse.ArgumentParser(description="从 CK3 安装目录构建制地图编辑器所需的缓存")
    ap.add_argument("--ck3", help="CK3 安装根目录（含 game/ 与 binaries/）")
    ap.add_argument("--lang", default="simp_chinese", help="本地化语言目录，默认 simp_chinese")
    ap.add_argument("--map", help="换一张 provinces.png（另一套地图里的那张）")
    ap.add_argument("--out", help="缓存写到哪个目录，默认 data/")
    ap.add_argument("--label", default="", help="这套地图的显示名，写进 meta")
    ap.add_argument("--dejure-year", type=int, default=1066,
                    help="法理按哪一年算，默认 1066（用 history/titles 里的改动覆盖骨架）")
    ap.add_argument("--no-dejure-history", action="store_true",
                    help="只用地 landed_titles 的骨架，不盖 history 的改动")
    ap.add_argument("--bookmark", default="1066.9.15",
                    help="剧本地图那一层的日期，默认 1066.9.15（CK3 那批 bm_1066_* 的开局）")
    ap.add_argument("--no-bookmark", action="store_true",
                    help="不生成 1066 剧本地图那一层（只剩法理那五层）")
    args = ap.parse_args()
    if args.no_bookmark and ERA_TIER in MAP_ORDER:
        MAP_ORDER.remove(ERA_TIER)      # 先摘掉，后面所有下标都按这版现查 ✓

    root = locator.find_ck3([args.ck3] if args.ck3 else None)
    game = root / "game"

    if args.out:
        DATA = Path(args.out).resolve()
    DATA.mkdir(parents=True, exist_ok=True)

    # 换投影时只有省份图从别处来；definition.csv、landed_titles、本地化还是读游戏本体
    prov_png = Path(args.map).resolve() if args.map else game / "map_data" / "provinces.png"
    log(f"输出目录 {DATA}")
    log(f"省份图   {prov_png}")

    # 1. 省份定义
    defs = parse_definition(game / "map_data" / "definition.csv")
    log(f"definition.csv：{len(defs)} 个省份，最大 id {max(defs)}")

    # 2. 头衔树
    log("解析 landed_titles …")
    titles = parse_landed_titles(game / "common" / "landed_titles")
    log(f"头衔：{len(titles)} 个")

    # 2b. 把法理按指定年份对齐
    # landed_titles 的嵌套是"默认"法理，history/titles 里带日期的 de_jure_liege
    # 才是各剧本的改动。要"1066 年的法理"就得把 1066 之前的改动全盖一遍。
    dejure_year = None if args.no_dejure_history else args.dejure_year
    if dejure_year:
        moved = parse_de_jure_history(game / "history" / "titles", titles,
                                      (dejure_year, 1, 1))
        log(f"法理按 {dejure_year} 年对齐：{moved} 个头衔的父级跟骨架不一样，已改")
    else:
        log("法理用 landed_titles 的骨架（没盖 history 的改动）")

    # 2c. 1066 剧本：**谁占着哪块地**（holder）和**谁是封臣**（liege）
    #     两个都写在 history/titles 里、都带日期 ✓ 见 parse_title_history ✓
    bookmark_date: tuple[int, int, int] | None = None
    holders: dict[str, int | str] = {}
    lieges: dict[str, str | None] = {}
    governments: dict[str, str] = {}
    obedient: set[str] = set()
    tributaries: set[str] = set()
    if not args.no_bookmark:
        bookmark_date = _parse_date(args.bookmark)
        holders, lieges, governments, tributaries = parse_title_history(
            game / "history" / "titles", titles, bookmark_date)
        obedient = parse_governments(game / "common" / "governments")
        # 🔴 **头衔自己没记 `government` 的，跟"这个人别的头衔"里那个政府** ✗
        #   用户报的："塔奔孛黑答在游戏里也应该不是大辽的" ✓
        #   查下来 `c_tavan_bogd` 自己那条历史里**没写 government** ✗
        #   而同一个持有者（303309）另外三个县全是 `nomad_government` ✓
        #   → 它也该按游牧算 ✓ 才不会被 `liege = e_great_liao` 带走 ✓
        #   （一个人手里的头衔政府当然是一致的 ✓ 照他别的头衔取一个就行 ✓）
        _by_holder: dict[str, list[str]] = {}
        for _k, _v in holders.items():
            if _v:
                _by_holder.setdefault(str(_v), []).append(_k)
        _filled = 0
        for _k, _v in holders.items():
            if not _v or governments.get(_k):
                continue
            for _k2 in _by_holder.get(str(_v), []):
                _g2 = governments.get(_k2)
                if _g2:
                    governments[_k] = _g2
                    _filled += 1
                    break
        if _filled:
            log(f"头衔没记政府的 {_filled} 个：照持有者别的头衔补上了 ✓")
        # ⚠ 这套不用收窄成"只有游牧" ✗ —— 判据在 `liege_of` 里是**两边政府一样不一样** ✓
        #   跟封君同一种政府 → 照旧算封臣（辽的草原行政封臣留着 ✓ 游牧可汗的部落留着 ✓）
        #   跨政府（游牧 ↔ 草原行政）→ 那条 liege 不成立 ✓（乃蛮那些部落独立 ✓）
        #   （先收窄过一次、又反过来全拆过一次，都被用户当场抓到 ✓ 见 liege_of 的说明 ✓）
        log(f"剧本 {'.'.join(str(x) for x in bookmark_date)}："
            f"{len(holders)} 个头衔有持有者、{len(lieges)} 个写了封君、"
            f"{len(obedient)} 种政府走 obedience（那些不算封臣 ✓）、"
            f"{len(tributaries)} 个头衔是**朝贡者**（也不是封臣 ✓）")

    ordered = rank_titles(titles)
    index_of = {t.key: i for i, t in enumerate(ordered)}
    owned = collect_provinces(titles, ordered)

    # 3. 名字：中文优先，缺的用英文补
    log(f"解析本地化（{args.lang}）…")
    keys = set(titles)
    names = parse_localisation(game / "localization" / args.lang, keys)
    missing = keys - set(names)
    log(f"  {args.lang}：{len(names)} 条，缺 {len(missing)} 条")
    if missing:
        en = parse_localisation(game / "localization" / "english", missing)
        names.update(en)
        log(f"  英文补上 {len(en)} 条，最终仍缺 {len(keys - set(names))} 条")

    # 4. 省份图
    ids, w, h, counts, pcx, pcy = build_province_map(prov_png, defs)

    # 5. 归属表（此时只有真头衔）
    n_prov = max(defs) + 1
    titlemap = build_titlemap(ordered, index_of, owned, n_prov)

    # 这里**不**做跨层继承：缺就是缺。
    # 硬把相邻层级的头衔抄到空层上，会凭空造出"威尼斯帝国"这种不存在的关系
    # —— 威尼斯王国法理上本来就没有帝国宗主，帝国层就该是空的。
    present = np.zeros(n_prov, dtype=bool)
    present[np.unique(ids)] = True
    present[0] = False
    log(f"地图上有 {int(np.count_nonzero((titlemap == NO_TITLE) & present))} 个 "
        f"(省份, 层级) 没有对应头衔，保持空缺")

    # 有头衔、但男爵领层空着的那几个，用所属伯爵领的色块顶替。
    # 有些省份就是没有地产（867 剧本里常见，比如 MANSA'L-KHARAZ、KA'BIR），
    # 在男爵领视图下露个灰洞没意义。
    # 注意要排掉海/湖/河/山 —— 它们这会儿还没归入地形类别，但本来就不该有男爵领。
    # 而且这是**降级显示**，得记下来，悬停时要跟玩家说清楚。
    gap_b = (titlemap[MAP_ORDER.index("b")] == NO_TITLE) & present \
        & (titlemap[MAP_ORDER.index("c")] != NO_TITLE)
    degraded = np.nonzero(gap_b)[0]
    if degraded.size:
        titlemap[MAP_ORDER.index("b"), degraded] = titlemap[MAP_ORDER.index("c"), degraded]
        shown = "、".join(str(int(p)) for p in degraded[:8])
        log(f"男爵领层空缺 {degraded.size} 个省份（{shown}），已用所属伯爵领的色块顶替")
    else:
        log("男爵领层没有空缺")

    # 6. 海/湖/河/山：所有层级都没头衔的地块才归地形类别
    terrain = parse_default_map(game / "map_data" / "default.map")
    blank = np.all(titlemap == NO_TITLE, axis=0) & present
    log(f"完全没有头衔的地块：{int(blank.sum())} 个")

    _special_names: dict[str, str] = {}

    # 5b. **1066 剧本地图**那一层（层级栈最上面那层 ✓ 见 build_realm_layer ✓）
    #     ⚠ 顺序要紧：它必须在 `build_special_titles` **之前**建 ✗ ——
    #       伪头衔（海/湖/河/每一块荒地）的编号是从"真头衔 + 剧本节点"之后开始的 ✓
    #       放在后面就会跟剧本节点**撞号**（我那版就是这样：荒地全挤进了真头衔范围 ✗）
    #
    #     ⚠ **每个非封臣政权要建自己的节点** ✗（key = `1066_<原头衔 key>` ✓
    #       跟 EU4 那边 `1444_FRA` 一个写法 ✓）—— 用户点名的"照搬代码"就是这个意思：
    #       · 剧本层的节点 tier 必须是 ERA_TIER（0 ✓），前端拿它当「势力」那一层认 ✓
    #       · 取色匹配表、pidsOf、名字落点、悬停那些**全按"节点自己那一层"走** ✓
    #         借用法理头衔的节点（我第一版那样）会到处打结：取色表收不进、站在
    #         地区层按 1066 的头衔涂会涂不动（pidsOf 按节点自己的 tier 找行 ✓）✗
    realm_nodes: list[Title] = []
    realm_names: dict[str, str] = {}
    realm_own: dict[str, list[int]] = {}
    realm_pos: dict[str, tuple[float, float]] = {}      # 剧本节点：名字落点（最大连通域重心 ✓）
    realm_area: dict[str, int] = {}
    if bookmark_date is not None:
        realm_own, _n_none = build_realm_layer(
            ordered, titles, titlemap, n_prov, holders, lieges, governments, obedient,
            tributaries,
            {t.key: len(owned.get(t.key, ())) for t in ordered})

        def _resolved_color(key: str):
            """自己没色就往上继承 —— 跟真头衔第 8 步同一套规矩 ✓"""
            cur = titles.get(key)
            c = cur.color if cur is not None else None
            guard = 0
            while c is None and cur is not None and cur.parent and guard < 8:
                cur = titles.get(cur.parent)
                if cur is None:
                    break
                c = cur.color
                guard += 1
            return c

        # 名字落点：跟 `patch_wasteland.fix_label_positions` **同一套规矩** ——
        #   "像素最多的那块连通域的重心" ✓（照搬那个函数用的那把尺 ✓）
        #   ⚠ 不能直接沿用那个顶层头衔的落点 ✗：1066 的地盘跟法理地盘常常不一样，
        #     借来的落点会跑到自家地界外（自检里那条"名字落在自家地盘上"当场抓住 ✓）
        from build_eu4 import largest_block_centre as _lbc     # noqa: PLC0415
        _adj = build_adjacency(ids, n_prov)
        _off = np.frombuffer(_adj, dtype=np.uint32, count=n_prov + 1)
        _ngb = np.frombuffer(_adj, dtype=np.uint16, offset=(n_prov + 1) * 4)

        for _key in sorted(realm_own):
            _t = Title(f"{ERA_TIER}_{_key}", tier=ERA_TIER)
            _t.color = _resolved_color(_key)
            realm_nodes.append(_t)
            realm_names[_t.key] = names.get(_key) or _key   # 名字照搬那个头衔的 ✓
            _ov = REALM_OVERRIDE.get((_key, ERA_TIER))
            if _ov:
                # 用户点名的覆盖（名字 / 颜色 ✓ 见 REALM_OVERRIDE 的说明 ✓）
                if _ov.get("name"):
                    realm_names[_t.key] = _ov["name"]
                if _ov.get("color"):
                    _t.color = tuple(_ov["color"])
            _idx = len(ordered) + len(realm_nodes) - 1
            _pids = realm_own[_key]
            for _pid in _pids:
                titlemap[0, _pid] = _idx
            _arr = np.fromiter((p for p in _pids if 0 < p < n_prov), dtype=np.int64)
            if _arr.size:
                realm_area[_t.key] = int(counts[_arr].sum())
                _cc = _lbc(_pids, _off, _ngb, counts, pcx, pcy)
                if _cc is not None:
                    realm_pos[_t.key] = (float(_cc[0]), float(_cc[1]))
                    realm_area[_t.key] = int(_cc[2])
        _n_own = sum(len(v) for v in realm_own.values())
        log(f"1066 剧本层：{len(realm_nodes)} 个非封臣政权 · {_n_own} 个省份有归属 · "
            f"{_n_none} 个留空（跟 EU4 的无主地一样：没标记、没名字 ✓）")

    #: 伪头衔的起始序号 = 真头衔 + 1066 剧本节点（后面一律用这个 ✓ 别再写 len(ordered) ✗）
    SPECIAL_BASE = len(ordered) + len(realm_nodes)

    special, assign, stats, fine_assign, waste_pids, waste_tids = build_special_titles(
        terrain, n_prov, blank, SPECIAL_BASE, _special_names)
    log("地形类别：" + "，".join(stats) if stats else "地形类别：无")

    sel = assign >= 0
    if sel.any():
        vals = assign[sel].astype(np.uint16)
        for r in range(len(MAP_ORDER)):
            titlemap[r, sel] = vals

    # 逐块荒地**只盖最细那层** —— 粗层照旧是那块共享的灰（跟 EU5 一个口径）
    sel2 = fine_assign >= 0
    if sel2.any():
        titlemap[MAP_ORDER.index(TIER_ORDER[-1]), sel2] = fine_assign[sel2].astype(np.uint16)
    left = int(np.count_nonzero(titlemap[MAP_ORDER.index(TIER_ORDER[-1])] == NO_TITLE))
    log(f"仍是空白的格子：{left}")

    # 逐块荒地的节点序号（meta 里要报给前端：荒漠涂色开关靠它判"这块是不是荒地"）
    #: 哪些伪头衔是**水**（算荒地边长时不算；荒地/无主地要算）
    WATER_KEYS = ("#river", "#lake", "#sea", "#impassable_sea")

    def _is_water_key(k: str) -> bool:
        return k in WATER_KEYS
    water_tids = {SPECIAL_BASE + k for k, sp in enumerate(special) if _is_water_key(sp.key)}
    # 逐块荒地的**真实节点号**直接来自 build_special_titles（建节点时记的）。
    # 以前在这里拿"special 尾部恰好连续 len(waste_pids) 个"反推 waste_base，
    # 可 #wasteland 的共享粗层节点插在两组逐块节点中间 —— 一差就差一位：
    # 第一块山地漏出 meta["wasteland"]、面积和标注位置整体错位一格。
    waste_tid_of = dict(zip(waste_pids, waste_tids))
    # 粗层那两个共享伪头衔也算"荒地"（荒漠涂色关着时它们要显示灰）
    for k, sp in enumerate(special):
        if sp.key in SETTABLE_CATEGORIES:
            waste_tids.append(SPECIAL_BASE + k)

    # ---- 荒地自动上色：按"跟周边国家接壤的边界像素占比"，严格过半 ----
    waste_auto: list[list[int]] = []
    if waste_pids:
        n_pid = int(ids.max()) + 1
        wmask = np.zeros(n_pid, dtype=bool)
        wmask[np.array(sorted(set(waste_pids)), dtype=np.int64)] = True
        pair_cnt: dict[int, int] = {}
        for axis in (0, 1):
            a = ids[:-1, :] if axis == 0 else ids[:, :-1]
            b = ids[1:, :] if axis == 0 else ids[:, 1:]
            aw = wmask[a]
            bw = wmask[b]
            m = aw != bw
            if not m.any():
                continue
            pa = a[m].astype(np.int64)
            pb = b[m].astype(np.int64)
            awm = aw[m]
            wp = np.where(awm, pa, pb)
            nb = np.where(awm, pb, pa)
            uk, uc = np.unique((wp << 16) | nb, return_counts=True)
            for k_, c_ in zip(uk.tolist(), uc.tolist()):
                pair_cnt[k_] = pair_cnt.get(k_, 0) + c_
        per_waste: dict[int, dict[int, int]] = {}
        edge_tot: dict[int, int] = {}          # 这块荒地的**整条陆地周长**
        for k_, c_ in pair_cnt.items():
            wp, nb = k_ >> 16, k_ & 0xFFFF
            # ⚠ 这里取的是**帝国那一行**（法理），不是第 0 行 ✗
            #   第 0 行现在是 1066 剧本（无主的一大片 ✓），拿它当"周边国家"会变味：
            #   荒地自动上色一直按"法理上的归属"算 ✓ 换行等于偷偷改了这个功能 ✓
            t_nb = int(titlemap[MAP_ORDER.index("e"), nb])
            if t_nb in water_tids:             # 水不算边长
                continue
            edge_tot[wp] = edge_tot.get(wp, 0) + c_
            if t_nb >= len(ordered):           # 无主/地形：进分母，但不算"某个国家"
                continue
            d = per_waste.setdefault(wp, {})
            d[t_nb] = d.get(t_nb, 0) + c_
        for wp, d in per_waste.items():
            tot = edge_tot.get(wp, 0)          # ← 分母是整条周长
            if not tot:
                continue
            best = max(d.items(), key=lambda kv: kv[1])
            if best[1] * 2 > tot:
                waste_auto.append([int(wp), int(best[0])])
        log(f"荒地自动上色：{len(waste_auto)}/{len(waste_pids)} 块有主（边缘过半）")

    # 7. 标注位置（伪头衔不参与，它们不上地名）
    log("计算名字标注位置 …")
    gx, gy = centroids_for_titles(ordered, owned, counts, pcx, pcy, ids, index_of)

    # 标注位置一律**按地盘算**（跟其他游戏同一套逻辑 ✓）：
    #   全部层级都用自己的几何中心 —— 重心落在自家地盘外时，
    #   centroids_for_titles 会自动退到面积最大那块省份的重心 ✓
    # （以前公爵领以上会被改标到**法理首都**的几何中心，名字因此挤在首都那儿 ✗）
    lx = gx.copy()
    ly = gy.copy()

    # ⚠ 顺序：真头衔 → 1066 剧本节点 → 伪头衔（海/湖/荒地）✓
    ordered_all = ordered + realm_nodes + special
    n_all = len(ordered_all)

    # 8. 颜色：优先自己的，没有就往上继承（男爵领常年没有自己的颜色）
    colors = np.zeros((n_all, 3), dtype=np.uint8)
    for i, t in enumerate(ordered_all):
        c = t.color
        cur = t
        guard = 0
        while c is None and cur.parent and guard < 8:
            p = titles.get(cur.parent)
            if p is None:
                break
            cur, c = p, p.color
            guard += 1
        if c is not None:
            colors[i] = c

    # 9. 写盘
    log("写出缓存 …")
    raw = titlemap.tobytes()
    packed = zlib.compress(raw, 9)
    (DATA / "titlemap.bin").write_bytes(packed)
    log(f"  titlemap.bin  {len(raw) / 1024:.0f} KB → {len(packed) / 1024:.0f} KB")

    prov_names = [""] * n_prov
    for pid, (_r, _g, _b, nm) in defs.items():
        if pid < n_prov:
            prov_names[pid] = nm

    meta = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "game": "ck3",
        "ck3_root": str(root),
        "label": args.label or "原版",
        "provinceMap": prov_png.name,
        "lang": args.lang,
        "mapWidth": w,
        "mapHeight": h,
        "numProvinces": n_prov,
        "numTitles": n_all,
        "numRealTitles": len(ordered) + len(realm_nodes),   # 剧本节点也算"真"（不是伪头衔 ✓）
        "tiers": list(MAP_ORDER),
        "tierNames": [ERA_LABEL if t == ERA_TIER else TIER_NAME[t] for t in MAP_ORDER],
        # 悬停卡片左边那个小徽章，CK3 就是 key 的前缀；1066 那一层写年份 ✓
        "tierKeys": [t if t == ERA_TIER else f"{t}_" for t in MAP_ORDER],
        "entity": "头衔",
        "defaultTier": MAP_ORDER.index("c"),
        # 🔴 **1066 那一层就是"剧本层"** ✓（跟 EU4 的 1444/1618/1789 一个身份 ✓）
        #   前端整套「年代层」的玩法**全靠这一个字段**认（`eraDates.length` ✓）：
        #     · 第 0 层归「势力」那一组开关，其余几层归「地区」那一组 ✓
        #     · 细层视图下"这块地属于哪个国家" = 最近的剧本层（1066 ✓）
        #     · 「粒度」玩法、取色/图例认族、剧本层才画那一圈边界 ✓
        #   ⚠ 以前 CK3 是**特立独行**的：没有年代层、界面上是「头衔」那一组 ✗
        #     用户点名的："取消 CK3 的特立独行，和其他模式一样" ✓
        #     所以：帝国/王国/…/男爵领**全是地区级**，1066 是剧本 ✓ 照搬现成代码 ✓
        #   ⚠ 顺带把 patch_wasteland 的 `_detect` 改了顺序 ✗ —— 它原来拿
        #     `"eraDates" in M` 认 EU5 ✓ 这一加 CK3 会被误认成 EU5 ✓（见那个函数 ✓）
        #   ⚠ patch_blank_era 见到 eraDates 就会想补一层「空白剧本」✗
        #     这里**没给它补**（用户没要 ✓）；要补就 `py patch_blank_era.py data` ✓
        "eraDates": [".".join(str(x) for x in bookmark_date)] if bookmark_date else [],
        # 法理按哪一年算的（history/titles 的 de_jure_liege 盖到 landed_titles 骨架上）
        "deJureYear": dejure_year or 0,
        # 每一层从百分之多少的缩放开始上地名（1066 那一层跟帝国层一样，早点出名字 ✓）
        "labelZoom": ([8] if ERA_TIER in MAP_ORDER else []) + [8, 30, 60, 120, 250],
        "noTitle": NO_TITLE,
        "specialPrefix": "#",
        "degradedBaronies": [int(x) for x in degraded],   # 没有男爵领、用伯爵领顶替的省份
        "colorLutWidth": 256,
        # 荒地（不可通行山地 / 无归属荒地）：哪些节点算荒地 + 逐块的自动归属
        "wasteland": sorted(set(waste_tids)),
        "wastelandAuto": waste_auto,
    }
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # 每个真头衔的地盘数；**1066 剧本节点**按它自己那一层的省份算；伪头衔按分到的地块算
    prov_count = [len(owned[t.key]) for t in ordered]
    for t in realm_nodes:
        prov_count.append(len(realm_own.get(t.key[len(ERA_TIER) + 1:], ())))
    for k in range(len(special)):
        prov_count.append(int(np.count_nonzero(assign == SPECIAL_BASE + k)))

    # 每个头衔在地图上占的真实像素数。地名标注靠它判断"这块够不够大、放得下字吗"
    # —— 拿省份个数当面积代理是不准的，同一个伯爵领的省份大小能差上百倍。
    area = np.zeros(n_all, dtype=np.int64)
    for i, t in enumerate(ordered):
        pids = np.fromiter((p for p in owned[t.key] if 0 < p < n_prov), dtype=np.int64)
        if pids.size:
            area[i] = int(counts[pids].sum())
    # 1066 剧本节点：面积按它**这个剧本里**那个最大连通域算（跟真头衔同一把尺 ✓）
    for j, t in enumerate(realm_nodes):
        area[len(ordered) + j] = realm_area.get(t.key, 0)
    for k in range(len(special)):
        idx = SPECIAL_BASE + k
        area[idx] = int(counts[assign == idx].sum())
    # 逐块荒地节点：它只管自己那一块地，面积和位置就取那一块的
    # （以前没给，于是 area=0、lx=null —— 标签层按面积排序时它们全挤在 (0,0)，
    #   挑视口会挑到它们头上，一个名字都画不出来）
    # 逐块荒地节点：它只管自己那一块地，面积和位置就取那一块的
    # （以前没给，于是 area=0、lx=null —— 标签层按面积排序时它们全挤在 (0,0)，
    #   挑视口会挑到它们头上，一个名字都画不出来）
    for pid in waste_pids:
        idx = waste_tid_of[pid]
        area[idx] = int(counts[pid])
        prov_count[idx] = 1   # 一个节点就是一个省份（assign 里查不到它，别信上面那轮）

    # 伪头衔那一段的位置：只有**逐块荒地**有（它就是个有像素的地块），海/湖/河没有。
    # 位置直接从那一块的像素重心来 —— 别的地方（area/位置数组）都只覆盖真实头衔，
    # 伪头衔这一段是在拼 payload 时才补的，所以这里按"补空"的口径一起算。
    _waste_pos: dict[int, tuple[float, float]] = {}
    for pid in waste_pids:
        if 0 < pid < len(pcx) and not np.isnan(pcx[pid]):
            _waste_pos[waste_tid_of[pid]] = (float(pcx[pid]), float(pcy[pid]))

    def _pad_pos(arr, which: int):
        """真头衔的位置数组 + **1066 剧本节点那一段** + 伪头衔那一段 ✓
        剧本节点的落点是它自己那一层算出来的（最大连通域重心 ✓ 见上面 5b 那段 ✓）"""
        mid = []
        for t in realm_nodes:
            p = realm_pos.get(t.key)
            mid.append(round(p[which], 1) if p else None)
        tail = []
        for k in range(len(special)):
            p = _waste_pos.get(SPECIAL_BASE + k)
            tail.append(round(p[which], 1) if p else None)
        return ([None if np.isnan(v) else round(float(v), 1) for v in arr] + mid + tail)

    # 头衔表：用并行的数组，比对象数组省一半体积
    # 伪头衔在本地化表里当然查不到，用 SPECIAL_CATEGORIES 里写好的中文名
    special_names = {key: label for key, label, _rgb, _src in SPECIAL_CATEGORIES}
    # 伪头衔的中文名（SPECIAL_CATEGORIES 里写好的那份 + 函数里 name_sink 带出来的）
    special_names.update(_special_names)
    payload = {
        "keys": [t.key for t in ordered_all],
        # ⚠ 这里是**地图层级**下标（前端拿它查 TIER_BADGE / 跳层 ✓）✗
        #   不是法理那五级的序号 —— 1066 那一层占据 0，所以 e_ 是 1 ✓
        "tiers": [MAP_ORDER.index(t.tier) if t.tier in MAP_ORDER else len(MAP_ORDER)
                  for t in ordered_all],
        "parents": [index_of.get(t.parent, -1) if t.parent else -1 for t in ordered_all],
        "names": [names.get(t.key) or realm_names.get(t.key)
                  or special_names.get(t.key) or t.key for t in ordered_all],
        "colors": [[int(c[0]), int(c[1]), int(c[2])] for c in colors],
        "provCount": prov_count,
        "area": area.tolist(),
        "lx": _pad_pos(lx, 0),
        "ly": _pad_pos(ly, 1),
        "gx": _pad_pos(gx, 0),
        "gy": _pad_pos(gy, 1),
        "provinceNames": prov_names,
    }
    (DATA / "titles.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    log(f"  titles.json  {(DATA / 'titles.json').stat().st_size / 1048576:.1f} MB")
    # 名字汉化（后处理并进来了：去键名 / 英文反查 / 前缀模糊）✓
    try:
        import nametools
        _hit, _left = nametools.localize_names(
            DATA / "titles.json",
            [game / "localization" / args.lang, game / "localization" / "english"])
        log(f"  名字汉化：换掉 {_hit} 个，仍非中文 {_left} 个")
    except Exception as _e:      # 汉化失败不该拖垮整个构建 ✓
        log(f"  名字汉化跳过：{_e}")


    # 顺手把 CK3 的省份图原样拷一份，前端要拿它当 id 纹理
    log("导出省份 id 图 …")
    ids_out = zlib.compress(ids.tobytes(), 6)
    (DATA / "provinces_id.bin").write_bytes(ids_out)
    log(f"  provinces_id.bin  {ids.nbytes / 1048576:.1f} MB → {len(ids_out) / 1048576:.1f} MB")

    # 省份邻接表 + 各省质心：常规模式下标"连通色块"的名字要用
    log("导出省份邻接表和质心 …")
    adj = build_adjacency(ids, n_prov)
    (DATA / "adjacency.bin").write_bytes(zlib.compress(adj, 6))
    # 三列：质心 x、质心 y、像素数（当权重用 —— 省份大小能差上百倍）
    pos = np.stack([pcx, pcy, counts.astype(np.float64)], axis=1).astype(np.float32)
    (DATA / "prov_pos.bin").write_bytes(zlib.compress(pos.tobytes(), 6))
    log(f"  adjacency.bin {(DATA / 'adjacency.bin').stat().st_size / 1024:.0f} KB"
        f" / prov_pos.bin {(DATA / 'prov_pos.bin').stat().st_size / 1024:.0f} KB")

    log("全部完成 ✔")

    # 荒地的事后加工（幂等）：每层都指向它自己 / 周长表 / 按层归属 / 名字 / 隐藏地名
    from patch_wasteland import patch as _patch_waste
    _patch_waste(DATA)
    # 再补一层**空白剧本**（幂等）：放在荒地之后 —— 它照抄的是"最终这版"的背景地形 ✓
    # （CK3 现在也有剧本层了 ✓ 所以它也照搬这一层：链上读作
    #   `1066 / 空白剧本 / 帝国 / 王国 / 公爵领 / 伯爵领 / 男爵领` ✓）
    from patch_blank_era import patch as _patch_blank
    _patch_blank(DATA)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

