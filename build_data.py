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
    parse_landed_titles,
    parse_localisation,
)

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"

#: 没有头衔的省份在 titlemap 里用这个值。正常情况下只有既没有头衔、
#: 又没被 default.map 归入任何地形类别的像素才会落到这里。
NO_TITLE = 0xFFFF

#: 省份图里用了 definition.csv 未登记颜色的像素，构建期间临时标这个
UNKNOWN_COLOR = 0xFFFE

_T0 = time.time()


def log(msg: str) -> None:
    print(f"[{time.time() - _T0:6.1f}s] {msg}", flush=True)


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


#: 海域分片的中文名（default.map 里的英文标题 → 中文）
SEA_GROUP_ZH = {
    "European Seas": "欧洲海域",
    "North European Seas": "北欧海域",
    "Mediterranean Seas": "地中海海域",
    "Black, Azov, Caspian & Aral Seas": "黑海·亚速海·里海·咸海",
    "Middle Eastern Seas": "中东海域",
    "Indian Seas": "印度洋海域",
    "African Seas": "非洲海域",
    "East Asia Seas": "东亚海域",
    "LAKES": "湖泊群",
}

#: 海域从"郡"这层开始细分成逐块（层序 e→k→d→c→b，0/1/2 = 公国领及以上）
SEA_SPLIT = 3


def read_sea_groups(map_path: Path) -> list[tuple[str, list[int]]]:
    """读 default.map 里按注释分片的 sea_zones（每片海域 = 一个标题 + 省份号）"""
    try:
        lines = map_path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError:
        return []
    groups: list[tuple[str, list[int]]] = []
    cur: tuple[str, list[int]] | None = None
    for raw in lines:
        s = raw.strip()
        if s.startswith("#") and re.search(r"[A-Za-z]", s):
            title = s.lstrip("# ").strip()
            cur = None
            if len(title) > 2 and not title.startswith("max_provinces"):
                cur = (title, [])
                groups.append(cur)
            continue
        m = re.match(r"sea_zones\s*=\s*(RANGE\s*)?\{([^}]*)\}", s)
        if m and cur is not None:
            nums = [int(x) for x in re.findall(r"\d+", m.group(2))]
            if len(nums) == 2 and m.group(1):
                cur[1].extend(range(nums[0], nums[1] + 1))
            else:
                cur[1].extend(nums)
    return [(title, pids) for title, pids in groups if pids]


#: 这些类别**每块地单独一个节点**（可以一块块涂色），其余地形仍旧一类一个伪头衔。
#: 都是"不可通行的陆地 / 无归属荒地"—— 玩家会想按周边国家给它们上色。
SETTABLE_CATEGORIES = ("#impassable", "#wasteland")


def build_special_titles(
    terrain: dict[str, set[int]],
    n_prov: int,
    blank: np.ndarray,
    base_index: int,
    sea_groups: list[tuple[str, list[int]]] | None = None,
    special_names: dict[str, str] | None = None,
) -> tuple[list[Title], np.ndarray, list[str], np.ndarray, list[int], np.ndarray, list[int]]:
    """给制不出头衔的地块分类；海/湖/河一类一个伪头衔，**荒地每块一个**。

    :param blank: 长度 n_prov 的 bool 表，True 表示这个省份在**所有**层级
                  都没有头衔（也就是海、湖、河、山这些）。
    :returns: (伪头衔列表, 全层共用的归属数组, 分类统计文字,
               只落在最细那层的归属数组, 逐块荒地的地块号, 海块的逐块归属,
               逐块荒地的**真实节点号**（与地块号一一对应）)
    """
    assign = np.full(n_prov, -1, dtype=np.int64)
    fine_assign = np.full(n_prov, -1, dtype=np.int64)   # 只有"逐块荒地"会用到
    low_assign = np.full(n_prov, -1, dtype=np.int64)    # 海域：郡/男爵领层的逐块节点
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
        if key == "#sea" and sea_groups:
            # ① 海：按 default.map 的分片建"整片海域"组节点（公国领及以上用它 ✓）
            cand = set(candidates.tolist())
            taken: set[int] = set()
            for title_en, pids in sea_groups:
                gidx = base_index + len(titles)
                gt = Title(f"#sea_grp_{len(titles)}", tier="@")
                gt.color = rgb
                titles.append(gt)
                if special_names is not None:
                    special_names[gt.key] = SEA_GROUP_ZH.get(title_en, title_en)
                n_in = 0
                for pid in pids:
                    if pid in cand and pid not in taken:
                        taken.add(pid)
                        assign[pid] = gidx
                        n_in += 1
                stats.append(f"{SEA_GROUP_ZH.get(title_en, title_en)} {n_in}")
            rest = sorted(cand - taken)
            if rest:
                gidx = base_index + len(titles)
                gt = Title(f"#sea_grp_other_{len(titles)}", tier="@")
                gt.color = rgb
                titles.append(gt)
                if special_names is not None:
                    special_names[gt.key] = "其它海域"
                for pid in rest:
                    assign[pid] = gidx
                stats.append(f"其它海域 {len(rest)}")
            # ② 海：**逐块节点**（郡/男爵领层用）
            for pid in sorted(cand):
                low_assign[pid] = base_index + len(titles)
                wt = Title(f"wz_{pid}", tier=TIER_ORDER[-1])
                wt.color = rgb
                titles.append(wt)
            stats.append(f"→ 逐块 {len(cand)} 个")
        else:
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

    return titles, assign, stats, fine_assign, waste_pids, low_assign, waste_tids


# ------------------------------------------------------------------ 头衔


def rank_titles(titles: dict[str, Title]) -> list[Title]:
    """排个稳定顺序，顺便把父子关系固化。父永远排在子前面。"""
    by_tier: dict[str, list[Title]] = {t: [] for t in TIER_ORDER}
    for t in titles.values():
        by_tier[t.tier].append(t)
    out: list[Title] = []
    for tier in TIER_ORDER:  # e → k → d → c → b
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
    """给每个省份、每个层级找出它归属的头衔，做成 5×n_prov 的表。

    这一张表就是前端着色的全部依据：查到 province id，再去对应层级取头衔，
    最后取头衔的颜色。
    """
    table = np.full((len(TIER_ORDER), n_prov), NO_TITLE, dtype=np.uint16)
    per_pid: dict[int, dict[str, int]] = {}
    for t in ordered:
        ti = index_of[t.key]
        for pid in owned[t.key]:
            if 0 < pid < n_prov:
                per_pid.setdefault(pid, {})[t.tier] = ti

    filled = 0
    for pid, tiers in per_pid.items():
        for tier, ti in tiers.items():
            table[TIER_ORDER.index(tier), pid] = ti
            filled += 1
    log(f"头衔归属表完成：{filled} 个 (省份, 层级) 对")
    return table


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
    args = ap.parse_args()

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
    gap_b = (titlemap[4] == NO_TITLE) & present & (titlemap[3] != NO_TITLE)
    degraded = np.nonzero(gap_b)[0]
    if degraded.size:
        titlemap[4, degraded] = titlemap[3, degraded]
        shown = "、".join(str(int(p)) for p in degraded[:8])
        log(f"男爵领层空缺 {degraded.size} 个省份（{shown}），已用所属伯爵领的色块顶替")
    else:
        log("男爵领层没有空缺")

    # 6. 海/湖/河/山：所有层级都没头衔的地块才归地形类别
    terrain = parse_default_map(game / "map_data" / "default.map")
    blank = np.all(titlemap == NO_TITLE, axis=0) & present
    log(f"完全没有头衔的地块：{int(blank.sum())} 个")

    _sea_groups = []   # 海域分组已废弃（按要求删掉）
    _special_names: dict[str, str] = {}
    special, assign, stats, fine_assign, waste_pids, low_assign, waste_tids = build_special_titles(
        terrain, n_prov, blank, len(ordered), _sea_groups, _special_names)
    log("地形类别：" + "，".join(stats) if stats else "地形类别：无")

    sel = assign >= 0
    if sel.any():
        vals = assign[sel].astype(np.uint16)
        for r in range(len(TIER_ORDER)):
            titlemap[r, sel] = vals
    # 海域：郡 / 男爵领两层换成**逐块节点**（公国领及以上仍旧整片海域 ✓）
    sel_low = low_assign >= 0
    if sel_low.any():
        low_vals = low_assign[sel_low].astype(np.uint16)
        for r in range(SEA_SPLIT, len(TIER_ORDER)):
            titlemap[r, sel_low] = low_vals

    # 逐块荒地**只盖最细那层** —— 粗层照旧是那块共享的灰（跟 EU5 一个口径）
    sel2 = fine_assign >= 0
    if sel2.any():
        titlemap[len(TIER_ORDER) - 1, sel2] = fine_assign[sel2].astype(np.uint16)
    left = int(np.count_nonzero(titlemap[0] == NO_TITLE))
    log(f"仍是空白的格子：{left}")

    # 逐块荒地的节点序号（meta 里要报给前端：荒漠涂色开关靠它判"这块是不是荒地"）
    #: 哪些伪头衔是**水**（算荒地边长时不算；荒地/无主地要算）
    WATER_KEYS = ("#river", "#lake", "#sea", "#impassable_sea")

    def _is_water_key(k: str) -> bool:
        return k in WATER_KEYS or k.startswith("#sea_grp_") or k.startswith("wz_")
    water_tids = {len(ordered) + k for k, sp in enumerate(special) if _is_water_key(sp.key)}
    # 逐块荒地的**真实节点号**直接来自 build_special_titles（建节点时记的）。
    # 以前在这里拿"special 尾部恰好连续 len(waste_pids) 个"反推 waste_base，
    # 可 #wasteland 的共享粗层节点插在两组逐块节点中间 —— 一差就差一位：
    # 第一块山地漏出 meta["wasteland"]、面积和标注位置整体错位一格。
    waste_tid_of = dict(zip(waste_pids, waste_tids))
    # 粗层那两个共享伪头衔也算"荒地"（荒漠涂色关着时它们要显示灰）
    for k, sp in enumerate(special):
        if sp.key in SETTABLE_CATEGORIES:
            waste_tids.append(len(ordered) + k)

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
            t_nb = int(titlemap[0, nb])
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

    ordered_all = ordered + special
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
        "numRealTitles": len(ordered),
        "tiers": list(TIER_ORDER),
        "tierNames": [TIER_NAME[t] for t in TIER_ORDER],
        # 悬停卡片左边那个小徽章，CK3 就是 key 的前缀
        "tierKeys": [f"{t}_" for t in TIER_ORDER],
        "entity": "头衔",
        "defaultTier": 3,            # 打开就是伯爵领视图
        # 法理按哪一年算的（history/titles 的 de_jure_liege 盖到 landed_titles 骨架上）
        "deJureYear": dejure_year or 0,
        # 每一层从百分之多少的缩放开始上地名
        "labelZoom": [8, 30, 60, 120, 250],
        "noTitle": NO_TITLE,
        "specialPrefix": "#",
        "degradedBaronies": [int(x) for x in degraded],   # 没有男爵领、用伯爵领顶替的省份
        "colorLutWidth": 256,
        # 荒地（不可通行山地 / 无归属荒地）：哪些节点算荒地 + 逐块的自动归属
        "wasteland": sorted(set(waste_tids)),
        "wastelandAuto": waste_auto,
    }
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    # 每个真头衔的地盘数；伪头衔按它实际分到的地块算
    prov_count = [len(owned[t.key]) for t in ordered]
    for k in range(len(special)):
        prov_count.append(int(np.count_nonzero(assign == len(ordered) + k)))

    # 每个头衔在地图上占的真实像素数。地名标注靠它判断"这块够不够大、放得下字吗"
    # —— 拿省份个数当面积代理是不准的，同一个伯爵领的省份大小能差上百倍。
    area = np.zeros(n_all, dtype=np.int64)
    for i, t in enumerate(ordered):
        pids = np.fromiter((p for p in owned[t.key] if 0 < p < n_prov), dtype=np.int64)
        if pids.size:
            area[i] = int(counts[pids].sum())
    for k in range(len(special)):
        idx = len(ordered) + k
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
        tail = []
        for k in range(len(special)):
            p = _waste_pos.get(len(ordered) + k)
            tail.append(round(p[which], 1) if p else None)
        return [None if np.isnan(v) else round(float(v), 1) for v in arr] + tail

    # 头衔表：用并行的数组，比对象数组省一半体积
    # 伪头衔在本地化表里当然查不到，用 SPECIAL_CATEGORIES 里写好的中文名
    special_names = {key: label for key, label, _rgb, _src in SPECIAL_CATEGORIES}
    # 海域组节点的中文名（分组时写进 _special_names）+ 逐块海块用该省自己的名字 ✓
    special_names.update(_special_names)
    payload = {
        "keys": [t.key for t in ordered_all],
        "tiers": [TIER_ORDER.index(t.tier) if t.tier in TIER_ORDER else len(TIER_ORDER)
                  for t in ordered_all],
        "parents": [index_of.get(t.parent, -1) if t.parent else -1 for t in ordered_all],
        "names": [names.get(t.key) or special_names.get(t.key)
                  or (prov_names[int(t.key[3:])] if t.key.startswith("wz_")
                      and t.key[3:].isdigit() and int(t.key[3:]) < len(prov_names) else None)
                  or t.key for t in ordered_all],
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
