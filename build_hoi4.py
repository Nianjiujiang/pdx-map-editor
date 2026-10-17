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
import base64
import json
import sys
import time
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from build_data import (NO_TITLE, build_adjacency, build_province_map, log)   # noqa: E402
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
# 悬停层级链左边那枚小标签（短名）✓ 2026-10-17 用户："那个『省』改名叫省份吧"
TAIL_KEY = {"sr": "战略", "st": "地区", "pr": "省份"}

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

#: **「修改边界」版的两条硬规则** ✓（2026-10-17 用户点名）
#:
#:   ① 省 5042（阿克赛钦那块）：归「**和田**」州（STATE_1042）+「**塔克拉玛干**」战略区（145）
#:      —— 原版把它算在克什米尔州 / 阿里战略区下面 ✓ 修改边界版要收回来 ✓
#:   ② 州 434「阿鲁纳恰尔」改名「**藏南**」✓
#:
#: ⚠ **只在 `--alt-borders` 时生效** ✗✗ —— 原版那份一个字都不能动 ✓
#:   （同样的游戏数据，只有省份图不同；这两条是"按图改归属"，不是数据修正 ✓）
ALT_BORDERS = {
    "province": 5042,
    "from_state": 441,          # 克什米尔
    "to_state": 1042,           # 和阗（显示名「和田」）
    "to_sr": 145,               # 塔克拉玛干
    "rename_states": {"STATE_434": "藏南"},
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
    # ⚠ **平铺的 `TAG` 在前、`TAG_DEF` 只当兜底** ✗ —— 顺序反过来的话，游戏里明明
    #   写着「大日耳曼国」（键 `GER`），图上却会变成更长的「德意志民族的大日耳曼国」
    #   （键 `GER_DEF`）✓（2026-10-12 廿九对着游戏点出来的 ✓）
    #   顺序就是上面 NAME_SUFFIXES 写的那样 —— 那个常量以前定义了没人用 ✓
    for suf in NAME_SUFFIXES:
        out.append(tag + suf)
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
    ap.add_argument("--alt-borders", action="store_true",
                    help="套用「修改边界」版的两条硬规则：省 5042 → 和田州 / 塔克拉玛干战略区；"
                         "州 434「阿鲁纳恰尔」→「藏南」")
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
    # 🔴 **同一天的 bookmark 只留一个** ✗✗（2026-10-17 英式和平）
    #   那个 mod 把世界拆成 6 个地区各做了一个 bookmark（欧洲/美洲/俄罗斯/亚洲/
    #   地中海/巴尔干），**日期全是 1933.1.1.12** ✓ 游戏里它们是"同一天的不同开局国家组"✗
    #   我们这儿一天就是一层，全收进来会变成 6 个一模一样的「1933.1」层 ✓
    _seen = set()
    _uniq = []
    for _b in bookmarks:
        if _b.date in _seen:
            continue
        _seen.add(_b.date)
        _uniq.append(_b)
    if len(_uniq) != len(bookmarks):
        log(f"  同一天的 bookmark 合并：{len(bookmarks)} 个 → {len(_uniq)} 层")
    bookmarks = _uniq
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

    # 🔴 **修改边界版的两条硬规则**（见 ALT_BORDERS 的注释 ✓）
    if getattr(args, "alt_borders", False):
        _ab = ALT_BORDERS
        _pid = _ab["province"]
        _old = states.get(_ab["from_state"])
        _new = states.get(_ab["to_state"])
        if _old and _pid in _old.provinces:
            _old.provinces.remove(_pid)
        if _new is not None and _pid not in _new.provinces:
            _new.provinces.append(_pid)
        _dropped = 0
        for _rid, (_nk, _plist) in srs.items():
            if _pid in _plist:
                _plist.remove(_pid)
                _dropped += 1
        if _ab["to_sr"] in srs:
            srs[_ab["to_sr"]][1].append(_pid)
        log(f"  修改边界：省 {_pid} → 州 {_ab['to_state']} / 战略区 {_ab['to_sr']}"
            f"（从 {_dropped} 个战略区里摘掉 ✓）")

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

    # 🔴 修改边界版的第二条：州名改口（见 ALT_BORDERS 的注释 ✓）
    if getattr(args, "alt_borders", False):
        for _k, _v in ALT_BORDERS["rename_states"].items():
            _was = zh.get(_k) or '(无)'
            zh[_k] = _v
            log(f"  修改边界：州名 {_k}「{_was}」→「{_v}」")

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

    # 8. 海 / 湖 —— **不再是伪头衔**（2026-10-14 ✓ 用户要求 ✓ 见下面说明）
    blank = np.all(titlemap == NO_TITLE, axis=0) & present
    # 🔴🔴 **水域不算"空白"** ✗✗（2026-10-14 ✓ 用户要求 ✓ 跟 CK3 / VIC3 同一刀 ✓）
    #
    #   用户："你就不能把水域变成一个**仅仅是不能填色的地块**吗……
    #     最底层的单位也有自己的 Province id"✓
    #     "和陆地一样啊，**大名，河北，华北**，这样下来"（= 逐块 / 地区 / 大区 ✓）
    #     "只是水域**带一个小标签**来让他在**边界和颜色**等方面听从相关的开关，
    #      **其他逻辑不变**"
    #
    #   → 水域**不再造伪头衔** ✓ 于是它"所有层都无主"✓ 正好落进上面这个 blank ✗
    #     → 被「不可通行」那片盖住 ✓（CK3 那边实跑量到过：悬停海拿到的 tid
    #       是 `#wasteland_c_3` ✓ 于是**海的高亮跟着荒地整片亮** ✗）
    #   → 必须**排除在 blank 之外** ✓ 那它就"完全无归属"✓
    #     身份靠 `pid` + `meta.waterMask`（那个"小标签"✓）——
    #     颜色走海域色 ✓ 边界听水域那两条开关 ✓ 高亮按 pid ✓ 别的全跟普通地块一样 ✓
    #
    #   ⚠ 水域**不能**进 `#wasteland` ✗ —— 荒地是"可以一块块涂色"的 ✓
    #     水域**不能填色** ✓ 两者待遇相反 ✓
    #   ⚠⚠ **HOI4 有真层级** ✗（`sr` 战略区 / `st` 州 ✓）——
    #     按用户"大名 / 河北 / 华北"那条口径，**粗层本该保留** ✓
    #     但这一刀先做到"**最细层回归逐块**"✓（那是关键 ✓）
    #     粗层怎么补见文件末尾 TODO ✓（`seaNamesByTier` 还在 ✓ 数据没丢 ✓）
    _water_all = np.asarray(is_sea, dtype=bool) | np.asarray(is_lake, dtype=bool)
    blank = blank & ~_water_all
    log(f"完全没有归属的地块：{int(blank.sum())} 个"
        f"（已排除 {int(_water_all.sum())} 个水域 ✓ 它们不算「无主荒地」✓）")
    _special_names: dict[str, str] = {}
    # 🔴 **HOI4 那两份类别清单**（`sea` / `lake` ✓）
    #   ⚠ 键是**不带井号**的 ✗（别的几家都带 ✓ 归一化在下面烤身份标那一步做 ✓）
    _hoi4_lists: dict[str, set[int]] = {
        "lake": set(np.nonzero(is_lake)[0].tolist()),
        "sea": set(np.nonzero(is_sea)[0].tolist()),
    }
    #: **地理层** = 年份层右边那三层（sr / st / pr ✓）
    _geo = list(TIER_ORDER[len(ERA_LABELS):])
    # 各层的水名表（现成的分层解析 ✓ 别另编一套 ✗）
    #
    # 🔴🔴 **取不到名字的层 → 按"省份级的海域"分片（= 逐块）** ✗✗
    #   （2026-10-14 用户明确要求 ✓ 原话："我不是说了吗，**地区级的显示也是用
    #     省份的海域**，这有什么难的"）
    #
    #   背景：HOI4 里**海省不落在任何州里** ✗（原版 3145 个海省不在
    #     `state_regions` 的 `provinces` 名单 ✓ 见 `parsers/hoi4/parser.py` ✓）
    #     → 所以 `st`（州）层**一个海名都取不到** ✓
    #   ⚠ 取不到就"整片一片"的话 ✗ → 那一层**整块海挤成一个片** ✓
    #     用户看到的就是"**地区级没有任何东西，直接一整块海洋**"✓（他报的 ✓）
    #
    #   ✅ 正解：**那一层就按"省份级的海域"分** ✓ ——
    #     海省本来就是逐块的（`pr` 层没有名字 ✓ 每个省一块 ✓）
    #     → 拿**地块号**当片名 ✓ 于是"**一块一片**"✓
    #     视觉上：地区级能看出海底下的分块 ✓ 跟"省份级"一致 ✓
    #   ⚠ 名字仍然是**类名**（"海洋" / "湖泊" ✓）—— 因为游戏里**真的没有** ✓
    #     前端判"类名 = 没名字"→ 不出标 ✓（用户定的"没有就是没有"✓）
    #     但**片还是分开的** ✓ 高亮 / 边界按块走 ✓ 那才是他要的 ✓
    #   ⚠ 判据是"**这个海省有没有名字**" ✗✗ —— 不是"整层有没有表" ✓
    #     我第一版写成 `if not _wtier[_t]` ✗ → 没触发 ✓（`st` 层有 118 条 ✓
    #     可那 118 条全是**陆地州名** ✓ 3145 个海省一条都不在里面 ✓）
    #     → 海省还是全归"无名组"→ 还是 1 片 ✓
    #   ✅ 正确的补法：**逐个海省看** ✗ —— 它不在那一层的表里就补上它自己的地块号 ✓
    #   ⚠ 用 `#<地块号>` 当片名 ✗ —— 加个前缀免得跟真名字撞 ✓
    #     （真名字是"白令海"那种 ✓ 不会长这样 ✓）
    _wtier: dict[str, dict[int, str]] = {t: {} for t in _geo}
    try:
        _raw = H.load_water_names_by_tier(root)
        for _t in _geo:
            _wtier[_t] = dict(_raw.get(_t) or {})
        log("水名表（分层）：" + "、".join(f"{t} {len(_wtier[t])} 条" for t in _geo))
    except Exception as _e:            # 解析不出来不该拖垮整个构建 ✓
        log(f"水名表跳过：{_e}")
    _sea_lake_pids = [int(_p) for _p in np.nonzero(is_sea | is_lake)[0].tolist()]
    for _t in _geo:
        _tbl = _wtier[_t]
        _miss = [_p for _p in _sea_lake_pids if _p not in _tbl]
        for _p in _miss:
            _tbl[_p] = f"#{_p}"
        if _miss:
            log(f"  水名表 {_t}：{len(_miss)} 个海省游戏里没有名字 → "
                f"按省份级海域**逐块分片** ✓（该层共 {len(_tbl)} 片）")
    special, _sp_rows, stats, _waste_pids, _waste_tids = build_special_titles(
        # 🔴 **`skip_fine_tier=True`** ✗（2026-10-14 ✓ 用户要求 ✓）
        #   水域**最细层不造片** ✓（它就是它自己那个 province ✓）而**粗层照造** ✓
        #   用户："和陆地一样啊，**大名，河北，华北**，这样下来"✓
        #     → HOI4 的 `sr`（战略区）/ `st`（州）那两级**照旧造** ✓
        #       `pr`（省份）那级**不造** ✓ —— 那一级就是"逐块 pid" ✓
        #   ⚠ 而 HOI4 的 `pr` 层水名**本来就是空的** ✓（"省份级 = 地区级、没有名字"✓
        #     见 `parsers/hoi4/parser.py` 那条 `("pr", (me,))` ✓）
        #     所以它那一级"不造"之后**看着跟以前一样**（都没名字 ✓）✓
        #   ⚠ 只影响"造片"那一步 ✗ —— `blank` / `waterMask` 都不受影响 ✓
        # ⚠⚠ **候选池要把水域加回来** ✗✗（2026-10-14 ✓ 差点栽在这儿）
        #   我上一版传的是**空 `{}`** ✗ → 水域一个片都造不出来 ✓（实跑：0 片 ✓）
        #   `blank` 上面**排除了水域** ✓（那是给 `patch_blank_era` 用的 ✓）
        #   可 `build_special_titles` **也拿它当候选池** ✗ → 得显式加回来 ✓
        #   ⚠ 水域**先认领**、荒地最后兜底 ✓ —— `SPECIAL_CATEGORIES` 的顺序保证 ✓
        _hoi4_lists,
        n_prov, blank | _water_all, n_real, categories=SPECIAL_CATEGORIES, fine_tier=_geo[-1],
        # 🔴 **剧本层：每一类共用一个「海洋」节点** ✗（2026-10-14 ✓ 用户的主意 ✓）
        script_tiers=[t for t in TIER_ORDER if t not in _geo],
        geo_tiers=_geo, tier_names=_wtier, name_sink=_special_names,
        skip_fine_tier=True,
        )
    log("锁住的地形：" + ("，".join(stats) if stats else "无"))

    # 🔴🔴 **底层地块的"身份标"** ✗✗（2026-10-16 补 ✓ 用户点名要的 ✓）
    #   跟 `build_data.py`(CK3) / `build_ck2.py` / `build_eu4.py` / `build_eu5.py` 同一枚 ✓
    #   → `meta.kindMask`：每地块 **1 字节**、base64
    #     1 陆地（兜底）/ 2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域 / 6 不可通行区域 ✓
    #   ⚠ **HOI4 只有海和湖** ✗（`definition.csv` 第 5 列就 `land` / `sea` / `lake` 三个值 ✓
    #     码 4 / 5 / 6 三格全图落"陆地 1" ✓ 不编假数据 ✓）
    #   ⚠ HOI4 那两份清单的键**不带井号**（`sea` / `lake` ✓）——
    #     下面归一化的时候补上 ✓（`kind_mask` 只认 `#` 开头的键 ✓）
    #   ⚠ **无归属区域不进这枚标** ✗（那是剧本 / 归属决定的 ✓ 不是地块身份 ✓）
    #   ⚠ 判据就是**上面传给 `build_special_titles` 的那两份清单** ✓
    #     跟"水域优先"一条口径 ✓ —— 同源，不会出现"造片一套、身份标另一套" ✗
    #   ⚠ **不许拿 `{ }` 当作用域块** ✗（Python 里那不是块 ✓ 见 build_data.py 那条教训 ✓）
    import base64 as _kind_b64mod                                 # noqa: PLC0415
    from build_tier_pieces import (kind_mask as _kind_mask,       # noqa: PLC0415
                                   KIND_CODES as _KIND_CODES)
    _kind_cat: dict[str, set[int]] = {}
    for _kkey, _ks in (("sea", _hoi4_lists.get("sea", set())),
                       ("lake", _hoi4_lists.get("lake", set()))):
        _nkey = "#" + _kkey.lstrip("#")           # HOI4 不带井号 → 补上 ✓
        if _nkey not in _KIND_CODES:
            continue                              # 这个游戏没有这一类 ✓ 不进标 ✓
        _kk = {int(p) for p in _ks if 0 < int(p) < n_prov}
        if _kk:
            _kind_cat[_nkey] = _kk
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
        f" (省份, 层级) 对（年份层借最粗那层的片 ✓）")

    ordered_all = ordered + special
    n_all = len(ordered_all)

    # 9. 成员 → 地盘数、像素面积
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
        # **底层地块身份标**（每地块 1 字节 base64 ✓ 2026-10-16 补 ✓
        #   1 陆地 / 2 海洋 / 3 湖泊 / 4 河流 / 5 不可通行海域 / 6 不可通行区域 ✓
        #   HOI4 只有前三种（省份类型就 land / sea / lake 三个值 ✓）✓）
        "kindMask": _kind_b64,
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
    # **水域名**（2026-10-13 ✓ 出处见 docs/水域名调研.md、接口见 _local/water_names_api2.md）
    #   ⚠ **按视图层各一套** ✗（用户要求："HOI4 的海域在 province 和 state 下应该每个地块
    #     一个名字，而在战略视图是合并的"✓）
    #     实测三层：sr=战略区名（3259，合并 ✓）/ st=州名（3259，只有 114 个水省
    #     拿得到真州名 ✓ 其余退区名 ✓）/ **pr=空** ✓
    #   ⚠⚠ **原版 HOI4 没有"每省一个专属名"这一级** ✗（实测核过，不是我漏做）：
    #     · `map/definition.csv` 第 5 列是**地块类型**（land/sea/lake），不是名字 ✓
    #     · 本地化 12.9 万条键里 `PROV<id>` **0 命中** ✓（`Unused1…` 那套是 **EU4** 的格式 ✓）
    #     · 唯一逐省的名字是 `VICTORY_POINTS_<省号>`（城市名 ✓ 落在水省上的 0 条 ✓）
    #   🔴 **2026-10-14：pr 层不再退战略区名** ✗✗（用户点破："Hoi4 的省份级水域
    #     和地区级是同一个东西，而且**没有名字**而已"✓）——
    #     以前退了区名 → 三层给的是同一套名字 ✓ 看不出"这一层没名字" ✗
    #     现在 pr 层**只认这一块自己的名字** ✓ 原版没有 → **`None`** ✓
    #     （前端那边跟着改：某层是 `None` 就**不再退回 `meta.seaNames`** ✓
    #      见 app.js 的 buildSeaLabelPoints / waterSpecificName / gl.js 的
    #      rebuildHoverGroups ✓ —— 只有**没有这张分层表**的老包才退 ✓）
    #     ⚠ 模组补了 `PROV<id>` 就能出逐块名 ✓ 那条路验通了 ✓（有名字就不会是 None ✓）
    #   `seaNames` 仍是**战略区口径**（第一轮验过的 3259 ✓）当"老包"兜底 ✓
    try:
        _by = H.load_water_names_by_tier(root)
        _arr = H.sea_names_by_tier(meta["tiers"], _by)
        if any(_arr):
            meta["seaNamesByTier"] = [
                ({str(k): str(v) for k, v in x.items()} if x else None) for x in _arr
            ]
        _sr = _by.get("sr") or {}
        if _sr:
            meta["seaNames"] = {str(k): str(v) for k, v in _sr.items()}
        log(f"水域名：分层 {[len(x or {}) for x in _arr]}")
    except Exception as _e:
        log(f"水域名解析跳过：{_e}")
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
