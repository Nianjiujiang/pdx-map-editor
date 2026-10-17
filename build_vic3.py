#!/usr/bin/env python3
"""从维多利亚3 安装目录构建地图编辑器所需的缓存 → ``data_vic3/``。

四层视图：

    1836      开局归属，按国家上色（common/country_definitions 的 color）
    战略       strategic region，142 个（**自带 map_color**，官方配色）
    地区       州（state region），781 个
    省份       province，4 万多个格子（无名，只看色块）

跟前面三套不一样的地方：

* **省份 id 是 24 位**（``provinces.png`` 的像素 ``xRRGGBB``），
  而渲染管线是 R16UI（上限 65535）—— 所以这里要把 24 位 id
  **重映射成密集序号 1..N**，前端只认序号。
* V3 只有**一个开局**（1836.1.1），没有剧本系统。
* 战略区列的是**州**（不是省份），所以 prov → state → strategic 三级链。

用法::

    python build_vic3.py
    python build_vic3.py --vic3 "D:\\Steam\\steamapps\\common\\Victoria 3"
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from build_data import NO_TITLE, build_adjacency, log                        # noqa: E402
from build_eu4 import Node, build_special_titles, find_steam_game, pick_color  # noqa: E402
from parsers.vic3 import parser as V                                                 # noqa: E402

DATA = ROOT / "data_vic3"

#: V3 只有一个开局
ERA_DATE = (1836, 1, 1)
ERA_LABEL = "1836"

#: 四层的顺序
TIER_ORDER = (ERA_LABEL, "sr", "st", "pr")
TIER_NAME = {ERA_LABEL: ERA_LABEL, "sr": "战略", "st": "地区", "pr": "省份"}
TIER_KEY = {ERA_LABEL: ERA_LABEL, "sr": "战略", "st": "地区", "pr": "省份"}

#: 锁住的地块：海、湖、不可通行（地形名里带 impassable 的，以及不属于任何州的陆地）
SPECIAL_CATEGORIES = [
    ("#lake", "湖泊", (47, 110, 150), "lakes"),
    ("#sea", "海洋", (32, 57, 92), "sea_starts"),
    ("#wasteland", "不可通行", (94, 94, 94), None),
]

#: 这些类别**最细那层每块地单独一个节点**（可以一块块涂色 ✓）
#: 🔴 2026-10-13 补 ✓ —— 上面那段原来引用的是 **EU4 模块**里的 `SETTABLE_CATEGORIES`
#:   而这里**从来没 import 过它** ✓（那段是从 `build_eu4.py` 抄的 ✓ 抄漏了一步 ✓）
#:   → `NameError` ✓ 整个 VIC3 构建当场崩 ✓
#: ⚠ **每个 build_*.py 用自己那份** ✗ 别跨模块借 —— 各游戏的地形类别本来就不一样 ✓
#:   （EU4 是 `("#wasteland",)` ✓ CK3 是 `("#impassable", "#wasteland")` ✓
#:     VIC3 只有"不可通行"这一种可涂的 ✓ 海域 / 湖泊不给涂 ✓）
VIC3_SETTABLE_CATEGORIES = ("#wasteland",)


def find_vic3(explicit: str | None = None) -> Path:
    return find_steam_game(explicit, "Victoria 3", "game/map_data/provinces.png", "--vic3")


def game_version(root: Path) -> str:
    import json as _json
    for name in ("launcher-settings.json", "game/launcher-settings.json"):
        fp = Path(root) / name
        if fp.is_file():
            try:
                data = _json.loads(fp.read_text(encoding="utf-8-sig", errors="replace"))
                for k in ("version", "rawVersion", "gameVersion"):
                    if data.get(k):
                        return str(data[k])
            except (OSError, ValueError):
                pass
    return "?"


def prov_key(dense: int) -> str:
    return f"p_{dense}"


_DYN = {}


def dyn_names(G):
    """动态国名（附庸/共主邦联时换显示名）。读一次就缓存，读不到就返回空表。"""
    if "dyn" not in _DYN:
        try:
            from parsers.vic3.dynamic_names import load_pacts, load_dynamic_names
            _DYN["pacts"] = load_pacts(G / "common" / "history" / "diplomacy")
            _DYN["dyn"] = load_dynamic_names(
                G / "common" / "dynamic_country_names" / "00_dynamic_country_names.txt")
            log(f"  动态国名：关系 {len(_DYN['pacts'])} 条 / 候选 {len(_DYN['dyn'])} 个 tag")
        except Exception as exc:          # 读不到就当没有，不能因此构建不出图
            log(f"  ！动态国名读取失败（跳过）：{exc}")
            _DYN["pacts"], _DYN["dyn"] = {}, {}
    return _DYN["pacts"], _DYN["dyn"]


def main() -> int:
    global DATA
    ap = argparse.ArgumentParser(description="从维多利亚3 安装目录构建制地图缓存")
    ap.add_argument("--vic3", help="VIC3 安装根目录（含 game/map_data）")
    ap.add_argument("--out", help="缓存写到哪个目录，默认 data_vic3/")
    #: 🔴 2026-10-16 用户定的：显示名「VIC3」（原来是 `V3` ✓）
    #:   ⚠ 只改**给人看的那个词** ✗ —— `--out` 的 `data_vic3/` 与 meta 里的
    #:     `game: vic3` 一律不动 ✓（那是数据 / 存档 / 路径的标识 ✓）
    ap.add_argument("--label", default="VIC3 原版", help="这套地图的显示名，写进 meta")
    args = ap.parse_args()

    root = find_vic3(args.vic3)
    G = root / "game"
    if args.out:
        DATA = Path(args.out).resolve()
    DATA.mkdir(parents=True, exist_ok=True)
    log(f"维多利亚3 {game_version(root)} @ {root}")
    log(f"输出目录 {DATA}")

    # 1. 省份图：像素就是 24 位 id
    raw_ids, w, h = V.parse_provinces(G / "map_data" / "provinces.png")
    log(f"provinces.png {w}×{h}，不同省份 id {len(np.unique(raw_ids))} 个")

    # 2. 州 / 战略区 / 归属 / 地形
    states = V.parse_state_regions(G / "map_data" / "state_regions")
    srs = V.parse_strategic_regions(G / "common" / "strategic_regions")
    owned = V.parse_states_history(G / "common" / "history" / "states" / "00_states.txt")
    default_map = V.parse_default_map(G / "map_data" / "default.map")
    terrains = V.parse_province_terrains(G / "map_data" / "province_terrains.txt")
    log(f"州 {len(states)} / 归属条目 {len(owned)} 条 / 战略区 {len(srs)} / 地形 {len(terrains)} 条")
    log("default.map：" + "，".join(f"{k} {len(v)}" for k, v in default_map.items()))

    # 3. 24 位 id → 密集序号。渲染管线是 R16UI，装不下 24 位
    known = set(int(x) for x in np.unique(raw_ids))
    known.discard(0)
    for s in states.values():
        known.update(s.provinces)
    known.update(default_map.get("sea_starts", []))
    known.update(default_map.get("lakes", []))
    dense_of = {rid: i + 1 for i, rid in enumerate(sorted(known))}
    n_prov = len(dense_of) + 1
    log(f"省份 id 重映射：{len(known)} 个 24 位 id → 1..{n_prov - 1}（R16UI 只装得下 65535）")

    lut = np.zeros(1 << 24, dtype=np.uint16)
    for rid, d in dense_of.items():
        lut[rid] = d
    ids = lut[raw_ids]
    log(f"  映射后最大序号 {int(ids.max())}")

    present = np.zeros(n_prov, dtype=bool)
    present[np.unique(ids)] = True
    present[0] = False

    def flag(raw_list) -> np.ndarray:
        a = np.zeros(n_prov, dtype=bool)
        v = np.fromiter((dense_of[r] for r in raw_list if r in dense_of), dtype=np.int64)
        if v.size:
            a[v] = True
        return a

    is_sea = flag(default_map.get("sea_starts", []))
    is_lake = flag(default_map.get("lakes", []))
    impassable = np.zeros(n_prov, dtype=bool)
    for rid, terr in terrains.items():
        if "impassable" in terr and rid in dense_of:
            impassable[dense_of[rid]] = True
    land = present & ~is_sea & ~is_lake
    log(f"地图上 {int(present.sum())} 个省份：陆地 {int(land.sum())}，"
        f"海 {int((is_sea & present).sum())}，湖 {int((is_lake & present).sum())}，"
        f"不可通行地形 {int((impassable & present).sum())}")

    # 4. 归属链：省份 → 州 → 战略区
    prov_state: dict[int, str] = {}
    for key, s in states.items():
        for rid in s.provinces:
            d = dense_of.get(rid)
            if d and land[d] and d not in prov_state:
                prov_state[d] = key
    state_sr: dict[str, str] = {}
    for key, sr in srs.items():
        for skey in sr.states:
            state_sr.setdefault(skey, key)

    land_pids = [int(p) for p in np.nonzero(land)[0]]
    no_state = [p for p in land_pids if p not in prov_state]
    log(f"陆地里不属于任何州的 {len(no_state)} 个 —— 这些就是 V3 的不可通行荒地")

    used_states = {prov_state[p] for p in land_pids if p in prov_state}
    used_sr = {state_sr[s] for s in used_states if s in state_sr}
    log(f"用得上的节点：战略区 {len(used_sr)} / 州 {len(used_states)} / 省份 {len(land_pids)}")

    # 1836 归属：**看最低单位（省份）**。
    # 州只是地理单位，一个州可以被几个国家瓜分 —— 每一条 create_state 里的
    # owned_provinces 才是真正占着的地。按州取国家的话，被瓜分的州会整块算给一家。
    owners: dict[int, str] = {}
    per_state: dict[str, set] = {}
    for o in owned:
        if o.country:
            per_state.setdefault(o.state, set()).add(o.country)
        for rid in o.provinces:
            d = dense_of.get(rid)
            if d and land[d] and d not in owners:
                owners[d] = o.country
    split = {k: v for k, v in per_state.items() if len(v) > 1}
    log(f"  {ERA_LABEL}：有主 {len(owners)} 省 / {len(set(owners.values()))} 个国家"
        f"（被瓜分的州 {len(split)} 个）")

    # 需求：1836（维多利亚3 唯一的剧本）把西藏并入中国 ——
    # 当时西藏在清朝治下，游戏里却是个独立 tag TIB，数据上换成 CHI。
    moved = [p2 for p2, t2 in owners.items() if t2 == "TIB"]
    for p2 in moved:
        owners[p2] = "CHI"
    if moved:
        log(f"    （西藏 {len(moved)} 省并入中国 CHI）")
    if split:
        k0 = sorted(split)[0]
        log(f"    例：{k0} 分属 {'、'.join(sorted(split[k0]))}")
    unowned = [p for p in land_pids if p not in owners]
    log(f"    没有任何国家占着的陆地 {len(unowned)} 个"
        f"（{'、'.join(str(x) for x in unowned[:6])}）" if unowned else "    陆地全都有主")

    # 5. 颜色与名字
    cd = V.parse_country_definitions(G / "common" / "country_definitions")
    # 本地化的键：州是 STATE_XXX（used_states 里已经是这个写法），
    # 战略区就是它的 key，国家就是 tag。别再加前缀 —— 加了会变成
    # STATE_STATE_XXX，于是一个州名都取不到。
    # hub 名：州里的 city / port / farm / mine / wood 那些地块有名字，
    # 键是 HUB_NAME_<州>_<字段>。维多利亚3 地图上放大的时候显示的就是这些。
    hub_key: dict[int, str] = {}
    for skey, s in states.items():
        for field, hid in s.hubs.items():
            d = dense_of.get(hid)
            if d and land[d] and d not in hub_key:
                hub_key[d] = f"HUB_NAME_{skey}_{field}"

    want = {k if k.startswith("STATE_") else f"STATE_{k}" for k in used_states}
    want |= set(hub_key.values())
    want |= set(used_sr)
    want |= set(owners.values())

    # **所有国家定义都要查**（不只是开局有地盘的）——
    # 不然 countryTags 里那些没地盘的 tag 只能显示 tag 本身 ✗
    want |= set(cd)
    # 动态国名的名字键也要一起读进来 —— 否则"中文表里有才换"那道判断永远不成立
    _pk0, _dn0 = dyn_names(G)
    for _cands in _dn0.values():
        for _c in _cands:
            want.add(_c["name"])
    zh = V.load_loc(G, "simp_chinese", want)
    en = V.load_loc(G, "english", want)
    log(f"名字：简体中文 {len(zh)} 条 / 英文 {len(en)} 条（要 {len(want)} 个键，"
        f"国家定义 {len(cd)} 个）")

    # 6. 组树
    ordered: list[Node] = []
    index_of: dict[str, int] = {}

    def add(t: Node) -> Node:
        index_of[t.key] = len(ordered)
        ordered.append(t)
        return t

    for tag in sorted(set(owners.values())):
        t = add(Node(f"{ERA_LABEL}_{tag}", ERA_LABEL))
        t.color = (cd.get(tag) or (None,))[0] or (128, 128, 128)

    # 战略区：配色用官方的 map_color。**纯白的不算数** —— 9 个欧洲战略区
    # 官方就写着 map_color = { 1 1 1 }，画出来等于没颜色，给他现配一个。
    sr_placed: list = []
    for i, key in enumerate(sorted(used_sr)):
        t = add(Node(key, "sr"))
        c = srs[key].color
        if min(c) > 235:
            c = pick_color((i * 47.0) % 360.0, 70.0, sr_placed)
        sr_placed.append(c)
        t.color = c

    # 州：同一个战略区里的兄弟散开（V3 没给州配色）
    groups: dict[str, list[str]] = {}
    for key in sorted(used_states):
        groups.setdefault(state_sr.get(key, ""), []).append(key)
    for parent, kids in sorted(groups.items()):
        base = 210.0
        if parent in srs:
            # 完整的三扇区 RGB→hue 公式：原来只写了 max==R 那个扇区的分支
            # 还对一切颜色套用 —— 纯绿算出 0°（真 120°）、纯蓝算出 300°（真 240°）
            r, g, b = srs[parent].color
            mx = max(r, g, b)
            if mx == 0 or mx == min(r, g, b):
                base = 210.0
            else:
                d = mx - min(r, g, b)
                # 变量名别叫 h ✗ —— main() 里 h 是地图高度，这里一覆盖，
                # 后面 np.mgrid[0:h, 0:w] 拿到的就是角度值，质心那步直接崩
                if mx == r:
                    hue = ((g - b) / d) % 6
                elif mx == g:
                    hue = (b - r) / d + 2
                else:
                    hue = (r - g) / d + 4
                base = (60.0 * hue) % 360.0
        placed: list = []
        for i, key in enumerate(kids):
            col = pick_color((base + i * 17.0) % 360.0, 62.0, placed)
            placed.append(col)
            t = add(Node(f"STATE_{key}" if not key.startswith("STATE_") else key, "st"))
            t.parent = parent or None
            t.color = col

    # 省份：颜色在所属州的色相附近散开
    hue_of: dict[str, float] = {}
    for i, key in enumerate(sorted(used_states)):
        hue_of[key] = (i * 137.508) % 360.0
    for p in sorted(land_pids):
        skey = prov_state.get(p)
        base = hue_of.get(skey, 200.0)
        t = add(Node(prov_key(p), "pr", p))
        t.parent = (skey if skey and skey.startswith("STATE_") else f"STATE_{skey}") \
            if skey else None
        t.color = pick_color(base, 14.0, [])

    n_real = len(ordered)
    log(f"真节点 {n_real} 个（国家 {len(set(owners.values()))} / 战略 {len(used_sr)}"
        f" / 州 {len(used_states)} / 省份 {len(land_pids)}）")

    # 7. 归属表
    titlemap = np.full((len(TIER_ORDER), n_prov), NO_TITLE, dtype=np.uint16)
    for p in land_pids:
        titlemap[3, p] = index_of[prov_key(p)]
        skey = prov_state.get(p)
        if skey:
            tk = skey if skey.startswith("STATE_") else f"STATE_{skey}"
            if tk in index_of:
                titlemap[2, p] = index_of[tk]
            srkey = state_sr.get(skey)
            if srkey and srkey in index_of:
                titlemap[1, p] = index_of[srkey]
        tag = owners.get(p)
        if tag:
            k = f"{ERA_LABEL}_{tag}"
            if k in index_of:
                titlemap[0, p] = index_of[k]

    # 8. 海 / 湖 / 不可通行 —— **每一层一片**（2026-10-13 架构统一 ✓）
    blank = (np.all(titlemap == NO_TITLE, axis=0) & present) | (impassable & present)
    # 🔴🔴 **水域不算"空白"** ✗✗（2026-10-14 ✓ 用户要求 ✓ 跟 CK3 同一刀 ✓）
    #
    #   用户："你就不能把水域变成一个**仅仅是不能填色的地块**吗……
    #     最底层的单位也有自己的 Province id"✓
    #     "和陆地一样啊，**大名，河北，华北**，这样下来"（= 逐块 / 地区 / 大区 ✓）
    #     "只是水域**带一个小标签**来让他在**边界和颜色**等方面听从相关的开关，
    #      **其他逻辑不变**"
    #
    #   → 水域**不再造伪头衔** ✓ 于是它"所有层都无主"✓ 正好落进上面这个 blank ✗
    #     → 被「**不可通行**」那片盖住 ✓（CK3 那边实跑量到过：悬停海拿到的 tid
    #       是 `#wasteland_c_3` ✓ 于是**海的高亮跟着荒地整片亮** ✗）
    #   → 必须**排除在 blank 之外** ✓ 那它就"完全无归属"✓
    #     身份靠 `pid` + `meta.waterMask`（那个"小标签"✓）——
    #     颜色走海域色 ✓ 边界听水域那两条开关 ✓ 高亮按 pid ✓ 别的全跟普通地块一样 ✓
    #
    #   ⚠ 水域**不能**进 `#wasteland` ✗ —— 荒地是"可以一块块涂色"的 ✓
    #     水域**不能填色** ✓ 两者待遇相反 ✓
    #   ⚠ VIC3 **只有一层水域数据** ✗（一个海州正好一个省 ✓ 战略区 1:1 ✓
    #     见 `load_water_names_by_tier` 的说明 ✓）→ 所以它**一层伪头衔都不造** ✓
    #     跟 CK3 一样 ✓（EU4 / EU5 / HOI4 有真层级 ✓ 它们**粗层保留** ✓） */
    #   ⚠ VIC3 这边变量叫 `is_sea` / `is_lake`（**布尔数组** ✓ 现成的 ✓）
    #     别去 `terrains` 里按名字找 ✗ —— 那是"地形分类"那张表 ✓ 名字不一样 ✓
    _water_all = np.asarray(is_sea, dtype=bool) | np.asarray(is_lake, dtype=bool)
    blank = blank & ~_water_all
    log(f"完全没有归属的地块：{int(blank.sum())} 个"
        f"（已排除 {int(_water_all.sum())} 个水域 ✓ 它们不算「无主荒地」✓）")
    _special_names_v: dict[str, str] = {}
    #: **地理层** = 年份层右边那三层（sr / st / pr ✓）
    _geo = list(TIER_ORDER[1:])
    # ⚠ VIC3 只有**一张**水名表（`load_water_names` ✓ 没有 by_tier 那一版）——
    #   海区是一区一省（游戏规定 ✓），所以三层拿同一张表分片 ✓
    #   每层仍旧**各有各的节点** ✓（这就是"每层自己的归属"那个骨架 ✓）
    _wtier: dict[str, dict[int, str]] = {t: {} for t in _geo}
    try:
        _one = dict(V.load_water_names(root) or {})
        for _t in _geo:
            _wtier[_t] = dict(_one)
        log(f"水名表：{len(_one)} 条（三层共用 ✓）")
    except Exception as _e:            # 解析不出来不该拖垮整个构建 ✓
        log(f"水名表跳过：{_e}")
    special, _sp_rows, stats, waste_pids, _waste_tids = build_special_titles(
        # 🔴 **`skip_fine_tier=True`** ✗（2026-10-14 ✓ 用户要求 ✓）
        #   水域**最细层不造片** ✓（它就是它自己那个 province ✓）而**粗层照造** ✓
        #   用户："和陆地一样啊，**大名，河北，华北**，这样下来"✓
        #     → VIC3 的 `sr`（战略区）/ `st`（州）那两级**照旧造** ✓
        #       `pr`（省份）那级**不造** ✓
        #   ⚠ VIC3 **只有一层水域数据** ✗（一个海州正好一个省 ✓ 战略区 1:1 ✓
        #     见 `load_water_names_by_tier` 的说明 ✓）
        #     → 所以 sr / st 两级聚出来的片**是一样的** ✓ 名字也一样 ✓
        #       这**不是 bug** ✗ 是"游戏内容只有一层"✓（跟 HOI4 那个"省份级=地区级"同类 ✓）
        #   ⚠ 只影响"造片"那一步 ✗ —— `blank` / `waterMask` 都不受影响 ✓
        {"sea_starts": set(np.nonzero(is_sea)[0].tolist()),
         "lakes": set(np.nonzero(is_lake)[0].tolist())},
        n_prov, blank | _water_all, n_real, categories=SPECIAL_CATEGORIES,
        # 🔴 **剧本层：每一类共用一个「海洋」节点** ✗（2026-10-14 ✓ 用户的主意 ✓）
        script_tiers=[t for t in TIER_ORDER if t not in _geo],
        fine_tier=_geo[-1], geo_tiers=_geo, tier_names=_wtier,
        skip_fine_tier=True,
        name_sink=_special_names_v)
    log("锁住的地形：" + ("，".join(stats) if stats else "无"))

    # 🔴🔴 **底层地块的"身份标"** ✗✗（2026-10-16 补 ✓ 用户点名要的 ✓）
    #   跟 `build_data.py`(CK3) / `build_ck2.py` / `build_eu4.py` / `build_eu5.py` /
    #     `build_hoi4.py` 同一枚 ✓
    #   → `meta.kindMask`：每地块 **1 字节**、base64
    #     1 陆地（兜底）/ 2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域 / 6 不可通行区域 ✓
    #   ⚠ VIC3 **只有海和湖** ✗（`sea_starts` / `lakes` 两张名单 ✓
    #     码 4 / 5 两格全图落"陆地 1" ✓ 不编假数据 ✓）
    #   ⚠🔴 **`#wasteland` 那 793 块故意不进标** ✗✗ ——
    #     它那一类里**混着两种东西**（见 `SPECIAL_CATEGORIES` 上面那段注释 ✓）：
    #       ① 地形名带 `impassable` 的**真的不可通行** ✓（该给码 6 ✓）
    #       ② "不属于任何州"的**没编进州里的陆地**（其实是能走的 ✓ 该给码 1 ✓）
    #     两样合在一个类别里，**分不开** ✗ → 硬给码 6 = 把一片陆地涂成"不可通行灰" ✗
    #     → 所以这一类**一个都不标** ✓ 全落"陆地 1" ✓
    #     ⚠ 这跟改造前**一模一样** ✓ 实测：VIC3 认水 海 106 · 湖 52 ✓
    #       而 kindMask 会发的正是同样这 158 块 ✓ **显示口径零变化** ✓
    #     （真要细分得先把那 793 块拆成两类 ✓ 那是另一件事 ✗ 别在这一轮夹带 ✓）
    #   ⚠ 判据就是**上面传给 `build_special_titles` 的那两份名单** ✓ 同源 ✓
    #   ⚠ **不许拿 `{ }` 当作用域块** ✗（Python 里那不是块 ✓ 见 build_data.py 那条教训 ✓）
    import base64 as _kind_b64mod                                 # noqa: PLC0415
    from build_tier_pieces import (kind_mask as _kind_mask,       # noqa: PLC0415
                                   KIND_CODES as _KIND_CODES)
    _kind_cat: dict[str, set[int]] = {}
    for _kkey, _kmask in (("#sea", is_sea), ("#lake", is_lake)):
        if _kkey not in _KIND_CODES:
            continue
        # ⚠ VIC3 这边**没有 `terrain` 那个字典** ✗ —— 它读的是 `default.map`
        #   上的两个布尔数组（`is_sea` / `is_lake` ✓ 见上面 170 行那两行 ✓）
        #   所以直接拿数组里的下标 ✓ 跟传给 `build_special_titles` 的那两份**同源** ✓
        _ks = {int(p) for p in np.nonzero(_kmask)[0].tolist() if 0 < int(p) < n_prov}
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
        + f"（1~6 合计 {_kind_tot} = numProvinces-1 ✓ 无空洞 ✓"
        + " ｜ `#wasteland` 那 793 块按「无归属 ≠ 身份」故意不标 ✓）")
    from build_tier_pieces import apply_rows as _apply_rows        # noqa: PLC0415
    log(f"背景地形按层填了 {_apply_rows(titlemap, _sp_rows, TIER_ORDER, _geo)} 个"
        f" (省份, 层级) 对（年份层借最粗那层的片 ✓）")

    # 荒地节点序号（建节点时记下的真实序号）+ 粗层那些"整片"伪头衔
    #（前端"荒漠·涂色"关着时它要显示灰）
    # ⚠ 判据一律**前缀匹配** ✗ —— 每层一片之后，键是 `#sea_pr_57` 这种 ✓
    waste_tids = list(_waste_tids)
    water_tids = set()
    for k, sp in enumerate(special):
        _k = str(sp.key)
        if _k.startswith(("#sea", "#lake", "#river", "#impassable_sea")):
            water_tids.add(n_real + k)
        # 🔴 **VIC3 自己的"可涂色"类别** ✗（2026-10-13 修 ✓）
        #   这里原来写的是 `SETTABLE_CATEGORIES` ✗ —— 那是 **EU4 模块**里的常量 ✓
        #   而 `build_vic3.py` 从头到尾**没 import 过它** ✓
        #   （那段是从 `build_eu4.py` 抄过来的 ✓ 抄漏了那一步 ✓）
        #   → `NameError: name 'SETTABLE_CATEGORIES' is not defined` ✓ 整个构建当场崩 ✓
        #   ✅ 用 VIC3 自己那套：它的地形只有 湖泊 / 海洋 / 不可通行 ✓
        #      "可以一块块涂色"的只有**不可通行**（跟 CK3 的不可通行山地同理 ✓
        #      玩家会想按周边国家给它上色 ✓）—— 海域 / 湖泊不给涂 ✓
        #   ⚠ 键名要**前缀**匹配 ✗ —— 每层一片之后是 `#impassable_sr_0` 这种 ✓
        #   ⚠ 用元组常量而不是内联字符串 ✗ 以后加类别只改一处 ✓
        if _k.startswith(VIC3_SETTABLE_CATEGORIES):
            waste_tids.append(n_real + k)


    ordered_all = ordered + special
    n_all = len(ordered_all)

    # 9. 像素数 / 质心
    counts = np.bincount(ids.ravel().astype(np.int64), minlength=n_prov)[:n_prov]
    ys, xs = np.mgrid[0:h, 0:w]
    ysum = np.bincount(ids.ravel().astype(np.int64), weights=ys.ravel().astype(np.float64),
                       minlength=n_prov)[:n_prov]
    xsum = np.bincount(ids.ravel().astype(np.int64), weights=xs.ravel().astype(np.float64),
                       minlength=n_prov)[:n_prov]
    pcx = np.where(counts > 0, xsum / np.maximum(counts, 1), 0.0).astype(np.float32)
    pcy = np.where(counts > 0, ysum / np.maximum(counts, 1), 0.0).astype(np.float32)
    log(f"算出 {int((counts > 0).sum())} 个省份的质心")

    # 10. 成员 → 地盘数、面积
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

    # 11. 标注位置：像素最多的连通块的重心
    adj = build_adjacency(ids, n_prov)
    offsets = np.frombuffer(adj, dtype=np.uint32, count=n_prov + 1)
    neigh = np.frombuffer(adj, dtype=np.uint16, offset=(n_prov + 1) * 4)
    lx = np.full(n_all, np.nan, dtype=np.float32)
    ly = np.full(n_all, np.nan, dtype=np.float32)
    block_area = np.zeros(n_all, dtype=np.int64)
    from build_eu4 import largest_block_centre
    for i, m in enumerate(members):
        c = largest_block_centre(m, offsets, neigh, counts, pcx, pcy)
        if c is not None:
            lx[i], ly[i] = c[0], c[1]
            block_area[i] = c[2]
    lx[n_real:] = np.nan
    ly[n_real:] = np.nan
    log("标注位置：每块地取像素最多的那个连通块的重心")

    # 12. 名字
    special_names = {k: label for k, label, _c, _s in SPECIAL_CATEGORIES}
    # ⚠ 每层一片之后，键是 `#sea_pr_57` 这种 ✗ —— 只有类别名那张表查不到它们 ✓
    #   必须把 `build_special_titles` 带出来的**逐片真名**并进来 ✓
    special_names.update(_special_names_v)
    resolved: list[str] = []
    names_en: list[str] = []
    key_of: list[str] = []
    zh_used = 0
    for t in ordered_all:
        if t.key in special_names:
            resolved.append(special_names[t.key])
            names_en.append("")
            key_of.append("")
            continue
        if t.tier == "pr":
            k = hub_key.get(getattr(t, "pid", 0), "") if getattr(t, "pid", 0) else ""   # 是 hub 的省份有名字，其余无名
        elif t.tier == ERA_LABEL:
            k = t.key.split("_", 1)[1]
            # 动态国名：**只换显示名**。tag、颜色、归属、格子数全都不动。
            try:
                from parsers.vic3.dynamic_names import resolve as _resolve
                _pk, _dn = dyn_names(G)
                _dk = _resolve(k, _pk, _dn)
                if _dk and (_dk in zh or _dk in en):
                    log(f"    {k} → {_dk}（附庸/共主邦联名）")
                    k = _dk
            except Exception:
                pass
        elif t.tier == "st":
            k = t.key if t.key.startswith("STATE_") else f"STATE_{t.key}"
        else:
            k = t.key
        key_of.append(k)
        z = zh.get(k) if k else None
        e = en.get(k, "") if k else ""
        if z:
            zh_used += 1
        resolved.append(z or e)
        names_en.append(e if e and e != z else "")
    hub_named = sum(1 for p in land_pids if p in hub_key)
    log(f"  有地名的省份 {hub_named} 个（州里的 city/port/farm/mine/wood）")
    named_all = sum(1 for v in resolved if v)
    log(f"  {zh_used} 个用了中文名（有名字的节点共 {named_all} 个）")

    # 13. 颜色表
    colors = np.zeros((n_all, 3), dtype=np.uint8)
    for i, t in enumerate(ordered_all):
        c = t.color
        if c is None:
            pi = index_of.get(t.parent) if t.parent else None
            c = colors[pi] if pi is not None else (150, 150, 150)
        colors[i] = c

    # 14. 写盘
    log("写出缓存 …")
    raw = titlemap.astype("<u2").tobytes()
    packed = zlib.compress(raw, 9)
    (DATA / "titlemap.bin").write_bytes(packed)
    log(f"  titlemap.bin  {len(raw)/1024:.0f} KB → {len(packed)/1024:.0f} KB")

    payload = {
        "keys": [t.key for t in ordered_all],
        "tiers": [TIER_ORDER.index(t.tier) if t.tier in TIER_ORDER else len(TIER_ORDER)
                  for t in ordered_all],
        "parents": [index_of.get(t.parent, -1) if t.parent else -1 for t in ordered_all],
        "names": resolved,
        "namesEn": names_en,
        "locKeys": key_of,
        "colors": colors.tolist(),
        "provCount": prov_count,
        "area": area.tolist(),

        "blockArea": block_area.tolist(),
        "lx": [None if np.isnan(v) else round(float(v), 1) for v in lx],
        "ly": [None if np.isnan(v) else round(float(v), 1) for v in ly],
        "gx": [None if np.isnan(v) else round(float(v), 1) for v in lx],
        "gy": [None if np.isnan(v) else round(float(v), 1) for v in ly],
    }
    (DATA / "titles.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"  titles.json  {(DATA / 'titles.json').stat().st_size/1024/1024:.1f} MB")

    log("导出省份 id 图 …")
    pid_raw = ids.astype("<u2").tobytes()
    pid_packed = zlib.compress(pid_raw, 6)
    (DATA / "provinces_id.bin").write_bytes(pid_packed)
    log(f"  provinces_id.bin  {len(pid_raw)/1024/1024:.1f} MB → {len(pid_packed)/1024/1024:.1f} MB")

    log("导出邻接表和质心 …")
    (DATA / "adjacency.bin").write_bytes(zlib.compress(adj, 6))
    pos_arr = np.stack([pcx, pcy, counts.astype(np.float64)], axis=1).astype(np.float32)
    (DATA / "prov_pos.bin").write_bytes(zlib.compress(pos_arr.tobytes(), 6))

    meta = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "game": "vic3",
        "gameVersion": game_version(root),
        "gameRoot": str(root),
        "label": args.label,
        "provinceMap": "provinces.png",
        "nameLang": "zh" if named_all and zh_used >= named_all * 0.9 else "en",
        "mapWidth": w,
        "mapHeight": h,
        "numProvinces": n_prov,
        # **底层地块身份标**（每地块 1 字节 base64 ✓ 2026-10-16 补 ✓
        #   1 陆地 / 2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域 / 6 不可通行区域 ✓
        #   VIC3 只有前三种（`sea_starts` / `lakes` 两张名单 ✓）
        #   ⚠ `#wasteland` 那 793 块**故意不标**（里面混着"真不可通行"与
        #     "没编进州的陆地"，分不开 ✓ 详见烤标那一段 ✓）✓）
        "kindMask": _kind_b64,
        "numTitles": n_all,
        "numRealTitles": n_real,
        "tiers": list(TIER_ORDER),
        "tierNames": [TIER_NAME[t] for t in TIER_ORDER],
        "tierKeys": [TIER_KEY[t] for t in TIER_ORDER],
        "entity": "省份",
        "defaultTier": 2,               # 州是 V3 的基本单位，而且全都有名字
        # **全部 tag** 的名字 + 颜色（含当前年代没地盘的）—— 搜索/取色要用 ✓
        # 名字先放 tag：中文名由 patch_wasteland 从 titles.json 统一补 ✓
        "countryTags": {tag: {"n": (zh.get(tag) or en.get(tag) or tag),
                             "c": list((cd.get(tag) or (None,))[0] or (128, 128, 128))}
                        for tag in sorted(cd)},
        "labelZoom": [14, 45, 90, 150],
        "eraDates": [f"{ERA_DATE[0]}.{ERA_DATE[1]}.{ERA_DATE[2]}"],
        "noTitle": NO_TITLE,
        "specialPrefix": "#",
        "colorLutWidth": 256,
        # 荒地：哪些节点算荒地 + 逐块的自动归属（口径同 EU4/EU5/CK3）
        "wasteland": sorted(set(waste_tids)),
        "lockedKinds": [k for k, *_ in SPECIAL_CATEGORIES],
        "landProvinces": int(land.sum()),
        "noStateProvinces": len(no_state),
        "impassableProvinces": int((impassable & present).sum()),
        "remappedIds": len(known),
    }
    # **水域名**（2026-10-13 ✓ 出处见 docs/水域名调研.md）
    #   { 地块 id : "北海" } —— 编辑器拿它画具体海域名（悬停一行 + 地图标签 ✓）
    #   ⚠ VIC3 的权威名单是 game/map_data/state_regions/99_seas.txt 那 106 条 ✓
    try:
        _wn = V.load_water_names(root)
        if _wn:
            meta["seaNames"] = {str(k): str(v) for k, v in _wn.items()}
            log(f"水域名：{len(_wn)} 个地块有具体名字")
        else:
            log("水域名：没解析到（跳过，画面用笼统名）")
    except Exception as _e:
        log(f"水域名解析跳过：{_e}")
    # **水域名 · 按层**（2026-10-13 补 ✓ 跟 EU4 / HOI4 / EU5 对齐）
    #   ⚠ 这是"每层一片"那套的配套：构建期按层把地块聚成片 ✓
    #     而"这一层的片叫什么"就得靠这张表 ✓ 见 `load_water_names_by_tier` 的说明 ✓
    #   ⚠ VIC3 只有一层水域数据（一个海州正好一个省 ✓ 战略区 1:1 ✓）
    #     → 三层返回同一张 ✓ 这是**游戏内容如此** ✗ 不是偷懒 ✓
    #   ⚠ 下标必须跟 `meta["tiers"]` 对齐 ✗ —— 剧本层给 None ✓
    #     （同 EU4 那套：`[None] * 剧本层数 + [三层的水名表]` ✓
    #      少一格就是"包导不进来"那条老坑 ✓ 见 pack.js 的等长校验 ✓）
    try:
        _wt = V.load_water_names_by_tier(root)
        _tiers_all = meta.get("tiers") or []
        _arr: list = []
        for _t in _tiers_all:
            _arr.append(({str(k): str(v) for k, v in _wt[_t].items()}
                         if _wt.get(_t) else None))
        meta["seaNamesByTier"] = _arr
        _n = sum(1 for x in _arr if x)
        log(f"水域名（按层）：{_n} 层有表（层序 {'/'.join(_tiers_all)} ✓）")
    except Exception as _e:
        log(f"水域名按层解析跳过：{_e}")
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                    encoding="utf-8")
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
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
