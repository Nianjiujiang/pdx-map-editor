#!/usr/bin/env python3
"""从 HOI4 安装目录构建地图编辑器所需的缓存 → ``data_hoi4/``。

五层视图（跟 EU4 那套一个思路）：

    1936      两个年份的归属，按国家上色（用 common/countries 的国旗色）
    1939
    战略       strategic region，304 个，游戏里的战区
    地区       州（state），1081 个 —— HOI4 真正的基本单位
    省份       province，13414 个格子

跟 EU4 那边的差别，都是翻文件翻出来的：

* ``definition.csv`` 是 **8 列**，第 5 列的 type 直接写 land/lake/sea，
  不用再去翻 ``default.map`` 的名单。
* **省份自己没有名字**：有名字的是国家、战略区、州和「胜利点」（城市），
  胜利点的键就是省份 id（``VICTORY_POINTS_3838``）。10155 个陆地省份里
  只有 15% 有城市名，剩下的是真·无名地块 —— 不编名字。
* **官方自带简体中文**（``localisation/simp_chinese``，UTF-8 BOM），
  不用装汉化 mod，也没有 EU4 那套"双字节"。
* **国家名有意识形态变体**：``SOV`` 是"俄罗斯"，``SOV_communism`` 才是
  "苏维埃联盟"；``GER_fascism`` 是"德意志国"。1936/1939 按执政党挑。

用法::

    python build_hoi4.py                  # 自动找安装目录
    python build_hoi4.py --hoi4 "D:\\Steam\\steamapps\\common\\Hearts of Iron IV"
    python build_hoi4.py --out data_hoi4 --label "HOI4 原版"
"""

from __future__ import annotations

import re

import argparse
import json
import sys
import time
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from build_data import NO_TITLE, build_adjacency, build_province_map, log   # noqa: E402
from build_eu4 import (                                                     # noqa: E402
    Node,
    build_special_titles,
    child_hue,
    find_steam_game,
    largest_block_centre,
    pick_color,
)
from parsers.hoi4 import parser as H                                                # noqa: E402

DATA = ROOT / "data_hoi4"

#: 年份视图那几层：由 ``common/bookmarks/*.txt`` 决定，不写死（DLC 会改那些文件）。
#: 三个全局在 main() 里按实际读到的剧本赋值。
TIER_ORDER: tuple = ()
TIER_NAME: dict = {}
TIER_KEY: dict = {}

#: 年份层之后那三层固定是战略区 / 州 / 省份
TAIL_TIERS = ("sr", "st", "pr")
TAIL_NAME = {"sr": "战略", "st": "地区", "pr": "省份"}
TAIL_KEY = {"sr": "战略", "st": "地区", "pr": "省"}

#: HOI4 只有海和湖要锁（荒地在这个数据集里就是普通陆地，能涂）
SPECIAL_CATEGORIES = [
    ("#lake", "湖泊", (47, 110, 150), "lake"),
    ("#sea", "海洋", (32, 57, 92), "sea"),
]

#: 国家名的意识形态后缀，按这个顺序挑
NAME_SUFFIXES = ("", "_DEF")


def prov_key(pid: int) -> str:
    return f"p_{pid}"


def enabled_dlcs(root: Path) -> set[str] | None:
    """已启用 DLC 的显示名集合 —— 拿不到就返回 ``None``（解析器当作"全都装了"）。

    这份安装里没有 ``*.dlc`` 文件（Steam 版 DLC 是内容目录 + Steam 授权），
    而 ``dlc_load.json`` 只列**被禁掉**的：它空着就说明全开 ✓。
    什么时候能做到"按名字精确判断"再说 —— 现在**宁可多应用也不要漏**
    （漏一块就是整个势力从图上消失）。
    """
    import json
    import os

    for c in (Path(os.path.expanduser("~")) / "Documents" / "Paradox Interactive"
              / "Hearts of Iron IV" / "dlc_load.json",
              Path(os.path.expanduser("~")) / "OneDrive" / "Documents" / "Paradox Interactive"
              / "Hearts of Iron IV" / "dlc_load.json"):
        if not c.is_file():
            continue
        try:
            data = json.loads(c.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        off = data.get("disabled_dlcs") or []
        if not off:
            return None                 # 全开：条件一律当真
        return None                     # 有禁用的，但反推不出显示名 —— 仍旧当真（不漏）
    return None


def era_labels(bookmarks) -> tuple[str, ...]:
    """工具栏上那一排的名字：用**年份**（短），同年有两个剧本就带上月份。"""
    years = [str(b.date[0]) for b in bookmarks]
    dup = {y for y in years if years.count(y) > 1}
    return tuple(f"{b.date[0]}.{b.date[1]}" if str(b.date[0]) in dup else str(b.date[0])
                 for b in bookmarks)


#: 定点改名（游戏里的名字来自**国策**给的自治级别，开局历史里查不到 ✗）
NAME_OVERRIDE = {
    "HBC": "冀察政务委员会",   # 察南 → 官方那个名字 ✓
}


def name_candidates(tag: str, ideology: str | None, subject=None,
                    cosmetic: str | None = None) -> list[str]:
    """这个国家在这一份剧本里**可能**用到的本地化键，从最具体到最笼统。

    附属国在 HOI4 里会**换名字**，键的规则是
    ``<cosmetic>_<意识形态>_<自治级别>``：满洲国就是
    ``MAN_JAP_fascism_autonomy_puppet``。而 ``MAN_fascism`` 是"大清"
    （溥仪复辟那条线）—— 只看后者的话东北会显示成大清。

    cosmetic tag 的命名约定是 ``<附属国>_<宗主国>``，所以没显式指定时猜一个；
    猜错了也没关系，查不到就往下退。

    先摆候选、再拿候选去取本地化，最后挑第一个查得到的 —— 反过来的话
    "要先知道键才能取文本、又要先有文本才能挑键"就卡死了。
    """
    cos = cosmetic
    if cos is None and subject is not None:
        cos = f"{tag}_{subject.overlord}"
    out: list[str] = []
    if cos:
        if subject is not None and ideology:
            out.append(f"{cos}_{ideology}_{subject.autonomy}")
            out.append(f"{cos}_{ideology}_{subject.autonomy}_DEF")
        if ideology:
            out.append(f"{cos}_{ideology}")
            out.append(f"{cos}_{ideology}_DEF")
        out.append(cos)
        out.append(cos + "_DEF")
    if subject is not None:
        # **`<tag>_autonomy_<自治级别>`** —— 游戏里不少国家用这个写法
        #（冀察政务委员会就是 HBC_autonomy_sea_warlord_subject ✓）
        # 它比"意识形态名"更具体，所以排在前面，免得退成察南那种旧名 ✗
        out.append(f"{tag}_autonomy_{subject.autonomy}")
        out.append(f"{tag}_autonomy_{subject.autonomy}_DEF")
        if cos and cos != tag:
            out.append(f"{cos}_autonomy_{subject.autonomy}")
            out.append(f"{cos}_autonomy_{subject.autonomy}_DEF")
    if subject is not None and ideology:
        out.append(f"{tag}_{ideology}_{subject.autonomy}")
        out.append(f"{tag}_{ideology}_{subject.autonomy}_DEF")
    if ideology:
        out.append(f"{tag}_{ideology}")
        out.append(f"{tag}_{ideology}_DEF")
    out.append(tag + "_DEF")
    out.append(tag)
    return out


def country_name(tag: str, loc_zh: dict, loc_en: dict, ideology: str | None,
                 subject=None, cosmetic: str | None = None):
    """按候选键挑第一个真有的，返回 (键, 中文, 英文)。"""
    for k in name_candidates(tag, ideology, subject, cosmetic):
        if k in loc_zh or k in loc_en:
            return k, loc_zh.get(k, ""), loc_en.get(k, "")
    return tag, "", ""


def main() -> int:
    global DATA, TIER_ORDER, TIER_NAME, TIER_KEY
    ap = argparse.ArgumentParser(description="从 HOI4 安装目录构建制地图编辑器所需的缓存")
    ap.add_argument("--hoi4", help="HOI4 安装根目录（含 map/ 与 history/）")
    ap.add_argument("--provinces", help="用指定的省份图（province id 表），不给就用游戏目录里的 map/provinces.bmp")
    ap.add_argument("--out", help="缓存写到哪个目录，默认 data_hoi4/")
    ap.add_argument("--label", default="HOI4 原版", help="这套地图的显示名，写进 meta")
    args = ap.parse_args()

    root = find_steam_game(args.hoi4, "Hearts of Iron IV", "map/provinces.bmp", "--hoi4")
    MAP = root / "map"
    if args.out:
        DATA = Path(args.out).resolve()
    DATA.mkdir(parents=True, exist_ok=True)
    ver = H.game_version(root)
    log(f"HOI4 {ver} @ {root}")
    log(f"输出目录 {DATA}")

    # 0. 开局剧本：日期和名字都从 common/bookmarks 读（DLC 会改这些文件）
    bookmarks = H.parse_bookmarks(root / "common" / "bookmarks")
    if not bookmarks:
        raise SystemExit("common/bookmarks 里没读到剧本，装的是不是完整版？")
    ERA_DATES = tuple(b.date for b in bookmarks)
    ERA_LABELS = era_labels(bookmarks)
    TIER_ORDER = tuple(ERA_LABELS) + TAIL_TIERS
    TIER_NAME = {**{lb: lb for lb in ERA_LABELS}, **TAIL_NAME}
    TIER_KEY = {**{lb: lb for lb in ERA_LABELS}, **TAIL_KEY}
    bm_names = H.load_names(root / "localisation" / "simp_chinese",
                            {b.name_key for b in bookmarks})
    for b, lb in zip(bookmarks, ERA_LABELS):
        log(f"  剧本 {lb}：{b.date[0]}.{b.date[1]}.{b.date[2]}"
            f"  {bm_names.get(b.name_key, b.name_key)}"
            f"{'（默认）' if b.is_default else ''}"
            f"  国家块 {len(b.ideologies)} 个")

    # 1. 省份定义（8 列：province;r;g;b;type;coastal;terrain;continent）
    defs = H.parse_definition(MAP / "definition.csv")
    rows = H.parse_definition_rows(MAP / "definition.csv")
    n_prov = max(defs) + 1
    kinds: dict[str, int] = {}
    for v in defs.values():
        kinds[v[3]] = kinds.get(v[3], 0) + 1
    log(f"definition.csv：{len(defs)} 个省份，最大 id {max(defs)}，类型 {kinds}")

    # 2. 省份图
    ids, w, h, counts, pcx, pcy = build_province_map(Path(args.provinces) if args.provinces else (MAP / "provinces.bmp"), defs)
    present = np.zeros(n_prov, dtype=bool)
    present[np.unique(ids)] = True
    present[0] = False

    def flag(kind: str) -> np.ndarray:
        a = np.zeros(n_prov, dtype=bool)
        v = np.fromiter((p for p, d in defs.items() if d[3] == kind and 0 < p < n_prov),
                        dtype=np.int64)
        if v.size:
            a[v] = True
        return a

    is_sea = flag("sea")
    is_lake = flag("lake")
    land = present & ~is_sea & ~is_lake
    log(f"地图上 {int(present.sum())} 个省份：陆地 {int(land.sum())}，"
        f"海 {int((is_sea & present).sum())}，湖 {int((is_lake & present).sum())}")

    # 3. 州 / 战略区 / 归属
    DLC_ON = enabled_dlcs(root)
    log(f"  已启用 DLC {len(DLC_ON) if DLC_ON else 0} 个"
        + ("（读不到 dlc_load.json，按全装算）" if DLC_ON is None else ""))
    states = H.parse_states(root / "history" / "states", dlcs=DLC_ON)
    srs = H.parse_strategic_regions(MAP / "strategicregions")
    log(f"州 {len(states)} 个 / 战略区 {len(srs)} 个")

    prov_state: dict[int, int] = {}
    for sid, st in states.items():
        for p in st.provinces:
            if 0 < p < n_prov and land[p] and p not in prov_state:
                prov_state[p] = sid
    prov_sr: dict[int, int] = {}
    for rid, (_nk, plist) in srs.items():
        for p in plist:
            if 0 < p < n_prov and land[p] and p not in prov_sr:
                prov_sr[p] = rid

    land_pids = [int(p) for p in np.nonzero(land)[0]]
    no_state = [p for p in land_pids if p not in prov_state]
    no_sr = [p for p in land_pids if p not in prov_sr]
    log(f"陆地省份里没进任何州的 {len(no_state)} 个 {no_state[:8]}")
    log(f"  没进任何战略区的 {len(no_sr)} 个 {no_sr[:8]}")

    # 一个州横跨多个战略区的情况：父级取成员多数
    state_sr: dict[int, int] = {}
    tally: dict[int, dict[int, int]] = {}
    for p, sid in prov_state.items():
        rid = prov_sr.get(p)
        if rid is None:
            continue
        d = tally.setdefault(sid, {})
        d[rid] = d.get(rid, 0) + 1
    split_states = []
    for sid, d in tally.items():
        state_sr[sid] = max(sorted(d), key=lambda k: d[k])
        if len(d) > 1:
            split_states.append(sid)
    if split_states:
        log(f"  横跨多个战略区的州 {len(split_states)} 个（父级取成员多数）")

    # 4. 各个剧本的归属
    owners: list[dict[int, str]] = []
    for d, label in zip(ERA_DATES, ERA_LABELS):
        arr: dict[int, str] = {}
        occupied = 0
        for p in land_pids:
            sid = prov_state.get(p)
            if sid is None:
                continue
            st = states[sid]
            # **按控制者上色**（占领区画成占领国的颜色），跟游戏的政治地图一致。
            # 1939.8.14 那个剧本里中国有 16 个州是 CHI 所有、JAP / MEN 控制 ——
            # 只看 owner 的话日本占领区会画成国民政府的颜色。
            ctrl = H.controller_at(st, d)
            tag = ctrl or H.owner_at(st, d)
            if tag:
                arr[p] = tag
                if ctrl and ctrl != H.owner_at(st, d):
                    occupied += 1
        # **逐省份控制**：一个州可以一半归中国、一半被日本控制 ——
        # 写在州历史的日期块里（`JAP = { set_province_controller = 1018 }`）。
        # 州级那一遍只是兜底，这里按日期覆盖：1936 年那三个省还没丢，1939 年才归日本。
        split_moved = 0
        for st2 in states.values():
            pc = H.province_controllers_at(st2, d)
            if not pc:
                continue
            for pid2, ctag2 in pc.items():
                if pid2 in arr and arr[pid2] != ctag2:
                    arr[pid2] = ctag2
                    split_moved += 1
        owners.append(arr)
        log(f"  {label}：有主 {len(arr)} 省 / {len(set(arr.values()))} 个国家"
            + (f"（其中被占领的 {occupied} 省、逐省分割 {split_moved} 省）" if occupied else ""))

    # 5. 国家颜色与名字
    common = root / "common"
    tags = H.parse_country_tags(common)
    tag_colors = H.parse_country_colors(common, tags)
    history_ideo = H.parse_ideologies(root / "history" / "countries")
    log(f"国家 tag {len(tags)} 个（有地图色 {len(tag_colors)}，有执政党 {len(history_ideo)}）")

    # 附属关系：HOI4 里附属国会换名字（cosmetic tag）。
    # 满洲国就是 MAN 顶着 MAN_JAP 这个 cosmetic，名字的键是
    # MAN_JAP_fascism_autonomy_puppet —— 不认这个的话东北会显示成"大清"。
    subjects = H.parse_subjects(root / "history" / "countries")
    cosmetics = H.parse_cosmetic_tags(root / "history" / "countries")
    # XSM（西北马家军）开局**不该**顶 united_ma_clique_tag 那个装饰名 ——
    # 那名字是"马家军统一"之后才该出现的 ✗；去掉它，名字就回到执政党名：
    # XSM_neutrality = 青海马家军 ✓
    cosmetics.pop("XSM", None)
    cos_colors = H.parse_cosmetic_colors(common)
    log(f"开局附属国 {len(subjects)} 个（显式指定 cosmetic 的 {len(cosmetics)} 个，"
        f"cosmetic 配色表 {len(cos_colors)} 条）")
    if subjects:
        sample = "、".join(f"{t}→{s.overlord}"
                          for t, s in sorted(subjects.items())[:6])
        log(f"  例：{sample}")

    # 颜色取自 common/countries/colors.txt（地图配色正表）。每国自己文件里的那个
    # color 常常是占位值 —— 好几个国家共用一个色，瑞士那个近乎全黑，
    # 画出来就是"很多国家没有颜色"。
    used = set()
    for i, label in enumerate(ERA_LABELS):
        used |= set(owners[i].values())
    no_color = sorted(t for t in used if t not in tag_colors)
    if no_color:
        log(f"  ！{len(no_color)} 个国家查不到地图色，会用中性灰：{no_color[:8]}")
    dup = {}
    for t in used:
        c = tag_colors.get(t)
        if c:
            dup.setdefault(c, []).append(t)
    share = {c: v for c, v in dup.items() if len(v) > 1}
    if share:
        worst = max(share.values(), key=len)
        log(f"  共色的国家 {len(share)} 组，最多的一组 {len(worst)} 个："
            + "、".join(worst[:6]))

    # 每个剧本里同一国家的执政党可能不一样：1939 的日本是法西斯（JAP_fascism =
    # 大日本帝国），history/countries 里那份是 1936 的（neutrality）。
    # 所以剧本里写了就以剧本为准，没写的退回 history。
    era_ideo: list[dict[str, str]] = []
    for b in bookmarks:
        merged = dict(history_ideo)
        merged.update(b.ideologies)
        era_ideo.append(merged)
    for b, lb in zip(bookmarks, ERA_LABELS):
        diff = [k for k, v in b.ideologies.items() if history_ideo.get(k) not in (None, v)]
        if diff:
            log(f"  {lb} 的剧本里改了执政党的国家 {len(diff)} 个："
                + "、".join(f"{k}({history_ideo.get(k)}→{b.ideologies[k]})" for k in diff[:6]))

    zh_dir = root / "localisation" / "simp_chinese"
    en_dir = root / "localisation" / "english"

    # 需要的本地化键：国家（含**各剧本**的意识形态 / cosmetic / 自治级别变体）、
    # 战略区、州、胜利点。国家名要先摆候选再取文本，所以这里要的是候选全集。
    want: set[str] = set()
    for i, label in enumerate(ERA_LABELS):
        for tag in set(owners[i].values()):
            ide = era_ideo[i].get(tag)
            want |= set(name_candidates(tag, ide, subjects.get(tag), cosmetics.get(tag)))
            if tag in cosmetics:
                want |= set(name_candidates(tag, ide, subjects.get(tag), cosmetics[tag]))
    # **所有 tag** 都要查（不只是开局有地盘的）——
    # 不然 countryTags 里那些没地盘的 tag 只能显示 tag 本身（用户就是这么发现的 ✗）
    for _tag in sorted(tags):
        want.add(_tag)
        want |= set(name_candidates(_tag, era_ideo[0].get(_tag),
                                    subjects.get(_tag), cosmetics.get(_tag)))
    want |= {f"STRATEGICREGION_{r}" for r in srs}
    want |= {f"STATE_{s}" for s in states}
    vp_keys = set()
    for st in states.values():
        vp_keys |= set(st.vp)
    want |= {f"VICTORY_POINTS_{p}" for p in vp_keys}

    zh = H.load_names(zh_dir, want)
    en = H.load_names(en_dir, want)
    log(f"名字：简体中文 {len(zh)} 条 / 英文 {len(en)} 条")

    # 每个 tag 的中文名（取不到就用英文、再不行用 tag 本身 ✓）—— countryTags 要用
    tag_names: dict[str, str] = {}
    for _tag in sorted(tags):
        try:
            _k, _z, _e = country_name(_tag, zh, en, era_ideo[0].get(_tag),
                                      subjects.get(_tag), cosmetics.get(_tag))
        except Exception:
            _k = _tag
        tag_names[_tag] = zh.get(_k) or en.get(_k) or _tag
    tag_names.update({k: v for k, v in NAME_OVERRIDE.items() if k in tag_names})
    _named = sum(1 for _k2, _v in tag_names.items() if _v and _v != _k2)   # 跟 tag 不同才算有名字 ✓
    log(f"  全部 tag 的中文名：{_named} / {len(tag_names)} 个")

    # 6. 组树
    ordered: list[Node] = []
    index_of: dict[str, int] = {}
    hue_of: dict[str, float] = {}

    def add(t: Node) -> Node:
        index_of[t.key] = len(ordered)
        ordered.append(t)
        return t

    for i, label in enumerate(ERA_LABELS):
        for tag in sorted(set(owners[i].values())):
            t = add(Node(f"{label}_{tag}", label))
            # 附属国用 cosmetic tag 的颜色（RAJ_UK / INS_HOL 这些），没有就用本国色
            cos = cosmetics.get(tag)
            if cos is None and tag in subjects:
                cos = f"{tag}_{subjects[tag].overlord}"
            t.color = (cos_colors.get(cos) if cos else None) or tag_colors.get(tag) \
                or (128, 128, 128)

    # 战略区：色相按 id 散开，兄弟之间贪心保证色差
    used_sr = {prov_sr[p] for p in land_pids if p in prov_sr}
    used_state = {prov_state[p] for p in land_pids if p in prov_state}
    for i, rid in enumerate(sorted(used_sr)):
        base = (i * 137.508) % 360.0
        t = add(Node(f"STRATEGICREGION_{rid}", "sr"))
        t.color = pick_color(base, 40.0, [])
        hue_of[rid] = base

    # 州：同一个战略区里的兄弟散开
    groups: dict[int, list[int]] = {}
    for sid in sorted(used_state):
        groups.setdefault(state_sr.get(sid, -1), []).append(sid)
    for parent, kids in sorted(groups.items()):
        base = hue_of.get(parent, 210.0)
        placed: list = []
        for i, sid in enumerate(kids):
            col = pick_color(base, 62.0, placed)
            placed.append(col)
            t = add(Node(f"STATE_{sid}", "st"))
            t.parent = f"STRATEGICREGION_{parent}" if parent in used_sr else None
            t.color = col

    # 省份：颜色就用 definition.csv 的
    for p in sorted(land_pids):
        t = add(Node(prov_key(p), "pr", p))
        sid = prov_state.get(p)
        t.parent = f"STATE_{sid}" if sid is not None else None
        t.color = defs[p][:3]

    n_real = len(ordered)
    log(f"真节点 {n_real} 个（年份 {sum(1 for t in ordered if t.tier in ERA_LABELS)}"
        f" / 战略 {len(used_sr)} / 州 {len(used_state)} / 省份 {len(land_pids)}）")

    # 7. 归属表
    # 行号按 TIER_ORDER 现查 —— TIER_ORDER 是按 bookmarks 动态生成的，
    # 剧本数不是 2 时写死的 2/3/4 会整表错位（甚至 IndexError）。
    _r_sr = TIER_ORDER.index("sr")
    _r_st = TIER_ORDER.index("st")
    _r_pr = TIER_ORDER.index("pr")
    titlemap = np.full((len(TIER_ORDER), n_prov), NO_TITLE, dtype=np.uint16)
    for p in land_pids:
        titlemap[_r_pr, p] = index_of[prov_key(p)]
        sid = prov_state.get(p)
        if sid is not None:
            titlemap[_r_st, p] = index_of[f"STATE_{sid}"]
        rid = prov_sr.get(p)
        if rid is not None:
            titlemap[_r_sr, p] = index_of[f"STRATEGICREGION_{rid}"]
        for i, label in enumerate(ERA_LABELS):
            tag = owners[i].get(p)
            if tag:
                k = f"{label}_{tag}"
                if k in index_of:
                    titlemap[i, p] = index_of[k]

    # 8. 海 / 湖
    blank = np.all(titlemap == NO_TITLE, axis=0) & present
    log(f"完全没有归属的地块：{int(blank.sum())} 个")
    _special_names: dict[str, str] = {}
    special, assign, stats, _fine_assign, _waste_pids, _waste_tids = build_special_titles(
        {"lake": set(np.nonzero(is_lake)[0].tolist()),
         "sea": set(np.nonzero(is_sea)[0].tolist())},
        n_prov, blank, n_real, categories=SPECIAL_CATEGORIES, fine_tier=TIER_ORDER[-1],
        name_sink=_special_names,
        )
    log("锁住的地形：" + ("，".join(stats) if stats else "无"))
    sel = assign >= 0
    if sel.any():
        vals = assign[sel].astype(np.uint16)
        for r in range(len(TIER_ORDER)):
            titlemap[r, sel] = vals

    ordered_all = ordered + special
    n_all = len(ordered_all)

    # 9. 成员 → 地盘数、像素面积
    members: list[list[int]] = [[] for _ in range(n_all)]
    for r in range(len(TIER_ORDER)):
        row = titlemap[r]
        for p in np.nonzero((row != NO_TITLE) & present)[0]:
            tid = int(row[p])
            if tid >= n_real and r > 0:
                continue
            members[tid].append(int(p))
    prov_count = [len(m) for m in members]
    area = np.zeros(n_all, dtype=np.int64)
    for i, m in enumerate(members):
        if m:
            area[i] = int(counts[np.fromiter(m, dtype=np.int64)].sum())

    # 10. 标注位置：像素最多的连通块的重心（跟 EU4 一样，跨国领地才不会落到海里）
    adj = build_adjacency(ids, n_prov)
    offsets = np.frombuffer(adj, dtype=np.uint32, count=n_prov + 1)
    neigh = np.frombuffer(adj, dtype=np.uint16, offset=(n_prov + 1) * 4)
    lx = np.full(n_all, np.nan, dtype=np.float32)
    ly = np.full(n_all, np.nan, dtype=np.float32)
    block_area = np.zeros(n_all, dtype=np.int64)
    for i, m in enumerate(members):
        c = largest_block_centre(m, offsets, neigh, counts, pcx, pcy)
        if c is not None:
            lx[i], ly[i] = c[0], c[1]
            block_area[i] = c[2]
    lx[n_real:] = np.nan
    ly[n_real:] = np.nan
    log("标注位置：每块地取像素最多的那个连通块的重心")

    # 11. 名字
    special_names = {k: label for k, label, _c, _s in SPECIAL_CATEGORIES}
    # 伪头衔的中文名（name_sink 带出来的）✓
    special_names.update(_special_names)
    resolved: list[str] = []
    names_en: list[str] = []
    key_of: list[str] = []          # 每个节点用哪个本地化键（省份是 VICTORY_POINTS_x）
    zh_used = 0
    named_prov = 0
    named_all = 0
    total_prov = 0
    for t in ordered_all:
        if t.key in special_names:
            resolved.append(special_names[t.key])
            names_en.append("")
            key_of.append("")
            continue
        if t.tier == "pr":
            k = f"VICTORY_POINTS_{t.pid}"
            total_prov += 1
        elif t.tier in ERA_LABELS:
            tag = t.key.split("_", 1)[1]
            # 按**这个剧本**的执政党 + cosmetic + 自治级别挑名字，
            # 1939 的日本才是"大日本帝国"、满洲国才是"满洲国"而不是"大清"
            k, _z, _e = country_name(tag, zh, en, era_ideo[ERA_LABELS.index(t.tier)].get(tag),
                                     subjects.get(tag), cosmetics.get(tag))
        else:
            k = t.key
        key_of.append(k)
        z = zh.get(k)
        e = en.get(k, "")
        if z:
            zh_used += 1
        if z or e:
            named_all += 1
        if t.tier == "pr" and (z or e):
            named_prov += 1
        if t.tier in ERA_LABELS and "_" in t.key:
            _tg = t.key.split("_", 1)[1]
            if _tg in NAME_OVERRIDE:
                z = NAME_OVERRIDE[_tg]
        resolved.append(z or e)
        names_en.append(e if e and e != z else "")
    log(f"  {zh_used} 个用了中文名（有名字的节点共 {named_all} 个）；"
        f"省份层 {named_prov}/{total_prov} 有城市名（HOI4 的省份本来就是无名地块）")

    # 12. 颜色表
    colors = np.zeros((n_all, 3), dtype=np.uint8)
    for i, t in enumerate(ordered_all):
        c = t.color
        if c is None:
            p = index_of.get(t.parent) if t.parent else None
            c = colors[p] if p is not None else (150, 150, 150)
        colors[i] = c

    # 13. 写盘
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

    # definition.csv 的原样 8 列不存 —— HOI4 的 provinces.bmp 是"省份 id 表"，
    # 不是显示用的地图，改了颜色游戏画面不会变（见 README 里导出那一节）。
    # 所以 HOI4 这边没有导出 mod 这条路。

    def read_country_capitals(root: Path, states) -> dict:
        """history/countries/<TAG> - <Name>.txt 的 capital = <州 id> → 取该州的一个省份号
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
                txt = f.read_text(encoding="latin-1", errors="replace")
            except OSError:
                continue
            # 两种写法都认：老式 capital = 622，新式 set_capital = { state = 622 }
            cands = [int(v) for v in re.findall(r"capital\s*=\s*(\d+)", txt)]
            cands += [int(v) for v in re.findall(r"set_capital\s*=\s*\{[^}]*?state\s*=\s*(\d+)", txt)]
            # 优先取这个州确实在数据里的那条，自动绕开 DLC 分支
            sid = next((c for c in cands if c in states), (cands[0] if cands else 0))
            st = states.get(sid)
            provs = getattr(st, "provinces", None) if st is not None else None
            if provs:
                _vp = getattr(st, "vp", None) or {}   # 省份 -> 胜利点
                # 游戏里"州的首府" = 胜利点最高的那个省；没有 VP 才退回最小省号
                out[tag] = int(max(_vp.items(), key=lambda kv: kv[1])[0]) if _vp else int(min(provs))
        return out


    meta = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "game": "hoi4",
        "gameVersion": ver,
        "gameRoot": str(root),
        "label": args.label,
        "provinceMap": "provinces.bmp",
        # 省份层多数没有城市名，所以"中文占多少"要跟**有名字的**节点比，
        # 不能跟全部节点比 —— 否则 10154 个无名省份会把比例压到 40% 以下，
        # 明明全是中文却被判成英文
        "nameLang": "zh" if named_all and zh_used >= named_all * 0.9 else "en",
        "mapWidth": w,
        "mapHeight": h,
        "numProvinces": n_prov,
        "numTitles": n_all,
        "numRealTitles": n_real,
        "tiers": list(TIER_ORDER),
        "tierNames": [TIER_NAME[t] for t in TIER_ORDER],
        "tierKeys": [TIER_KEY[t] for t in TIER_ORDER],
        "entity": "省份",
        "defaultTier": TIER_ORDER.index("st"),   # 州是 HOI4 真正的基本单位，而且全都有名字
        # **全部 tag** 的名字 + 颜色（含当前年代没地盘的）—— 搜索/取色要用 ✓
        # 名字先放 tag：中文名由 patch_wasteland 从 titles.json 统一补 ✓
        "countryTags": {tag: {"n": tag_names.get(tag, tag), "c": list(c)}
                        for tag, c in sorted(tag_colors.items())},
        # 年份层 20，sr/st/pr 递进 —— 剧本数变了也不能缺值（缺值 = 那层不画标签）
        "labelZoom": [20] * len(ERA_LABELS) + [45, 95, 165][:len(TAIL_TIERS)],
        "eraDates": [f"{y}.{m}.{d}" for (y, m, d) in ERA_DATES],
        # 开局剧本：日期和名字都是从 common/bookmarks 读的（DLC 会改那些文件），
        # 工具栏按钮的 tooltip 会把它显示出来
        "bookmarks": [
            {"date": f"{b.date[0]}.{b.date[1]}.{b.date[2]}",
             "key": b.name_key,
             "name": bm_names.get(b.name_key, ""),
             "default": b.is_default}
            for b in bookmarks
        ],
        "noTitle": NO_TITLE,
        "specialPrefix": "#",
        "colorLutWidth": 256,
        "lockedKinds": [k for k, *_ in SPECIAL_CATEGORIES],
        "landProvinces": int(land.sum()),
        "noStateProvinces": no_state,
        "vpProvinces": named_prov,
        "splitStates": len(split_states),
        "generatedColors": len(used_sr) + len(used_state),
    }
    meta["capitals"] = read_country_capitals(root, states)
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                    encoding="utf-8")
    log("全部完成 ✔")

    # 荒地的事后加工（幂等）：每层都指向它自己 / 周长表 / 按层归属 / 名字 / 隐藏地名
    from patch_wasteland import patch as _patch_waste
    _patch_waste(DATA)
    # 再补一层**空白剧本**（幂等）：放在荒地之后 —— 它照抄的是"最终这版"的背景地形 ✓
    from patch_blank_era import patch as _patch_blank
    _patch_blank(DATA)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
