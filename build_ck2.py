#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 CK2（十字军之王 II）安装目录构建地图编辑器所需的缓存 → ``data_ck2/``。

用法::

    py build_ck2.py                       # 自动找游戏目录 → data_ck2/
    py build_ck2.py --out data_ck2        # 指定输出
    py build_ck2.py --root "D:\\CK2"      # 指定游戏根目录
    py build_ck2.py --scale 2             # 降采样到 1536×1024 出一张省显存的对照图
    py build_ck2.py --no-rivers           # 大河的 113 个地块按「海洋」算（见下）
    py build_ck2.py --loc "…\\ck2_chinese\\localisation"   # 手动指汉化（一般不用，自动找 ✓）

产出跟 CK3 那份（``build_data.py`` → ``data/``）**逐字段对齐** ✓：
``meta.json`` / ``titles.json`` / ``titlemap.bin`` / ``provinces_id.bin`` /
``adjacency.bin`` / ``prov_pos.bin`` —— 前端按 ``meta.game = "ck2"`` 走 CK2 自己那一套 ✓

## 跟 CK3 不一样的地方（都是数据决定的，不是偷懒 ✗）

① **一块地 = 一个伯爵领** ✗ 不是男爵领 ✓ —— 所以地图上是**四级**不是五级 ✓
   CK2 的地图省份就是伯爵领：``history/provinces/<号> - <名>.txt`` 里一行
   ``title = c_xxx`` ✓（1740 行，去重 1740 个 c_ ✓ 一个 b_ 都没有 ✓）
   男爵领（``b_`` ✓ 12973 个）是**伯爵领里面的地产**、**一个像素都不占** ✗
   → 层级栈 = ``1066 / 空白剧本 / 帝国 / 王国 / 公爵领 / 伯爵领`` ✓ **没有男爵领那一行** ✓
   （依据的完整推演见 ``parsers/ck2/parser.py`` 的 ``TIER_ORDER`` 那段 ✓）

② **名字取 ``PROV<地块号>``** ✗ 不是 ``c_xxx`` ✓
   CK2 有 1432 个伯爵领**压根没有 ``c_`` 名字** ✓（``c_aargau`` / ``c_acre`` … ✓）
   名字在 ``PROV`` 键上（2015 个，1…2014 一个不缺 ✓）
   详见 ``parsers/ck2/parser.py`` 的 ``prov_loc_key`` ✓

③ **剧本层与法理层都按 1066 那一天算** ✓
   日期**不是在脚本里拍**的 ✗ —— 是从 ``common/bookmarks/00_bookmarks.txt`` 读出来的 ✓
   （1066 在 CK2 里有**两个**书签 ✓ 挑法见 ``parser.find_bookmark`` ✓ 构建日志会打出
     用的哪个文件第几行 ✓）。归属读 ``history/titles/*.txt`` 里 **≤ 该日期**的最后一条
   ``holder`` / ``liege`` ✓；法理 = ``landed_titles`` 骨架 + ``de_jure_liege`` 里
   **≤ 该日期**的那些 ✓（别把 1200 年的漂移算进 1066 ✗）

④ **中文靠汉化 mod** ✓ —— CK2 vanilla 的 localisation 是 CSV，只有英/法/德/西四栏 ✓
   中文列**根本不存在** ✓。汉化组的做法是**整套替换** ``localisation/*.csv``，
   把中文按一种**自造的三字节编码**写进 ENGLISH 那一栏 ✓
   → 读法见 ``parsers/ck2/hanhua.py``（**跟 EU4 那套不是一个东西** ✗ 别照搬 ✓）
   回退链：**汉化中文 → 原版英文 → 键名** ✓（``names`` 中文 / ``namesEn`` 英文 ✓）
"""

from __future__ import annotations

import argparse
import base64
import json
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

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

# 省份图 / 邻接表 / 归属表 / 剧本层 / 标注位置 / 日志：**跟 CK3 共用同一份实现** ✓
# （抄三份拍平清单踩过的坑见 build_standalone.py 顶上那段 ✓ 同一个道理 ✓）
from build_data import (                                          # noqa: E402
    NO_TITLE,
    build_adjacency,
    build_province_map,
    build_realm_layer,
    build_titlemap,
    centroids_for_titles,
    collect_provinces,
    log,
    rank_titles,
)
from parsers.ck2 import hanhua as ZH                              # noqa: E402
from parsers.ck2 import parser as C                               # noqa: E402
from parsers.ck2.parser import TIER_NAME, TIER_ORDER              # noqa: E402

DATA = ROOT / "data_ck2"

#: 剧本层的名字 = **那一年** ✓（跟 CK3 那边 ``ERA_TIER = "1066"`` 一个写法 ✓）
#: ⚠ 具体日期（1066.9.15 那个）**从游戏的书签文件里读** ✓ 见 ``main()`` 那一段 ✓
ERA_TIER = "1066"
ERA_LABEL = "1066"

#: 地图从上到下的层级：**1066 剧本 → 帝国 → 王国 → 公爵领 → 伯爵领** ✓
#: 🔴 **只有四级法理** ✗（CK2 没有男爵领 ✓ 见文件头 ① ✓）
#: ⚠ 这张表是**构建期**的长度（5 行）✓ —— 收尾时 ``patch_blank_era`` 会往剧本块
#:   最右边插一格「空白剧本」✓ 于是最终 ``meta.tiers`` 是 **6** 行 ✓
#:   （跟 CK3 那边 ``1066 / 空白剧本 / e / k / d / c / b`` 七行同一个构造 ✓ 只是少一级 ✓）
MAP_ORDER: list[str] = [ERA_TIER, *TIER_ORDER]

#: 空白剧本那一格的 key / 名字（``patch_blank_era`` 里那两个常量 ✓ 得一致 ✓）
BLANK_KEY = "blank"
BLANK_NAME = "空白剧本"


def find_ck2(explicit: str | None = None) -> Path:
    """找 CK2 安装根目录（里面有 ``map/provinces.bmp`` 与 ``common/landed_titles`` ✓）。

    候选按"这台机器上真装在哪"排（本机是 ``C:\\Steam\\steamapps\\common\\Crusader Kings II`` ✓），
    另外**还会看本工程已有的缓存里记的游戏根目录**：CK3 / EU4 那些 ``meta.json`` 里
    存着 ``ck3_root`` / ``gameRoot`` ✓ 同一台机器上 Steam 库通常就那一个 ✓
    拿它的**兄弟目录**里去找 CK2 ✓ 比硬编码一堆盘符靠谱 ✓
    """
    cands: list[Path] = []
    if explicit:
        cands.append(Path(explicit))

    # ① 已烘好的缓存里记着的游戏根目录 → 它的兄弟目录
    for cache in ("data", "data_eu4", "data_vic3", "data_hoi4", "data_eu5"):
        mp = ROOT / cache / "meta.json"
        if not mp.is_file():
            continue
        try:
            m = json.loads(mp.read_text(encoding="utf-8"))
        except Exception:                    # noqa: BLE001
            continue
        for k in ("ck3_root", "gameRoot", "eu4_root"):
            v = m.get(k)
            if isinstance(v, str) and v:
                cands.append(Path(v).parent / "Crusader Kings II")

    # ② 明面上的几个位置
    for drive in ("C:", "D:", "E:", "F:"):
        cands.append(Path(f"{drive}\\Steam\\steamapps\\common\\Crusader Kings II"))
        cands.append(Path(f"{drive}\\SteamLibrary\\steamapps\\common\\Crusader Kings II"))
        cands.append(Path(f"{drive}\\Program Files (x86)\\Steam\\steamapps\\common"
                          f"\\Crusader Kings II"))
        cands.append(Path(f"{drive}\\Game NIANJIU\\CK2"))
        cands.append(Path(f"{drive}\\Game NIANJIU\\Crusader Kings II"))

    tried: list[str] = []
    for p in cands:
        tried.append(str(p))
        try:
            if (p / "map" / "provinces.bmp").is_file() \
                    and (p / "common" / "landed_titles").is_dir():
                return p
        except OSError:
            continue
    raise SystemExit(
        "找不到 CK2 安装目录 ✗（要的是**游戏根目录**，里面有 map/provinces.bmp 与"
        " common/landed_titles ✓）\n"
        "  用 --root 指定，例如：\n"
        "    py build_ck2.py --root \"C:\\Steam\\steamapps\\common\\Crusader Kings II\"\n"
        "  找过这些地方：\n    " + "\n    ".join(tried[-14:]))


#: 汉化 mod 一般装在哪（CK2 的"文档"目录 ✓）
HANHUA_BASE = Path.home() / "Documents" / "Paradox Interactive" / "Crusader Kings II" / "mod"


# ------------------------------------------------------------------ 地形类别

#: 海 / 湖 / 河 / 不可通行在 CK2 里也是**地块**（有省份号、有像素 ✓ 只是没有头衔 ✓），
#: 跟 CK3 一模一样 —— 所以同样给它们各造一个"伪头衔"，就能跟真头衔走完全同一套
#: 着色 / 取色 / 涂色逻辑 ✓ 前端一行都不用改 ✓
#: key 以 ``#`` 开头，跟 ``e_/k_/d_/c_`` 永远撞不上 ✓
#: **判定按列表顺序来，先命中的赢** ✓（``claimed`` 一置，后面的类就拿不到它了 ✓）
#:
#: ⚠ 颜色**逐字照抄 CK3 那份**（``build_data.SPECIAL_CATEGORIES`` ✓）——
#:   这四类水在编辑器里是同一套配色 ✓ 两代游戏不该各调各的 ✗
#:
#: ⚠ 来源键里**有两个 CK2 根本没有** ✗（``impassable_seas`` / ``impassable_mountains``
#:   ✓ ``default.map`` 里一个都没有 ✓ 实跑核过 ✓）—— 没有就老实空着 ✓
#:   （那一类的节点数为 0 ✓）不编假数据 ✗
#:
#: 🔴 **``lakes`` 也不是 default.map 里的键** ✗✗（2026-10-16 用户追问"原版怎么定义" ✓）：
#:   它是**构建期算出来**的 ✓ 依据三条实跑结论（见 ``parse_river_segments`` /
#:   ``find_enclosed_lakes`` 的注释 ✓）：
#:     · ``major_rivers`` 名单（113）里混着 **22 个封闭水体**（里海/咸海/拉多加/伊尔门/
#:       奥涅加/扎伊桑/爱尔兰三湖… ✓）—— 真正的河段是名单 ∩ `adjacencies.csv` 的
#:       `major_river` 穿越点 = **91** 个 ✓
#:     · ``sea_zones`` 里还有一批**内陆湖**（罗布泊/贝尔加/赛马湖/维纳恩… ✓）
#:     · 连通性：水块接起来**只有两个分量贴着地图边缘**（地中海 / 印度洋 ✓）
#:       → 连不到大洋的就是内陆水 ✓ 归湖 ✓
#:   → 实测结果：**海 132 · 湖 36 · 河 91** ✓（改之前是 海 129 · 湖 17 · 河 113 ✗）
#:
#: 🔴 **CK2 有没有"不可通行"那类省份** ✗（2026-10-15 用户点名要确认 ✓）：
#:   **没有** ✓ —— 依据三条，都实跑核过：
#:     · ``default.map`` 里**没有任何不可通行类** ✗（键就只有
#:       ``sea_zones`` / ``major_rivers`` / ``externals`` 那几个 ✓ 全库核过 ✓）
#:     · CK2 连"不可通行省份"这个概念都没有 ✓ —— 不能走的地方**压根不是省份** ✓
#:       它们是 ``provinces.bmp`` 上的**背景像素**（纯黑 0.45% + 纯白 7.61% ✓
#:       一共 8.06% ✓ 实跑量过 ✓）→ 认不出颜色 → 落成 pid **0** ✓
#:       （0 号是"没有省份"，不是"一块省份" ✓）
#:     · 剩下那 20 块"有像素、没头衔"的地（丝绸之路的 ``externals`` 3 块 +
#:       5 块指向已删伯爵领的残地 + 12 块别的 ✓）是**无归属** ✓ →
#:       走 ``#wasteland`` ✓ **不进 kindMask** ✗（无归属是归属/剧本决定的 ✓
#:       不是地块身份 ✓ 用户交代过 ✓）
#:   → 所以 ``#impassable`` 那一类在 CK2 里**节点数 0、kindMask 码 6 = 0** ✓
#:     这不是"没做"，是**这份数据里没有** ✓
SPECIAL_CATEGORIES: list[tuple[str, str, tuple[int, int, int], tuple[str, ...]]] = [
    # 🔴 **大河排在海洋前面** ✗（顺序要紧 ✓）—— CK2 的 ``major_rivers`` 是
    #    ``sea_zones`` 的**子集** ✓（113 个地块，全是"能通航的河"✓ 莱茵 / 易北 /
    #    伏尔加 / 尼罗河 / 恒河 … ✓ 实跑核过：113 ⊂ 259 ✓）
    #   → 按"先命中的赢"，这 113 个算**河流**、剩下的 146 个才算**海洋** ✓
    #   （``kindMask`` 里它们分别是码 4 和码 2 ✓ 见 ``kind_mask`` ✓）
    #   ⚠ 要是想全按海算 → ``--no-rivers`` ✓（那时候这一类的节点数就是 0 ✓）
    ("#river",          "河流",         ( 62, 136, 181), ("major_rivers",)),
    ("#lake",           "湖泊",         ( 47, 110, 150), ("lakes",)),            # CK2 没有 → 空
    ("#sea",            "海洋",         ( 32,  57,  92), ("sea_zones",)),
    ("#impassable_sea", "不可通行海域", ( 26,  46,  71), ("impassable_seas",)),  # CK2 没有 → 空
    ("#impassable",     "不可通行山地", ( 94, 94, 94), ("impassable_mountains",)),  # 同上 → 空
    ("#wasteland",      "无归属荒地",   (150, 150, 150), ()),                    # 兜底：剩下的空白
]

#: 伪头衔的**英文名**（``titles.json`` 的 ``namesEn`` 用 ✓）
#: 真正的头衔当然用**原版英文名** ✓ 这里只是给"类别"一个说得出口的英文说法 ✓
#: （``patch_wasteland`` 的 mode=ck3 那一支也会拿 ``Impassable`` 当荒地英文名 ✓ 同一个词 ✓）
CATEGORY_EN = {
    "#river": "River", "#lake": "Lake", "#sea": "Sea",
    "#impassable_sea": "Impassable Sea", "#impassable": "Impassable",
    "#wasteland": "Wasteland",
}

#: 这几类算"水"（``kindMask`` 的码 2/3/4/5 ✓ 也是"不算无主荒地"的那个判据 ✓）
WATER_SOURCES = ("major_rivers", "lakes", "sea_zones", "impassable_seas")

#: 这几类最细那层**逐块一个节点**（能一块块涂色 ✓）—— 都是"不可通行的陆地 / 无归属
#: 荒地"，玩家会想按周边国家给它们上色 ✓ 跟 CK3 那份一字不差 ✓
SETTABLE_CATEGORIES = ("#impassable", "#wasteland")

#: 哪些伪头衔是**水**（算荒地边长 / 判"这是不是水"时用 ✓）
#: ⚠ 前缀匹配 ✗（每层一片之后键长这样 ``#sea_e_3`` ✓ 精确相等一个都认不出来 ✓）
WATER_KEYS = ("#river", "#lake", "#sea", "#impassable_sea")

#: ``patch_wasteland`` 那边**同一套**前缀（它自己文件里也有一份 ✓ 别去动它 ✓）
_WASTE_EXCLUDE = ("#impassable_sea",)


def _is_water_key(k) -> bool:
    return str(k).startswith(WATER_KEYS)


def parse_river_segments(root: Path) -> set[int]:
    """**真正的河段** —— `adjacencies.csv` 里当过 `major_river` 穿越点的那些地块 ✓

    为什么要这一份（2026-10-16 用户追问"原版怎么定义的"之后实跑核出来的 ✓）：

      · `default.map` 的 `major_rivers` 名单有 **116** 个 ✓
      · 可其中真正出现在 `adjacencies.csv` 的 `Through` 列（`major_river` 类型 ✓）
        只有 **91** 个 ✓ —— 差出来的 **25 个全是封闭水体**：
        里海 · 咸海 · 拉多加湖 · 伊尔门湖 · 奥涅加湖 · 扎伊桑湖 · 爱尔兰三湖 ·
        里海北/南 · 蓝海 · 阿格拉甘海岸 · Kama / Votkinsk …
      · **反向是空的**：当过穿越点的 91 个，一个都不在 `major_rivers` 之外 ✓

    → 所以"河"的硬判据是 **`major_rivers` ∩ `major_river` 穿越点** ✓
      （游戏拿它做过河惩罚 ✓ 这才是它真正的用处 ✓ 名单本身混了内陆湖进去 ✗）
    → 名单里剩下那 25 个 + `sea_zones` 里的封闭水体 = **湖** ✓ 见 `find_enclosed_lakes`

    :returns: 河段地块号集合（读不到就给空集 ✓ 调用方退回名单 ✓）
    """
    csv = root / "map" / "adjacencies.csv"
    if not csv.is_file():
        return set()
    out: set[int] = set()
    # ⚠ 用 `C.read_text`（cp1252 ✓ 见 parsers/ck2/parser.py 那段编码说明 ✓）
    #   别在这儿裸 `read_text` ✗ —— 这个名字在本文件里没有 ✓（我第一版就栽了 ✓）
    for line in C.read_text(csv).splitlines()[1:]:
        parts = line.split(";")
        if len(parts) < 5 or parts[2].strip() != "major_river":
            continue
        try:
            through = int(parts[3])
        except ValueError:
            continue                      # `-1` = 没有穿越点 ✓
        if through > 0:
            out.add(through)
    return out


def find_enclosed_lakes(root: Path, defs: dict, water: set[int],
                        rivers: set[int]) -> set[int]:
    """**CK2 的湖泊** —— 数据里没有这一档 ✗ 得自己算（2026-10-16 用户点破 ✓）

    用户原话："**CK2 的湖泊和河流其实是有名字的**，而且你错误的把不少湖泊归入海域或河流"✓
    追问："为什么有些湖泊是河流（里海），有些湖泊是海洋（罗布泊）"✓

    判据（三份原始数据合起来，**不是拍脑袋** ✓ 调研见 `_local/ck2_*.py` ✓）：
      · `default.map` 里**没有 `lakes` 键** ✗（只有 `sea_zones` 区间 + `major_rivers` ✓）
      · `terrain.txt` 只有 `ocean` / `inland_ocean` 两种水，而 `terrain.bmp` 的水
        **只用了一个调色板项** → 分不出湖 ✗（实跑核过 ✓）
      · **拓扑**：四邻全是陆地的水块 = 封闭水体 ✓
      · **连通性**：把水块按邻接连起来，**只有两个分量贴着地图边缘**
        （地中海 164 块 · 印度洋 42 块 ✓）—— 那两个才是大洋 ✓
        其余 29 个分量（里海那一坨 28 块 + 一堆单块 ✓）全是内陆水 ✓

    规则（三条，按顺序判 ✓）：
      ① 在 `rivers`（真河段 ✓）里 → **河** ✓（`major_rivers` 名单里那 25 个假河已经
         被调用方剔掉了 ✓ 见 `parse_river_segments` ✓）
      ② 四邻全是陆地 → **湖** ✓
      ③ 其余 → 还是海 ✓（贴着大洋的那种 ✓）

    :returns: 该归湖泊的地块号集合 ✓
    """
    bmp = root / "map" / "provinces.bmp"
    if not bmp.is_file() or not defs:
        return set()
    rgb2pid = {(r, g, b): pid for pid, (r, g, b, _n) in defs.items()}
    raw = bmp.read_bytes()
    off = int.from_bytes(raw[10:14], "little")
    w = int.from_bytes(raw[18:22], "little", signed=True)
    h = int.from_bytes(raw[22:26], "little", signed=True)
    if w <= 0 or h <= 0:
        return set()
    bpp = int.from_bytes(raw[28:30], "little")
    step = bpp // 8
    stride = ((w * bpp // 8) + 3) // 4 * 4
    hh = abs(h)

    def at(x: int, y: int) -> int:
        x = 0 if x < 0 else (w - 1 if x >= w else x)
        y = 0 if y < 0 else (hh - 1 if y >= hh else y)
        yy = (hh - 1 - y)
        i = off + yy * stride + x * step
        return rgb2pid.get((raw[i + 2], raw[i + 1], raw[i]), 0)

    # 四邻采样（隔 3 像素一格就够 —— 湖/海的边界不是一像素宽的事 ✓）
    nbr: dict[int, set[int]] = {}
    S = 3
    for y in range(S, hh - S, S):
        for x in range(S, w - S, S):
            p = at(x, y)
            if p not in water:
                continue
            s = nbr.setdefault(p, set())
            for dx, dy in ((S, 0), (-S, 0), (0, S), (0, -S)):
                q = at(x + dx, y + dy)
                if q and q != p:
                    s.add(q)
    #: 真正的大洋 = 有地块**贴着地图边缘**的那个连通分量 ✓（实测只有地中海 + 印度洋 ✓）
    par = {p: p for p in water}

    def find(a: int) -> int:
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a

    for p, s in nbr.items():
        for q in s:
            if q not in water:
                continue
            ra, rb = find(p), find(q)
            if ra != rb:
                par[ra] = rb
    edge_roots: set[int] = set()
    for y in range(0, hh, S):
        for x in range(0, w, S):
            if x >= 6 and y >= 6 and x <= w - 7 and y <= hh - 7:
                continue
            p = at(x, y)
            if p in water:
                edge_roots.add(p)
    #: 这一块连到的是不是大洋（分量里有没有贴边的 ✓ 并查集收尾之后才算得准 ✓）
    ocean_root = {find(r) for r in edge_roots}
    about: set[int] = set()
    for p in water:
        if p in rivers:
            continue                      # ① 真河段 ✓ 不动 ✓
        s = nbr.get(p)
        inland = find(p) not in ocean_root
        if inland or (s and not (s & water)):
            about.add(p)                  # ② 内陆 / 封闭 → 湖 ✓
    log(f"  水块 {len(water)}（河段 {len(rivers)} ✓）· 落到湖 {len(about)} 个"
        f"（其中内陆分量里的 {sum(1 for p in about if find(p) not in ocean_root)} 个 ✓）")
    return about


def _en_of_node(key: str) -> str | None:
    """伪头衔节点 → 它的**英文类名**（``namesEn`` 用 ✓ 真头衔走不到这儿 ✓）。

    ⚠ **按前缀认，不能按"中文类名反查"** ✗ —— 水的片名是 ``#<地块号>`` 占位
      （CK2 没有分层水名表 ✓ 见 ``SPECIAL_CATEGORIES`` 上那段 ✓），
      荒地更麻烦：``patch_wasteland`` 会把逐块荒地统一改名叫**它扫到的第一个**
      占位号 ✓ —— 两个都不是稳定的"类名" ✓ 拿它去查表一定查不到 ✓
    """
    k = str(key)
    if k.startswith("wl_"):
        return CATEGORY_EN["#wasteland"]
    for cat, en in CATEGORY_EN.items():
        if k.startswith(cat):
            return en
    return None


# ------------------------------------------------------------------ 主流程


def main() -> int:
    global DATA
    ap = argparse.ArgumentParser(
        description="从 CK2 安装目录构建地图编辑器所需的缓存",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    # ``--root`` 是这一版的新口径 ✓；``--ck2`` 留着当别名（跟 build_eu4 的 ``--eu4``
    # 那种"一个游戏一个旗标"的老写法兼容 ✓ 两个写法都有人用，别只认一个 ✗）
    ap.add_argument("--root", "--ck2", dest="root",
                    help="CK2 安装根目录（含 map/ 与 common/）")
    ap.add_argument("--out", help="缓存写到哪个目录，默认 data_ck2/")
    ap.add_argument("--label", default="CK2 原版", help="这套地图的显示名，写进 meta")
    ap.add_argument("--scale", type=int, default=1,
                    help="省份图降采样倍数，默认 1（CK2 那张本来就只有 3072×2048 ✓）")
    ap.add_argument("--loc", action="append", default=[],
                    help="额外的 localisation 目录（汉化 mod 用 ✓ 可给多次 ✓ 后给的覆盖先给的 ✓）")
    ap.add_argument("--no-hanhua", action="store_true",
                    help="不自动找汉化 mod，名字只用原版英文")
    ap.add_argument("--no-rivers", action="store_true",
                    help="把 major_rivers 那 113 个地块按「海洋」算（默认按「河流」✓）")
    args = ap.parse_args()

    if args.scale < 1:
        raise SystemExit("--scale 得是 >= 1 的整数 ✗")

    root = find_ck2(args.root)
    if args.out:
        DATA = Path(args.out).resolve()
    DATA.mkdir(parents=True, exist_ok=True)
    log(f"游戏目录 {root}")
    log(f"输出目录 {DATA}（缩 1/{args.scale}）")

    # 1. 省份定义（**按 max_provinces 裁** ✓ 见 parse_definition 那两条坑 ✓）
    dm = root / "map" / "default.map"
    n_prov = C.parse_max_provinces(dm)
    defs = C.parse_definition(root / "map" / "definition.csv", n_prov)
    if not defs:
        raise SystemExit("definition.csv 一条都没读出来 ✗（--root 指对了吗？）")
    log(f"definition.csv：{len(defs)} 个省份（裁到 max_provinces = {n_prov} ✓）"
        f"，最大 id {max(defs)}")

    # 2. 地形分类（海 / 大河 / 丝绸之路那几条 ✓ —— 坑见 parse_default_map ✓）
    terrain = C.parse_default_map(dm)
    #: 🔴 **把"河"和"湖"两档修正过来** ✗✗（2026-10-16 用户追问"原版怎么定义"之后 ✓）
    #:   实跑核出来的两条（见 `parse_river_segments` / `find_enclosed_lakes` 的注释 ✓）：
    #:     ① `major_rivers` 名单（116）里混着 **25 个封闭水体**（里海/咸海/拉多加/伊尔门/
    #:        奥涅加/扎伊桑/爱尔兰三湖… ✓）—— 真正的河段只有 **91** 个（名单 ∩ 穿越点 ✓）
    #:     ② `sea_zones` 里还有一批**内陆湖**（罗布泊/贝尔加/赛马湖/维纳恩… ✓ 连不到大洋 ✓）
    #:   → 河只留那 91 个 ✓ 其余内陆水全归湖 ✓
    #:   ⚠ 必须在 `build_special_titles` **之前**改好 ✓（`SPECIAL_CATEGORIES` 里 `#lake`
    #:     排在 `#sea` 前面 ✓ 先命中的赢 ✓）
    #:   ⚠ `--no-rivers` 时**全不动** ✗ —— 那个开关的意思就是"全按海算" ✓ 别跟它打架 ✓
    if not args.no_rivers:
        try:
            _seas = set(terrain.get("sea_zones") or ())
            _mr = set(terrain.get("major_rivers") or ())
            _seg = parse_river_segments(root)
            if _seg:
                _real = _mr & _seg
                _fake = _mr - _seg
                terrain["major_rivers"] = _real
                log(f"河段：名单 {len(_mr)} ∩ 过河穿越点 {len(_seg)} → **真河 {len(_real)}** ✓"
                    f"（名单里那 {len(_fake)} 个不是河，转湖："
                    + "、".join(str(x) for x in sorted(_fake)) + "）")
                _mr = _real
            else:
                log("  ⚠ 没读到 adjacencies.csv，河仍按 default.map 名单算（这一版先这样 ✓）")
            _lakes = find_enclosed_lakes(root, defs, _seas | _mr, _mr)
            terrain["lakes"] = _lakes
            log(f"湖泊 {len(_lakes)} 个："
                + "、".join(str(x) for x in sorted(_lakes)))
        except Exception as exc:                      # noqa: BLE001 —— 算不出来不该拦住构建 ✓
            log(f"  ⚠ 河/湖没算出来（{type(exc).__name__}: {exc}）—— 这一版按名单老口径 ✓")
    log("default.map：" + "，".join(
        f"{k} {len(terrain.get(k) or ())}" for k in
        ("sea_zones", "major_rivers", "lakes", "impassable_seas",
         "impassable_mountains", "externals") if terrain.get(k))
        + f"（max_provinces {n_prov} ✓）")

    # 3. 头衔树（CK2 就一个文件 ✓ 只有**头衔块**往下走 ✓ b_ 整块跳过 ✓）
    log("解析 landed_titles …")
    titles, capitals = C.parse_landed_titles(
        root / "common" / "landed_titles" / "landed_titles.txt")
    log(f"头衔：{len(titles)} 个（" + "、".join(
        f"{TIER_NAME[t]} {sum(1 for x in titles.values() if x.tier == t)}"
        for t in TIER_ORDER) + f"）—— **没有男爵领** ✓ 它不上地图 ✓")

    # 4. **省份轴**：history/provinces 里的 `title = c_xxx`（CK2 唯一的省份↔头衔来源 ✓）
    log("解析 history/provinces …")
    prov_title = C.parse_province_history(root / "history" / "provinces")
    orphan: list[tuple[int, str]] = []
    for pid, key in sorted(prov_title.items()):
        t = titles.get(key)
        if t is None:
            orphan.append((pid, key))
            continue
        if pid not in t.direct_provinces:
            t.direct_provinces.append(pid)
    land_pids = sorted(prov_title)
    log(f"省份↔头衔：{len(prov_title)} 个地块（去重后 {len(set(prov_title.values()))} 个伯爵领）"
        f"，{len(land_pids)} 块陆地")
    if orphan:
        # ⚠ **不编数据** ✗ —— vanilla 里真有 5 个地块指向 landed_titles 里不存在的伯爵领
        #   （c_kirichi / c_petra / c_tarousa 那几个 ✓ 多半是砍内容时留下的尾巴 ✓）
        #   照实报出来 ✓ 那几块地在这版缓存里就是"有像素、没头衔" → 落进无归属荒地 ✓
        log(f"  ⚠ {len(orphan)} 个地块的 title 指向了 landed_titles 里没有的伯爵领"
            f"（数据本身就这样 ✓ 照实留着 ✓）："
            + "、".join(f"{p}→{k}" for p, k in orphan))

    # 5. **剧本日期**：从游戏的书签里读（**不许自己拍** ✗ 用户交代 ✓）
    bookmarks = root / "common" / "bookmarks"
    bm = C.find_bookmark(bookmarks, 1066)
    log(f"1066 剧本：{bm['key']}（{bm['name']}）· 日期 {bm['text']} · "
        f"出自 {bm['file']} 第 {bm['line']} 行 ✓"
        + ("（era = yes，是那个开场剧本 ✓）" if bm["era"] else ""))
    until = bm["date"]

    # 6. 归属 + 法理（**都按同一天** ✓ 见文件头 ③ ✓）
    log(f"解析 history/titles（只取 ≤ {bm['text']} 的）…")
    holders, lieges, dejure = C.parse_title_history(root / "history" / "titles", until, titles)
    log(f"  归属：{len(holders)} 个头衔有持有者（"
        + "、".join(f"{TIER_NAME[t]} {sum(1 for k in holders if k.startswith(t + '_'))}"
                    for t in TIER_ORDER) + f"）· {len(lieges)} 个头衔写了封君")
    log(f"  法理变更（de_jure_liege）：{len(dejure)} 条 —— 这是全库里带日期的那些 ✓")
    # ⚠ `history/provinces` **没有归属** ✗（实跑核过：那 1761 个文件里的键只有
    #   title / max_settlements / culture / religion / terrain / b_* 那几个 ✓
    #   `holder` 出现 0 次 ✓）—— CK2 的归属**只写在 history/titles 上** ✓
    #   所以这里没有"再读一遍省份历史"那一步 ✓ 不是漏了 ✓
    applied = C.apply_de_jure(dejure, titles)
    log(f"  法理按 {bm['text']} 对齐：{applied} 个头衔的父级跟 landed_titles 骨架不一样，已改 ✓")

    # 7. 名字：**汉化中文 → 原版英文 → 键名** ✓（见文件头 ④ ✓）
    log("解析 localisation …")
    #    ⚠ 伯爵领那一层取 **PROV<地块号>** ✓（1432 个 c_ 没有自己的名字 ✓ 见 prov_loc_key ✓）
    #    ⚠ **PROV 键要【全要】** ✗ —— 别只取陆地那 1740 个 ✓
    #      水与荒地的真名也是从这张表来的 ✓（见下面 11b ✓）而它们**不是陆地** ✓
    #      只取陆地的话：水名会整个退回英文 ✗（实跑抓到的：`936→Eastern Cyclades`
    #      而不是「东基克拉泽斯」✓）荒地更惨 —— 15 块一块都拿不到 ✗
    #      多要 274 条而已 ✓ 一秒钟的事 ✓ 别为了省它去读第二遍本地化 ✗
    need_prov = {C.prov_loc_key(p) for p in range(1, n_prov)}
    need_titles = set(titles)
    want = need_prov | need_titles
    en = C.parse_localisation(root / "localisation", want)          # 原版：英文那一栏 ✓
    zh: dict[str, str] = {}
    loc_dirs = [Path(d) for d in (args.loc or [])]
    if not args.no_hanhua and not loc_dirs:
        loc_dirs = ZH.find_hanhua(HANHUA_BASE)
        if loc_dirs:
            log(f"自动找到汉化：{'、'.join(str(d.parent.name) for d in loc_dirs)} ✓")
        else:
            log(f"没找到汉化 mod（找的是 {HANHUA_BASE} ✓）—— 名字就是原版英文 ✓")
    for d in loc_dirs:
        got = ZH.load_dir(d, want)
        if got:
            for k, v in got.items():
                zh.setdefault(k, v)
            log(f"  汉化 {d}：{len(got)} 条 ✓")
        else:
            log(f"  汉化 {d}：一条都没读到 ✗（路径对吗？CK2 的本地化是 *.csv、"
                f"而且是**自造三字节编码** ✓ 见 parsers/ck2/hanhua.py ✓）")
    # 伯爵领的中文名：先看它自己有没有 `c_` 条目（少 ✓），没有就取它那块地的 PROV ✓
    # ⚠ **英文名走同一条路** ✗ —— 不然 `namesEn['c_luneburg']` 只能退回键名 ✓
    #   而 `names['c_luneburg']` 却拿到了「吕讷堡」✓ 两边对不上，排查时会以为英文表缺了 ✓
    for pid, key in sorted(prov_title.items()):
        if key not in zh:
            v = zh.get(C.prov_loc_key(pid))
            if v:
                zh[key] = v
        if key not in en:
            v = en.get(C.prov_loc_key(pid))
            if v:
                en[key] = v
    # **回退链**：汉化 → 英文 → 键名 ✓
    names = {k: (zh.get(k) or en.get(k) or k) for k in need_titles}
    names_en = {k: (en.get(k) or k) for k in need_titles}

    zh_titles = sum(1 for k in need_titles if zh.get(k))
    zh_prov = sum(1 for p in land_pids if zh.get(C.prov_loc_key(p)))
    en_titles = sum(1 for k in need_titles if en.get(k))
    log(f"  中文命中：头衔 {zh_titles}/{len(need_titles)}"
        f"（按层：" + "、".join(
            f"{TIER_NAME[t]} {sum(1 for k in need_titles if k.startswith(t + '_') and zh.get(k))}"
            f"/{sum(1 for k in need_titles if k.startswith(t + '_'))}" for t in TIER_ORDER)
        + f"）· 省份 {zh_prov}/{len(land_pids)}（PROV 键 ✓）")
    log(f"  英文命中：头衔 {en_titles}/{len(need_titles)}"
        f"（取不到的按键名显示 ✓ 那是实话 ✓）")
    log("  ⚠ **PROV 那一份也是中文** ✓ —— 伯爵领那一层显示的就是它 ✓"
        "（CK2 一个省份 = 一个伯爵领 ✓ 见文件头 ① ✓）")

    # 8. 省份图
    ids, w, h, counts, pcx, pcy = build_province_map(
        root / "map" / "provinces.bmp", defs, scale=args.scale)
    present = np.zeros(n_prov, dtype=bool)
    present[np.unique(ids)] = True
    present[0] = False
    log(f"地图上有像素的地块：{int(present.sum())} 个（共 {n_prov} 位 ✓）")

    # 9. 归属表（此时只有真头衔 ✓ 剧本层那一行留空 ✓ 收尾由剧本节点填 ✓）
    ordered = rank_titles(titles)
    index_of = {t.key: i for i, t in enumerate(ordered)}
    owned = collect_provinces(titles, ordered)
    titlemap = build_titlemap(ordered, index_of, owned, n_prov, order=MAP_ORDER)

    # 10. **1066 剧本层**：谁占着哪块地（每块地归到它的**非封臣** = 独立政权 ✓）
    #     ⚠ 顺序要紧：它必须在 `build_special_titles` **之前**建 ✗ ——
    #       伪头衔（海/河/荒地）的编号是从"真头衔 + 剧本节点"之后开始的 ✓
    #       放后面就会跟剧本节点**撞号** ✓（CK3 那边踩过 ✓）
    #     ⚠ 每个非封臣政权建自己的节点 ✓ key = `1066_<原头衔 key>` ✓
    #       （跟 EU4 那边 `1444_FRA` 一个写法 ✓ 前端拿节点自己的 tier 认层 ✓）
    realm_own, n_none = build_realm_layer(
        ordered, titles, titlemap, n_prov, holders, lieges,
        None, None, None,
        {t.key: len(owned.get(t.key, ())) for t in ordered},
        order=MAP_ORDER, tiers=TIER_ORDER)

    def _resolved_color(key: str):
        """自己没色就往上继承（跟真头衔第 13 步同一套规矩 ✓ 取不到就是没有 ✓ 不编 ✗）"""
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

    # 名字落点：跟 CK3 那边**同一套规矩** —— "像素最多的那块连通域的重心" ✓
    # ⚠ 不能沿用那个顶层头衔的落点 ✗：1066 的地盘跟法理地盘常常不一样 ✓
    from build_eu4 import largest_block_centre as _lbc            # noqa: PLC0415
    _adj = build_adjacency(ids, n_prov)
    _off = np.frombuffer(_adj, dtype=np.uint32, count=n_prov + 1)
    _ngb = np.frombuffer(_adj, dtype=np.uint16, offset=(n_prov + 1) * 4)

    realm_nodes: list = []
    realm_names: dict[str, str] = {}
    realm_names_en: dict[str, str] = {}
    realm_pos: dict[str, tuple[float, float]] = {}
    realm_area: dict[str, int] = {}
    for _key in sorted(realm_own):
        from parsers.ck3.parser import Title as _Title           # noqa: PLC0415
        _t = _Title(f"{ERA_TIER}_{_key}", tier=ERA_TIER)
        _t.color = _resolved_color(_key)
        realm_nodes.append(_t)
        realm_names[_t.key] = names.get(_key) or en.get(_key) or _key
        realm_names_en[_t.key] = names_en.get(_key) or _key
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
    log(f"{ERA_TIER} 剧本层：{len(realm_nodes)} 个非封臣政权 · {_n_own} 个省份有归属 · "
        f"{n_none} 个留空（跟 EU4 的无主地一个待遇：没标记、没名字 ✓）")

    #: 伪头衔的起始序号 = 真头衔 + 剧本节点（后面一律用这个 ✓ 别再写 len(ordered) ✗）
    SPECIAL_BASE = len(ordered) + len(realm_nodes)

    # 11. 水 / 荒地：所有层级都没头衔的地块才归地形类别
    water_all = np.zeros(n_prov, dtype=bool)
    for cat in WATER_SOURCES:
        for p in (terrain.get(cat) or ()):
            i = int(p)
            if 0 <= i < n_prov:
                water_all[i] = True
    blank = np.all(titlemap == NO_TITLE, axis=0) & present & ~water_all
    log(f"完全没有头衔的地块：{int(blank.sum())} 个"
        f"（已排除 {int(water_all.sum())} 个水域 ✓ 它们不算「无主荒地」✓）")
    if blank.any():
        pids = [int(x) for x in np.nonzero(blank)[0]]
        log(f"  它们就是 CK2 的「无归属荒地」：{'、'.join(str(x) for x in pids[:20])}"
            + ("…" if len(pids) > 20 else ""))

    # 11b. 🔴 **水与荒地的真名** ✗✗（2026-10-15 用户要求 ✓）
    #
    #   用户原话："**就不能既有名字显示，同时单独一块块涂色吗**" ✓
    #   → **能** ✓ 而且两件事互不相干 ✗（别把它们绑在一起 ✓）：
    #     · **名字**：走 `titles.names` / `meta.seaNames` / `meta.wastelandNames` ✓
    #       前端在地图上出标、悬停卡片第一行都用它 ✓
    #     · **片**：**一块一片** ✓（`tier_names` / `waste_names` 一律**不传** ✗ ——
    #       那两张表是"**按名字并片**"的开关 ✓ 传了同名地块就变成一个可涂单元 ✗
    #       正好是用户不要的那个 ✗ 见 `build_tier_pieces.tier_pieces` ✓）
    #
    #   所以这儿是"**先按一块一片建好节点、再逐块把真名写回去**" ✓
    #   名字来源：`PROV<地块号>` 那张本地化表（中文优先 ✓ 退回英文 ✓ 别编 ✗）
    #   —— 259 个水地块**全部**有名字 ✓（实跑核过 ✓）、15 块无归属荒地也全部有 ✓
    #   （而且都是正经真名：`基克拉泽斯群岛` / `伏尔加河` / `撒哈拉沙漠` /
    #     `塔克拉玛干沙漠` / `丝绸之路` ×3 … ✓ —— 顺带印证了"大河那 113 个"
    #     确实是河：它们叫伏尔加河 / 多瑙河 / 莱茵河 / 尼罗河 ✓）
    #
    #   ⚠⚠ **不写上真名会出大事** ✗✗ —— 片名会留在 `#<地块号>` 那个占位号上 ✓
    #     而前端 `buildPseudoLabelPositions` 只按"是不是**类名**"过滤占位号 ✗
    #     （`isPseudoCategoryName` ✓）→ `#936` 这种会被当成一个**正常地名画到地图上** ✗
    #     （CK3 不受影响：它整段都不算 ✓；EU4/EU5 每层都有真名表、片名本来就是真名 ✓
    #      所以只有 CK2 会踩 ✓ 实跑抓到的 ✓）
    def _prov_display(pid: int) -> str | None:
        """一个地块的显示名（中文优先 → 英文 → definition.csv 那一列 ✓ 都没有就 None ✓）"""
        k = C.prov_loc_key(pid)
        return zh.get(k) or en.get(k) or (defs[pid][3] if pid in defs else "") or None

    water_names: dict[int, str] = {}
    for i in np.nonzero(water_all)[0]:
        pid = int(i)
        nm = _prov_display(pid)
        if nm:
            water_names[pid] = nm
    waste_names: dict[int, str] = {}
    for i in np.nonzero(blank)[0]:
        pid = int(i)
        nm = _prov_display(pid)
        if nm:
            waste_names[pid] = nm
    log(f"水与荒地的真名：水 {len(water_names)}/{int(water_all.sum())} 条 · "
        f"荒地 {len(waste_names)}/{int(blank.sum())} 条（中文优先 ✓ 来源 PROV<地块号> ✓）")
    if water_names:
        _show = "、".join(f"{p}→{water_names[p]}" for p in sorted(water_names)[:5])
        log(f"  样例：{_show} …")
    if waste_names:
        log("  荒地：" + "、".join(f"{p}→{waste_names[p]}" for p in sorted(waste_names)))


    # 12. 伪头衔（海 / 河 / 湖 / 荒地 ✓ 每层各造自己的片 ✓）
    #     ``kind_sink`` 把"每一类认领了哪些底层地块"带出来 → 后面烤 ``meta.kindMask`` ✓
    from build_tier_pieces import (build_special_titles as _bst,      # noqa: PLC0415
                                   apply_rows as _apply_rows,
                                   kind_mask as _kind_mask)
    special_names: dict[str, str] = {}
    kind_sink: dict[str, set[int]] = {}
    special, sp_rows, stats, waste_pids, waste_tids = _bst(
        terrain, SPECIAL_CATEGORIES, n_prov, blank | water_all, SPECIAL_BASE,
        list(TIER_ORDER),
        # 🔴 **这两张表一律不传** ✗✗（见上面 11b 那段 ✓）——
        #   它们是"**按名字并片**"的开关：传了，同名地块就变成一个可涂单元 ✗
        #   那正是用户不要的（"同时单独一块块涂色"✓）→ 名字**建完节点再逐块写回去** ✓
        tier_names=None,
        waste_names=None,
        settable=SETTABLE_CATEGORIES,
        skip_fine_tier=True,        # 兼容参数 ✓ 现在只影响"不跳过任何层"那条 ✓
        script_tiers=[ERA_TIER],
        name_sink=special_names,
        kind_sink=kind_sink,
    )
    log("地形类别：" + ("，".join(stats) if stats else "无"))

    # 12b. **逐块把真名写回去** ✓（片还是一块一片 ✓ 见 11b ✓）
    #      · 只改"**一块地一个节点**"的那些 ✗ —— 剧本层那种"整类一片"
    #        （`#sea_1066_0` 盖着 259 块 ✓）保持类名 ✓：
    #        它不是"每层一片"的键（层名是数字 ✓ `PIECE_KEY_RE` 只认字母 ✓），
    #        前端对它走 `meta.seaNames` 那条真名表的路 ✓ 名字来自表、不来自节点 ✓
    #      · `wl_<地块号>`（荒地最细层逐块 ✓）也在这儿拿到真名 ✓ ——
    #        ⚠ 光写这儿还不够 ✗：`patch_wasteland` 收尾会把它们**统一改成**
    #          "它扫到的第一个荒地节点的名字" ✗（那是为 CK3 写的：CK3 的荒地本来
    #          就没名字 ✓）→ 所以那边加了一个 `ck2` 模式**一个字都不动** ✓ 见那个文件 ✓
    node_pids: dict[int, list[int]] = {}
    for _t, _arr in sp_rows.items():
        for _tid in np.unique(_arr[_arr >= 0]):
            node_pids[int(_tid)] = [int(p) for p in np.nonzero(_arr == _tid)[0]]
    renamed = 0
    special_en: dict[str, str] = {}
    for k, sp in enumerate(special):
        _pids = node_pids.get(SPECIAL_BASE + k) or []
        if len(_pids) != 1:
            continue                       # 整类一片 / 多块一片：名字保持原样 ✓
        _key = str(sp.key)
        _pid = _pids[0]
        if _is_water_key(_key):
            nm = water_names.get(_pid)
            nm_en = en.get(C.prov_loc_key(_pid)) or defs.get(_pid, (0, 0, 0, ""))[3] or None
        elif _key.startswith("#wasteland") or _key.startswith("wl_"):
            nm = waste_names.get(_pid)
            nm_en = en.get(C.prov_loc_key(_pid)) or defs.get(_pid, (0, 0, 0, ""))[3] or None
        else:
            nm = None                       # #impassable 那两类 CK2 是空的 ✓ 用不着 ✓
            nm_en = None
        if nm and special_names.get(_key) != nm:
            special_names[_key] = nm
            renamed += 1
        if nm_en:
            special_en[_key] = nm_en        # 英文名同一条路 ✓（`namesEn` 用 ✓）
    log(f"逐块写回真名：{renamed} 个节点（片还是一块一片 ✓ 没并 ✗）")
    filled_bg = _apply_rows(titlemap, sp_rows, MAP_ORDER, TIER_ORDER)
    log(f"背景地形按层填了 {filled_bg} 个 (省份, 层级) 对")

    # 逐块荒地的**真实节点号**（建节点时记的 ✓ 别拿"尾部连续几个"反推 ✗ 差一位就全错 ✓）
    waste_tid_of = dict(zip(waste_pids, waste_tids))
    for k, sp in enumerate(special):
        key = str(sp.key)
        if not key.startswith(SETTABLE_CATEGORIES):
            continue
        if key.startswith(_WASTE_EXCLUDE):
            continue          # 不可通行海域：是水 ✗ 不是荒地 ✓（跟 CK3 同一条 ✓）
        waste_tids.append(SPECIAL_BASE + k)

    # 每一层盖了多少格 / 水多少 / 荒地多少（自证用 ✓ 照实报 ✓）
    water_tids = {SPECIAL_BASE + i for i, sp in enumerate(special) if _is_water_key(sp.key)}
    waste_tid_set = set(int(x) for x in waste_tids)
    for t in MAP_ORDER:
        row = titlemap[MAP_ORDER.index(t)]
        n_water = int(np.count_nonzero(np.isin(row, sorted(water_tids))))
        n_waste = int(np.count_nonzero(np.isin(row, sorted(waste_tid_set))))
        left = int(np.count_nonzero(row == NO_TITLE))
        log(f"  [{t}] {TIER_NAME.get(t, ERA_LABEL)}：有节点 {n_prov - left} 格"
            f"（水 {n_water} · 荒地 {n_waste}）· 仍空白 {left} 格"
            + ("（含 0 号那一格 ✓）" if left else ""))
    log(f"  伪头衔节点 {len(special)} 个（其中逐块荒地 {len(waste_pids)} 个"
        f" → wl_<地块号> ✓ 粗层荒地片也在 meta.wasteland 里 ✓）")

    # 13. 标注位置 + 颜色
    log("计算名字标注位置 …")
    gx, gy = centroids_for_titles(ordered, owned, counts, pcx, pcy, ids, index_of)
    lx, ly = gx.copy(), gy.copy()

    # ⚠ 顺序：真头衔 → 剧本节点 → 伪头衔（海 / 河 / 荒地）✓
    ordered_all = ordered + realm_nodes + special
    n_all = len(ordered_all)
    #: **全量** key → 序号（父节点查表用 ✓ 别拿 index_of ✗ 它只有真头衔 ✓）
    all_index = {t.key: i for i, t in enumerate(ordered_all)}

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
    # ⚠ 别拿"三通道和为 0"当"没颜色" ✗ —— `e_rebels` / `e_pirates` 在数据里
    #   就是 `color={ 0 0 0 }` ✓ 它们**有色**（黑色）✓ 这一行只是报个数 ✓
    log(f"颜色：{len(ordered_all)} 个节点里三通道全 0 的 {int(np.count_nonzero(colors.sum(axis=1) == 0))} 个"
        f"（CK2 那两个名义帝国本来就是黑的 ✓ 不是没取到 ✓）")

    # 14. 写缓存
    log("写出缓存 …")
    raw = titlemap.tobytes()
    packed = zlib.compress(raw, 9)
    (DATA / "titlemap.bin").write_bytes(packed)
    log(f"  titlemap.bin  {len(raw) / 1024:.0f} KB → {len(packed) / 1024:.0f} KB")

    prov_names = [""] * n_prov
    for pid, (_r, _g, _b, nm) in defs.items():
        if pid < n_prov:
            prov_names[pid] = nm

    # 🔴 **底层地块身份标** ✗✗（跟 EU5 / CK3 同一枚 ✓ 2026-10-15 定的口径 ✓）
    #   每地块 **1 字节**、base64（= 当年 ``waterMask`` 那个形状 ✓）
    #   1 陆地（**兜底** ✓ 不属于下面几类的全是它）/ 2 海洋 / 3 湖泊 / 4 河流 /
    #   5 不可通行海域 / 6 不可通行区域 ✓
    #   ⚠ **无归属区域不进这枚标** ✗（那是归属 / 剧本决定的 ✓ 不是地块身份 ✓）
    #     → CK2 那 20 块无归属荒地在标里**就是陆地（1）** ✓ 照规矩来 ✓
    #   ⚠ CK2 **没有**湖泊 / 不可通行海域 / 不可通行区域 ✗ → 码 3 / 5 / 6 老实空着 ✓
    #     依据（三条，实跑核过 ✓）见上面 ``SPECIAL_CATEGORIES`` 那段长注释 ✓
    #     —— 尤其是"不能走的地方压根不是省份、是 pid 0 的背景像素"那条 ✓
    #   ⚠ 判据是**构建期那几套现成类别集合**（``kind_sink`` ✓ 就是上面
    #     ``build_special_titles`` 认领出来的那份账 ✓ 跟"水域优先"一条口径 ✓
    #     ``#river`` 排在 ``#sea`` 前面 ✓ 所以大河那 113 个是码 4 不是码 2 ✓）
    kind_b64 = _kind_mask(n_prov, kind_sink)
    kind_n = {0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0}
    for b in base64.b64decode(kind_b64):
        if int(b) in kind_n:
            kind_n[int(b)] += 1
    # ⚠ **自证**：1~6 加起来必须 = numProvinces - 1 ✗（0 号那一格是空位 ✓）
    #   陆地是兜底 ✓ 一个空洞都不许有 ✓
    total_coded = sum(kind_n[c] for c in range(1, 7))
    assert total_coded == n_prov - 1, \
        f"kindMask 有空洞 ✗：1~6 合计 {total_coded} ≠ numProvinces-1 = {n_prov - 1}"
    assert kind_n[0] == 1, f"kindMask 的 0 号格子应该是空位 ✗（实际 {kind_n[0]} 个）"
    log("身份标 kindMask："
        + " · ".join(f"{c}={kind_n[c]}" for c in range(1, 7))
        + f"（1~6 合计 {total_coded} = numProvinces-1 = {n_prov - 1} ✓ 无空洞 ✓）")

    meta = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "game": "ck2",
        # ⚠ 键名叫 **gameRoot** ✗ 不是 CK3 那个 ``ck3_root`` ✓ ——
        #   往一个 CK2 的缓存里写 ``ck3_root`` 是假话 ✓
        #   两个键打包时都会被清掉（``pack_map.LOCAL_PATH_KEYS`` ✓）前端也都不读 ✓
        "gameRoot": str(root),
        "label": args.label or "CK2 原版",
        "provinceMap": "provinces.bmp",
        # 名字的主语言：有汉化就是中文 ✓ 没有就是英文 ✓（见文件头 ④ ✓）
        "lang": "zh" if zh else "english",
        "mapWidth": w,
        "mapHeight": h,
        "numProvinces": n_prov,
        "numTitles": n_all,
        # 剧本节点也算"真"（不是伪头衔 ✓ 跟 CK3 一个口径 ✓）
        "numRealTitles": len(ordered) + len(realm_nodes),
        "tiers": list(MAP_ORDER),
        "tierNames": [ERA_LABEL if t == ERA_TIER else TIER_NAME[t] for t in MAP_ORDER],
        # 悬停卡片左边那个小徽章：CK2 就是 key 的前缀；剧本那一格写年份 ✓
        "tierKeys": [t if t == ERA_TIER else f"{t}_" for t in MAP_ORDER],
        "entity": "头衔",
        "defaultTier": MAP_ORDER.index("c"),
        # **剧本层就是"剧本层"** ✓（跟 EU4/CK3 那边一个身份 ✓）——
        #   前端整套「年代层」的玩法全靠 ``eraDates.length`` 认（``nEra`` ✓）
        #   ⚠ 收尾时 ``patch_blank_era`` 会往后面插一格空的 ✓ 于是最终是两条 ✓
        "eraDates": [bm["text"]],
        # 法理按哪一年对齐的（读 history/titles 里带日期的 de_jure_liege 盖到骨架上 ✓）
        # 🔴 **这一枚也是给 ``patch_wasteland._detect`` 认模式用的** ✗✗（别删 ✗）
        #   它按"有没有 deJureYear"认 CK3 型数据 ✓ 没有这一枚的话，CK2 会被
        #   ``eraDates`` 那一支**误认成 EU5** ✓ → 整份数据按 EU5 的规矩去刷荒地名字 ✗
        "deJureYear": until[0],
        # 每一层从百分之多少的缩放开始上地名（剧本那两层跟帝国一样，早点出名字 ✓）
        "labelZoom": [8, 8, 30, 60, 120],
        "noTitle": NO_TITLE,
        "specialPrefix": "#",
        "colorLutWidth": 256,
        # 荒地（无归属荒地）：哪些节点算荒地 + 逐块的自动归属 ✓
        "wasteland": sorted(set(int(x) for x in waste_tids)),
        # 🔴 **水 / 荒地的"真名表"** ✗✗（2026-10-15 用户要求 ✓ 键 = **地块号**字符串 ✓
        #   跟 EU4/EU5 那两张同一个形状、同一套读法 ✓ 前端一个字节都不用改 ✓）
        #   谁在用：
        #     · `buildSeaLabelPoints()` —— 对**不是"每层一片"**的水域（CK2 只有剧本层
        #       那个整类节点 ✓ 它的层名是数字 "1066" ✓ 过不了 `PIECE_KEY_RE` ✓）
        #       **按名字分组、每组出一个标** ✓（同名的一组只出一个 ✓ 用户要的正是这个 ✓）
        #     · `waterSpecificName()` / `specificPlaceName()` —— 悬停卡片的真名 ✓
        #       （每层一片的那种走"片自己的名字"那条 ✓ 见 `build_ck2` 12b ✓ 两边同一个答案 ✓）
        #   ⚠ **不是"并片"** ✗ —— 它只管名字，涂色粒度还是**一块一片** ✓
        #   ⚠ 它只服务**剧本层那个整类水节点** ✓（`#sea_1066_0` 一个节点盖着 259 块 ✓
        #     按名字出标才合理 ✓）；地理层的水是"每层一片" ✓ 前端对片**直接让开**
        #     （`if (_piece) continue;` ✓）→ 不会叠标 ✓ 实跑核过 ✓
        "seaNames": {str(p): water_names[p] for p in sorted(water_names)},
        # 🔴 **`wastelandNames` 故意不写** ✗✗（2026-10-15 ✓ 用户口径"**都应该是一个一个标**"✓）
        #   那张表会把 20 块荒地交给前端 `buildSeaLabelPoints` 里
        #   `_piece === false` 那一支 → **按名字合组出标** ✗
        #   （实跑量到的就是 18 个 ✗「丝绸之路」3 块只出 1 个标 ✗ 正是用户不要的 ✓）
        #   ⚠ 真名**一点没丢** ✓ —— 它们逐块写在 `titles.names` 上（`wl_<地块号>` ✓
        #     见上面 12b ✓），前端两条路读到的是**同一个名字** ✓：
        #       · 地图上的标：`wl_<地块号>` 不被 hideLabel 挡 ✓（`patch_wasteland`
        #         的 ck2 模式不设它 ✓ 见那个文件 ✓）→ **一个节点一个标** ✓
        #       · 悬停第一行：`specialTileLabel` 拿最细层那个节点的名字 → "丝绸之路" ✓
        #   ⚠ 哪天前端把 `wl_<地块号>` 也认成"片"了 ✓（那它就不再参与合组 ✓）——
        #     那时候这张表加回来是**无害**的 ✓ `waste_names` 已经算好了 ✓
        #     （它现在还用在日志里 ✓ 见上面 11b ✓）
        # **底层地块身份标**（每地块 1 字节 base64 ✓ 见上面那段 ✓）
        "kindMask": kind_b64,
        # 这一版**没有**男爵领那一行 ✓（CK2 的男爵领不上地图 ✓ 见文件头 ① ✓）
        # ⚠ CK3 那边有个 ``degradedBaronies``（"男爵领缺了、拿伯爵领顶替"的名单 ✓）
        #   CK2 **不需要也不能有** ✗ —— 它压根没有男爵领那一层 ✓
        #   （键留着会让前端以为"有那一层、只是降级了" ✓ 那就是假话 ✓）
        # 剧本日期出自哪一行（回报 / 复查用 ✓ 不影响前端 ✓）
        "bookmark": {"key": bm["key"], "name": bm["name"], "date": bm["text"],
                     "file": bm["file"], "line": bm["line"]},
    }
    if args.scale > 1:
        # 只有真缩过才写 ✓（默认那条路上 meta 的形状跟 CK3 那份完全一致 ✓）
        meta["scaleDown"] = args.scale

    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                    encoding="utf-8")

    # 每个头衔的地盘数 / 面积
    prov_count = [len(owned[t.key]) for t in ordered]
    for t in realm_nodes:
        prov_count.append(len(realm_own.get(t.key[len(ERA_TIER) + 1:], ())))
    for k, sp in enumerate(special):
        idx = SPECIAL_BASE + k
        r = MAP_ORDER.index(sp.tier) if sp.tier in MAP_ORDER else None
        prov_count.append(int(np.count_nonzero(titlemap[r] == idx)) if r is not None else 0)

    area = np.zeros(n_all, dtype=np.int64)
    for i, t in enumerate(ordered):
        pids = np.fromiter((p for p in owned[t.key] if 0 < p < n_prov), dtype=np.int64)
        if pids.size:
            area[i] = int(counts[pids].sum())
    # 剧本节点：面积按它**这个剧本里**那个最大连通域算（跟真头衔同一把尺 ✓）
    for j, t in enumerate(realm_nodes):
        area[len(ordered) + j] = realm_area.get(t.key, 0)
    for k, sp in enumerate(special):
        idx = SPECIAL_BASE + k
        r = MAP_ORDER.index(sp.tier) if sp.tier in MAP_ORDER else None
        if r is not None:
            area[idx] = int(counts[titlemap[r] == idx].sum())
    for pid in waste_pids:
        idx = waste_tid_of[pid]
        area[idx] = int(counts[pid])
        prov_count[idx] = 1          # 一个节点就是一块地 ✓

    waste_pos: dict[int, tuple[float, float]] = {}
    for pid in waste_pids:
        if 0 < pid < len(pcx) and not np.isnan(pcx[pid]):
            waste_pos[waste_tid_of[pid]] = (float(pcx[pid]), float(pcy[pid]))

    def _pad_pos(arr, which: int):
        """真头衔的位置 + **剧本节点那一段** + 伪头衔那一段（跟 CK3 一个口径 ✓）"""
        mid = []
        for t in realm_nodes:
            p = realm_pos.get(t.key)
            mid.append(round(p[which], 1) if p else None)
        tail = []
        for k in range(len(special)):
            p = waste_pos.get(SPECIAL_BASE + k)
            tail.append(round(p[which], 1) if p else None)
        return ([None if np.isnan(v) else round(float(v), 1) for v in arr] + mid + tail)

    special_names_all = {key: label for key, label, _rgb, _src in SPECIAL_CATEGORIES}
    special_names_all.update(special_names)
    keys_all = [t.key for t in ordered_all]
    payload = {
        "keys": keys_all,
        # **地图层级**下标（前端拿它查 TIER_BADGE / 跳层 ✓）：剧本占 0，所以 e_ 是 1 ✓
        "tiers": [MAP_ORDER.index(t.tier) if t.tier in MAP_ORDER else len(MAP_ORDER)
                  for t in ordered_all],
        "parents": [all_index.get(t.parent, -1) if t.parent else -1 for t in ordered_all],
        # 中文优先（汉化没覆盖到的退回英文 ✓ 英文也没有就退回键名 ✓ 都是实话 ✓）
        "names": [names.get(t.key) or realm_names.get(t.key)
                  or special_names_all.get(t.key) or t.key for t in ordered_all],
        # 英文名（原版那一栏 ✓）。伪头衔：先看逐块写回那份真英文名 ✓
        # 再按**键前缀**归到它那个类别的英文说法 ✓（`_en_of_node` ✓）
        "namesEn": [names_en.get(t.key) or realm_names_en.get(t.key)
                    or special_en.get(t.key) or _en_of_node(t.key) or t.key
                    for t in ordered_all],
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
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"  titles.json  {(DATA / 'titles.json').stat().st_size / 1048576:.2f} MB")

    # 省份 id 图 + 邻接表 + 各省质心（跟 CK3 同一套 ✓）
    log("导出省份 id 图 …")
    ids_out = zlib.compress(ids.tobytes(), 6)
    (DATA / "provinces_id.bin").write_bytes(ids_out)
    log(f"  provinces_id.bin  {ids.nbytes / 1048576:.1f} MB → {len(ids_out) / 1048576:.1f} MB")

    log("导出省份邻接表和质心 …")
    adj = build_adjacency(ids, n_prov)
    (DATA / "adjacency.bin").write_bytes(zlib.compress(adj, 6))
    pos = np.stack([pcx, pcy, counts.astype(np.float64)], axis=1).astype(np.float32)
    (DATA / "prov_pos.bin").write_bytes(zlib.compress(pos.tobytes(), 6))
    log(f"  adjacency.bin {(DATA / 'adjacency.bin').stat().st_size / 1024:.0f} KB"
        f" / prov_pos.bin {(DATA / 'prov_pos.bin').stat().st_size / 1024:.0f} KB")

    log("全部完成 ✔")

    # 荒地的事后加工（幂等 ✓）：每层都指向它自己 / 标注位置 / 名字 / 隐藏地名 ✓
    # 模式按 ``deJureYear`` 认成 ck3 ✓ 于是荒地名字用类别名 ✓（跟 CK3 同一条 ✓）
    from patch_wasteland import patch as _patch_waste        # noqa: PLC0415
    _patch_waste(DATA)
    # 再补一层**空白剧本** ✓（幂等 ✓）：插在**剧本块的最右边** = 第 1 行 ✓
    #   它照抄左边那一格（= 1066 剧本层）的背景地形 ✓ —— 海还是海、陆地全无主 ✓
    #   正是"拿来从零涂的那一层" ✓（跟 EU4/EU5/CK3 一模一样 ✓）
    # ⚠ 这一步**必须在剧本层建好之后**跑 ✗ —— 没有真剧本层时它会拿"左边那一格"
    #   （空的 ✓）当来源 → 整行清零 ✓（我在只做空白层那一版踩过 ✓）
    from patch_blank_era import patch as _patch_blank        # noqa: PLC0415
    _patch_blank(DATA)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
