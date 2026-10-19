# -*- coding: utf-8 -*-
"""**每一层一片** —— 海 / 湖 / 河 / 荒地的分层伪头衔（2026-10-13 架构统一）。

用户原话：「**海域的边界划定也没有因为视图而改变**。其实你完全可以把它们视作一种
**仅仅是不能填色的普通地块**，它们一样用**上下级的规则**，这样就可以防止很多问题」✓

## 以前是特例 ✗

全世界的海共用一个 `#sea`、荒地粗层共用一个灰 —— 归属表（`titlemap.bin`）
**每一行填的都是同一个序号** ✓ 于是"换层之后海域范围会变"在缓存里根本没表达 ✗。
前端只好到处写旁路：水名表 `seaNamesByTier` / 悬停特判 / 高亮编组 / 边界特判…
一处改动要在四五处配对改 ✓ 长度还容易不齐（数组差一格 → 整个包导不进来 ✓ 踩过）。

## 现在是普通地块 ✓

**每一层的海 / 湖 / 河 / 荒地各有各的节点** ✓
一层的"片" = **该层同名地块的集合** ✓ —— 名字跟现成那几张水名表**同源** ✓
（`parsers/*/parser.py` 的 `load_water_names_by_tier` ✓ 不另编一套解析 ✗）。

于是前端只认一条规则：**当前层那个头衔是谁** ✓
悬停名 / 标签聚组 / 边界 / 高亮**全自动跟着层级走** ✓ 旁路可以删掉 ✓。

## 两条口径（别改错）

* **荒地不按名字并片** ✗ —— 粗层每层一片、**最细那层仍旧逐块一个节点**（`wl_<地块号>`）。
  「荒地按地块涂色」那个功能靠逐块节点 ✓ 按名字并会把同名荒地并掉（EU4 有 13 块 ✓）。
* **剧本层 / 空白层借最粗那层地理层的片** ✓（它们只关心陆地归谁）——
  这样每一行指向的节点 `tier` 都跟该行自洽 ✓ 前端的 `pidsOf` 不用再特判 ✓。

模块放在 `build_*.py` 这一族名字里（不进 `build_data.py` 是因为那份文件同时有人在做
"P 社国名弯曲"那一摊 ✓ 分开省得互相踩 ✗）。
"""
from __future__ import annotations

import numpy as np

from parsers.ck3.parser import Title

__all__ = ["tier_pieces", "tier_piece_parents", "build_special_titles", "apply_rows"]


def tier_pieces(pids, tiers, name_maps=None, label: str = "",
                skip_tiers=None) -> list[dict]:
    """把一批地块按**每一层各自的名字**聚成"片"。

    :param pids: 这一类的地块号（已经按"没有真头衔"过滤好 ✓）
    :param tiers: 要分片的层，**粗 → 细**（父一定排在子前面 ✓）
    :param name_maps: ``{层名: {地块号: 名字}}``；某层没有就给空 dict / None ✓
                      （那一层整片算一片，名字用 ``label`` ✓）
    :param label: 取不到名字时的兜底名（"海洋" / "湖泊" / "不可通行" ✓）
    :param skip_tiers: **这些层不造片** ✗（2026-10-14 ✓ 用户要求 ✓）
        水域的**最细层不再造伪头衔** ✓ —— 用户原话："你就不能把水域变成一个
        **仅仅是不能填色的地块**吗……**最底层的单位也有自己的 Province id**"✓
        → 最细层它就是它自己那个 province ✓ 不需要片 ✓
        ⚠ 但**粗层要保留** ✗ —— 用户："和陆地一样啊，**大名，河北，华北**，
          这样下来"（= 逐块 / 地区 / 大区 ✓）→ 地区 / 大区那两级照旧造 ✓
        ⚠ 荒地**不传这个** ✗ —— 它最细层要**逐块涂色** ✓（`wl_<pid>` ✓ 见 settable ✓）
    :returns: ``[{"tier": 层名, "name": 片名, "pids": [地块号…]}, …]``
              ⚠ **顺序稳定** ✗ —— 层按 ``tiers``、层内按名字排 ✓
              （包是可复现的 ✓ 同一位图两次构建必须逐字节一样 ✓）
    """
    maps = name_maps or {}
    _skip = set(skip_tiers or ())
    out: list[dict] = []
    for t in tiers:
        if t in _skip:
            continue
        nm_of = maps.get(t) or {}
        bucket: dict[str, list[int]] = {}
        for p in pids:
            nm = nm_of.get(int(p))
            # 🔴🔴 **取不到名字 → 用它自己的地块号** ✗✗（2026-10-14 ✓ 用户要求 ✓）
            #
            #   用户原话："你直接**全部都用 EU4 那套逻辑**！只不过 CK3 和 VIC3 的
            #     海域**不管什么层面都叫那个名字**"✓
            #     "打包 hoi4 的地图包的时候，**每个省份的 id 复制一遍到 state**"✓
            #
            #   → 所以"没名字"不是"跟别人挤成一片"✗ 而是"**它就是它自己**"✓
            #     用 `#<地块号>` 当片名 ✓（加 `#` 免得跟真名字撞 ✓）
            #     —— 效果 = **一块一片** ✓（HOI4 的 `st` 层就是这么修的 ✓）
            #   ⚠ 原来这里填的是 `label`（"海洋"/"湖泊"那种类名 ✓）→
            #     同一层里**所有没名字的海省并成一片** ✓（用户报的"一整块海洋"✗）
            #   ⚠ **一处改完全部生效** ✗ —— 所有游戏都走这个函数 ✓
            #     （EU4/EU5 每层都有表 ✓ 走不到这个分支 ✓ 不受影响 ✓）
            bucket.setdefault(str(nm) if nm else f"#{int(p)}", []).append(int(p))
        for nm in sorted(bucket):
            out.append({"tier": t, "name": nm, "pids": sorted(bucket[nm])})
    return out


def tier_piece_parents(pieces: list[dict], tiers) -> list[int]:
    """细层的片挂到粗层里**含它多数地块**的那一片上；挂不上 → -1（当根 ✓）

    骨架跟 `build_data.build_realm_layer` 认国号那几步一个路子：**多数投票**，
    比不过就不认 ✓ 为什么不是"取最大"：一片细海被粗层的两片切开时（跨了两片粗海 ✓），
    它属于哪一片本来就没定论 ✓ 与其瞎认一个父，不如让它当根 ✓
    """
    order = list(tiers)
    par = [-1] * len(pieces)
    by_tier: dict[str, list[tuple[int, set]]] = {t: [] for t in order}
    for i, pc in enumerate(pieces):
        by_tier.setdefault(pc["tier"], []).append((i, set(pc["pids"])))
    for i, pc in enumerate(pieces):
        want = set(pc["pids"])
        if not want or pc["tier"] not in by_tier:
            continue
        coarser = order[:order.index(pc["tier"])]
        for t in reversed(coarser):        # 从最近的那层往外找 ✓
            best, best_n = -1, 0
            for j, s in by_tier.get(t, ()):
                n = len(want & s)
                if n > best_n:
                    best, best_n = j, n
            if best >= 0 and best_n * 2 >= len(want):
                par[i] = best
                break
    return par


#: **底层地块身份标**（`meta.kindMask` 的口径 ✓ 2026-10-15 用户定 ✓）
#:
#:   用户原话："你可以给不是这些玩意的普通陆地加上陆地标记，就像给他们加上海洋河流标记
#:     一样。这个标记统一加给所有底层 prov 的 id 设置，反正不管怎么切换也无法改变
#:     他们的身份" ✓
#:
#:   ⚠ 键名就是各游戏 `SPECIAL_CATEGORIES` 里那几个 ✓（`#` 开头 ✓）
#:     顺序 = 判定优先级（先命中的赢 ✓ 跟水陆那套一致 ✓）
KIND_CODES: dict[str, int] = {
    "#sea": 2, "#lake": 3, "#river": 4, "#impassable_sea": 5, "#impassable": 6,
}


def kind_mask(n_prov: int, cats: dict) -> str:
    """把"每个底层地块是什么"烤成一枚 base64 标（**每地块 1 字节** ✓）。

    跟前端 `decodeKindMask` 一个口径（= 当年 `meta.waterMask` 那个形状 ✓）：

    ====  ================  ==================================================
    码    身份              来源
    ====  ================  ==================================================
    0     空位（0 号不用 ✓） —
    1     **陆地**（兜底 ✓） 不属于下面任何一类的底层 pid 全是它 ✓
    2     海洋              ``#sea``
    3     湖泊              ``#lake``
    4     河流              ``#river``（CK3 有 ✓ / EU5 是空集 ✓）
    5     不可通行海域       ``#impassable_sea``（CK3 有 ✓）
    6     不可通行区域       ``#impassable``
    ====  ================  ==================================================

    ⚠ **无归属区域不在这枚标里** ✗✗（用户明确交代 ✓）——
      无归属是**剧本 / 归属**决定的，不是地块身份 ✓
      它继续按运行时算（前端那行 `set-unpainted` ✓）
    ⚠ 认不出来（`cats` 空 / 游戏没有那一类）→ 那几类**老实留空** ✓，
      全图落到**陆地 1** ✓（兜底**不许有空洞** ✗ 前端拿它当唯一判据 ✓）
    """
    import base64                                     # 局部导入：这文件别处不用 ✓

    kind = np.ones(int(n_prov), dtype=np.uint8)       # 1 = 陆地 ✓ 兜底
    if kind.size:
        kind[0] = 0                                   # 0 号不用 ✓
    for key, code in KIND_CODES.items():
        for p in (cats.get(key) or ()):
            i = int(p)
            if 0 <= i < kind.size:
                kind[i] = code
    return base64.b64encode(kind.tobytes()).decode("ascii")


def build_special_titles(
    source_lists: dict[str, set[int]],
    categories,
    n_prov: int,
    blank: np.ndarray,
    base_index: int,
    geo_tiers,
    *,
    script_tiers=None,
    tier_names: dict[str, dict[int, str]] | None = None,
    waste_names: dict[int, str] | None = None,
    settable=(),
    skip_fine_tier: bool = False,
    name_sink: dict[str, str] | None = None,
    kind_sink: dict[str, set[int]] | None = None,
) -> tuple[list[Title], dict[str, np.ndarray], list[str], list[int], list[int]]:
    """给制不出头衔的地块分类 —— **每一层给该层自己的伪头衔** ✓

    :param source_lists: ``{类别键: 地块集合}``（CK3 是 default.map 的分类字典、
                         EU4 系是 ``{"lakes": …, "sea_starts": …}`` ✓）
    :param categories: ``[(key, 中文名, 颜色, [来源键…] 或 None), …]``
                       —— 来源给 None / 空 = "前面都没认领的空白地块"（荒地兜底 ✓）
    :param blank: 长度 n_prov 的 bool 表，True = 这个省份在**所有**层级都没有头衔 ✓
    :param geo_tiers: 要分片的**地理**层（粗 → 细 ✓）；剧本层 / 空白层不算 ✓
    :param tier_names: ``{层名: {地块号: 名字}}`` —— 那一层的水名表 ✓
    :param waste_names: ``{地块号: 荒地名}`` —— 荒地**没有分层表**（游戏里就一张 ✓），
                        所以每个粗地理层都拿它分片（同名的荒地算一片 ✓）
    :param settable: 这些类别**最细那层逐块一个节点**（荒地 / 不可通行 ✓）
    :param name_sink: 伪头衔的中文名写进这个字典（调用方拼 titles.json 时用 ✓）
    :returns: (节点列表, ``{层名: 该层逐地块的归属数组}``, 统计文字,
               逐块荒地的地块号, 逐块荒地的**真实节点号**（与地块号一一对应）)
    """
    tiers = list(geo_tiers)
    rows: dict[str, np.ndarray] = {t: np.full(n_prov, -1, dtype=np.int64) for t in tiers}
    claimed = np.zeros(n_prov, dtype=bool)      # 一个地块只归一个类别（照列表顺序 ✓）
    titles: list[Title] = []
    stats: list[str] = []
    waste_pids: list[int] = []
    waste_tids: list[int] = []
    #: 剧本层那种"整类一片"一共造了几个（只用于日志 ✓ 见下面那段 ✓）
    whole_built = 0
    fine = tiers[-1]
    coarser = tiers[:-1]                        # 逐块那层的上面几层 ✓（可能为空 ✓）

    for key, label, rgb, sources in categories:
        if sources:
            wanted: set[int] = set()
            for s in sources:
                wanted |= set(source_lists.get(s, ()) or ())
            cand = np.fromiter((p for p in wanted
                                if 0 < p < n_prov and blank[p] and not claimed[p]),
                               dtype=np.int64)
        else:
            cand = np.nonzero(blank & ~claimed)[0]      # 兜底：剩下没认领的空白地块 ✓
        if cand.size == 0:
            continue
        claimed[cand] = True
        pids = [int(p) for p in cand.tolist()]
        # **身份标**的原始账（→ `kind_mask` ✓ 2026-10-15 ✓）：
        #   这个类别认领了哪些底层地块 ✓ —— 调用方拿去烤 `meta.kindMask` ✓
        #   ⚠ 键统一带 `#` ✗（HOI4 那边传的是 `sea` / `lake`，没井号 ✓ 归一化 ✓）
        #   ⚠ `kind_sink` 不给（None）= 老行为，一个字节都不动 ✓
        if kind_sink is not None:
            _k = str(key)
            kind_sink.setdefault(_k if _k.startswith("#") else "#" + _k,
                                 set()).update(pids)
        per_block = key in settable
        if per_block:
            # 裁到粗层为止 —— 最细那层是**逐块节点**，不在这一轮里 ✓
            maps = {t: (waste_names or {}) for t in coarser}
            pieces = tier_pieces(pids, coarser, maps, label)
            pars = tier_piece_parents(pieces, coarser)
        else:
            # 🔴🔴 **每一层都造片** ✗✗（2026-10-14 ✓ 用户统一口径 ✓）
            #
            #   用户原话："你直接**全部都用 EU4 那套逻辑**！只不过 CK3 和 VIC3 的
            #     海域**不管什么层面都叫那个名字**"✓
            #
            #   → 不再有"最细层不造"这个特例 ✗（`skip_fine_tier` 从此**只影响
            #     兼容、不再跳过任何层** ✓ 保留参数是为了不动各游戏的调用 ✓）
            #   ⚠ 名字怎么办 ✗ —— 由 `tier_pieces` 那条统一规则管：
            #     表里有就用 ✓ 没有就**用它自己的地块号**（= 一块一片 ✓）
            #     → 所以 CK3 / VIC3（没有分层表 ✓）每一层都是"逐块"✓
            #       片名各层一样（都是 `#<地块号>` ✓）—— 正是用户要的"不管
            #       什么层面都叫那个名字"✓
            #   ⚠ 荒地 / 不可通行仍走上面 `per_block` 那条 ✗（它们最细层要
            #     **逐块涂色** ✓ 见 `wl_<pid>` ✓）
            pieces = tier_pieces(pids, tiers, tier_names, label)
            pars = tier_piece_parents(pieces, tiers)
        #: 每层每个片名 → 节点 key（逐块荒地要挂到"它那一层同名的那一片"上 ✓）
        key_of: dict[tuple[str, str], str] = {}
        built = 0
        for pi, pc in enumerate(pieces):
            t = Title(f"{key}_{pc['tier']}_{pi}", tier=pc["tier"])
            t.color = rgb
            if pars[pi] >= 0:
                _p = pieces[pars[pi]]
                t.parent = f"{key}_{_p['tier']}_{pars[pi]}"     # 上下级 ✓
            titles.append(t)
            key_of[(pc["tier"], pc["name"])] = t.key
            _tid = base_index + len(titles) - 1
            for pid in pc["pids"]:
                rows[pc["tier"]][pid] = _tid
            if name_sink is not None:
                # ⚠ 粗层片名也可能是 `#<地块号>`（`tier_pieces` 里"没名字 → 用它
                #   自己的地块号"那条 ✓ 井号是防撞前缀、不是给人看的 ✗
                #   照抄就把 `#3737` 印到图上 ✓（用户 2026-10-19 报的同款 ✓）
                #   → 这里剥掉井号，退成"没名字"（前端会拿类名 / 空兜底 ✓）
                _pn = str(pc["name"] or "")
                if _pn.startswith("#"):
                    _pn = _pn.lstrip("#").strip()
                name_sink[t.key] = _pn
            built += 1
        if per_block:
            # 最细那一层：**逐块一个节点**（荒地要能一块块涂 ✓）
            up = coarser[-1] if coarser else None
            for pid in pids:
                tid = base_index + len(titles)
                wt = Title(f"wl_{pid}", tier=fine)
                wt.color = rgb
                if up:
                    nm = (waste_names or {}).get(pid) or label
                    wt.parent = key_of.get((up, nm))
                titles.append(wt)
                rows[fine][pid] = tid
                waste_pids.append(int(pid))
                waste_tids.append(tid)
                if name_sink is not None:
                    # ⚠ `#` 前缀是 EU4 那个"只当地名、不上地图"的约定 ✗
                    #   照抄就把井号印到图上了（用户 2026-10-19 报的 ✓）
                    _wn = str((waste_names or {}).get(pid) or label)
                    if _wn.startswith("#"):
                        _wn = _wn.lstrip("#").strip()
                    name_sink[wt.key] = _wn
            stats.append(f"→ 逐块 {cand.size} 个")
        stats.append(f"{label} {cand.size} 个 → 每层 {built} 片")

        # 🔴🔴 **剧本层：这一整类共用一个节点** ✗✗（2026-10-14 ✓ 用户的主意 ✓）
        #
        #   用户原话："我想出一个非常精妙的主意，你可以把**所有剧本级别的海域的
        #     归属全部改成同一个比如海洋**，这样**中间就不会有边界了**"
        #
        #   ⚠ 为什么这一招好 ✗：剧本层是"国家"那一层 ✓ 海域在那儿本来就没有
        #     任何真实归属 ✓ 与其留空（`NONE` ✓ 前端得走"无主"那条特例 ✓）
        #     不如**给它们一个共同的、说得出口的身份**：就是"海洋"✓
        #     → 同一层里所有海**同一个 tid** ✓ 于是任何按 tid 比的东西
        #       （边界 / 高亮 / 颜色边界 ✓）都判成"同一片"→ **中间一条线都没有** ✓
        #     → 而且悬停卡片能显示"海洋"✓（用户要的：CK3 海域就说它是什么 ✓）
        #
        #   ⚠ 每个剧本层**各造一个** ✗（不是全游戏共用一个 ✓）——
        #     节点的 `tier` 得跟它所在的层对上 ✓（前端按层分组 / 查表 ✓）
        #     层数很少（CK3 1 个、EU4 3 个 ✓）所以节点数可以忽略 ✓
        #   ⚠ 名字用**类别名**（"海洋" / "湖泊" / "不可通行海域" ✓）——
        #     它就该是"这块地是什么"，不是"哪一片海"✓（用户点名的 ✓）
        #   ⚠ 只给**剧本层**造 ✗ —— 地理层照旧按那一层的名字分片 ✓
        #     （那儿才有"大名 / 河北 / 华北"✓ 粒度才有意义 ✓）
        #
        # 🔴🔴 **荒地 / 不可通行：不给剧本层造这个** ✗✗（2026-10-14 ✓ 用户报的 ✓）
        #   用户原话："荒地设定也有问题，现在的情况是**悬停时所有荒地都在亮**，
        #     **不要给他们分配剧本归属**应该能解决这个问题"
        #   ⚠ 对 ✗ —— 荒地（和不可通行 ✓）本来在剧本层就是"**无主**"的 ✓
        #     我上一版给它们也造了"整类一片"→ 剧本层所有荒地**同一个 tid** ✓
        #     → 悬停一块 → 前端按 tid 整片亮 → **全世界荒地一起亮** ✗（用户看到的 ✓）
        #   ✅ 判据：**`settable` 那两类不造** ✗（`("#impassable", "#wasteland")` ✓
        #     见 `build_data.SETTABLE_CATEGORIES` / `build_eu4.SETTABLE_CATEGORIES` ✓）
        #     它们本来就该"留空"✓（前端按"无主"处理 ✓ 悬停只亮一格 ✓）
        #   ⚠ 水域那几类（海 / 湖 / 河 / 不可通行海域 ✓）**照造** ✗ ——
        #     它们需要那个"海蓝色"和"海洋"这个名字 ✓（用户上一条要的 ✓）
        #   ⚠ `per_block` 正是 `settable` 那两类 ✗（见上面那条分支 ✓）
        #     所以判据直接用它 ✓ 不用另立一套 ✗
        if not per_block:
            for _st in (script_tiers or ()):
                _whole = Title(f"{key}_all_{_st}", tier=_st)
                _whole.color = rgb
                titles.append(_whole)
                _wtid = base_index + len(titles) - 1
                if _st not in rows:
                    rows[_st] = np.full(n_prov, -1, dtype=np.int64)
                rows[_st][cand] = _wtid
                if name_sink is not None:
                    name_sink[_whole.key] = label
                whole_built += 1

    if whole_built:
        stats.append(f"剧本层每类各 1 片 × {whole_built}")

    return titles, rows, stats, waste_pids, waste_tids


def apply_rows(titlemap, rows: dict[str, np.ndarray], tier_order, geo_tiers) -> int:
    """把"每层各自的归属"填进归属表；返回填了多少格。

    * 每个地理层填它**自己那一行** ✓（节点 `tier` 跟行号天然自洽 ✓）
    * 🔴 **剧本层：每一类共用一个节点** ✗✗（2026-10-14 ✓ 用户的主意 ✓）
      用户原话："我想出一个非常精妙的主意，你可以把**所有剧本级别的海域的归属
        全部改成同一个比如海洋**，这样**中间就不会有边界了**"
      → 节点在 `build_special_titles` 里就造好了（`script_tiers` 那个参数 ✓
        每个剧本层 × 每个类别**一个**节点 ✓ 名字就是类别名"海洋"✓）
        它们**按层名**存进 `rows` ✓ → 下面这个循环天然就填上了 ✓ 不用特殊处理 ✓
      ⚠ 跟"借最粗地理层的片"**不是一回事** ✗ —— 那是**多片**（`#sea_rg_0/1/2…` ✓）
        于是剧本层海里照样有内部边界 ✗；这个是**一片**✓ 所以没边界 ✓
      ⚠ 空白剧本层**仍旧留空** ✗（`patch_blank_era` 管的那一层 ✓
        它整层无主 → 也没内部边界 ✓ 两种都达到目的 ✓）
    """
    order = list(tier_order)
    filled = 0
    for t, arr in rows.items():
        if t not in order:
            continue
        sel = arr >= 0
        if not sel.any():
            continue
        titlemap[order.index(t)][sel] = arr[sel].astype(np.uint16)
        filled += int(sel.sum())
    return filled
