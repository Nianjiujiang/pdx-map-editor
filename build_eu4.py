"""把 EU4 的原始数据生成前端能直接吃的缓存。

跑一次就好： ``python build_eu4.py``
换 EU4 版本之后再跑一次。输出到 ``data_eu4/``。

跟 CK3 那套的对应关系 —— EU4 的行政区划正好也是五级，而且能一一对上
``titlemap`` 的 5 行，所以前端一行渲染代码都不用改：

    index   CK3         EU4            数据来源
    0       e_ 帝国     大洲            continent.txt（**直接挂在省份上**）
    1       k_ 王国     大区            superregion.txt
    2       d_ 公爵领   区域            region.txt
    3       c_ 伯爵领   地区            area.txt
    4       b_ 男爵领   省份            definition.csv

三个跟 CK3 不一样、必须说清楚的地方：

  * **名字是英文的。** EU4 只带英法德西四种本地化，没有中文。
  * **颜色大半是编辑器生成的。** definition.csv 给了每个省份一个颜色，
    area.txt 里有 50 个地区自带 ``color``，但区域、大区、大洲在 EU4 里
    根本没有配色数据。这些层级的颜色是按"同一个父级下的兄弟"用黄金角
    散开的，纯粹为了看清层级，不是游戏里的东西。
  * **海、湖、不可通行荒地是锁住的伪头衔。** EU4 其实给海洋也编了
    area/region/superregion（baltic_sea_region 之类），但编辑器里
    "海不能涂、不能选"这条规矩在 CK3 模式下已经定了，这里保持一致，
    把它们归成 ``#sea`` / ``#lake`` / ``#wasteland``。
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

Image.MAX_IMAGE_PIXELS = None

from build_data import NO_TITLE, build_adjacency, build_province_map, log
from parsers.ck3.parser import Title, hsv_to_rgb
from parsers.eu4 import hanhua
from parsers.eu4 import history as EH
from parsers.eu4 import parser as E

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data_eu4"


#: 海、湖、不可通行荒地在编辑器里都是**伪头衔**（key 以 # 开头），
#: 只读、不给涂、悬停不选中。判定按顺序来，先命中的赢。
SPECIAL_CATEGORIES = [
    ("#lake",      "湖泊",         ( 47, 110, 150), "lakes"),
    ("#sea",       "海洋",         ( 32,  57,  92), "sea_starts"),
    ("#wasteland", "不可通行荒地", (94, 94, 94), None),   # 兜底：剩下没归属的
]

#: 官方大洲的基准色相（度）。六个洲是闭集，挑一组互相离得开的色相当族谱根，
#: 下面的区域/大区都从根色相散出去，同一洲的东西看起来像一家。
CONTINENT_HUE = {
    "europe": 212, "asia": 26, "africa": 46,
    "north_america": 154, "south_america": 96, "oceania": 288,
}

#: 黄金角 —— 同一父级下的兄弟按它散开，不管有几个都能拉开距离
_GOLDEN = 0.6180339887498949


def prov_key(pid: int) -> str:
    """EU4 的省份没有 key，自己造一个，前缀 p_ 不会跟别的东西撞。"""
    return f"p_{pid}"


class Node:
    """一个层级节点。"""

    __slots__ = ("key", "tier", "color", "parent", "pid")

    def __init__(self, key: str, tier: str, pid: int = 0):
        self.key = key
        self.tier = tier
        self.color: tuple[int, int, int] | None = None
        self.parent: str | None = None
        self.pid = pid


# ------------------------------------------------------------------ 找游戏

def find_steam_game(explicit: str | None, folder: str, probe: str, flag: str) -> Path:
    """从一个 Steam 库里把某个游戏翻出来。

    CK3/EU4/HOI4 的安装目录都在 ``steamapps/common/<folder>``，找法一模一样，
    所以抽出来共用。

    :param folder: ``steamapps/common`` 下的目录名
    :param probe:  这个相对路径存在才算找对（免得认错成别的目录）
    :param flag:   找不到时报错提示用哪个命令行参数
    """
    if explicit:
        p = Path(explicit).resolve()
        if (p / probe).is_file():
            return p
        raise SystemExit(f"{flag} 指的目录里没有 {probe}：{p}")

    roots: list[Path] = []
    try:
        import winreg
        for hive, key in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                          (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam"),
                          (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam")):
            try:
                with winreg.OpenKey(hive, key) as k:
                    roots.append(Path(winreg.QueryValueEx(k, "SteamPath")[0]))
            except OSError:
                pass
    except Exception:
        pass
    roots += [Path(r"C:\Steam"), Path(r"C:\Program Files (x86)\Steam"),
              Path(r"C:\Program Files\Steam")]

    libs: list[Path] = []
    for r in roots:
        if r not in libs:
            libs.append(r)
    for r in list(libs):
        vdf = r / "steamapps" / "libraryfolders.vdf"
        if not vdf.is_file():
            continue
        try:
            txt = vdf.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for m in re.finditer(r'"path"\s*"([^"]+)"', txt):
            p = Path(m.group(1).replace("\\\\", "\\"))
            if p not in libs:
                libs.append(p)

    for lib in libs:
        p = lib / "steamapps" / "common" / folder
        if (p / probe).is_file():
            return p
    raise SystemExit(f"没找到 {folder} 的安装目录，用 {flag} 手动指定吧")


def find_eu4(explicit: str | None = None) -> Path:
    """从注册表 / 默认路径 / libraryfolders.vdf 里把 EU4 翻出来。"""
    return find_steam_game(explicit, "Europa Universalis IV", "map/provinces.bmp", "--eu4")


def eu4_version(root: Path) -> str:
    cfg = root / "launcher-settings.json"
    if cfg.is_file():
        try:
            d = json.loads(cfg.read_text(encoding="utf-8-sig", errors="replace"))
            v = str(d.get("rawVersion") or d.get("version") or "").lstrip("v")
            if v:
                return v
        except Exception:
            pass
    branch = root / "eu4_branch.txt"
    if branch.is_file():
        return branch.read_text(encoding="utf-8", errors="replace").strip()
    return ""


# ------------------------------------------------------------------ 中文名

#: 默认的 workshop 目录，自动找汉化用
DEFAULT_WORKSHOP = Path(r"C:\Steam\steamapps\workshop\content")


def load_hanhua(explicit: str | None, workshop: str | None) -> tuple[dict[str, str], str]:
    """中文名表。返回 (表, 来源说明)。

    找的顺序：``--hanhua`` 明确指定的（json 或 mod 目录）→ 项目里现成的
    ``eu4_names_zh.json`` → workshop 里自动认。都找不到就返回空表，
    名字退回游戏自带的英文。``--hanhua none`` 可以强制用英文。

    表里那条 ``_meta`` 是 ``extract_eu4_zh.py`` 写下的来源信息，
    这里提出来单独返回 —— 免得以后看着一堆中文名不知道是谁给的。
    """
    def unpack(d: dict, fallback: str) -> tuple[dict[str, str], str]:
        meta = d.get("_meta")
        names = {k: v for k, v in d.items() if isinstance(v, str)}
        if isinstance(meta, dict):
            name = meta.get("name") or "?"
            wid = meta.get("workshop_id") or meta.get("remote_file_id") or "?"
            return names, f"{name}（workshop {wid}）"
        return names, fallback

    if explicit and explicit.lower() in ("none", "off", "no"):
        return {}, "按要求跳过，用英文"

    if explicit:
        p = Path(explicit)
        if p.is_file() and p.suffix.lower() == ".json":
            return unpack(json.loads(p.read_text(encoding="utf-8")), p.name)
        if p.is_dir():
            loc = p / "localisation"
            d = hanhua.load_dir(loc if loc.is_dir() else p)
            if d:
                return d, p.name
            raise SystemExit(f"--hanhua 指的目录里没读出中文：{p}")

    cache = ROOT / "eu4_names_zh.json"
    if cache.is_file():
        try:
            d = json.loads(cache.read_text(encoding="utf-8"))
            if d:
                return unpack(d, cache.name)
        except Exception:
            pass

    cands = hanhua.find_hanhua(Path(workshop) if workshop else DEFAULT_WORKSHOP)
    if cands:
        best, best_n, best_d = None, -1, {}
        for c in cands:
            d = hanhua.load_file(c / "localisation" / "prov_names_l_english.yml")
            if len(d) > best_n:
                best, best_n, best_d = c, len(d), d
        if best_d:
            # 挑出来之后再把它的 localisation 整个读了 —— 别只读省份那个文件，
            # 地区/区域的名字散在别的文件里
            full = hanhua.load_dir(best / "localisation")
            return full, f"{best.name}（自动认的）"
    return {}, "没找到汉化 mod，用英文"


# ------------------------------------------------------------------ 配色

def _lohi(i: int, mod: float, lo: float, hi: float) -> float:
    """第 i 个兄弟在 [lo,hi] 里取一个低差异值（乘无理数取小数）。"""
    return lo + (hi - lo) * ((i * mod) % 1.0)


def child_hue(seed: float, i: int, amp: float) -> float:
    """从父级色相散出第 i 个兄弟的色相。"""
    return (seed + (((i * _GOLDEN) % 1.0) * 2.0 - 1.0) * amp) % 360.0


def generate_color(seed: float, i: int, amp: float,
                   sat_rng=(0.28, 0.72), val_rng=(0.36, 0.92)):
    """从父级色相散出第 i 个兄弟的颜色。

    三个分量各用各的无理数步长（黄金比 + R2 序列的两个常数），
    合起来是一条填得挺匀的三维低差异序列 —— 单靠一个步长的话
    所有颜色会挤在一条曲线上，21 个兄弟必然有两块撞在一起。
    """
    sat = _lohi(i, 0.7548776662, sat_rng[0], sat_rng[1])
    val = _lohi(i, 0.5698402910, val_rng[0], val_rng[1])
    return hsv_to_rgb(child_hue(seed, i, amp) / 360.0, sat, val)


def continent_color(name: str):
    return hsv_to_rgb(CONTINENT_HUE.get(name, 200) / 360.0, 0.36, 0.62)


#: 同一父级下的两个兄弟，RGB 距离小于这个数（0..441 的范围）就基本看不出区别
MIN_COLOR_DIST = 40.0


def _dist2(a, b) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2


def pick_color(seed: float, amp: float, placed: list, min_dist: float = MIN_COLOR_DIST):
    """在这个色相族里挑一个跟 ``placed`` 里已摆好的颜色都拉得开的颜色。

    顺着序列找第一个够远的；万一找遍了都没有（兄弟太多、色相带太窄），
    就扫一遍取**最远**的那个 —— 宁可挨得近一点，也不能撞成同一个颜色。
    """
    lim = min_dist * min_dist
    best, best_d = None, -1.0
    for k in range(900):
        c = generate_color(seed, k, amp)
        d = min((_dist2(c, p) for p in placed), default=float("inf"))
        if d >= lim:
            return c
        if d > best_d:
            best_d, best = d, c
    return best if best is not None else generate_color(seed, 0, amp)


# ------------------------------------------------------------------ 伪头衔

#: 这些类别**每块地单独一个节点**（可以一块块涂色），其余地形仍旧一类一个伪头衔。
SETTABLE_CATEGORIES = ("#wasteland",)


def build_special_titles(lists: dict[str, set[int]], n_prov: int, blank: np.ndarray,
                         base_index: int, categories=None, fine_tier: str = "pr",
                         name_sink: dict[str, str] | None = None):
    """给海/湖/荒地各造一个伪头衔；**荒地额外每块一个**。

    返回 (头衔列表, 全层共用的归属, 统计文字, 只占最细层的归属, 逐块荒地的地块号,
          逐块荒地的**真实节点号**)。

    :param categories: 默认用 EU4 那套；HOI4 只有海和湖，自己传一份。
    :param fine_tier: 逐块荒地落在哪一层（EU4 是 "pr" 省份层）。
        **得传进来**：TIER_ORDER 是 main() 里的局部变量，模块层的函数看不见它。
    :param name_sink: 伪头衔的中文名写进这个字典（调用方拼 titles.json 时用）。
    """
    assign = np.full(n_prov, -1, dtype=np.int64)
    fine_assign = np.full(n_prov, -1, dtype=np.int64)   # 只有"逐块荒地"会用到
    titles: list[Title] = []
    stats: list[str] = []
    waste_pids: list[int] = []
    waste_tids: list[int] = []   # 跟 waste_pids 一一对应：建一个节点记一个序号

    for key, label, rgb, source in (categories or SPECIAL_CATEGORIES):
        if source is None:
            cand = np.nonzero(blank & (assign < 0))[0]
        else:
            wanted = np.fromiter((p for p in lists.get(source, ()) if 0 < p < n_prov),
                                 dtype=np.int64)
            cand = wanted[blank[wanted] & (assign[wanted] < 0)] if wanted.size else wanted
        if cand.size == 0:
            continue
        # ① 共享的粗层伪头衔
        assign[cand] = base_index + len(titles)
        t = Title(key, tier="@")
        t.color = rgb
        titles.append(t)
        if name_sink is not None:
            name_sink[t.key] = label
        stats.append(f"{label} {cand.size}")
        # ② 荒地：每块地一个节点，只占最细那层
        if key in SETTABLE_CATEGORIES:
            for pid in cand.tolist():
                _tid = base_index + len(titles)   # 序号在建节点时记下，别事后反推
                fine_assign[pid] = _tid
                wt = Title(f"wl_{pid}", tier=fine_tier)
                wt.color = rgb
                titles.append(wt)
                waste_pids.append(int(pid))
                waste_tids.append(_tid)
            stats.append(f"→ 逐块 {len(cand)} 个")

    return titles, assign, stats, fine_assign, waste_pids, waste_tids


def largest_block_centre(pids, offsets, neigh, counts, pcx, pcy):
    """一堆省份里，**像素最多的那个连通块**的几何中心。

    一个国家/地区常常是好几个互不相连的色块（本土 + 一堆海外领地）。
    拿全部地盘求重心，法国本土加一个千里之外的小岛，名字就掉到大西洋里去了；
    所以先按省份邻接把地盘切成连通块，挑像素最多的那块，取它的重心。

    :returns: ``(x, y, 这块地的像素数)``，没有可用地盘就返回 None。
              像素数要给标注层当字号用 —— 名字写在伊比利亚，字号就得按伊比利亚算，
              按整个西班牙帝国算会撑得离谱。
    """
    if not pids:
        return None
    present = set(pids)
    parent = {p: p for p in pids}

    def find(x: int) -> int:
        r = x
        while parent[r] != r:
            r = parent[r]
        while parent[x] != r:
            parent[x], x = r, parent[x]
        return r

    for p in pids:
        for k in range(int(offsets[p]), int(offsets[p + 1])):
            q = int(neigh[k])
            if q in present:
                ra, rb = find(p), find(q)
                if ra != rb:
                    parent[ra] = rb

    blocks: dict[int, list[float]] = {}
    for p in pids:
        g = blocks.setdefault(find(p), [0.0, 0.0, 0.0])
        w = float(counts[p])
        g[0] += float(pcx[p]) * w
        g[1] += float(pcy[p]) * w
        g[2] += w
    best = max(blocks.values(), key=lambda g: g[2])
    if best[2] <= 0:
        return None
    return best[0] / best[2], best[1] / best[2], int(best[2])


# ------------------------------------------------------------------ 主流程

#: 构建缓存要用到的地图文件。``--mapdir`` 给了覆盖目录的话，一个一个文件地优先用它，
#: 它没带的（比如很多高清 mod 不重画 superregion.txt）就回退到游戏本体。
MAP_FILES = ("definition.csv", "area.txt", "region.txt", "superregion.txt",
             "continent.txt", "default.map", "provinces.bmp")


#: 三个年份视图。EU4 最早的剧本是 1444.11.11，另外两个是玩家最常说的两个节点。
#: 每一层就是一张"那年谁占了哪块地"的地图，取代原来的大洲/大区/区域三层。
ERA_DATES = ((1444, 11, 11), (1618, 1, 1), (1789, 7, 14))
ERA_LABELS = ("1444", "1618", "1789")

#: 顶部三层留几个给年份视图（后面两层固定是地区、省份）
ERA_TIERS = len(ERA_LABELS)


#: 有些 mod 的 definition.csv 把非 ASCII 名字损成了 U+FFFD 的 UTF-8 字节
#: （EF BF BD）—— 高清版里 Östergötland 就变成了 EF BF BD + "sterg" + EF BF BD + "tland"。
#: parse_definition 是按 latin-1 读的（字节保真），所以那三个字节在这里长这样。
_FFFD_BYTES = b"\xef\xbf\xbd".decode("latin-1")


def broken_name(nm: str) -> bool:
    """这个名字是不是被 mod 的工具有损转换弄坏了。"""
    return (not nm) or "\ufffd" in nm or _FFFD_BYTES in nm


class MapFiles:
    """按"覆盖目录优先、本体兜底"取地图文件。"""

    def __init__(self, game_map: Path, override: Path | None):
        self.game = game_map
        self.override = override
        self.used: dict[str, str] = {}

    def get(self, name: str) -> Path:
        if self.override:
            p = self.override / name
            if p.is_file():
                self.used[name] = "覆盖"
                return p
        self.used[name] = "本体"
        return self.game / name

    def from_override(self) -> list[str]:
        return [n for n, src in self.used.items() if src == "覆盖"]


def _label_zoom(tiers, era_n: int) -> list[int]:
    """每一层"标签从多大缩放开始出现"。

    年份层统一 18（一进去就该看见国名），非年份层从粗到细**等差**排到 110 ——
    写死一张表的话，以后加层就会缺值（缺值 = 那一层一个标签都不画 ✗）。
    """
    out = [18] * era_n
    rest = len(tiers) - era_n
    if rest > 0:
        out += [int(round(70 + (110 - 70) * (i / max(1, rest - 1)))) for i in range(rest)]
    return out


def main() -> int:
    global DATA
    ap = argparse.ArgumentParser(description="从 EU4 安装目录构建制地图编辑器所需的缓存")
    ap.add_argument("--eu4", help="EU4 安装根目录（含 map/ 与 localisation/）")
    ap.add_argument("--mapdir", help="换一套地图文件（高清 mod 的 map/ 目录）")
    ap.add_argument("--hanhua", help="汉化 mod 目录或 eu4_names_zh.json；none=不用中文")
    ap.add_argument("--workshop", help="workshop content 目录（自动找汉化用）")
    ap.add_argument("--out", help="缓存写到哪个目录，默认 data_eu4/")
    ap.add_argument("--no-history", action="store_true",
                    help="顶部三层退回大洲/大区/区域，不用 1444/1618/1800 三个年份视图")
    ap.add_argument("--label", default="EU4 原版", help="这套地图的显示名，写进 meta")
    args = ap.parse_args()

    # 顶部三层是什么，由 --no-history 决定
    use_eras = not args.no_history
    if use_eras:
        TIER_ORDER = tuple(ERA_LABELS) + ("rg", "ar", "pr")   # rg 区域：地区的上一级
        TIER_NAME = {**{y: y for y in ERA_LABELS}, "rg": "区域", "ar": "地区", "pr": "省份"}
        TIER_KEY = {**{y: y for y in ERA_LABELS}, "rg": "区域", "ar": "地区", "pr": "省"}
    else:
        TIER_ORDER, TIER_NAME, TIER_KEY = E.TIER_ORDER, E.TIER_NAME, E.TIER_KEY

    root = find_eu4(args.eu4)
    overlay = Path(args.mapdir).resolve() if args.mapdir else None
    if overlay and not overlay.is_dir():
        raise SystemExit(f"--mapdir 不是目录：{overlay}")
    MF = MapFiles(root / "map", overlay)
    MAP = MF.game                     # 兼容下面按 MAP 取文件的地方

    if args.out:
        DATA = Path(args.out).resolve()
    DATA.mkdir(parents=True, exist_ok=True)
    ver = eu4_version(root)
    log(f"EU4 {ver} @ {root}")
    if overlay:
        log(f"地图覆盖目录 {overlay}")
    log(f"输出目录 {DATA}")

    # 1. 省份定义
    defs = E.parse_definition(MF.get("definition.csv"))
    n_prov = max(defs) + 1
    log(f"definition.csv：{len(defs)} 个省份，最大 id {max(defs)}")
    # 本体那份，用来修覆盖目录里被弄坏的名字（见下面 prov_names）
    base_defs = E.parse_definition(MF.game / "definition.csv")

    # 2. 四张划表
    areas, area_colors = E.parse_areas(MF.get("area.txt"))
    regions = E.parse_regions(MF.get("region.txt"))
    supers = E.parse_superregions(MF.get("superregion.txt"))
    conts = E.parse_continents(MF.get("continent.txt"))
    log(f"area {len(areas)}（自带配色 {len(area_colors)}，空壳 {sum(1 for v in areas.values() if not v)}）"
        f" / region {len(regions)} / superregion {len(supers)} / continent {len(E.CONTINENTS)}")

    area_region: dict[str, str] = {}
    for rn, alist in regions.items():
        for an in alist:
            area_region.setdefault(an, rn)
    region_super: dict[str, str] = {}
    for sn, rlist in supers.items():
        for rn in rlist:
            region_super.setdefault(rn, sn)

    terrain = E.parse_map_lists(MF.get("default.map"),
                               ("sea_starts", "lakes", "only_used_for_random"))
    log("default.map：" + "，".join(f"{k} {len(v)}" for k, v in terrain.items()))

    # 3. 省份图 + 像素统计
    ids, w, h, counts, pcx, pcy = build_province_map(MF.get("provinces.bmp"), defs)
    if overlay:
        log(f"  这套图来自覆盖目录的文件：{ '、'.join(MF.from_override()) }")

    present = np.zeros(n_prov, dtype=bool)
    present[np.unique(ids)] = True
    present[0] = False

    def flag(idset) -> np.ndarray:
        a = np.zeros(n_prov, dtype=bool)
        v = np.fromiter((p for p in idset if 0 < p < n_prov), dtype=np.int64)
        if v.size:
            a[v] = True
        return a

    is_sea = flag(terrain.get("sea_starts", ()))
    is_lake = flag(terrain.get("lakes", ()))
    land = present & ~is_sea & ~is_lake
    log(f"地图上 {int(present.sum())} 个省份：陆地 {int(land.sum())}，"
        f"海 {int((is_sea & present).sum())}，湖 {int((is_lake & present).sum())}")

    # 4. 挂牌
    prov_area: dict[int, str] = {}
    for an, plist in areas.items():
        for pid in plist:
            if 0 < pid < n_prov and land[pid] and pid not in prov_area:
                prov_area[pid] = an          # 4648 在 durango_area 里写了两遍，取先出现的
    prov_cont: dict[int, str] = {}
    for cn in E.CONTINENTS:
        for pid in conts.get(cn, ()):
            if 0 < pid < n_prov and pid not in prov_cont:
                prov_cont[pid] = cn

    land_pids = [int(p) for p in np.nonzero(land)[0]]
    no_area = [p for p in land_pids if p not in prov_area]
    no_cont = [p for p in land_pids if p not in prov_cont]
    log(f"陆地里没归进任何地区的 {len(no_area)} 个 —— 这些就是 EU4 的不可通行荒地：")
    log("  " + "、".join(defs[p][3] for p in no_area))
    if no_cont:
        log(f"  ！有 {len(no_cont)} 个陆地省份查不到大洲：{no_cont[:10]}")

    # 5. 只保留在地图上真占着地的节点
    used_pr = [p for p in land_pids if p in prov_area]
    used_ar = {prov_area[p] for p in used_pr}
    used_rg = {area_region[a] for a in used_ar if a in area_region}
    used_sr = {region_super[r] for r in used_rg if r in region_super}
    used_ct = {prov_cont[p] for p in used_pr if p in prov_cont}

    # 6. 三个年份的归属。海/湖/荒地的历史里没有 owner（它们本来就不是谁的领地），
    #    所以只按"陆地上有地区"的省份去查。
    owners: list[dict[int, str]] = []
    if use_eras:
        hist = EH.load_province_history(root / "history" / "provinces")
        log(f"省份归属历史：{len(hist)} 个省有记录")
        for d, y in zip(ERA_DATES, ERA_LABELS):
            arr: dict[int, str] = {}
            for p in used_pr:
                base, tl = hist.get(p, (None, []))
                o = EH.owner_at(base, tl, d)
                if o:
                    arr[p] = o
            # 需求：**1789 那层把西藏并入中国**（当时西藏在清朝治下）。
            # 只动这一层，别的年份照历史来 —— 数据上就是把这些省的 owner 换掉。
            if y == "1789":
                has_cn = [t2 for t2 in ("QNG", "MNG", "CHI") if t2 in set(arr.values())]
                cn = has_cn[0] if has_cn else "QNG"
                # EU4 里西藏的 tag 是 **UTS**（名字就叫「藏」），不是 TIB —— TIB 一起收着以防版本差异
                moved = [p for p, t2 in arr.items() if t2 in ("UTS", "TIB")]
                for p in moved:
                    arr[p] = cn
                log(f"    （西藏 {len(moved)} 省并入中国 {cn}）")
            owners.append(arr)
            log(f"  {y}：有主 {len(arr)} 省 / {len(set(arr.values()))} 个国家")
    else:
        log(f"用得上的节点：大洲 {len(used_ct)} / 大区 {len(used_sr)} / 区域 {len(used_rg)}"
            f" / 地区 {len(used_ar)} / 省份 {len(used_pr)}")
    log(f"  没进树的：{len(areas) - len(used_ar)} 个地区（海洋区域 + 空壳）"
        + ("" if use_eras else f"、{len(regions) - len(used_rg)} 个区域、"
           f"{len(supers) - len(used_sr)} 个大区"))

    # 6. 大区 → 大洲：EU4的大洲直接挂省份，所以按成员的省份投票定父级
    prov_super: dict[int, str] = {}
    for p in used_pr:
        rn = area_region.get(prov_area[p])
        sn = region_super.get(rn) if rn else None
        if sn:
            prov_super[p] = sn

    tally: dict[str, dict[str, int]] = {sn: {} for sn in used_sr}
    for p, sn in prov_super.items():
        cn = prov_cont.get(p)
        if cn:
            tally[sn][cn] = tally[sn].get(cn, 0) + 1
    sup_cont: dict[str, str] = {}
    split_super: list[str] = []
    for sn in sorted(tally):
        d = tally[sn]
        if not d:
            continue
        sup_cont[sn] = max(sorted(d), key=lambda k: d[k])
        if len(d) > 1:
            split_super.append(sn)
    if split_super and not use_eras:
        log(f"  跨洲的大区 {len(split_super)} 个（父级取成员多数）："
            + "、".join(split_super))

    # 7. 组树 + 配色。父级都建好了再建子级，保证 add 的顺序是从上到下
    ordered: list[Node] = []
    index_of: dict[str, int] = {}
    hue_of: dict[str, float] = {}

    def add(t: Node) -> Node:
        index_of[t.key] = len(ordered)
        ordered.append(t)
        return t

    if use_eras:
        # 三个年份视图：每层就是一张归属地图。同一个国家在三个年份算**三个节点**
        # —— 共用一个的话，涂 1444 的瑞典会连带把 1618、1800 的瑞典也涂了，
        # 因为涂色刷的是"这个头衔在它那一层的地盘"，一个节点只能属于一层。
        tag_colors = EH.parse_country_colors(root, EH.parse_country_tags(root))
        n_era = 0
        for i, year in enumerate(ERA_LABELS):
            for tag in sorted(set(owners[i].values())):
                t = add(Node(f"{year}_{tag}", year))
                t.color = tag_colors.get(tag) or (128, 128, 128)
                n_era += 1
        log(f"三个年份共 {n_era} 个国家节点（配色取 common/countries 的国旗色）")
        # 地区配色还是按"区域"分家族，只是区域本身不再单独成层
        # ① 区域名先按黄金角撒开 —— 它就是**地区层**的家族基色（786 行查的就是它）
        for i, rn in enumerate(sorted(used_rg)):
            hue_of[rn] = (i * 137.508) % 360.0
        # ② 大区名单独撒一份：区域家族按大区分组，查的是**大区名**，
        #    上面那把种子里没有大区键，不撒的话全族都从 200 起步挤一个色相带
        sup_hue = {sn: (i * 137.508) % 360.0
                   for i, sn in enumerate(sorted({region_super.get(rn, "") for rn in used_rg}))}
        # **区域节点照样要建**（它是地区的上一级）：不建的话点进那一层一片空白 ✗
        groups = {}
        for rn in sorted(used_rg):
            groups.setdefault(region_super.get(rn, ""), []).append(rn)
        for parent, kids in sorted(groups.items()):
            base = sup_hue.get(parent, 200)
            placed: list = []
            for i, rn in enumerate(kids):
                col = pick_color(base, 46.0, placed)
                placed.append(col)
                t = add(Node(rn, "rg"))
                t.parent = parent or None
                t.color = col
                # 别把 ① 撒好的区域种子覆盖掉 —— 那是地区层的家族基色，
                # 覆盖成 child_hue(200 基) 会把整片拉回一个色相带
    else:
        # --no-history：没有年份层就没有国家节点，countryTags 只能空着
        #（不赋值的话拼 meta 时 NameError，整个构建在最后一步报废）
        tag_colors = {}
        for cn in sorted(used_ct):
            t = add(Node(cn, "ct"))
            t.color = continent_color(cn)

        # 大区：同一大洲的兄弟散开
        groups: dict[str, list[str]] = {}
        for sn in sorted(used_sr):
            groups.setdefault(sup_cont.get(sn, ""), []).append(sn)
        for parent, kids in sorted(groups.items()):
            base = CONTINENT_HUE.get(parent, 200)
            placed: list = []
            for i, sn in enumerate(kids):
                col = pick_color(base, 90.0, placed)
                placed.append(col)
                t = add(Node(sn, "sr"))
                t.parent = parent or None
                t.color = col
                hue_of[sn] = child_hue(base, i, 90.0)

        # 区域：同一大区里的兄弟散开
        groups = {}
        for rn in sorted(used_rg):
            groups.setdefault(region_super.get(rn, ""), []).append(rn)
        for parent, kids in sorted(groups.items()):
            base = hue_of.get(parent, CONTINENT_HUE.get(sup_cont.get(parent, ""), 200))
            placed = []
            for i, rn in enumerate(kids):
                col = pick_color(base, 46.0, placed)
                placed.append(col)
                t = add(Node(rn, "rg"))
                t.parent = parent or None
                t.color = col
                hue_of[rn] = child_hue(base, i, 46.0)

    # 地区：同一区域里的兄弟散开。这 50 个有官方色的直接用官方的，
    # 但先摆进去，好让生成的那些绕开它
    official = 0
    groups = {}
    for an in sorted(used_ar):
        groups.setdefault(area_region.get(an, ""), []).append(an)
    for parent, kids in sorted(groups.items()):
        base = hue_of.get(parent, 200)
        placed = [area_colors[an] for an in kids if an in area_colors]
        official += len(placed)
        for an in kids:
            col = area_colors.get(an)
            if col is None:
                col = pick_color(base, 66.0, placed)
                placed.append(col)
            t = add(Node(an, "ar"))
            t.parent = parent or None
            t.color = col

    # 省份：颜色就用 definition.csv 的
    for p in sorted(used_pr):
        t = add(Node(prov_key(p), "pr", p))
        t.parent = prov_area[p]
        t.color = defs[p][:3]

    n_real = len(ordered)
    log(f"真头衔 {n_real} 个（其中地区用官方配色 {official} 个，其余 {n_real - official - len(used_pr)} 个是生成的）")

    # 8. 归属表：每个省份、每个层级分别属于谁
    titlemap = np.full((len(TIER_ORDER), n_prov), NO_TITLE, dtype=np.uint16)
    missing_chain = 0
    for p in used_pr:
        titlemap[len(TIER_ORDER) - 1, p] = index_of[prov_key(p)]   # 省份（最细一层）
        an = prov_area[p]
        titlemap[len(TIER_ORDER) - 2, p] = index_of[an]            # 地区
        # **区域**（地区的上一级）：按名字取行号，加层也不会错位 ✓
        if "rg" in TIER_ORDER:
            rn2 = area_region.get(an)
            if rn2 and rn2 in index_of:
                titlemap[TIER_ORDER.index("rg"), p] = index_of[rn2]
        if use_eras:
            for i, year in enumerate(ERA_LABELS):
                tag = owners[i].get(p)
                if tag:
                    k = f"{year}_{tag}"
                    if k in index_of:
                        titlemap[i, p] = index_of[k]
        else:
            rn = area_region.get(an)
            if rn and rn in index_of:
                titlemap[2, p] = index_of[rn]
                sn = region_super.get(rn)
                if sn and sn in index_of:
                    titlemap[1, p] = index_of[sn]
            else:
                missing_chain += 1
            cn = prov_cont.get(p)
            if cn and cn in index_of:
                titlemap[0, p] = index_of[cn]
    if missing_chain:
        log(f"  {missing_chain} 个省份的地区没挂到区域上，中间那层留空")

    # 9. 海/湖/荒地
    blank = np.all(titlemap == NO_TITLE, axis=0) & present
    log(f"完全没有归属的地块：{int(blank.sum())} 个")
    _special_names: dict[str, str] = {}
    special, assign, stats, fine_assign, waste_pids, waste_tids = build_special_titles(
        terrain, n_prov, blank, n_real, fine_tier=TIER_ORDER[-1],
        name_sink=_special_names,
        )
    # 逐块荒地的名字：从同名省份借（Title 有 __slots__，加不了新属性）
    log("地形类别：" + ("，".join(stats) if stats else "无"))
    sel = assign >= 0
    if sel.any():
        vals = assign[sel].astype(np.uint16)
        for r in range(len(TIER_ORDER)):
            titlemap[r, sel] = vals
    # 逐块荒地**只盖最细那层**（粗层照旧是那块共享的灰）
    sel2 = fine_assign >= 0
    if sel2.any():
        titlemap[len(TIER_ORDER) - 1, sel2] = fine_assign[sel2].astype(np.uint16)
    left = int(np.count_nonzero((titlemap[0] == NO_TITLE) & present))
    log(f"有像素但仍是空白的格子：{left}")

    # 荒地节点序号（建节点时记下的真实序号）+ 那两个共享伪头衔
    #（前端"荒漠·涂色"关着时它们要显示灰）
    waste_tid_of = dict(zip(waste_pids, waste_tids))
    water_tids = set()
    for k, sp in enumerate(special):
        if sp.key in ("#sea", "#lake"):
            water_tids.add(n_real + k)
        if sp.key in SETTABLE_CATEGORIES:
            waste_tids.append(n_real + k)

    # ---- 荒地自动上色：分母是**整条陆地周长**（无主地也算），严格过半 ----
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
        edge_tot: dict[int, int] = {}
        for k_, c_ in pair_cnt.items():
            wp, nb = k_ >> 16, k_ & 0xFFFF
            t_nb = int(titlemap[0, nb])
            if t_nb in water_tids:
                continue
            edge_tot[wp] = edge_tot.get(wp, 0) + c_
            if t_nb >= n_real:
                continue
            d = per_waste.setdefault(wp, {})
            d[t_nb] = d.get(t_nb, 0) + c_
        for wp, d in per_waste.items():
            tot = edge_tot.get(wp, 0)
            if not tot:
                continue
            best = max(d.items(), key=lambda kv: kv[1])
            if best[1] * 2 > tot:
                waste_auto.append([int(wp), int(best[0])])
        log(f"荒地自动上色：{len(waste_auto)}/{len(waste_pids)} 块有主（边缘过半）")

    ordered_all = ordered + special
    n_all = len(ordered_all)

    # 10. 每个头衔的成员省份 → 地盘数、像素面积
    members: list[list[int]] = [[] for _ in range(n_all)]
    for r in range(len(TIER_ORDER)):
        row = titlemap[r]
        for p in np.nonzero((row != NO_TITLE) & present)[0]:
            tid = int(row[p])
            # 伪头衔（海/湖/荒地）在 5 个层级里写着同一个序号，
            # 每层都数一遍会把它虚高成 5 倍，只在第一层数。
            if tid >= n_real and r > 0:
                continue
            members[tid].append(int(p))
    prov_count = [len(m) for m in members]
    area = np.zeros(n_all, dtype=np.int64)
    for i, m in enumerate(members):
        if m:
            area[i] = int(counts[np.fromiter(m, dtype=np.int64)].sum())
    # 逐块荒地节点只写在最细一层，上面的循环把 r>0 的伪头衔全跳过了 ——
    # 它们的 provCount/area 恒 0（CK3 那边修过的同一个坑，EU4 漏了）。
    # 按"一个节点一块地"补上，标签层按面积排序才有它的份。
    for pid in waste_pids:
        idx = waste_tid_of[pid]
        prov_count[idx] = 1
        area[idx] = int(counts[pid])

    # 11. 标注位置：取**像素最多的那一块地**的几何中心（见 largest_block_centre）
    #
    # 邻接表在这里先算出来 —— 下面导 adjacency.bin 用的也是它，只算一次。
    adj = build_adjacency(ids, n_prov)
    offsets = np.frombuffer(adj, dtype=np.uint32, count=n_prov + 1)
    neigh = np.frombuffer(adj, dtype=np.uint16, offset=(n_prov + 1) * 4)

    lx = np.full(n_all, np.nan, dtype=np.float32)
    ly = np.full(n_all, np.nan, dtype=np.float32)
    block_area = np.zeros(n_all, dtype=np.int64)     # 名字所在那块地的像素数（当字号用）
    for i, m in enumerate(members):
        c = largest_block_centre(m, offsets, neigh, counts, pcx, pcy)
        if c is not None:
            lx[i], ly[i] = c[0], c[1]
            block_area[i] = c[2]
    log("标注位置：每块地取像素最多的那个连通块的重心")
    # 伪头衔不上地名（海/湖/荒地只是一层底图），跟 CK3 那边一样留空
    lx[n_real:] = np.nan
    ly[n_real:] = np.nan
    gx, gy = lx.copy(), ly.copy()

    # 12. 名字：中文优先，其次游戏自带的英文，再退回 definition.csv / key
    LOC = root / "localisation"
    want = {f"PROV{p}" for p in used_pr} | used_ar
    if use_eras:
        want |= {tag for arr in owners for tag in arr.values()}
    else:
        want |= used_rg | used_sr | used_ct
    en = E.parse_localisation_files(
        [LOC / "prov_names_l_english.yml", LOC / "areas_regions_l_english.yml",
         LOC / "regions_phase4_l_english.yml", LOC / "text_l_english.yml",
         LOC / "countries_l_english.yml"], want)
    zh, zh_from = load_hanhua(args.hanhua, args.workshop)
    log(f"名字：汉化 {len(zh)} 条（{zh_from}） / 游戏英文 {len(en)} 条")

    special_names = {k: label for k, label, _c, _s in SPECIAL_CATEGORIES}
    special_names.update(_special_names)   # 伪头衔的中文名（name_sink 带出来的）✓
    # 组名给的是原始键（baltic_area 这类）→ 用汉化/英文查一遍，再退到 humanize ✓
    for _k, _v in list(special_names.items()):
        if _v.endswith("_area") or "_" in _v:
            _z = zh.get(_v)
            _e = en.get(_v)
            if _z or _e:
                special_names[_k] = _z or _e
            elif _v.endswith("_area"):
                special_names[_k] = E.humanize(_v)
    from_key = 0
    zh_used = 0
    resolved: list[str] = []
    names_en: list[str] = []          # 留给搜索：中文名显示，英文名也搜得到
    for t in ordered_all:
        if t.key in special_names:
            resolved.append(special_names[t.key])
            names_en.append("")
            continue
        # 本地化的 key：省份是 PROV<id>，年份节点是里面的国家 tag，别处就是 key 自己
        if t.tier == "pr":
            ek = f"PROV{getattr(t, 'pid', 0)}"
        elif use_eras and t.tier in ERA_LABELS:
            ek = t.key.split("_", 1)[1]           # 1444_SWE → SWE
        elif t.key.startswith("wl_") and t.key[3:].isdigit():
            ek = f"PROV{t.key[3:]}"               # 逐块荒地：省份号就在 key 里
            #（这些节点是 CK3 的 Title，没有 pid 属性可挂，得从 key 里拿）
        else:
            ek = t.key
        e = en.get(ek) or (defs.get(getattr(t, "pid", 0), (0, 0, 0, ""))[3]
                               if t.tier == "pr" and getattr(t, "pid", 0) else "")
        z = zh.get(ek)
        if z:
            zh_used += 1
        nm = z or e
        if not nm:
            nm = E.humanize(t.key)
            if t.tier in TIER_ORDER:
                from_key += 1
        resolved.append(nm)
        names_en.append(e if e and e != nm else "")
    log(f"  {zh_used} 个用了中文名，{from_key} 个只能从 key 收拾出来")

    # 13. 颜色表
    colors = np.zeros((n_all, 3), dtype=np.uint8)
    for i, t in enumerate(ordered_all):
        c = t.color
        if c is None:
            p = index_of.get(t.parent) if t.parent else None
            c = colors[p] if p is not None else (128, 128, 128)
        colors[i] = c

    # 14. 写盘
    log("写出缓存 …")
    raw = titlemap.tobytes()
    packed = zlib.compress(raw, 9)
    (DATA / "titlemap.bin").write_bytes(packed)
    log(f"  titlemap.bin  {len(raw) / 1024:.0f} KB → {len(packed) / 1024:.0f} KB")

    prov_names = [""] * n_prov
    name_fixed = 0
    for pid, (_r, _g, _b, nm) in defs.items():
        if pid >= n_prov:
            continue
        # 高清 mod 的 definition.csv 把非 ASCII 名字转坏了（Östergötland →
        # \uFFFDsterg\uFFFDtland），拿本体的名字补回来 —— 不然导出时会把这个
        # 坏名字写进 mod 的 definition.csv
        if broken_name(nm):
            b = base_defs.get(pid)
            if b and not broken_name(b[3]):
                nm, name_fixed = b[3], name_fixed + 1
        prov_names[pid] = nm
    if name_fixed:
        log(f"  修好 {name_fixed} 个被弄坏的省份名（用本体的 definition.csv）")

    # 每个省份在 definition.csv 里的原色。导出 provinces.bmp 时要拿它当底 ——
    # 省份层的头衔颜色对不上海/湖/荒地（那些是伪头衔，一整类共用一个颜色），
    # 直接拿头衔色写进图里会让整片海变成一个颜色。
    prov_colors = [[0, 0, 0]] * n_prov
    for pid, (r, g, b, _nm) in defs.items():
        if pid < n_prov:
            prov_colors[pid] = [r, g, b]

    def read_country_capitals(root: Path) -> dict:
        """每个国家的首都省号 → {tag: pid}
        来源：history/countries/<TAG> - <Name>.txt 里的 capital = <省号>
        （app 读 meta.capitals：键取头衔键里 tag 那一段，值用省份号）"""
        out = {}
        d = root / "history" / "countries"
        if not d.is_dir():
            return out
        for f in sorted(d.glob("*.txt")):
            tag = f.name.split(" - ")[0].strip().upper()
            if not re.fullmatch(r"[A-Z0-9]{3}", tag):
                continue
            try:
                txt = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            m = re.search(r"^\s*capital\s*=\s*(\d+)", txt, re.M)
            if m:
                out[tag] = int(m.group(1))
        return out


    meta = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "game": "eu4",
        "gameVersion": ver,
        "gameRoot": str(root),
        "label": args.label,
        "provinceMap": MF.get("provinces.bmp").name,
        "mapOverlay": str(overlay) if overlay else "",
        "nameLang": "zh" if zh_used > len(ordered) * 0.5 else "en",
        "hanhua": zh_from,
        "hanhuaUsed": zh_used,           # 树里有多少个真节点拿到了中文名
        "mapWidth": w,
        "mapHeight": h,
        "numProvinces": n_prov,
        "numTitles": n_all,
        "numRealTitles": n_real,
        "tiers": list(TIER_ORDER),
        "tierNames": [TIER_NAME[t] for t in TIER_ORDER],
        "tierKeys": [TIER_KEY[t] for t in TIER_ORDER],
        "entity": "省份",
        # 年份模式 6 层，省份 = ERA_TIERS+2；非年份模式只有 5 层，取最后一层
        "defaultTier": (ERA_TIERS + 2) if use_eras else (len(TIER_ORDER) - 1),
        # 年份那三层节点少（几百个国家）、彼此还挤在一起，门槛比大洲那套高一点
        # **全部 tag** 的名字 + 颜色（含当前年代没地盘的）—— 搜索/取色要用 ✓
        # 名字先放 tag —— 中文名由 patch_wasteland 从 titles.json 里统一补 ✓
        "countryTags": {tag: {"n": tag, "c": list(col)}
                        for tag, col in sorted(tag_colors.items())},
        "labelZoom": _label_zoom(TIER_ORDER, ERA_TIERS) if use_eras else [5, 10, 20, 70, 110],
        # 三个年份视图是什么时候的地图（空 = 用的是大洲/大区/区域那套）
        "eraDates": [f"{y}.{m}.{d}" for (y, m, d) in ERA_DATES] if use_eras else [],
        "noTitle": NO_TITLE,
        "specialPrefix": "#",
        "colorLutWidth": 256,
        # 荒地：哪些节点算荒地 + 逐块的自动归属（口径同 EU5/CK3）
        "wasteland": sorted(set(waste_tids)),
        "wastelandAuto": waste_auto,
        # 区域/大区/大洲在 EU4 里没有配色，是编辑器按层级散出来的
        "generatedColors": n_real - len(used_pr) - official,
        "officialAreaColors": official,
        # 跨洲的大区（近东、波斯这种横跨欧亚的），父级按成员多数投票
        "splitSuperregions": split_super,
        "lockedKinds": [k for k, *_ in SPECIAL_CATEGORIES],
        "landProvinces": int(land.sum()),
        "noAreaProvinces": no_area,       # 不可通行荒地，编辑器不当作领地
        "droppedSeaTitles": (len(areas) - len(used_ar)) + (len(regions) - len(used_rg))
                           + (len(supers) - len(used_sr)),
    }
    meta["capitals"] = read_country_capitals(root)
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                    encoding="utf-8")

    payload = {
        "keys": [t.key for t in ordered_all],
        "tiers": [TIER_ORDER.index(t.tier) if t.tier in TIER_ORDER else len(TIER_ORDER)
                  for t in ordered_all],
        "parents": [index_of.get(t.parent, -1) if t.parent else -1 for t in ordered_all],
        "names": resolved,
        "namesEn": names_en,
        "colors": [[int(c[0]), int(c[1]), int(c[2])] for c in colors],
        "provCount": prov_count,
        "area": area.tolist(),
        "blockArea": block_area.tolist(),
        "lx": [None if np.isnan(v) else round(float(v), 1) for v in lx],
        "ly": [None if np.isnan(v) else round(float(v), 1) for v in ly],
        "gx": [None if np.isnan(v) else round(float(v), 1) for v in gx],
        "gy": [None if np.isnan(v) else round(float(v), 1) for v in gy],
        "provinceNames": prov_names,
        "provinceNamesEn": prov_names,   # 汉化前的原版名：definition.csv 是 cp1252，导出 mod 时中文写不进就用它
        "provinceColors": prov_colors,
    }
    (DATA / "titles.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"  titles.json  {(DATA / 'titles.json').stat().st_size / 1048576:.1f} MB")
    # 名字汉化（并进构建了）✓
    try:
        import nametools
        # ① 省份名是按地块号查的（PROV<id>）
        _tj = json.loads((DATA / "titles.json").read_text(encoding="utf-8"))
        _pn = _tj.get("provinceNames") or []
        _n = 0
        for _pid in range(1, len(_pn)):
            _v = zh.get(f"PROV{_pid}")
            if _v and not (_pn[_pid] and nametools.HAS_ZH.search(str(_pn[_pid]))):
                _pn[_pid] = _v
                _n += 1
        _tj["provinceNames"] = _pn
        (DATA / "titles.json").write_text(
            json.dumps(_tj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        # ② 节点名走通用匹配（去键名 / 英文反查 / 前缀模糊）
        _hit, _left = nametools.localize_names(DATA / "titles.json", [LOC])
        log(f"  名字汉化：省名 {_n} 个，节点名换掉 {_hit} 个，仍非中文 {_left} 个")
    except Exception as _e:
        log(f"  名字汉化跳过：{_e}")


    log("导出省份 id 图 …")
    ids_out = zlib.compress(ids.tobytes(), 6)
    (DATA / "provinces_id.bin").write_bytes(ids_out)
    log(f"  provinces_id.bin  {ids.nbytes / 1048576:.1f} MB → {len(ids_out) / 1048576:.1f} MB")

    log("导出省份邻接表和质心 …")
    (DATA / "adjacency.bin").write_bytes(zlib.compress(adj, 6))
    pos_arr = np.stack([pcx, pcy, counts.astype(np.float64)], axis=1).astype(np.float32)
    (DATA / "prov_pos.bin").write_bytes(zlib.compress(pos_arr.tobytes(), 6))
    log(f"  adjacency.bin {(DATA / 'adjacency.bin').stat().st_size / 1024:.0f} KB"
        f" / prov_pos.bin {(DATA / 'prov_pos.bin').stat().st_size / 1024:.0f} KB")
    log("全部完成 ✔")

    # 荒地的事后加工（幂等）：每层都指向它自己 / 周长表 / 按层归属 / 名字 / 隐藏地名
    from patch_wasteland import patch as _patch_waste
    _patch_waste(DATA)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
