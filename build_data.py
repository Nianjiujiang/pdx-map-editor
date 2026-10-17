"""把 CK3 的原始数据生成前端能直接吃的缓存。

跑一次就好： ``python build_data.py``
换 CK3 版本或加了 mod 之后再跑一次。
"""

from __future__ import annotations

import argparse
import base64
import json
import math
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


def parse_character_deaths(char_dir: Path) -> dict[str, tuple[int, int, int]]:
    """``history/characters`` → ``{角色 id: 死亡日期}`` ✓（2026-10-17）

    为什么需要它：头衔史里的 ``holder`` 只写了"某年某月谁拿了它"，
    **人死了不会自动把 holder 清掉** ✗ —— 于是 1066 年那一层会出现
    "几百年前就死了的人还占着地"（用户报的："这个人明明都死了，还找他干嘛"✓）。
    构建时按人物史把这些人筛掉，当无主处理 ✓

    实现：人物史是嵌套块，用一个小括号栈把每个角色块切出来，
    再在块里找 ``death``，记下它所在子块的日期 ✓
    （``death = yes`` 和 ``death = { death_reason = … }`` 两种写法都认 ✓）
    ⚠ 读不出死亡日期的一律当活着 —— **宁可留着，也别凭空清人** ✓
    """
    out: dict[str, tuple[int, int, int]] = {}
    if not char_dir.is_dir():
        return out
    date_re = re.compile(r"^\s*(\d{1,4})\.(\d{1,2})\.(\d{1,2})\s*=\s*\{")
    for f in sorted(char_dir.glob("*.txt")):
        try:
            lines = f.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        i, n = 0, len(lines)
        while i < n:
            head = lines[i].split("#", 1)[0]
            m = re.match(r"^(\S+)\s*=\s*\{", head)
            if not m:
                i += 1
                continue
            cid = m.group(1).strip('"')
            depth = head.count("{") - head.count("}")
            block = [head]
            i += 1
            while i < n and depth > 0:
                cur = lines[i].split("#", 1)[0]
                depth += cur.count("{") - cur.count("}")
                block.append(cur)
                i += 1
            got_date = None
            for line in block:
                dm = date_re.match(line)
                if dm:
                    got_date = (int(dm.group(1)), int(dm.group(2)), int(dm.group(3)))
                if got_date and re.search(r"\bdeath\b", line):
                    out[cid] = got_date
                    break
    return out


# ------------------------------------------------------------------ 省份图


def build_province_map(png_path: Path, defs: dict[int, tuple[int, int, int, str]],
                       scale: int = 1):
    """把 provinces.png 的每个像素换算成 province id。

    CK3 用的是「颜色查表」而不是调色板索引：图片里的 RGB 直接等于
    definition.csv 第三列的颜色。所以先建一张 24 位色 → id 的查找表。

    :param scale: 降采样倍数（默认 1 = 原样 ✓）。
        ⚠ **CK3 永远不传它** ✗（它那张 9216×4608 是编辑器的主力尺寸 ✓ 缩了画质就没了 ✓）——
        CK2 那份（``build_ck2.py``）才有 ``--scale``：它地图只有 3072×2048，
        想要一张更省显存的对照图时才会用到 ✓
        ⚠ 缩放必须在**建颜色表之前**做 ✗ —— 缩完再认色，边缘那圈混色像素
        才会老老实实落进 ``UNKNOWN`` 那一档（先认色再缩，插值出来的新颜色
        会变成一堆"表里没有的颜色" ✓ 数量级完全不同 ✓）；NEAREST 保证
        缩出来的每一个像素都还是**原来某个省份的颜色** ✓ 不会凭空造色 ✓
    """
    log(f"读取 {png_path.name} …")
    im = Image.open(png_path)
    if im.mode != "RGB":
        im = im.convert("RGB")
    if scale > 1:
        im = im.resize((max(1, im.width // scale), max(1, im.height // scale)),
                       Image.NEAREST)
        log(f"  按 1/{scale} 降采样 → {im.width}×{im.height}")
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


#: 这些类别**最细那层每块地单独一个节点**（可以一块块涂色），粗层每层各一片 ✓
#: 都是"不可通行的陆地 / 无归属荒地"—— 玩家会想按周边国家给它们上色。
SETTABLE_CATEGORIES = ("#impassable", "#wasteland")


def build_special_titles(
    terrain: dict[str, set[int]],
    n_prov: int,
    blank: np.ndarray,
    base_index: int,
    special_names: dict[str, str] | None = None,
    geo_tiers=None,
    tier_names: dict[str, dict[int, str]] | None = None,
    waste_names: dict[int, str] | None = None,
    skip_fine_tier: bool = False,
    script_tiers=None,
) -> tuple[list[Title], dict[str, np.ndarray], list[str], list[int], list[int]]:
    """给制不出头衔的地块分类 —— **每一层给该层自己的伪头衔**（2026-10-13 统一 ✓）。

    以前是"全世界的海共用一个 ``#sea``、荒地粗层共用一个灰"✗ —— 归属表每一行填的都是
    同一个序号 ✓ 于是"换层海域范围会变"在缓存里根本没有表达 ✗，前端只好为它们到处写
    旁路 ✓（水名表 / 悬停特判 / 高亮编组 / 边界特判…一口气四五处配对改 ✗）。
    现在：**每一层的海 / 湖 / 河 / 荒地各有各的节点** ✓ 每层的"片"就是该层同名地块的
    集合 ✓ 前端按"当前层那个头衔"一套逻辑走到底 ✓ 不用再开特例 ✓。

    真正的实现（两种口径、"上下级"父子连接、逐块荒地）在 ``build_tier_pieces`` 里 ✓
    —— 那份文件是 CK3 与 EU4/HOI4/VIC3/EU5 共用的，别在这儿复制一份 ✗


    ⚠ 参数 `tier_names` 就是 `parsers/ck3` 那边……**CK3 没有水名表** ✓
    （游戏数据里没有"每片海叫什么"这一级 ✓ 见 `docs/水域名调研.md` 第 411 行 ✓）
    所以 CK3 每一层整片算一片、名字用类别名 ✓ 这是实话，不是没实现 ✓
    `waste_names` 同理（CK3 的荒地名字由 `patch_wasteland` 统一补成类别名 ✓）。
    """
    from build_tier_pieces import build_special_titles as _impl   # noqa: PLC0415
    return _impl(
        terrain, SPECIAL_CATEGORIES, n_prov, blank, base_index,
        list(geo_tiers or TIER_ORDER),
        tier_names=tier_names,
        waste_names=waste_names,
        settable=SETTABLE_CATEGORIES,
        # 🔴 **最细层不造片** ✗（2026-10-14 ✓ 用户要求 ✓ 见调用处那段长注释 ✓）
        #   水域的最细层就是它自己那个 province ✓ 不需要片 ✓
        #   ⚠ 荒地 / 不可通行**不受影响** ✗ —— 它们走 `settable` 那条逐块路 ✓
        #     （`skip_fine_tier` 只作用于"按名字分片"那一条 ✓）
        skip_fine_tier=skip_fine_tier,
        script_tiers=script_tiers,
        name_sink=special_names,
    )


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
    order: list[str] | None = None,
) -> np.ndarray:
    """给每个省份、每个层级找出它归属的头衔，做成 len(层级栈)×n_prov 的表。

    这一张表就是前端着色的全部依据：查到 province id，再去对应层级取头衔，
    最后取头衔的颜色。

    :param order: 层级栈（**行号就是它里面的下标** ✓）。不给 = 本文件那份 ``MAP_ORDER`` ✓
        ⚠ **CK2 显式传它自己的** ✗ —— CK2 第 0 层是「空白剧本」、CK3 第 0 层是「1066」✓
          两边 e…b 的下标**碰巧**都是 1…5 ✓ 但那是巧合 ✗ 别靠巧合
          （CK3 哪天给剧本块再加一层，这边就会悄悄错位一格 ✓）
          显式传进来，行号才是调用方自己说了算的 ✓（默认值保住 CK3 的老行为 ✓）

    ⚠ 第 0 行（**剧本层**）不在这里填 ✗ —— CK3 那边要等伪头衔建好
      （"无主"要挂到无归属荒地上 ✓），由 build_realm_layer 收尾 ✓；
      CK2 那边整层留空（本版不做归属 ✓ 只有背景地形由伪头衔填 ✓ 见 build_ck2.py ✓）
    """
    order = list(order) if order is not None else MAP_ORDER
    table = np.full((len(order), n_prov), NO_TITLE, dtype=np.uint16)
    per_pid: dict[int, dict[str, int]] = {}
    for t in ordered:
        ti = index_of[t.key]
        for pid in owned[t.key]:
            if 0 < pid < n_prov:
                per_pid.setdefault(pid, {})[t.tier] = ti

    filled = 0
    for pid, tiers in per_pid.items():
        for tier, ti in tiers.items():
            if tier not in order:
                continue
            table[order.index(tier), pid] = ti
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
    order: list[str] | None = None,
    tiers: tuple[str, ...] | None = None,
) -> tuple[dict[str, list[int]], int]:
    """算出**剧本层**每一格归谁：每块地归到它的**非封臣**（独立政权）✓

    :param order: 层级栈（行号就是它里面的下标 ✓）。不给 = 本文件那份 ``MAP_ORDER`` ✓
    :param tiers: **法理层级**（粗 → 细 ✓）。不给 = 本文件那份 ``TIER_ORDER`` ✓
        ⚠ **CK2 必须传它自己的** ✗ —— 它只有 e/k/d/c 四级（没有男爵领 ✓ 见
          ``parsers/ck2/parser.py`` 的 ``TIER_ORDER`` 那段 ✓）。
          默认那份里有 ``b`` ✗ → `rows` 会多算一个用不上的行号 ✓
          （眼下 `fine_first` 会把 ``b`` 排掉 ✓ 所以不传也不会当场炸 ✓
           但那是**碰巧** ✓ 别靠碰巧 ✓ 见 `build_titlemap` 的 `order` 同理 ✓）

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
    _tiers = tuple(tiers) if tiers is not None else tuple(TIER_ORDER)
    _order = list(order) if order is not None else MAP_ORDER
    rows = {tier: _order.index(tier) for tier in _tiers if tier in _order}
    # ⚠ **从伯爵领（c）开始往上找，不看男爵领** ✗ ——
    #   用户点名的："男爵领本来就没法在 CK3 进行细分，全都应该属于伯爵领才对" ✓
    #   男爵领只是伯爵领**里面的地产** ✓ 它自己那条 liege / holder 不该决定
    #   "这块地归谁政权" ✗（辽东范围不对就是这个：那几块地的男爵领挂着别的 liege ✓）
    #   ⚠ CK2 的 `tiers` 里**压根没有 b** ✓ 这边这个过滤对它就是个空操作 ✓
    fine_first = [rows[tier] for tier in reversed(_tiers) if tier != "b" and tier in rows]   # c → e
    for pid in range(1, n_prov):
        start = -1
        for r in fine_first:
            tid = int(titlemap[r, pid])
            if 0 < tid < len(ordered):
                start = tid
                break
        if start < 0:
            continue                       # 背景地形：这一层照地形那套走 ✓
        # 🔴 **县和公国打架时，以公国为准** ✗✗（2026-10-17 用户报的「宋的大同、怀安飞地」）
        #   例：大同那几块地的县（c_datong_2）封君写着 k_hedong（宋的河东 ——
        #   还是 924 年留下的老字段 ✓），可**同一个人**（耶律合术 1413746）
        #   另外还拿着公国 d_yunshuo，而那个公国挂在辽下面 ✓
        #   → 一条链通宋、一条链通辽，我们原来只认"县"那条 → 宋凭空多一块飞地 ✗
        #   现在：同一个人同时拿着这块地的县和它的公国 → **按公国算** ✓
        #   ⚠ 只在"同一个人"时才改 ✗ —— 换个人的话县和公国本来就是两码事 ✓
        if _order[r] == "c" and "d" in rows:
            _dtid = int(titlemap[rows["d"], pid])
            if 0 < _dtid < len(ordered):
                _dkey = keys[_dtid]
                _h = holders.get(keys[start])
                if _h and holders.get(_dkey) == _h:
                    start = _dtid
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
    # 🔴 **二次归并：同一个人的地盘不许裂成两个政权** ✗✗（2026-10-17 用户报的「凉国」）
    #   上面那一刀只并了"**自己名下**那些头衔"；可还有一类会漏：
    #   瓜州 / 振武这些县的封君链**顶到 `k_hexi`**（河西那位君主），
    #   于是它们被记在 `k_hexi` 名下 —— 而 `k_hexi` 的持有者同时拿着 `k_xia` ✓
    #   → 一边记 `k_xia`、一边记 `k_hexi`，同一个君主的同一条线裂成「夏」和「凉」✗
    #   所以再扫一遍：`out` 里凡是**持有者相同**的两个政权，并到地盘大的那个上 ✓
    #   （持有者查不到 = 这个头衔没人持 → 留着，它本来就是独立的一块 ✓）
    by_holder_out: dict[str, list[str]] = {}
    for _k2 in out:
        _h = holders.get(_k2)
        if _h:
            by_holder_out.setdefault(str(_h), []).append(_k2)
    for _h, _ks in by_holder_out.items():
        if len(_ks) < 2:
            continue
        _ks.sort(key=lambda k3: -len(out[k3]))
        _keep = _ks[0]
        for _k3 in _ks[1:]:
            out[_keep].extend(out.pop(_k3))
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
    ap.add_argument("--drop-dead-holders", action="store_true",
                    help="剧本日期前已去世的持有者当无主处理（默认关：人一死地就往法理上层跑，"
                         "宋这种大帝国会凭空变大 ✓）")
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
        # 🔴 **死者持仓** ✗✗（2026-10-17 用户报："这个人明明都死了，还找他干嘛"）
        #   头衔史里的 `holder` 只是"某年某月谁拿了它"，**人死了不会自动清空** ✗
        #   → 1066 那会儿会有一批头衔还挂在几百年前的人名下
        #     （实测东方王朝这张图有 178 个：3 个帝国级、27 个王国级、46 个公国级 ✓）
        #   这里按人物史把"死在剧本日期之前（含当天）"的人筛掉，那些头衔按无主处理 ✓
        #   ⚠ 只认**带日期的 death** ✗；读不出来的当活着（宁可留着，也别凭空清人 ✓）
        _deaths = parse_character_deaths(game / "history" / "characters") \
            if getattr(args, "drop_dead_holders", False) else {}
        if _deaths:
            _dead = [k for k, v in holders.items()
                     if v and str(v) in _deaths and _deaths[str(v)] <= bookmark_date]
            if _dead:
                for _k in _dead:
                    holders.pop(_k, None)
                log(f"持有者在剧本日期前已去世：{len(_dead)} 个头衔按无主处理")
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
    # 🔴🔴 **水域不算"空白"** ✗✗（2026-10-14 ✓ 用户要求 ✓）
    #
    #   用户："你就不能把水域变成一个**仅仅是不能填色的地块**吗……
    #     最底层的单位也有自己的 Province id"✓
    #   → 水域**不再造伪头衔** ✓ 于是它"所有层都无主"✓ 正好落进下面这个 blank ✗
    #     → 被「**无归属荒地**」那一片盖住 ✓
    #     后果（实跑量到的）：悬停一块海，`tid` 拿到的是 `#wasteland_c_3` ✓
    #       于是**海的高亮跟着荒地整片亮** ✗ 边界也走了荒地那条 ✓
    #
    #   → 水域必须**排除在 blank 之外** ✓ 那它就"完全无归属"✓
    #     身份完全靠 `pid` + `meta.waterMask`（那个"小标签"✓）——
    #     颜色走海域色 ✓ 边界听水域那两条开关 ✓ 高亮按 pid ✓ 别的全跟普通地块一样 ✓
    #
    #   ⚠ 水域**不能**进 `#wasteland` ✗ —— 荒地是"可以一块块涂色"的 ✓
    #     而水域**不能填色** ✓ 两者待遇相反 ✓ 混在一起两头都错 ✓ */
    _water_all = np.zeros(int(n_prov), dtype=bool)
    for _wcat in ("river_provinces", "lakes", "sea_zones", "impassable_seas"):
        for _wp in (terrain.get(_wcat) or ()):
            _wpi = int(_wp)
            if 0 <= _wpi < _water_all.size:
                _water_all[_wpi] = True
    blank = np.all(titlemap == NO_TITLE, axis=0) & present & ~_water_all
    log(f"完全没有头衔的地块：{int(blank.sum())} 个"
        f"（已排除 {int(_water_all.sum())} 个水域 ✓ 它们不算「无主荒地」✓）")

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

    # ⚠ **CK3 没有水名表** ✗ —— 游戏数据里没有"每片海叫什么"这一级 ✓
    #   （`map_data/default.map` 的 `sea_zones` 只是一串地块号，
    #     连行注释都只是给人看的分类 ✓ 见 `docs/水域名调研.md` 第 411 行 ✓）
    #   → 每一层整片算一片、名字用类别名 ✓ 这是**实话**，不是没做 ✓
    #     CK3 的"换层海域边界变了"本来也不该变：游戏里海就不分层 ✓
    # 🔴🔴 **水域不造层级伪头衔** ✗✗（2026-10-14 ✓ 用户要求 ✓）
    #
    #   用户原话："你就不能把水域变成一个**仅仅是不能填色的地块**吗，
    #     明明在游戏里也是这样的，而且**最底层的单位也有自己的 Province id**"
    #     "和陆地一样啊，**大名，河北，华北**，这样下来"（= 逐块 / 地区 / 大区 ✓）
    #     "只是水域**带一个小标签**来让他在**边界和颜色**等方面听从相关的开关，
    #      **其他逻辑不变**"
    #
    #   → 所以：
    #     · **最细层**：水域**不造节点** ✓ 它就是它自己那个 province ✓
    #       （跟荒地不一样 ✗ —— 荒地要"一块块涂色"✓ 所以它有 `wl_<pid>` ✓
    #        水域**不能填色** ✗ 所以连那个都不需要 ✓）
    #     · **粗层**：**CK3 游戏里没有水域层级** ✗（`default.map` 的 `sea_zones`
    #       只是一串地块号 ✓ 没有任何归并 ✓）→ 所以**一层都不造** ✓
    #       （EU4/EU5 有 `sea_starts` / `area` 那种真层级 ✓ 它们**粗层照造** ✓
    #        见各自的脚本传的 `skip_fine_tier` ✓）
    #
    #   ⚠ **`skip_fine_tier=True`** ✗ —— 意思是"最细层不造片 ✓ 粗层照造"✓
    #     CK3 没有粗层 ✓ → `coarser` 为空 ✓ → 于是一层都不造 ✓ 正是要的 ✓
    #   ⚠⚠ **候选池要把水域加回来** ✗✗（2026-10-14 ✓ 差点栽在这儿）
    #     `blank` 上面**排除了水域** ✓（那是给 `patch_blank_era` 用的 ✓ 它不该
    #     把水域当"背景地形"抄进空白层 ✓）—— 可 `build_special_titles` **也拿它
    #     当候选池** ✗ → 于是水域一个片都造不出来 ✓（实跑：EU4/HOI4/VIC3 全是 0 片 ✓）
    #     → 这里传 **`blank | _water_all`** ✓：水域重新进候选池 ✓
    #       而"最细层不造"由 `skip_fine_tier` 负责 ✓ 两件事各管各的 ✓
    #   ⚠ 水域**先认领**、荒地最后兜底 ✓ —— `SPECIAL_CATEGORIES` 的顺序保证的 ✓
    #     （`#river`/`#lake`/`#sea`/`#impassable_sea` 都在 `#wasteland` 前面 ✓
    #      `claimed` 一置 ✓ 荒地就拿不到水域了 ✓）
    special, _sp_rows, stats, waste_pids, waste_tids = build_special_titles(
        terrain, n_prov, blank | _water_all, SPECIAL_BASE, _special_names,
        geo_tiers=TIER_ORDER, skip_fine_tier=True,
        # 🔴 **剧本层：每一类共用一个"海洋"节点** ✗（2026-10-14 ✓ 用户的主意 ✓）
        #   = 全层里排在地理层**前面**的那几格（CK3 是 `1066` ✓）
        script_tiers=[t for t in MAP_ORDER if t not in TIER_ORDER])
    log("地形类别：" + "，".join(stats) if stats else "地形类别：无")

    # 🔴🔴 **底层地块的"身份标"** ✗✗（2026-10-16 补 ✓ 用户点名要的 ✓）
    #   用户原话："我记得开发一开始就给每个地图每个最低等级都加上了相应的标记"✓
    #   —— 他记得对：`build_tier_pieces.kind_mask()` **早就写好了** ✓
    #     而 `build_ck2.py` / `build_eu5.py` 一直在调它 ✓
    #     **CK3 / EU4 / HOI4 / VIC3 这四家从来没接过** ✗（这一轮就是来补这个的 ✓）
    #   → `meta.kindMask`：每地块 **1 字节**、base64（跟当年那枚 `waterMask` 一个形状 ✓）
    #     1 陆地（**兜底** ✓ 不属于下面几类的全是它）/ 2 海洋 / 3 湖泊 / 4 河流 /
    #     5 不可通行海域 / 6 不可通行区域 ✓
    #   ⚠ **无归属区域不进这枚标** ✗（用户明确交代：无归属是**剧本 / 归属**决定的 ✓
    #     不是地块身份 ✓ 它继续按运行时算 —— 见前端那行 `set-unpainted` ✓
    #     → 所以下面只挑 KIND_CODES 里有的那几个类别 ✓
    #     CK3 的 `#wasteland`（无归属荒地 ✓）**故意不进** ✓ 它照旧落"陆地 1" ✓）
    #   ⚠ 判据是**构建期那几套现成类别集合**（`terrain` ✓ 就是 `SPECIAL_CATEGORIES`
    #     里那几个来源清单读出来的那份 ✓ 跟"水域优先"一条口径 ✓
    #     `#river` 排在 `#sea` 前面 ✓ 所以河流那些是码 4 不是码 2 ✓）
    #   ⚠ **跟 CK3 那枚老的 `waterMask` 是两回事** ✗ —— 那枚只有 0/1（"是不是水"）
    #     而且**当前仓库里已经没有任何脚本会产出它** ✓（2026-10-15 那轮退役的 ✓
    #     见 `_local/_surgery_water_data.py` 开头那段 ✓）
    #     → 这枚 `kindMask` 是它的**正当接班人** ✓ 六类齐全 ✓
    #   ⚠ **不许拿 `{ }` 当作用域块** ✗✗ —— Python 里那不是块，是**字典/集合字面量** ✓
    #     （我第一版就这么写的 ✓ `py -3` 直接 `SyntaxError: invalid syntax` ✓
    #      在 JS 里写顺手了 ✗ —— 空格子块在 Python 3.14 上更是硬报错 ✓）
    #     → 下面**平铺写** ✓ 变量一律带 `_kind` / `_cat` 前缀，不污染这个函数的命名空间 ✓
    import base64 as _kind_b64mod                                 # noqa: PLC0415
    from build_tier_pieces import (kind_mask as _kind_mask,       # noqa: PLC0415
                                   KIND_CODES as _KIND_CODES)
    _cat: dict[str, set[int]] = {}
    for _key, _klabel, _krgb, _sources in SPECIAL_CATEGORIES:
        if _key not in _KIND_CODES:
            continue                # `#wasteland` 这类：无归属 ≠ 地块身份 ✓ 不进标 ✓
        _s: set[int] = set()
        for _src in _sources:
            _s |= set(terrain.get(_src, ()) or ())
        # ⚠ 只收"真有像素的地块" ✗ —— 跟候选池同一口径（`present` ✓）
        _s = {int(p) for p in _s if 0 < int(p) < n_prov and present[int(p)]}
        if _s:
            _cat[_key] = _s
    _kind_b64 = _kind_mask(n_prov, _cat)
    _kind_n = {c: 0 for c in range(7)}
    for _kb in _kind_b64mod.b64decode(_kind_b64):
        _kind_n[int(_kb)] = _kind_n.get(int(_kb), 0) + 1
    _kind_tot = sum(_kind_n[c] for c in range(1, 7))
    # **自证**：1~6 加起来必须 = numProvinces - 1 ✗（0 号那一格是空位 ✓ 不许有空洞 ✓）
    assert _kind_tot == n_prov - 1, \
        f"kindMask 有空洞 ✗：1~6 合计 {_kind_tot} ≠ numProvinces-1 = {n_prov - 1}"
    assert _kind_n[0] == 1, f"kindMask 的 0 号格子应该是空位 ✗（实际 {_kind_n[0]} 个）"
    log("身份标 kindMask："
        + " · ".join(f"{c}={_kind_n[c]}" for c in range(1, 7))
        + f"（1~6 合计 {_kind_tot} = numProvinces-1 ✓ 无空洞 ✓）")

    # **每一层填它自己那一片** ✓（2026-10-13 统一，见 `build_tier_pieces.apply_rows`）
    #   以前是"全层共用一个 `#sea`"✗ → 现在每层各有各的节点 ✓
    #   剧本层（1066）借**最粗那层地理层**的海片 ✓（它只关心陆地归谁 ✓）
    from build_tier_pieces import apply_rows as _apply_rows     # noqa: PLC0415
    log(f"背景地形按层填了 {_apply_rows(titlemap, _sp_rows, MAP_ORDER, TIER_ORDER)} 个"
        f" (省份, 层级) 对")
    left = int(np.count_nonzero(titlemap[MAP_ORDER.index(TIER_ORDER[-1])] == NO_TITLE))
    log(f"仍是空白的格子：{left}")

    # 逐块荒地的节点序号（meta 里要报给前端：荒漠涂色开关靠它判"这块是不是荒地"）
    #: 哪些伪头衔是**水**（算荒地边长时不算；荒地/无主地要算）
    WATER_KEYS = ("#river", "#lake", "#sea", "#impassable_sea")

    def _is_water_key(k: str) -> bool:
        # ⚠ **前缀匹配** ✗（2026-10-13 起每层一片：键长这样 `#sea_pr_57` ✓）
        #   精确相等在这儿会把新键**一个都认不出来** ✗ ——
        #   荒地边长那一步就会把海算进"陆地周长"里去 ✓
        return str(k).startswith(WATER_KEYS)
    water_tids = {SPECIAL_BASE + k for k, sp in enumerate(special) if _is_water_key(sp.key)}
    # 逐块荒地的**真实节点号**直接来自 build_special_titles（建节点时记的）。
    # 以前在这里拿"special 尾部恰好连续 len(waste_pids) 个"反推 waste_base，
    # 可 #wasteland 的共享粗层节点插在两组逐块节点中间 —— 一差就差一位：
    # 第一块山地漏出 meta["wasteland"]、面积和标注位置整体错位一格。
    waste_tid_of = dict(zip(waste_pids, waste_tids))
    # 粗层那些"整片"伪头衔也算"荒地"（荒漠涂色关着时它们要显示灰 ✓）
    # ⚠ **前缀匹配** ✗ —— 2026-10-13 起每层一片，键是 `#impassable_c_3` 这种 ✓
    #
    # 🔴🔴 **`#impassable_sea` 必须排除** ✗✗
    #   （2026-10-13 用户报："不同时期**不可通行海域会被上色为背景色**"✓）
    #   `startswith("#impassable")` 是**前缀**匹配 ✓ 于是
    #     `#impassable_sea_e_0`（不可通行**海域** ✓）**也被吞进来** ✓
    #   而它是**水** ✗ —— 该走水域那套（海洋色 ✓），根本不该进"荒地"列表 ✓
    #   进去的后果：`meta.wasteland` 里混着它 ✓
    #     → 前端 `isWastelandTid()` 对它返回 **true** ✓
    #     → 按荒地逻辑上色 → **画成荒地色 / 背景色** ✓ 正是用户看到的 ✓
    #   （这个坑其实一直在 ✗ 只是"每层一片"改名之后更明显 ✓
    #     以前叫 `#impassable_sea` 也是同样被吞 ✓ 只是没人注意 ✓）
    #   ⚠ 判定要**先看排除项** ✗ —— 别指望调整前缀顺序能解决 ✓
    _WASTE_EXCLUDE = ("#impassable_sea",)
    for k, sp in enumerate(special):
        _key = str(sp.key)
        if not _key.startswith(SETTABLE_CATEGORIES):
            continue
        if _key.startswith(_WASTE_EXCLUDE):
            continue          # 不可通行海域：是水 ✗ 不是荒地 ✓
        waste_tids.append(SPECIAL_BASE + k)


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
    #: **全量** key → 序号（真头衔 + 剧本节点 + 伪头衔 ✓）—— 父节点查表用 ✓
    #  ⚠ 别拿 `index_of` ✗ 它只有真头衔 ✓ 伪头衔之间的"上下级"会被它一律查成 -1 ✓
    _all_index = {t.key: i for i, t in enumerate(ordered_all)}

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
        # **底层地块身份标**（每地块 1 字节 base64 ✓ 2026-10-16 补 ✓
        #   1 陆地 / 2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域 / 6 不可通行区域 ✓
        #   以前 CK3 只有一枚 `waterMask`（0/1 ✓ 而且已经没有脚本产出它了 ✗）——
        #   这枚是它的接班人 ✓ 前端 `decodeKindMask` 读的就是它 ✓）
        "kindMask": _kind_b64,
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
    }
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # 每个真头衔的地盘数；**1066 剧本节点**按它自己那一层的省份算；伪头衔按分到的地块算
    prov_count = [len(owned[t.key]) for t in ordered]
    for t in realm_nodes:
        prov_count.append(len(realm_own.get(t.key[len(ERA_TIER) + 1:], ())))
    # 伪头衔：**按它自己那一层那一行数** ✓（每层一片，一个节点只在自己那层出现 ✓）
    #   ⚠ 不能再像以前那样拿一个"全层共用"的 assign 数 ✗ ——
    #     那样每层一片会被数漏（`assign` 已经没有了 ✓）
    for k, _sp in enumerate(special):
        _idx = SPECIAL_BASE + k
        _r = MAP_ORDER.index(_sp.tier) if _sp.tier in MAP_ORDER else None
        prov_count.append(int(np.count_nonzero(titlemap[_r] == _idx)) if _r is not None else 0)

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
    # 伪头衔的面积同样**按它自己那一层那一行**算 ✓（跟上面 provCount 同一个口径 ✓）
    for k, _sp in enumerate(special):
        idx = SPECIAL_BASE + k
        _r = MAP_ORDER.index(_sp.tier) if _sp.tier in MAP_ORDER else None
        if _r is not None:
            area[idx] = int(counts[titlemap[_r] == idx].sum())
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
    _keys_all = [t.key for t in ordered_all]
    _lx_all = _pad_pos(lx, 0)
    _ly_all = _pad_pos(ly, 1)
    payload = {
        "keys": _keys_all,
        # ⚠ 这里是**地图层级**下标（前端拿它查 TIER_BADGE / 跳层 ✓）✗
        #   不是法理那五级的序号 —— 1066 那一层占据 0，所以 e_ 是 1 ✓
        "tiers": [MAP_ORDER.index(t.tier) if t.tier in MAP_ORDER else len(MAP_ORDER)
                  for t in ordered_all],
        # ⚠ 父节点要查**全量**表 ✗（2026-10-13）—— 伪头衔（海/湖/河/荒地）现在按
        #   "上下级"互相挂 ✓（细层的片挂在粗层的片上 ✓）；只有真头衔的 `index_of`
        #   会把它们一律查成 -1 ✓ 上下级就白连了 ✓
        "parents": [_all_index.get(t.parent, -1) if t.parent else -1 for t in ordered_all],
        "names": [names.get(t.key) or realm_names.get(t.key)
                  or special_names.get(t.key) or t.key for t in ordered_all],
        "colors": [[int(c[0]), int(c[1]), int(c[2])] for c in colors],
        "provCount": prov_count,
        "area": area.tolist(),
        "lx": _lx_all,
        "ly": _ly_all,
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



# 2026-10-12 · 地图编辑器 v1.9（本版未改动此脚本）
