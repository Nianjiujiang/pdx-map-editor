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
import base64
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

from build_data import (NO_TITLE, build_adjacency, build_province_map, log)
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


# 🔴 **2026-10-19：这里原来有个 `_fix_waste_names`，已删** ✗✗
#
#   它是在**产物上**把 `wl_<省号>` 的名字按 `waste_names` 重写一遍，
#   用来擦掉"图上荒地显示成 `#大泽山` / `Eastern Daba Mountains`"那个毛病 ✓
#   加它的人自己也写了"追了七八轮没定位到真凶"✓
#
#   **真凶现在找到了**（三条，都在上游）：
#     ① `definition.csv` 的中文写在 `#` 后面（第 5 列 / 第 6 列两种位置 ✓
#        ` #大泽山` / `Ravenburg;x #拉文斯堡`）→ 见 parsers/eu4/parser.py 的
#        `_pick_def_name` ✓ 原来整列照抄，于是名字里带井号、或者只剩英文 ✓
#     ② `patch_wasteland.py` 的 eu4 那支拿 `provinceNames[pid]` **覆盖**节点名 ✗
#        —— 荒地块不在省份层，那一格常常只有英文（`Vistula Lagoon`）✓
#        一覆盖就把构建期写好的中文盖掉了 ✓ 现在"已经是中文就让开"✓
#     ③ `build_tier_pieces.py` 里逐块荒地的 `name_sink` 值带 `#` 前缀
#        （`label` 是 `#wasteland` 那种 ✓）→ 已 lstrip ✓
#
#   → 源头三条都修完之后，两处补丁都成了空转（实测"改名 0 个"✓）
#     产物逐字段比对：只有 6 个名字不同，而且**新的更对**
#     （`wl_3737` 从类名兜底"不可通行荒地"变成真名"吉尔巴吉"✓）
#     所以这里连函数一起删掉，不留"为什么要有这一步"的疑问 ✓



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
                         geo_tiers=None, tier_names=None, waste_names=None,
                         skip_fine_tier: bool = False, script_tiers=None,
                         name_sink: dict[str, str] | None = None):
    """给海/湖/荒地各造伪头衔 —— **每一层给该层自己的片**（2026-10-13 统一 ✓）。

    返回 (头衔列表, ``{层名: 该层逐地块的归属数组}``, 统计文字,
          逐块荒地的地块号, 逐块荒地的**真实节点号**)。

    ⚠ **签名必须跟函数体、跟调用方一致** ✗（2026-10-13 补）
      架构统一那轮改了函数体（用上 `geo_tiers` / `tier_names` / `waste_names` ✓）
      也改了调用方（那几个参数都传了 ✓），**唯独签名没跟上** ✗ ——
      于是 `TypeError: got an unexpected keyword argument 'geo_tiers'` ✓ 整个构建直接崩 ✓
      （`build_data.py` 里那个同名包装是好的 ✓ 断的是 **`build_eu4.py` 这个本地副本** ✓
        —— 它遮蔽了 import 进来的那个 ✗）

    :param categories: 默认用 EU4 那套；HOI4 / VIC3 只有海和湖，自己传一份。
    :param fine_tier: 最细那一层（逐块荒地落在它上面 ✓）
    :param geo_tiers: 要分片的**地理**层（粗 → 细 ✓）；剧本层不算 ✓
                      ⚠ 缺省时退回 ``[fine_tier]``（只有一个片、等于旧行为 ✓ 不会炸 ✓）
    :param tier_names: ``{层名: {地块号: 名字}}`` —— 那一层的水名表 ✓
                      （`parsers/<游戏>/parser.py` 的 `load_water_names_by_tier` ✓
                        不另编解析 ✓）；某层没有就给 ``{}``（那一层整片一片 ✓）
    :param waste_names: ``{地块号: 荒地名}`` —— 荒地只有一张表（游戏里就一张 ✓）
    :param skip_fine_tier: **最细那层不造片** ✗（2026-10-14 ✓ 用户要求 ✓）
        水域的最细层就是它自己那个 province ✓（"最底层的单位也有自己的 Province id"✓）
        而**粗层照造** ✓ —— 用户："和陆地一样啊，**大名，河北，华北**，这样下来"✓
        ⚠ 荒地 / 不可通行**不受影响** ✗ —— 它们走 `settable` 那条逐块路 ✓
    :param name_sink: 伪头衔的中文名写进这个字典（调用方拼 titles.json 时用）。

    实现全在 ``build_tier_pieces`` 里 ✓（CK3 跟这几个游戏共用同一份 ✓）
    """
    from build_tier_pieces import build_special_titles as _impl    # noqa: PLC0415
    cats = [(key, label, rgb, ([source] if source else None))
            for key, label, rgb, source in (categories or SPECIAL_CATEGORIES)]
    return _impl(lists, cats, n_prov, blank, base_index,
                 list(geo_tiers or [fine_tier]),
                 tier_names=tier_names, waste_names=waste_names,
                 settable=SETTABLE_CATEGORIES, skip_fine_tier=skip_fine_tier,
                 script_tiers=script_tiers, name_sink=name_sink)


def largest_block_centre(pids, offsets, neigh, counts, pcx, pcy, map_w=None):
    """一堆省份里，**像素最多的那个连通块**的几何中心。

    一个国家/地区常常是好几个互不相连的色块（本土 + 一堆海外领地）。
    拿全部地盘求重心，法国本土加一个千里之外的小岛，名字就掉到大西洋里去了；
    所以先按省份邻接把地盘切成连通块，挑像素最多的那块，取它的重心。

    🔴 **跨接缝的块：x 走"展开坐标"** ✗✗（2026-10-15 ✓ 用户实测抓的 ✓）
      用户报的："**北太平洋**的名字怎么还是在地图正中央呢？" ✓
      成因：太平洋那种水域在**最左和最右**各有一半 ✓ 而地图是**横向环绕**的 ——
        邻接表把左右边缘算成邻居 ✓ → 两半被判成**同一块** ✓
        可重心那一步是**算术平均** ✗ → 左右一平均正好落回**地图正中** ✗✗
      → 把像素沿 x 平移到"**离参考点最近的那一份**"（展开坐标 ✓
        `x + map_w * floor((ref - x)/map_w + 0.5)` ✓ 参考点 = 块里权重最大的那个 ✓），
        在展开坐标里取算术平均 ✓ 最后 `% map_w` 绕回 [0, map_w) ✓
      → 落点回到**它自己那半边**（左或右都行 ✓）绝不再落中间 ✓
      ⚠ **只有真跨接缝的块**（块内 x 跨度 > 半图宽 ✓）才走这条路 ✗ ——
        不跨接缝的块：**一个字都不动** ✓（回归判据 = 结果必须一模一样 ✓）

    :param map_w: **地图宽** ✓。不给（None ✓）= 老行为，算术平均一个字不变 ✓
                  （CK3 / EU4 / HOI4 / VIC3 现在都不传 ✓ 它们下次要修再传 ✓）
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
    #: 每个块里各 pid 的 (x, 权重) —— **只在给了 map_w、且那个块真跨接缝时才用** ✓
    #  （老调用（map_w=None）连这个字典都不建 ✓ 零开销 ✓）
    bx: dict[int, list] = {}
    for p in pids:
        _r = find(p)
        g = blocks.setdefault(_r, [0.0, 0.0, 0.0])
        w = float(counts[p])
        g[0] += float(pcx[p]) * w
        g[1] += float(pcy[p]) * w
        g[2] += w
        if map_w:
            bx.setdefault(_r, []).append((float(pcx[p]), w))
    _broot = max(blocks, key=lambda r: blocks[r][2])
    best = blocks[_broot]
    if best[2] <= 0:
        return None
    cx = best[0] / best[2]
    if map_w and map_w > 0:
        xs = bx.get(_broot) or []
        if xs:
            lo = min(x for x, _ in xs)
            hi = max(x for x, _ in xs)
            if hi - lo > map_w * 0.5:                     # **真跨接缝** ✓ 才动 ✗
                import math                                # 局部导入：老路径不碰它 ✓
                ref = max(xs, key=lambda t: t[1])[0]        # 参考点 = 块里权重最大的那个 ✓
                sx2 = sw2 = 0.0
                for x, w in xs:
                    # 平移到"离参考点最近的那一份"（展开坐标 ✓）
                    xx = x + map_w * math.floor((ref - x) / map_w + 0.5)
                    sx2 += xx * w
                    sw2 += w
                if sw2 > 0:
                    cx = (sx2 / sw2) % map_w                # 绕回 [0, map_w) ✓
    return cx, best[1] / best[2], int(best[2])


def largest_block_members(pids, offsets, neigh, counts):
    """**最大那块连通域里有哪些省** —— 跟 `largest_block_centre` 同一套并查集 ✓
    （2026-10-13 加 ✓ 起因见下面那段）

    🔴 为什么必须有它：**名字只画在最大那块上** ✗
      落点 `lx/ly` 是"最大连通域的重心"✓（见 build_data 里那段注释 ✓）
      字号也按"最大那块"算 ✓（见 `largest_block_centre` 的说明 ✓）
      **可主轴 / 折线却拿了全部领地** ✗ —— 一个跨海的公国（本土 + 海外领地 ✓）
      折线就从本土拉到海外 ✓ 算出来的"方向"跟名字压根不在一条线上 ✓
      → 所以算形状时必须**先切出最大那块**，只用它的地块 ✓

    ⚠ 这不是"国家领地割裂所以主轴没意义"✗ ——
      是**算错了对象** ✓ 名字只画一块，形状就该按那一块算 ✓
      （用户 2026-10-13 一句话点破的 ✓："如果领地真的割裂，那原本的规则就是
        每个连通域显示一个，换言之就是你的计算有问题" ✓ 一针见血 ✓）

    :returns: 最大那块的省列表（已排序 ✓）；没有可用地盘就返回 ``[]`` ✓
    """
    if not pids:
        return []
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

    blocks: dict[int, list[int]] = {}
    for p in pids:
        blocks.setdefault(find(p), []).append(int(p))
    best = max(blocks.values(), key=lambda ps: sum(float(counts[p]) for p in ps))
    return sorted(best)


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
    global DATA, ERA_DATES, ERA_LABELS, ERA_TIERS
    ap = argparse.ArgumentParser(description="从 EU4 安装目录构建制地图编辑器所需的缓存")
    ap.add_argument("--eu4", help="EU4 安装根目录（含 map/ 与 localisation/）")
    ap.add_argument("--mapdir", help="换一套地图文件（高清 mod 的 map/ 目录）")
    ap.add_argument("--bookmarks", help="剧本清单目录（mod 的 common/bookmarks）；"
                                        "省略 = 自动用「安装根目录下 common/bookmarks」"
                                        "（原版 1.37 里有 12 个剧本，不是三个 ✓）")
    ap.add_argument("--eras", help="只做这几年的剧本层，逗号分隔，如 867,1066,1444,1836,1936；"
                                   "省略 = bookmarks 里有几个做几个（同一天的自动去重 ✓）")
    ap.add_argument("--max-eras", type=int, default=None,
                    help="剧本层最多做几个（按年份从小到大取前 N 个）；"
                         "省略 = 不限制。剧本太多（几百个）时用它截断 ✓")
    ap.add_argument("--hanhua", help="汉化 mod 目录或 eu4_names_zh.json；none=不用中文")
    ap.add_argument("--workshop", help="workshop content 目录（自动找汉化用）")
    ap.add_argument("--out", help="缓存写到哪个目录，默认 data_eu4/")
    ap.add_argument("--geo", default=None,
                    help="地理层，逗号分隔（从粗到细）。可选 ct 大洲 / sr 大区 / "
                         "rg 区域 / ar 地区；细层 pr 省份 与最细层自动保留。"
                         "省略 = 全都要（ct,sr,rg,ar）")
    ap.add_argument("--no-history", action="store_true",
                    help="不要年份剧本层，只做地理层")
    ap.add_argument("--label", default="EU4 原版", help="这套地图的显示名，写进 meta")
    args = ap.parse_args()

    # 🔴🔴 **剧本日期从 bookmarks 读，不写死** ✗✗（2026-10-18 起；2026-10-19 再放松一层）
    #
    #   原来定的是本体那三个（1444/1618/1789）✗ 可 mod 的剧本完全不一样
    #   （风云世纪两千年 111 个 bookmark，从公元 4 年排到 2025 ✓）
    #
    #   **2026-10-19 用户原话**："EU4 的游戏剧本其实有不少，你说的三个是脚本写死的，
    #    能不能不要那么死板，构建程序这些都应该可以自定义才对"✓
    #
    #   → 现在的行为：
    #     · **不给 --bookmarks** → 自动去「安装根目录/common/bookmarks」找 ✓
    #       （原版就是那三个；mod 合并根里有几个读几个 ✓ **不再要求手写** ✓）
    #     · 给了 --eras → 只做这几个年份（老的用法，仍然保留 ✓）
    #     · 给了 --max-eras N → 按年份从早到晚取前 N 个（剧本几百个时截断 ✓）
    #     · 都没有 → **bookmarks 里有几个做几个** ✓ 一个都不丢 ✓
    if not args.no_history:
        bm_dir = Path(args.bookmarks) if args.bookmarks else None
        if bm_dir is None:
            # 安装根目录下自己找（原版 / 合并根都长这样 ✓）
            _try = [Path(p) / "common" / "bookmarks" for p in (args.eu4, args.mapdir) if p]
            bm_dir = next((p for p in _try if p.is_dir()), None)
            if bm_dir is None:
                raise SystemExit(
                    "找不到 bookmarks 目录。传 --bookmarks <目录>，或者确认 "
                    "「<--eu4>/common/bookmarks」存在（原版就在那儿 ✓）")
            log(f"bookmarks：自动找到 {bm_dir}")
        bms = E.parse_bookmarks(bm_dir)
        if not bms:
            raise SystemExit(f"--bookmarks 里一个 date 都没读到：{bm_dir}")
        # 同一天多个 bookmark（不同推荐国家）→ 只留一层 ✓
        seen = set()
        picked = []
        for date, nm in bms:
            if date in seen:
                continue
            seen.add(date)
            picked.append(date)
        if args.eras:
            want = {int(x) for x in re.split(r"[,\s]+", args.eras.strip()) if x.strip()}
            have = {d[0] for d in picked}
            缺 = sorted(want - have)
            if 缺:
                log(f"⚠ 这些年份在 bookmarks 里没有，跳过：{'、'.join(map(str, 缺))}")
            picked = [d for d in picked if d[0] in want]
            if not picked:
                raise SystemExit("--eras 里没有一个年份能在 bookmarks 里找到")
        elif args.max_eras and len(picked) > args.max_eras:
            _all = [tuple(d) for d in picked]
            log(f"⚠ 剧本太多了（{len(_all)} 个），按 --max-eras {args.max_eras} 截断"
                f"（取年份最早的 {args.max_eras} 个；要全做就去掉 --max-eras ✓）")
            picked = _all[:args.max_eras]
        ERA_DATES = tuple(picked)
        ERA_LABELS = tuple(str(d[0]) for d in ERA_DATES)
        ERA_TIERS = len(ERA_LABELS)
        log(f"剧本 {len(ERA_DATES)} 层：" + "、".join(
            f"{y}.{m}.{d}" for (y, m, d) in ERA_DATES))

    # 顶部那几层是什么，由 --no-history / --geo 决定
    #
    # 🔴🔴 **2026-10-19：把大区 / 大洲接进来** ✗✗（用户："加入大区和大洲"）
    #
    #   解析器早就读出来了（`parse_superregions` / `parse_continents` ✓），
    #   但这里**只用了 rg/ar/pr** ✗ —— 那 25 个大区、6 个大洲白解析了 ✓
    #   → 现在默认全接：ct 大洲 → sr 大区 → rg 区域 → ar 地区 → pr 省份
    #     （EU4 层级树本来就是这么长的：continent → superregion → region → area → province ✓）
    #
    #   ⚠ `--geo` 可以自选（从粗到细 ✓），比如只要 `--geo sr,rg,ar` ✓
    #     细层 pr 自动保留（它是地块之上的最后一层，去掉就没得涂了 ✗）
    #   ⚠ `--no-history` 时只有地理层，没有年份剧本 ✓
    use_eras = not args.no_history
    GEO_ORDER = tuple(x.strip() for x in (args.geo or "ct,sr,rg,ar").split(",") if x.strip())
    _bad = [g for g in GEO_ORDER if g not in ("ct", "sr", "rg", "ar")]
    if _bad:
        raise SystemExit(f"--geo 里有不认识的层：{_bad}（只认 ct / sr / rg / ar ✓）")
    # 细层永远是最后一个 ✓（`pr` 不能由 --geo 指定顺序 —— 它必须是"地块之上"那一层 ✓）
    GEO_ALL = GEO_ORDER + ("pr",)
    _gn = {"ct": "大洲", "sr": "大区", "rg": "区域", "ar": "地区", "pr": "省份"}
    _gk = {"ct": "洲", "sr": "大区", "rg": "区域", "ar": "地区", "pr": "省"}
    if use_eras:
        TIER_ORDER = tuple(ERA_LABELS) + GEO_ALL
        TIER_NAME = {**{y: y for y in ERA_LABELS}, **{g: _gn[g] for g in GEO_ALL}}
        TIER_KEY = {**{y: y for y in ERA_LABELS}, **{g: _gk[g] for g in GEO_ALL}}
    else:
        TIER_ORDER = GEO_ALL
        TIER_NAME = {g: _gn[g] for g in GEO_ALL}
        TIER_KEY = {g: _gk[g] for g in GEO_ALL}
    log(f"层级（{len(TIER_ORDER)} 层）：" + " → ".join(TIER_NAME[t] for t in TIER_ORDER))

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
        # 🔴🔴 **2026-10-19：藏（UTS）当清朝附庸时并入清朝** ✗✗
        #
        #   用户原话："原版EU4的剧本如果藏（UTS）是清朝附庸，就改成并入清朝"✓
        #
        #   原来这里是一句 `if y == "1789"` + 一堆写死的 tag ✗ ——
        #   "1789 把西藏并入中国"是当初**手点的一条规则** ✓
        #   可真实数据里，西藏当清朝附庸是 **1724.1.1 → 1792.11.1**（见
        #   `history/diplomacy/Chinese_alliances.txt` 那条 vassal ✓）——
        #   所以 1789 **和 1792 这两个剧本都该并** ✓ 写死一年永远是漏的 ✓
        #
        #   → 现在：**按 diplomacy 里那条附庸关系自己判**，哪年有效就哪年并 ✓
        #
        #   ⚠⚠ **只并西藏，不许并别的附庸** ✗✗
        #     我第一版是"所有附庸都并入宗主"—— 那会把挪威并进丹麦（18 省）、
        #     立陶宛并进波兰（48 省）、葡萄牙并进西班牙（81 省）……
        #     **整张欧洲地图全糊成几坨** ✗ 用户要的根本不是这个 ✓
        #     EU4 地图上附庸本来就该**分开着色** ✓ 只有西藏是用户点名要并的 ✓
        #   ⚠ `TIB` 一起收着（版本差异：有的版本西藏是 TIB 不是 UTS ✓）
        # 🔴 **2026-10-20 加上 KAM（康）** ✗✗（用户："把EU4的UTS那条规则也补上对康（KAM）的"）
        #   `history/diplomacy/Chinese_alliances.txt` 里本来就是两条并列的：
        #     vassal = { first = QNG second = UTS  1724.1.1 ~ 1792.11.1 }
        #     vassal = { first = QNG second = KAM  1724.1.1 ~ 1776.1.1  }  ← 结束得早
        #   所以在期的年份要**两家都并** ✓
        #   ⚠ 不能"找到一个就 break" ✗ —— 那样 KAM 永远轮不上 ✓（原来就是 break ✓）
        #   ⚠ KAM 的结束日是 **1776.1.1**，而剧本 1776 是 **7 月 4 日** →
        #     那天已经过期了 ✓ 所以 1776 / 1789 / 1792 只并 UTS、不并 KAM ✓
        #     这不是 bug，游戏数据就这么写的 ✓
        subj_rels = EH.parse_subject_relations(root / "history")
        log(f"附庸关系：{len(subj_rels)} 条（history/diplomacy ✓）")
        MERGE_SUBJECTS = ("UTS", "TIB", "KAM")   # 只并这几家（用户点名的 ✓）
        for d, y in zip(ERA_DATES, ERA_LABELS):
            arr: dict[int, str] = {}
            for p in used_pr:
                base, tl = hist.get(p, (None, []))
                o = EH.owner_at(base, tl, d)
                if o:
                    arr[p] = o
            # 那天这几家是不是别人的附庸？是的话并进宗主 ✓（**可能不止一家** ✓）
            notes: list[str] = []
            if subj_rels:
                subj_map = EH.subject_at(subj_rels, d)
                for sub in MERGE_SUBJECTS:
                    lord = subj_map.get(sub)
                    if not lord:
                        continue
                    if sub not in set(arr.values()):
                        continue          # 那天它没地，没什么可并的 ✓
                    if lord not in set(arr.values()):
                        continue          # 宗主那天没地 → 并过去变无主 ✗ 不并
                    moved = [p for p, t2 in arr.items() if t2 == sub]
                    if not moved:
                        continue
                    for p in moved:
                        arr[p] = lord
                    notes.append(f"{sub}→{lord}（{len(moved)} 省）")
            owners.append(arr)
            log(f"  {y}：有主 {len(arr)} 省 / {len(set(arr.values()))} 个国家"
                + (f"　附庸并入：{'、'.join(notes)}" if notes else ""))
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

    #: 层名 → 归属表行号（不在这一版层级里就 -1 ✓）
    #  ⚠ **必须定义在组树之前** ✗ —— 下面建节点时要用它判断"这一层要不要建" ✓
    #    （我第一版写在归属表那段，结果第 831 行就用了 → NameError ✓）
    def _slot(name: str) -> int:
        return TIER_ORDER.index(name) if name in TIER_ORDER else -1

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
        log(f"{len(ERA_LABELS)} 个年份共 {n_era} 个国家节点（配色取 common/countries 的国旗色）")
        # 地区配色还是按"区域"分家族，只是区域本身不再单独成层
        # ① 区域名先按黄金角撒开 —— 它就是**地区层**的家族基色（786 行查的就是它）
        for i, rn in enumerate(sorted(used_rg)):
            hue_of[rn] = (i * 137.508) % 360.0
        # ② 大区名单独撒一份：区域家族按大区分组，查的是**大区名**，
        #    上面那把种子里没有大区键，不撒的话全族都从 200 起步挤一个色相带
        sup_hue = {sn: (i * 137.508) % 360.0
                   for i, sn in enumerate(sorted({region_super.get(rn, "") for rn in used_rg}))}
        # 🔴🔴 **2026-10-19：剧本模式下也要建大洲 / 大区节点** ✗✗
        #   （用户："加入大区和大洲"✓）
        #   原来这条分支**只建 rg** ✗ —— 因为当时层级里只有 rg/ar/pr ✓
        #   现在层级里加了大洲 / 大区，不建的话点进那两层是**一片空白** ✓
        #   ⚠ 必须**先建父级再建子级** ✗（下面 region 的 parent 要指向 sr ✓
        #     顺序反了 parent 就挂不上 ✓ 跟 --no-history 那支同一个道理 ✓）
        #   ⚠ 只建**这一版层级里有的层** ✗（`--geo sr,rg,ar` 时 ct 不建 ✓）
        if _slot("ct") >= 0:
            for cn in sorted(used_ct):
                t = add(Node(cn, "ct"))
                t.color = continent_color(cn)
        if _slot("sr") >= 0:
            groups = {}
            for sn in sorted(used_sr):
                groups.setdefault(sup_cont.get(sn, ""), []).append(sn)
            for parent, kids in sorted(groups.items()):
                base = CONTINENT_HUE.get(parent, 200)
                placed: list = []
                for i, sn in enumerate(kids):
                    col = pick_color(base, 90.0, placed)
                    placed.append(col)
                    t = add(Node(sn, "sr"))
                    # 父级是 ct 且**它真建了**才挂 ✓（--geo 里没 ct 时就当根 ✓）
                    t.parent = parent if (parent and parent in index_of) else None
                    t.color = col
                    hue_of[sn] = child_hue(base, i, 90.0)
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
    #
    # 🔴🔴 **2026-10-19：全部改成「按层名索引」，不再用相对位置** ✗✗
    #
    #   原来是 `len(TIER_ORDER)-1` 省份 / `-2` 地区 / `[2]` 区域 / `[1]` 大区 / `[0]` 大洲 ✗
    #   这套硬编码**只在"5 层"时成立** ✓ 一旦在顶部插入大洲 / 大区，
    #   整个表就整体错位一格 —— 而且错得**不报错**（只是涂的地方不对 ✗）
    #   这种 bug 最难查，所以索性改成 `_slot("rg")` 这种按名取 ✓
    #   加层 / 减层 / 调整顺序，这里一个字都不用动 ✓
    titlemap = np.full((len(TIER_ORDER), n_prov), NO_TITLE, dtype=np.uint16)

    # ⚠ `_slot()` 定义在上面「组树」那段 ✗ 这里别重复定义
    _S_PR = _slot("pr")
    _S_AR = _slot("ar")
    _S_RG = _slot("rg")
    _S_SR = _slot("sr")
    _S_CT = _slot("ct")
    missing_chain = 0
    for p in used_pr:
        if _S_PR >= 0:
            titlemap[_S_PR, p] = index_of[prov_key(p)]            # 省份（最细一层）
        an = prov_area[p]
        rn2 = area_region.get(an)
        sn2 = region_super.get(rn2) if rn2 else None
        cn2 = prov_cont.get(p)
        if _S_AR >= 0 and an in index_of:
            titlemap[_S_AR, p] = index_of[an]                     # 地区
        if _S_RG >= 0 and rn2 and rn2 in index_of:
            titlemap[_S_RG, p] = index_of[rn2]                    # 区域
        if _S_SR >= 0 and sn2 and sn2 in index_of:
            titlemap[_S_SR, p] = index_of[sn2]                    # 大区
        if _S_CT >= 0 and cn2 and cn2 in index_of:
            titlemap[_S_CT, p] = index_of[cn2]                    # 大洲
        if rn2 and rn2 not in index_of:
            missing_chain += 1
        if use_eras:
            for i, year in enumerate(ERA_LABELS):
                tag = owners[i].get(p)
                if tag:
                    k = f"{year}_{tag}"
                    if k in index_of:
                        titlemap[i, p] = index_of[k]
    if missing_chain:
        log(f"  {missing_chain} 个省份的区域没建出来，中间那层留空")

    # 9. 海/湖/荒地 —— 水域**不再是伪头衔**（2026-10-14 ✓ 用户要求 ✓）
    blank = np.all(titlemap == NO_TITLE, axis=0) & present
    # 🔴🔴 **水域不算"空白"** ✗✗（2026-10-14 ✓ 跟 CK3 / VIC3 / HOI4 同一刀 ✓）
    #
    #   用户："你就不能把水域变成一个**仅仅是不能填色的地块**吗……
    #     最底层的单位也有自己的 Province id"✓
    #     "和陆地一样啊，**大名，河北，华北**，这样下来"（= 逐块 / 地区 / 大区 ✓）
    #     "只是水域**带一个小标签**来让他在**边界和颜色**等方面听从相关的开关，
    #      **其他逻辑不变**"
    #
    #   → 水域**不再造伪头衔** ✓ 于是它"所有层都无主"✓ 正好落进上面这个 blank ✗
    #     → 被「无归属荒地」那片盖住 ✓（CK3 那边实跑量到过：悬停海拿到的 tid
    #       是 `#wasteland_c_3` ✓ 于是**海的高亮跟着荒地整片亮** ✗）
    #   → 必须**排除在 blank 之外** ✓ 那它就"完全无归属"✓
    #     身份靠 `pid` + `meta.waterMask`（那个"小标签"✓）——
    #     颜色走海域色 ✓ 边界听水域那两条开关 ✓ 高亮按 pid ✓ 别的全跟普通地块一样 ✓
    #
    #   ⚠ 水域**不能**进 `#wasteland` ✗ —— 荒地是"可以一块块涂色"的 ✓
    #     水域**不能填色** ✓ 两者待遇相反 ✓
    #   ⚠⚠ **EU4 有真层级** ✗（`sea_starts` 海区 / `area` 区域 ✓）——
    #     按用户"大名 / 河北 / 华北"那条口径，**粗层本该保留** ✓
    #     但这一刀先做到"**最细层回归逐块**"✓（那是关键 ✓）
    #     粗层怎么补见文件末尾 TODO ✓（`seaNamesByTier` 还在 ✓ 数据没丢 ✓）
    _water_all = np.asarray(is_sea, dtype=bool) | np.asarray(is_lake, dtype=bool)
    blank = blank & ~_water_all
    log(f"完全没有归属的地块：{int(blank.sum())} 个"
        f"（已排除 {int(_water_all.sum())} 个水域 ✓ 它们不算「无主荒地」✓）")
    _special_names: dict[str, str] = {}
    #: **地理层** = 剧本层右边那几层（rg / ar / pr ✓）；`--no-history` 时全层都是地理层 ✓
    _geo = list(TIER_ORDER[ERA_TIERS:]) if use_eras else list(TIER_ORDER)
    # **各层的水名表**（用现成的分层解析 ✓ 别另编一套 ✗）
    #   `load_water_names_by_tier` 的键**就是层名**（rg / ar / pr ✓）＋ "wasteland" ✓
    #   某一层一条都取不到 → 给 {} → 那一层整片算一片（名字用类别名"海洋"✓）
    #   这就是"每层的片 = 该层同名地块的集合" ✓（用户点名的口径 ✓）
    _wtier: dict[str, dict[int, str]] = {t: {} for t in _geo}
    _waste_names: dict[int, str] = {}
    try:
        _raw = E.load_water_names_by_tier(root)
        for _t in _geo:
            _wtier[_t] = dict(_raw.get(_t) or {})
        _waste_names = dict(_raw.get("wasteland") or {})
        log("水名表（分层）：" + "、".join(f"{t} {len(_wtier[t])} 条" for t in _geo)
            + f" · 荒地 {len(_waste_names)} 条")
    except Exception as _e:            # 解析不出来不该拖垮整个构建 ✓
        log(f"水名表跳过：{_e}")
    # 🔴 **EU4 不需要补任何东西** ✗（2026-10-14 ✓ 用户澄清 ✓）
    #   用户："**EU4 和 EU5 都一样每个层面都有海域**"✓
    #   → `rg` / `ar` / `pr` 三层**各自都有海名表**（各 607 条 ✓）——
    #     那是游戏数据里**真有**的 ✓ 直接用 ✓
    #   ⚠ "没名字的海省"**就是真的没有** ✗（游戏里那一层没给它名字 ✓）
    #     → 归"无名组"✓ 名字用类名 ✓ **不该补地块号** ✗
    #   ⚠ 只有 **HOI4** 要补 ✗ —— 它"**单独的 state 和 province 共用**"✓
    #     （海省不落在任何州里 ✓ 见 `build_hoi4.py` 那段 ✓）
    special, _sp_rows, stats, waste_pids, waste_tids = build_special_titles(
        # 🔴 **`skip_fine_tier=True`** ✗（2026-10-14 ✓ 用户要求 ✓）
        #   水域**最细层不造片** ✓（它就是它自己那个 province ✓）而**粗层照造** ✓
        #   用户："和陆地一样啊，**大名，河北，华北**，这样下来"✓
        #     → EU4 的 `rg`（区域）/ `ar`（大区）那两级**照旧造** ✓
        #       `pr`（省份）那级**不造** ✓ —— 那一级就是"逐块 pid" ✓
        #   ⚠ `terrain` **原样传** ✗ —— 下面算 `meta.waterMask`（那个"小标签"✓）
        #     也用它 ✓ 而且 `skip_fine_tier` 只影响"造片"那一步 ✓ 不动 `blank` ✓
        terrain, n_prov, blank | _water_all, n_real, fine_tier=_geo[-1],
        # 🔴 **剧本层：每一类共用一个「海洋」节点** ✗（2026-10-14 ✓ 用户的主意 ✓）
        script_tiers=[t for t in TIER_ORDER if t not in _geo],
        geo_tiers=_geo, tier_names=_wtier, waste_names=_waste_names,
        skip_fine_tier=True,
        name_sink=_special_names,
        )
    log("地形类别：" + ("，".join(stats) if stats else "无"))

    # 🔴🔴 **底层地块的"身份标"** ✗✗（2026-10-16 补 ✓ 用户点名要的 ✓）
    #   跟 `build_data.py`(CK3) / `build_ck2.py` / `build_eu5.py` **同一枚** ✓
    #   → `meta.kindMask`：每地块 **1 字节**、base64
    #     1 陆地（兜底）/ 2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域 / 6 不可通行区域 ✓
    #   ⚠ **EU4 只有海和湖** ✗（游戏数据 `default.map` 里就 `sea_starts` + `lakes` 两张名单 ✓
    #     码 4 / 5 / 6 三格在全图落"陆地 1" ✓ 不编假数据 ✓）
    #   ⚠ **无归属区域不进这枚标** ✗（那是剧本 / 归属决定的，不是地块身份 ✓
    #     所以 `#wasteland`（不可通行荒地 ✓）**故意不发** ✓ 它照旧落"陆地 1" ✓
    #     —— 这跟改造前**推出来的结果一致** ✓ 实测：EU4 认水 海 668 · 湖 125 ✓ 两边一样 ✓）
    #   ⚠ 判据是**构建期那份现成类别集合**（`terrain` ✓ 就是上面 `SPECIAL_CATEGORIES`
    #     那几个来源清单读出来的 ✓ 跟"水域优先"一条口径 ✓）
    #   ⚠ **不许拿 `{ }` 当作用域块** ✗（Python 里那不是块 ✓ 见 build_data.py 那条教训 ✓）
    import base64 as _kind_b64mod                                 # noqa: PLC0415
    from build_tier_pieces import (kind_mask as _kind_mask,       # noqa: PLC0415
                                   KIND_CODES as _KIND_CODES)
    _kind_cat: dict[str, set[int]] = {}
    for _kkey, _klabel, _krgb, _ksrc in SPECIAL_CATEGORIES:
        if _kkey not in _KIND_CODES:
            continue                    # `#wasteland`：无归属 ≠ 地块身份 ✓ 不进标 ✓
        if not _ksrc:
            continue                    # 来源是 None 的那一类（纯兜底 ✓）没清单可读 ✓
        _ks = {int(p) for p in (terrain.get(_ksrc) or ()) if 0 < int(p) < n_prov}
        if _ks:
            _kind_cat[_kkey] = _ks
    _kind_b64 = _kind_mask(n_prov, _kind_cat)
    _kind_n = {c: 0 for c in range(7)}
    for _kb in _kind_b64mod.b64decode(_kind_b64):
        _kind_n[int(_kb)] = _kind_n.get(int(_kb), 0) + 1
    _kind_tot = sum(_kind_n[c] for c in range(1, 7))
    assert _kind_tot == n_prov - 1, \
        f"kindMask 有空洞 ✗：1~6 合计 {_kind_tot} ≠ numProvinces-1 = {n_prov - 1}"
    assert _kind_n[0] == 1, f"kindMask 的 0 号格子应该是空位 ✗（实际 {_kind_n[0]} 个）"
    log("身份标 kindMask："
        + " · ".join(f"{c}={_kind_n[c]}" for c in range(1, 7))
        + f"（1~6 合计 {_kind_tot} = numProvinces-1 ✓ 无空洞 ✓）")
    from build_tier_pieces import apply_rows as _apply_rows        # noqa: PLC0415
    log(f"背景地形按层填了 {_apply_rows(titlemap, _sp_rows, TIER_ORDER, _geo)} 个"
        f" (省份, 层级) 对（剧本层借最粗那层的片 ✓）")
    left = int(np.count_nonzero((titlemap[0] == NO_TITLE) & present))
    log(f"有像素但仍是空白的格子：{left}")

    # 荒地节点序号（建节点时记下的真实序号）+ 粗层那些"整片"伪头衔
    #（前端"荒漠·涂色"关着时它们要显示灰）
    # ⚠ 判据一律**前缀匹配** ✗ —— 2026-10-13 起每层一片，键是 `#sea_pr_57` 这种 ✓
    waste_tid_of = dict(zip(waste_pids, waste_tids))
    water_tids = set()
    for k, sp in enumerate(special):
        if str(sp.key).startswith(("#sea", "#lake", "#river", "#impassable_sea")):
            water_tids.add(n_real + k)
        if str(sp.key).startswith(SETTABLE_CATEGORIES):
            waste_tids.append(n_real + k)


    ordered_all = ordered + special
    n_all = len(ordered_all)

    # 10. 每个头衔的成员省份 → 地盘数、像素面积
    # ⚠ **按"节点自己那一层"数** ✗（2026-10-13 每层一片之后）
    #   以前伪头衔在**每一行**都写着同一个序号 ✗ → 每层数一遍会虚高成 N 倍，
    #   所以老代码用 `tid >= n_real and r > 0` 把它挡掉 ✗。
    #   现在每层是**不同的节点** ✓、剧本层借的是最粗那层的片 ✓ ——
    #   老判据会把水 / 荒地整个跳过（provCount / area 全 0 → 标签层挑不到它们 ✓）
    #   正确的口径：**只数"它自己那一层"那一行** ✓
    _own_row = np.array([TIER_ORDER.index(t.tier) if t.tier in TIER_ORDER else -1
                         for t in ordered_all], dtype=np.int64)
    members: list[list[int]] = [[] for _ in range(n_all)]
    for r in range(len(TIER_ORDER)):
        row = titlemap[r]
        sel = np.nonzero((row != NO_TITLE) & present)[0]
        if sel.size == 0:
            continue
        tids = row[sel].astype(np.int64)
        keep = _own_row[tids] == r          # 这一行里"本来就属于这一层"的节点 ✓
        sel, tids = sel[keep], tids[keep]
        if sel.size == 0:
            continue
        _o = np.argsort(tids, kind="stable")
        sel, tids = sel[_o], tids[_o]
        _uniq, _starts = np.unique(tids, return_index=True)
        _ends = np.append(_starts[1:], tids.size)
        for _u, _a, _b in zip(_uniq.tolist(), _starts.tolist(), _ends.tolist()):
            members[_u].extend(sel[_a:_b].tolist())
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
    # 🔴 **荒地省份也要进 want** ✗✗（2026-10-18 风云世纪两千年）
    #   `used_pr` 只装了**省份层**用到的省份 ✓ 荒地（`wl_5xxx`）不在那一层里 ✗
    #   → 它们的 `PROV<id>` 被这次过滤裁掉 → 名字只能退回 `definition.csv` 的英文
    #     （用户截图里那条「Northern Taihang Mountains」就是它 ✓）
    #   荒地节点的 key 就是 `wl_<省号>` ✓ 顺手把它们也加进来 ✓
    want |= {f"PROV{t.key[3:]}" for t in ordered_all
             if t.key.startswith("wl_") and t.key[3:].isdigit()}
    if use_eras:
        want |= {tag for arr in owners for tag in arr.values()}
    else:
        want |= used_rg | used_sr | used_ct
    # 🔴 **本地化要整目录读，别再手写文件名清单** ✗✗（2026-10-18 风云世纪两千年）
    #   原来只读顶层那 5 个 `*_l_english.yml` ✓
    #   可这个 mod 的省份名整份放在 `localisation/replace/bu_prov_names_l_english.yml` ✗
    #   （`replace/` 是 Paradox 的覆盖机制，`read_loc_dir` 本来就支持 ✓）
    #   → 64 个省份查不到名字，全退成 `P 5088` 那种编号印在图上 ✓
    #   现在：整目录递归读（含 replace/，后读的覆盖先读的 ✓）
    #   ⚠ 汉化那份是"双字节 yml"，`read_loc_file` 里另有分支解 ✓
    en = E.read_loc_dir(LOC)
    en = {k: v for k, v in en.items() if k in want}
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
        # **底层地块身份标**（每地块 1 字节 base64 ✓ 2026-10-16 补 ✓
        #   1 陆地 / 2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域 / 6 不可通行区域 ✓
        #   EU4 只有前三种（河 / 不可通行海域 / 不可通行区域 都不存在 ✓）✓）
        "kindMask": _kind_b64,
        "numTitles": n_all,
        "numRealTitles": n_real,
        "tiers": list(TIER_ORDER),
        "tierNames": [TIER_NAME[t] for t in TIER_ORDER],
        "tierKeys": [TIER_KEY[t] for t in TIER_ORDER],
        "entity": "省份",
        # 年份模式 6 层，省份 = ERA_TIERS+2；非年份模式只有 5 层，取最后一层
        # 🔴 **默认停在"省份"层** ✓（2026-10-22 ✓ 用户："EU4 和 EU5 一进去的默认视图
        #   从地区改为省份，其他不变"）
        #   ⚠ 原来是 `TIER_ORDER.index("ar")`（地区 ✗）→ 现在 `"pr"`（省份 ✓）
        #   ⚠ 别写 `len(TIER_ORDER) - 1` ✗ —— 那是"最后一层"，
        #     地理层将来加/减（大洲/大区/区域/地区/省份）它就指到别处 ✓
        #     按**层名**取才稳（这条 2026-10-19 已经踩过一次 ✓）
        #   ⚠ 只在 `"pr"` 真存在时才用 ✓ 万一以后砍掉省份层，
        #     退回"最后一层"至少不会给出越界下标 ✓
        "defaultTier": (TIER_ORDER.index("pr") if "pr" in TIER_ORDER else len(TIER_ORDER) - 1),
        # 年份那三层节点少（几百个国家）、彼此还挤在一起，门槛比大洲那套高一点
        # **全部 tag** 的名字 + 颜色（含当前年代没地盘的）—— 搜索/取色要用 ✓
        # 名字先放 tag —— 中文名由 patch_wasteland 从 titles.json 里统一补 ✓
        "countryTags": {tag: {"n": tag, "c": list(col)}
                        for tag, col in sorted(tag_colors.items())},
        "labelZoom": _label_zoom(TIER_ORDER, ERA_TIERS) if use_eras else [5, 10, 20, 20, 70, 110],
        # 年份视图是什么时候的地图（空 = 用的是地理那套）
        "eraDates": [f"{y}.{m}.{d}" for (y, m, d) in ERA_DATES] if use_eras else [],
        # 🔴 **剧本的名字和日期也要带上** ✗✗（2026-10-19）
        #   前端 `buildToolbar()` 会读 `meta.bookmarks` 给层级按钮加 tooltip
        #   （"1066.9.15 · 1066" 那种 ✓）—— 一直没有这个字段，所以剧本多的图
        #   顶栏只有光秃秃的年份数字 ✓ 现在按层号对齐写进去 ✓
        #   ⚠ 下标 = 层号：前 N 层是剧本，第 N 层是空白层（给 null ✓）
        "bookmarks": (
            [{"date": f"{y}.{m}.{d}", "key": str(y), "name": str(y),
              "default": (i == 0)}
             for i, (y, m, d) in enumerate(ERA_DATES)]
            + ([{"date": "", "key": "blank", "name": "空白剧本", "default": False}]
               if use_eras else [])
        ) if use_eras else [],
        "noTitle": NO_TITLE,
        "specialPrefix": "#",
        "colorLutWidth": 256,
        # 荒地：哪些节点算荒地 + 逐块的自动归属（口径同 EU5/CK3）
        "wasteland": sorted(set(waste_tids)),
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
    # **水域名**（2026-10-13 ✓ 出处见 docs/水域名调研.md）
    #   ⚠ **按视图层各一套** ✗（用户要求："EU4/5 在不同的视图下，海域包括的范围也不一样"✓）
    #     rg / ar / pr 三层粒度真的不同（原版上 rg↔ar 有 346 块名字不一样 ✓）
    #   `seaNames` 写 **ar 层** ✓ —— 那就是第一轮的口径（area 优先、退到省自己 ✓）
    #     留着当"老包 / 没有 byTier 时"的兜底 ✓
    #   **荒地名字**一并收（用户要求 ✓）：VN 那张图的 wl_* 正是"热那亚""波尔多"那批 ✓
    #   ⚠ 这个函数是 `sea_names_by_tier(tiers, by_tier)` ✗ 参数顺序跟 EU5 的**相反** ✓ 别抄错
    try:
        _t = E.load_water_names_by_tier(root)
        _arr = E.sea_names_by_tier(meta["tiers"], _t)
        if any(_arr):
            meta["seaNamesByTier"] = [
                ({str(k): str(v) for k, v in x.items()} if x else None) for x in _arr
            ]
        _ar = _t.get("ar") or {}
        if _ar:
            meta["seaNames"] = {str(k): str(v) for k, v in _ar.items()}
        _wl = _t.get("wasteland") or {}
        if _wl:
            meta["wastelandNames"] = {str(k): str(v) for k, v in _wl.items()}
        log(f"水域名：分层 {[len(x or {}) for x in _arr]} · 荒地 {len(_wl)} 条")
    except Exception as _e:
        log(f"水域名解析跳过：{_e}")
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
    # 2026-10-19：这里原来还有一段"伪头衔名字校正"（写盘后按 key 重写一遍）✗
    #   已随 `_fix_waste_names` 一起删掉 —— 三条真凶都在上游修好了 ✓
    #   见文件头那段说明（`definition.csv` 的 `#` 中文 / patch_wasteland 的覆盖 /
    #   逐块荒地的 `#` 前缀 ✓）保留下来的话，每次构建都要多读多写一遍 1MB 的 json ✓
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
    # **荒地挪成伪头衔**（幂等）：EU5 的荒地序号混在真头衔里 ✗ ——
    #   app 里"伪头衔（>= numRealTitles）= 背景地形"那条假设在 EU5 上不成立，
    #   于是荒地轮廓被画成"本层那条线"的 50% ✗（用户报过 ✓）
    #   放在荒地加工**之后**（它已经把那几张表烘好了 ✓）、
    #   空白剧本**之前**（空白那一行照抄的是最终编号 ✓）
    from patch_waste_pseudo import patch as _patch_waste_pseudo
    _patch_waste_pseudo(DATA)
    # 再补一层**空白剧本**（幂等）：放在荒地之后 —— 它照抄的是"最终这版"的背景地形 ✓
    from patch_blank_era import patch as _patch_blank
    _patch_blank(DATA)
    # 2026-10-19：`_fix_waste_names` 已删 —— 真凶是 patch_wasteland 的 eu4 那支
    #   拿 `provinceNames` 覆盖节点名（见那个文件里那段说明 ✓）
    #   源头一修，这里就不用再擦屁股了 ✓
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
