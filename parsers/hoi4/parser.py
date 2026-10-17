"""HOI4 的地图数据。

跟 CK3 / EU4 不一样的地方（都是翻过才发现）：

* ``map/definition.csv`` 是 **8 列**：``province;r;g;b;type;coastal;terrain;continent``。
  比 EU4 多出 type / coastal / terrain / continent —— type 直接标明 land/lake/sea，
  不用再去翻 ``default.map`` 的名单。
* **省份自己没有名字**。有名字的是国家、战略区、州，以及「胜利点」（城市）：
  胜利点的键就是省份 id（``VICTORY_POINTS_3838``）。10155 个陆地省份里只有
  15% 有城市名，剩下的是货真价实的无名地块 —— 不编名字。
* **官方自带简体中文**（``localisation/simp_chinese``，UTF-8 BOM），格式是
  ``KEY: "文本"``。不是 EU4 那套"双字节"，也不用装汉化 mod。
* **归属**写在 ``history/states/*.txt`` 的 ``history = { ... }`` 里：无日期的
  ``owner = PHI`` 就是 1936 剧本（游戏最早的开局），带日期的块
  （``1939.1.1 = { owner = ... }``）覆盖之后的状态。1081 个州里只有 **57 个**
  的日期块真的动了归属 —— 德奥合并、慕尼黑协定、瓜分波兰这些。
* **水域名分三层**（第二轮 ✓）：战略区层是**合并**口径（一个区一个名，第一轮的
  结果），州层用州名，省层想用"每块自己的名字"。但 HOI4 原版**根本没有逐省
  水名**（``definition.csv`` 第 5 列是地块类型、本地化里没有 ``PROV<id>`` 键、
  1709 条胜利点一条都不落在水省上 ✗），所以原版上省层退成战略区名 ——
  详见 :func:`load_water_names_by_tier`。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import NamedTuple

from parsers.ck3.parser import as_int_list, block_all, block_get, parse_localisation, parse_script

#: definition.csv 的列数
DEF_COLS = 8

#: ``1939.1.1`` 这种日期键
_DATE_KEY = re.compile(r"^(\d{3,4})\.(\d+)\.(\d+)")

#: 剧本里的国家块：``FRA = { ... }`` 那样的三字母键
_TAG_KEY = re.compile(r"^[A-Z]{2,4}$")

#: 本地化里游戏自带的排版码：§G 换色、§! 复位
_LOC_MARKUP = re.compile(r"§.")


def _limit_ok(limit, dlcs) -> bool:
    """DLC 条件的粗略判定。``dlcs is None`` 表示"当全都装了"。

    只认常见的几种：``has_dlc = "X"`` / ``NOT = { ... }`` / ``AND`` / ``OR``。
    认不出来的条件一律**当真**（宁可多应用，也别漏 —— 漏了就是整块势力消失）。
    """
    if not isinstance(limit, list):
        return True
    # dlcs=None = "全都装了"：那 has_dlc 一律为真，但**逻辑结构照样要算** ——
    # 直接 return True 会把 NOT = { has_dlc = ... } 也当成真 ✗
    # （于是"马家军并入中国"那种块被执行，1939 剧本里马家军就没了 ✗）
    _has = (lambda _nm: True) if dlcs is None else (lambda _nm: str(_nm).strip('"') in dlcs)
    ok = True
    for k, v in limit:
        if not isinstance(k, str):
            continue
        ku = k.upper()
        if k == "has_dlc":
            ok = ok and _has(v)
        elif ku == "NOT" and isinstance(v, list):
            ok = ok and not _limit_ok(v, dlcs)
        elif ku == "AND" and isinstance(v, list):
            ok = ok and _limit_ok(v, dlcs)
        elif ku == "OR" and isinstance(v, list):
            ok = ok or _limit_ok(v, dlcs)
    return ok


def _owner_in(pairs, dlcs) -> str | None:
    """效果列表里"谁变成所有者"：``owner = X`` / ``transfer_state_to = X`` /
    **``X = { transfer_state = … }``**（国家作用域，原来漏掉的就是它 ✗）。

    会穿过 ``IF / ELSE / ELSE_IF``（并按 ``limit`` 里的 DLC 条件决定进不进）。

    Paradox 的效果按顺序生效、**后写覆盖先写**（``_effect_tag`` 的注释也是
    这么写的）—— 所以不能扫到第一个就 return，得记下最后一个生效的。
    原来的"首个命中即返回"会把「先 owner = CHI、后 IF{transfer_state_to = XSM}」
    读成 CHI，DLC 移交整个被丢掉。
    （这处修法来自 v1.5 的代码审查 PR #1 ✓）
    """
    got: str | None = None
    for k, v in pairs:
        if not isinstance(k, str):
            continue
        if k in ("owner", "transfer_state_to") and isinstance(v, str):
            got = v
            continue
        ku = k.upper()
        if ku in ("IF", "ELSE", "ELSE_IF", "AND", "OR"):
            if not isinstance(v, list):
                continue
            lim = [b for a, b in v if isinstance(a, str) and a.upper() == "LIMIT"]
            if ku in ("IF", "ELSE_IF") and lim and not _limit_ok(lim[0], dlcs):
                continue
            sub = _owner_in(v, dlcs)
            if sub:
                got = sub
            continue
        if _TAG_KEY.match(k) and isinstance(v, list):
            for a, _b in v:
                if a == "transfer_state":
                    got = k
    return got


class State(NamedTuple):
    """一个州。"""

    id: int
    name_key: str                 # STATE_1
    owner: str | None             # 1936 剧本的**所有者**
    timeline: list                # [(日期, tag)]，按时间排好
    provinces: list               # 省份 id
    vp: dict                      # 省份 id → 胜利点值
    controller: str | None = None # 1936 剧本的**控制者**（被占领时跟 owner 不一样）
    ctimeline: list = []          # 控制者的时间线，同上
    ptimeline: list = ()          # **逐省份**控制：[(日期, tag, 省份id)]  —— 一个州可以一半一半


def parse_definition(path: Path) -> dict[int, tuple[int, int, int, str]]:
    """``definition.csv`` → ``{id: (r, g, b, type)}``。type 是 land/lake/sea。"""
    out: dict[int, tuple[int, int, int, str]] = {}
    text = Path(path).read_text(encoding="latin-1", errors="replace")
    for line in text.splitlines():
        p = line.split(";")
        if len(p) < DEF_COLS:
            continue
        try:
            pid = int(p[0])
            r, g, b = int(p[1]), int(p[2]), int(p[3])
        except ValueError:
            continue          # 表头之类的
        out[pid] = (r, g, b, p[4].strip().lower())
    return out


def parse_definition_rows(path: Path) -> dict[int, list[str]]:
    """原样保留 8 列 —— 导出时要一列不差地写回去。"""
    out: dict[int, list[str]] = {}
    text = Path(path).read_text(encoding="latin-1", errors="replace")
    for line in text.splitlines():
        p = line.split(";")
        if len(p) != DEF_COLS:
            continue
        try:
            int(p[0])
        except ValueError:
            continue
        out[int(p[0])] = [c.strip() for c in p]
    return out


def parse_continents(path: Path) -> list[str]:
    """``map/continent.txt`` 里的洲名表。定义表第 8 列就是它的序号。"""
    text = Path(path).read_text(encoding="latin-1", errors="replace")
    m = re.search(r"continents\s*=\s*\{([^}]*)\}", text)
    return re.findall(r"[a-z_]+", m.group(1)) if m else []


def _clean_tag(raw: str) -> str | None:
    """``owner = SWE`` 里的 SWE。``---`` 之类的占位符当无主。"""
    t = raw.strip().strip('"')
    if not t or set(t) <= {"-"} or t.lower() in ("none", "null"):
        return None
    return t


def _effect_tag(entries, keys, depth: int = 0) -> str | None:
    """按顺序走一遍这些条目，返回它们最后定下来的归属（没有就 None）。

    认三种写法（``keys`` 决定这次要取哪个键）：

    * ``owner = TAG`` / ``controller = TAG`` —— 最直白的那种；
    * ``transfer_state_to = TAG`` —— **开局移交**。DLC 就是靠这个把中国的州
      在 ``1936.1.1`` 交给四川/西康/湖北这些军阀的，只看 ``owner`` 会全漏掉
      （于是 1936 的四川显示成国民政府的）；
    * ``IF = { limit = { has_dlc = "..." } ... }`` —— 开了那个 DLC 才生效。
      实测州历史里 **57 个 limit 全是 has_dlc**，没有别的条件，
      所以按"全开 DLC"算它们全部成立。

    块按顺序生效，所以后出现的覆盖先出现的（1938.10.25 那个块里
    ``IF{remove_core_of}` 之后又写了 ``owner = CHI``，就是要把州收回来）。
    """
    if depth > 4:
        return None
    owner: str | None = None
    for key, value in entries:
        if key is None:
            continue
        if key in keys and isinstance(value, str):
            tag = _clean_tag(value)
            if tag:
                owner = tag
        elif key == "limit":
            continue          # 条件块，里面的不是效果
        elif isinstance(value, list):
            sub = _effect_tag(value, keys, depth + 1)
            if sub:
                owner = sub
    return owner


def parse_states(dir_path: Path, dlcs=None) -> dict[int, State]:
    """``history/states`` → ``{州 id: State}``。

    :param dlcs: 已启用 DLC 的名字集合（``dlc_load.json`` 里读）——
        ``IF = { limit = { has_dlc = ... } }`` 那类块按它决定进不进；
        传 ``None`` 表示"当全都装了"。
    """
    out: dict[int, State] = {}
    d = Path(dir_path)
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        try:
            text = fp.read_text(encoding="latin-1", errors="replace")
        except OSError:
            continue
        body = block_get(parse_script(text), "state")
        if not isinstance(body, list):
            continue
        sid = block_get(body, "id")
        if not isinstance(sid, (int, str)):
            continue
        try:
            sid = int(sid)
        except (TypeError, ValueError):
            continue

        name_key = block_get(body, "name")
        hist = block_get(body, "history")
        owner = None
        controller = None
        timeline: list[tuple[tuple[int, int, int], str]] = []
        ctimeline: list[tuple[tuple[int, int, int], str]] = []
        ptimeline: list[tuple[tuple[int, int, int], str, int]] = []
        vp: dict[int, int] = {}
        if isinstance(hist, list):
            # 无日期那一段就是"1936 之前的底子"
            base = [(k, v) for k, v in hist
                    if not (isinstance(k, str) and _DATE_KEY.match(k))]
            owner = (_owner_in(base, dlcs)
                     or _effect_tag(base, ("owner", "transfer_state_to")))
            controller = _effect_tag(base, ("controller",))
            # 一块可以写好几条 victory_points，都是"省份 点数"成对
            for blk in block_all(hist, "victory_points"):
                nums = as_int_list(blk)
                for i in range(0, len(nums) - 1, 2):
                    vp.setdefault(nums[i], nums[i + 1])
            for key, value in hist:
                if key is None or not isinstance(value, list):
                    continue
                m = _DATE_KEY.match(key)
                if m is None:
                    continue
                when = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
                tag = (_owner_in(value, dlcs)
                       or _effect_tag(value, ("owner", "transfer_state_to")))
                if tag:
                    timeline.append((when, tag))
                ctag = _effect_tag(value, ("controller",))
                if ctag:
                    ctimeline.append((when, ctag))
                # **逐省份控制**：`1938.10.25 = { JAP = { set_province_controller = 1018 } }`
                # 一个州可以一半归中国、一半被日本控制 —— 只看州级的 controller 会漏掉。
                for ck, cv in value:
                    if ck is None or not isinstance(cv, list) or not _TAG_KEY.match(ck):
                        continue
                    for pk, pv in cv:
                        if pk != "set_province_controller":
                            continue
                        try:
                            ptimeline.append((when, ck, int(pv)))
                        except (TypeError, ValueError):
                            pass
        timeline.sort(key=lambda x: x[0])
        ctimeline.sort(key=lambda x: x[0])
        ptimeline.sort(key=lambda x: x[0])

        provinces = as_int_list(block_get(body, "provinces"))
        out[sid] = State(
            id=sid,
            name_key=str(name_key or f"STATE_{sid}").strip('"'),
            owner=owner,
            timeline=timeline,
            provinces=[p for p in provinces if p],
            vp=vp,
            controller=controller,
            ctimeline=ctimeline,
            ptimeline=ptimeline,
        )
    return out


def parse_strategic_regions(dir_path: Path) -> dict[int, tuple[str, list[int]]]:
    """``map/strategicregions`` → ``{id: (名字键, [省份])}``。"""
    out: dict[int, tuple[str, list[int]]] = {}
    d = Path(dir_path)
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        try:
            text = fp.read_text(encoding="latin-1", errors="replace")
        except OSError:
            continue
        body = block_get(parse_script(text), "strategic_region")
        if not isinstance(body, list):
            continue
        sid = block_get(body, "id")
        try:
            sid = int(sid)
        except (TypeError, ValueError):
            continue
        name_key = str(block_get(body, "name") or f"STRATEGICREGION_{sid}").strip('"')
        provinces = [p for p in as_int_list(block_get(body, "provinces")) if p]
        out[sid] = (name_key, provinces)
    return out


def parse_country_tags(common: Path) -> dict[str, str]:
    """``common/country_tags`` → ``{tag: 相对 common/ 的文件路径}``。"""
    out: dict[str, str] = {}
    d = Path(common) / "country_tags"
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        for line in fp.read_text(encoding="latin-1", errors="replace").splitlines():
            m = re.match(r'^\s*([A-Z0-9]{2,4})\s*=\s*"([^"]+)"', line)
            if m:
                out.setdefault(m.group(1), m.group(2))
    return out


def parse_country_colors(common: Path, tags: dict[str, str]) -> dict[str, tuple[int, int, int]]:
    """国家在地图上是什么颜色。

    **优先读 ``common/countries/colors.txt``** —— 那才是地图配色的正表。
    每个国家自己那个 ``<Name>.txt`` 里的 ``color`` 往往是**占位值**：实测 1936 的
    90 个国家里有 **30 个**两边不一样，而且每国文件里好几个国家共用同一个颜色
    （``(152,130,191)`` 被不丹/古巴/海地/尼加拉瓜/南非… 8 个国家共用），
    瑞士那个甚至是 ``(33,14,19)`` 的近乎全黑 —— 画出来就是"这个国家没有颜色"。

    colors.txt 里允许写 HSV（德国就是 ``HSV { 0.1 0.15 0.4 }``），``as_rgb`` 会算。
    """
    from parsers.ck3.parser import as_rgb
    out: dict[str, tuple[int, int, int]] = {}

    table = Path(common) / "countries" / "colors.txt"
    if table.is_file():
        text = table.read_text(encoding="latin-1", errors="replace")
        for key, value in parse_script(text):
            if key is None or not isinstance(value, list):
                continue
            rgb = as_rgb(block_get(value, "color"))
            if rgb:
                out[key] = rgb

    # 正表里没有的（少部分 tag），退回它自己那个文件
    for tag, rel in tags.items():
        if tag in out:
            continue
        fp = Path(common) / rel.replace("\\", "/")
        if not fp.is_file():
            continue
        for key, value in parse_script(fp.read_text(encoding="latin-1", errors="replace")):
            if key == "color":
                rgb = as_rgb(value)
                if rgb:
                    out[tag] = rgb
                break
    return out


def load_names(lang_dir: Path, keys) -> dict[str, str]:
    """读一个语言目录里的名字，顺手把 ``§G`` 这类排版码去掉。

    两个坑，都是 2026-10-13 烘模组时踩出来的：

    * **子目录要递归读** —— 模组爱把文本按主题分文件夹放：KR 的正文在
      ``english/KR_common/`` ``english/KR_country_specific/`` 里（37.9 MB），
      顶层那 121 个 yml 只有 0.6 MB。只读顶层 = 名字大面积空掉。
    * **``replace/`` 优先级最高** —— 那是 Paradox 的覆盖机制，模组把改动过的
      文本整份放这儿：TFR 的 1493 个州名就全在
      ``simp_chinese/replace/TFR_replace_state_names_l_simp_chinese.yml`` 里。
      所以它得**最后**读，才盖得住前面读到的。
    """
    d = Path(lang_dir)
    if not d.is_dir():
        return {}
    raw = parse_localisation(d, keys, recursive=True, skip=("replace",))
    rep = d / "replace"
    if rep.is_dir():
        raw.update(parse_localisation(rep, keys, recursive=True))
    return {k: _LOC_MARKUP.sub("", v).strip() for k, v in raw.items()}


#: ``lang`` 参数 → 本地化**目录名**，按优先级排（前面的盖后面的）。
#: HOI4 的简中目录叫 ``simp_chinese``（不是 ``zh``），所以参数得翻译一道。
_WATER_LANG_DIRS: dict[str, tuple[str, ...]] = {
    "zh": ("simp_chinese", "english"),
    "zh_cn": ("simp_chinese", "english"),
    "zh_hans": ("simp_chinese", "english"),
    "zh_hant": ("simp_chinese", "english"),
    "chs": ("simp_chinese", "english"),
    "cn": ("simp_chinese", "english"),
    "chinese": ("simp_chinese", "english"),
    "simp_chinese": ("simp_chinese", "english"),
    "en": ("english",),
    "english": ("english",),
}

#: ``definition.csv`` 第 5 列里**能贴水名**的类型。
#: ``land`` 故意不在这里 —— 半陆半海的战略区（16 北海 = 14 sea + 1 land）
#: 只标它里面的水省，不然"北海"会糊到陆地上 ✗
_WATER_TYPES = frozenset(("sea", "lake"))

#: 三层水域视图的层名。跟 ``meta.tiers`` 的**尾部**对齐（sr 最粗 → pr 最细）——
#: HOI4 的 ``meta.tiers`` 是 ``['1936','1939','blank','sr','st','pr']``。
WATER_TIERS = ("sr", "st", "pr")

#: ``definition.csv`` 第 5 列里"这不是名字、是地块类型"的三个记号 ——
#: **HOI4 原版那一列就是它**，见 :func:`parse_definition_names`。
_DEF_TYPE_TOKENS = frozenset(("land", "sea", "lake"))

#: 本地化 / 定义表里的占位名：``Unused`` / ``Unused976`` 是随机新世界的预留位，
#: 不是地名 ✗ 宁可不给名字，也别把 "Unused42" 发到地图上。
_UNUSED_NAME = re.compile(r"^\s*unused\s*\d*\s*$", re.I)

#: 同一份 root + lang 的分层结果只算一次（构建器会反复问）。
_TIER_CACHE: dict[tuple[str, str], dict] = {}


def _water_lang_dirs(lang: str) -> tuple[str, ...]:
    """``lang`` → 本地化目录名列表。写的是目录名就照用，认不出来就原样试再退回英文。"""
    raw = str(lang or "").strip()
    if not raw:
        return ("simp_chinese", "english")
    hit = _WATER_LANG_DIRS.get(raw.lower().replace("-", "_"))
    if hit is not None:
        return hit
    return (raw, "english") if raw != "english" else ("english",)


def load_water_names(root: Path, *, lang: str = "zh") -> dict[int, str]:
    """HOI4 的水域名 → ``{省份 id: 名字}``。认不出来返回 ``{}``。

    链路（省 → 战略区 → 名字），全照 ``docs/水域名调研.md`` 那一节走：

    1. ``map/strategicregions/*.txt``：拿每个区的 ``id`` 和 ``provinces`` 列表。
       **名字键取文件里写的 ``name``**，不是按 id 拼出来的 —— 因为有 id=215
       那个例外（文件里写的是 ``STRATEGICREGION_NAMIBIA``，不是 ``..._215``）。
       顺带也绕开了"文件名不可信"那个坑（88/304 个文件名跟真名不一样：
       ``9-Baltic Sea.txt`` 的真名其实是芬兰湾）—— 文件名我们压根不看 ✓
    2. ``map/definition.csv`` 第 5 列判省是 ``land`` / ``sea`` / ``lake``。
    3. 名字去 ``localisation/<lang>/strategic_region_names_l_<lang>.yml`` 取，
       走本文件已有的 :func:`load_names`（递归 + ``replace/`` 覆盖 + 去排版码）。
       中文缺的条目退回英文；两边都没有的**跳过**，绝不拿 id 编一个
       （实测这一版只有 ``STRATEGICREGION_15`` 中英都缺，而 15 号区本来就没有省份）。

    **半陆半海怎么办**：一个战略区里既有水省又有陆省是常态（16 北海 = 14 sea + 1 land、
    53 加勒比海 = 34 + 34），直接给整区贴海名会误导。所以这里**按省逐个判**：
    只有 ``sea`` / ``lake`` 的省才拿到名字，陆地省一个都不标。
    纯水区自然全中，纯陆区自然全不中；实测 304 个区里 58 纯水 / 96 半陆半海 /
    147 纯陆 / 3 无省份，结果里混进的 land 省是 **0** 个。
    唯一的"意外收获"是几乎全陆、只夹着几个湖的区（198 北美五大湖 = 107 land + 5 lake、
    217 维多利亚湖 = 38 land + 4 lake）—— 那 9 个 lake 省会拿到区名，
    而"北美五大湖""维多利亚湖"本来就是湖名，给湖正好 ✓

    :param root: 游戏根目录（``Hearts of Iron IV``，含 ``map/`` 和 ``localisation/``）。
    :param lang: ``zh``（默认，= ``simp_chinese``）/ ``en``，也可以直接给目录名。
    """
    try:
        root = Path(root)
        defs = parse_definition(root / "map" / "definition.csv")
        if not defs:
            return {}
        regions = parse_strategic_regions(root / "map" / "strategicregions")
        if not regions:
            return {}

        # 只找战略区名那几个键（215 那种例外键也在里面）
        want = {name_key for name_key, _ in regions.values() if name_key}
        names: dict[str, str] = {}
        for sub in _water_lang_dirs(lang):
            d = root / "localisation" / sub
            if not d.is_dir():
                continue
            got = load_names(d, want)
            for k, v in got.items():
                names.setdefault(k, v)     # 前面的语言优先，后面的只补空缺
            if want <= names.keys():
                break                      # 全齐了，不用再读下一个语言（省 13 MB 解析）

        out: dict[int, str] = {}
        for name_key, provinces in regions.values():
            name = names.get(name_key)
            if not name:
                continue                   # 中英都缺名的区：跳过，不拿 id 编一个
            for pid in provinces:
                info = defs.get(pid)
                if info is None or info[3] not in _WATER_TYPES:
                    continue               # 陆地省 / 不在 definition 里的：不标
                out.setdefault(pid, name)
        return out
    except Exception:                      # 契约：认不出来一律 {}，不抛给调用方
        return {}


def _def_name(row) -> str | None:
    """``definition.csv`` 某一行的**第 5 列** —— 是名字才算。

    ⚠ HOI4 原版那一列是地块类型（``land`` / ``sea`` / ``lake``），所以原版上
    一律返回 ``None``；``Unused976`` 那种随机新世界占位也一律不算。
    认的是 EU4 那种"第 5 列写地名"的格式（HOI4 自己那一列**必须是类型** ✗）。
    """
    if not row or len(row) < 5:
        return None
    nm = (row[4] or "").strip()
    if not nm or nm.lower() in _DEF_TYPE_TOKENS or _UNUSED_NAME.match(nm):
        return None
    return nm


def _loc_names(root: Path, lang: str, want) -> dict[str, str]:
    """按语言优先级翻本地化目录，凑 ``want`` 里那些键（同一个惯用法见
    :func:`load_water_names`：前面的语言优先，凑齐了就早退，省一趟 13 MB）。"""
    want = {k for k in want if k}
    out: dict[str, str] = {}
    if not want:
        return out
    for sub in _water_lang_dirs(lang):
        d = Path(root) / "localisation" / sub
        if not d.is_dir():
            continue
        for k, v in load_names(d, want).items():
            out.setdefault(k, v)
        if want <= out.keys():
            break
    return out


def parse_definition_names(path: Path) -> dict[int, str]:
    """``definition.csv`` 第 5 列当**省名**读 → ``{id: 名字}``。占位垃圾滤掉。

    ⚠ **HOI4 原版这一列不是名字，是地块类型** —— 实测 13414 行里只有
    ``land`` / ``sea`` / ``lake`` 三个值（10155 / 3133 / 126），一个地名都没有，
    所以原版上这个函数返回 ``{}``。这是照数据说话，不是没实现：
    ``Unused1``…``Unused976`` 那批是 **EU4** ``definition.csv`` 的口径
    （HOI4 的 map 目录里连 "Unused" 这个词都搜不到一个 ✗）。

    ⚠ 再提醒一句：HOI4 的**水陆判据就是这一列**（:func:`parse_definition`
    读的同一格）—— 想给它塞名字，先得把类型换到别的列去，不然游戏自己先瞎。
    """
    out: dict[int, str] = {}
    for pid, row in parse_definition_rows(path).items():
        nm = _def_name(row)
        if nm:
            out[pid] = nm
    return out


def parse_state_names(dir_path: Path) -> dict[int, tuple[str, list[int]]]:
    """``history/states/*.txt`` → ``{州 id: (名字键, [省份])}``。

    只要这两样，**不碰归属**（归属那条链在 :func:`parse_states` 里，慢得多）——
    水域名用不着谁占了这块地。子目录也读（模组爱分文件夹）。
    """
    out: dict[int, tuple[str, list[int]]] = {}
    d = Path(dir_path)
    if not d.is_dir():
        return out
    for fp in sorted(d.rglob("*.txt")):
        try:
            text = fp.read_text(encoding="latin-1", errors="replace")
        except OSError:
            continue
        body = block_get(parse_script(text), "state")
        if not isinstance(body, list):
            continue
        try:
            sid = int(block_get(body, "id"))
        except (TypeError, ValueError):
            continue
        name_key = str(block_get(body, "name") or f"STATE_{sid}").strip('"')
        provinces = [p for p in as_int_list(block_get(body, "provinces")) if p]
        out[sid] = (name_key, provinces)
    return out


def _prov_name_table(root: Path, lang: str, pids) -> dict[int, str]:
    """本地化的 ``PROV<id>`` 键 → ``{省号: 名字}``（中文优先，缺的退英文）。

    ⚠ HOI4 原版**没有这种键** —— 中英两边各 12.9 万条键里 ``PROV<数字>``
    是 0 条（0.33s/0.50s 实测扫完）。名字像的那个
    ``localisation/<lang>/province_names_l_<lang>.yml`` 装的是**洲名**
    （``europe`` / ``asia`` / ``middle_east``，441 字节），跟省名没关系 ✗。
    这条路留着是给模组的：模组真写了 ``PROV1234`` 就自动生效。
    """
    want = {f"PROV{int(p)}" for p in pids}
    out: dict[int, str] = {}
    for k, v in _loc_names(root, lang, want).items():
        if not v or _UNUSED_NAME.match(v):
            continue                  # 空名 / "Unused42" 那种占位：不算名字 ✗
        try:
            pid = int(k[4:])
        except ValueError:
            continue
        out[pid] = v
    return out


def load_province_names(root: Path, *, lang: str = "zh",
                        pids=None) -> dict[int, str]:
    """**每省一个名字** → ``{省号: 名字}``（中文优先、缺的退英文原名）。

    两个出处：

    1. 本地化的 ``PROV<id>``（中文）—— 见 :func:`_prov_name_table`；
    2. ``map/definition.csv`` 第 5 列（英文原名）—— 见 :func:`parse_definition_names`。

    ⚠ **原版 HOI4 上这个函数返回 ``{}``**：这两处原版里都不是名字。
    连 1709 条胜利点（``VICTORY_POINTS_<省号>``，那是**城市**名）也**一条都
    不落在水省上**，所以水省一个逐块名字都拿不到。这是游戏数据里就没有这一级，
    不是没实现。

    ⚠ 而且第 ②条在 HOI4 里**跟判水陆是同一列**（``type``）—— 只要那一列换成
    名字，游戏自己就分不出 land/sea/lake 了，本 parser 的 :func:`parse_definition`
    也一样瞎 ✗。所以 HOI4 上真正能给逐省名的只有第 ①条：**模组补的 ``PROV<id>``
    键**（第 ②条留着是为了把"你说的那列其实是 type"这件事写死在代码里，
    顺带给 EU4 那种格式留个口子）。

    :param pids: 只查这些省号（默认 :func:`parse_definition_rows` 里的全部）。
    """
    root = Path(root)
    defs = parse_definition_rows(root / "map" / "definition.csv")
    if pids is None:
        pids = list(defs)
    own = _prov_name_table(root, lang, pids)
    out: dict[int, str] = {}
    for pid in pids:
        zh = own.get(pid)
        if zh:
            out[pid] = zh
            continue
        nm = _def_name(defs.get(pid))
        if nm:
            out[pid] = nm
    return out


def load_state_names(root: Path, *, lang: str = "zh",
                     states=None) -> dict[int, str]:
    """州名 → ``{州 id: 名字}``。中文优先、缺的退英文；中英都缺的**跳过**
    （不拿 ``STATE_<id>`` 编一个 ✗ 跟 :func:`load_water_names` 同一个口径）。

    ``states`` 可以传 :func:`parse_state_names` 的结果，省一遍目录扫描。
    """
    if states is None:
        states = parse_state_names(Path(root) / "history" / "states")
    names = _loc_names(Path(root), lang, {nk for nk, _ in states.values()})
    return {sid: names[nk] for sid, (nk, _plist) in states.items() if names.get(nk)}


def _water_names_by_tier(root: Path, lang: str) -> dict[str, dict[int, str]]:
    """分层水名域的干活函数（缓存、兜底在 :func:`load_water_names_by_tier`）。"""
    root = Path(root)
    defs = parse_definition(root / "map" / "definition.csv")
    water = sorted(pid for pid, row in defs.items() if row[3] in _WATER_TYPES)
    empty = {t: {} for t in WATER_TIERS}
    if not water:
        return empty

    # ① 战略区层：**就是第一轮那份结果**（合并口径 ✓ 一个区一个名 ✓ 别改口径）
    #    第一轮实测 3259 条 = 水省全集，所以它同时当另外两层的**兜底名字**用。
    sr = dict(load_water_names(root, lang=lang))

    # ② 州层：州名 + "州 → 省"（就在同一个文件里）
    states = parse_state_names(root / "history" / "states")
    prov_state: dict[int, int] = {}
    for sid, (_nk, plist) in states.items():
        for pid in plist:
            if pid in defs:
                prov_state.setdefault(pid, sid)
    s_names = load_state_names(root, lang=lang, states=states)

    # ③ 省层：这一块**自己的**名字（原版是空的，见 load_province_names）
    own = load_province_names(root, lang=lang, pids=water)

    layers: dict[str, dict[int, str]] = {t: {} for t in WATER_TIERS}
    for pid in water:
        r_nm = sr.get(pid)                       # 战略区名（最粗，也最全）
        s_nm = s_names.get(prov_state.get(pid))  # 州名（只有落在州里的才有）
        me = own.get(pid)                        # 这一块自己的名字（通常没有）

        # 每层的**首选**就是那一层的粒度 ——
        # 🔴 **某层没有名字就是没有名字** ✗✗（2026-10-14 用户点破的口径：
        #   "每个水域不同的层级按游戏内容给名字，反正是遵循陆地那样的思路，
        #    只不过 Hoi4 的省份级水域和地区级是同一个东西，而且没有名字而已"✓）
        #   → **不许拿别层的名字去填** ✗（填了就看不出"这一层其实没名字" ✓
        #     地图上会显得三层都满，跟陆地那边"某层没名字就是空的"不一样 ✗）
        #   · ``sr`` 战略区级：那份合并口径（3259 ✓ 最全 ✓ 一点没动 ✓）
        #   · ``st`` 州级：**只认真的落在某个州 ``provinces`` 名单里的水域** ✓
        #     不在任何州里的（海省没有州 ✓ 3145 个 ✓）**就是没名字** ✗
        #     ⚠ 2026-10-14 改的 ✗：以前它们**退区名** ✓ → 那 3145 个省
        #       在州级视图下顶的是战略区的名字 ✓「按游戏内容给名字」就不成立了 ✓
        #       （用户点破的就是这个 ✓ 跟 ``pr`` 层同一个道理 ✓）
        #   · ``pr`` 省级：**只认这一块自己的名字** ✓ 原版压根没有这一级
        #     （实测见下面那段 ✓）→ 那这一层就是**空的**（``None`` ✓）✓
        #     ⚠ 以前它退到**区名** ✗ → 三层給的是同一套战略区名 ✓
        #       用户点破的"拿战略区名去填"就是这个 ✓（州名也不退 ✗
        #       州名是陆地归属分组、不是水名 ✓ 见原来那段顾虑 ✓）
        for tier, chain in (
            ("sr", (r_nm, s_nm, me)),      # 战略区级：整片海共用区名
            ("st", (s_nm,)),               # 州级：**没落在州里就是没有** ✓（不退区名 ✗）
            ("pr", (me,)),                 # 省级：**没有就是没有** ✓（不退区名/州名 ✗）
        ):
            for cand in chain:
                if cand:
                    layers[tier][pid] = cand
                    break
    return layers


def load_water_names_by_tier(root: Path, *, lang: str = "zh") -> dict[str, dict[int, str]]:
    """**按视图层**分开的水域名（第二轮）→ ``{"sr": …, "st": …, "pr": …}``。

    三层的**省号集合是同一个**：``definition.csv`` 里 type 为 ``sea`` / ``lake``
    的 3259 个水省（判水陆只看那一列 ✓ 名字里带 Sea 的陆地不会混进来）。
    变的只是每层取哪个粒度的名字：

    * ``sr`` 战略区视图 —— **合并**：一个战略区一个名（= :func:`load_water_names`
      那份，第一轮的结果，口径一点没动 ✓）；
    * ``st`` 州视图 —— **只认真的落在某个州 ``provinces`` 名单里的水域**（用州名 ✓）
      不在任何州里的（海省没有州 ✗）**就是没名字** ✗
      （2026-10-14 改：以前它们退到战略区名 ✓ → 那 3145 个省在州级视图下
       顶的是战略区的名字 ✓「按游戏内容给名字」就不成立了 ✓）；
    * ``pr`` 省份视图 —— **只认这一块自己的名字** ✓（**没有就是空的** ✗
      2026-10-14 改：以前它退到战略区名 ✗ → 三层是同一套战略区名 ✓
      用户点破了："Hoi4 的省份级水域……没有名字而已"✓ 见 :func:`_water_names_by_tier`）

    ⚠ **原版 HOI4 上 ``pr`` 层是空的**（2026-10-14 之前退区名，所以那时它跟
    ``sr`` 层一模一样 ✓），``st`` 层里只有 **114 个水省**
    （126 个湖里的 118 个被写进了某个州的
    ``provinces``，去掉 4 个州名跟区名同字的）拿得到州名。原因是游戏数据里
    没有"每省一个水名"这一级：``definition.csv`` 第 5 列是地块类型不是名字、
    本地化里没有 ``PROV<id>`` 键、1709 条胜利点一条都不落在水省上
    （都是 ``_local/test_water_names_tier_hoi4.py`` 实跑出来的数）。
    这不是没实现，是没数据：**模组给水省补上 ``PROV<id>`` 键**它自己就细了
    （``definition.csv`` 第 5 列那条路走不通 —— 那一列是水陆判据本身，
    换了名字游戏和 parser 就都分不出水陆 ✗ 见 :func:`load_province_names`）。

    ⚠ 那 114 条州名在州视图里会跟**州名标签重名**（州名本来就在 tier-4 的
    头衔里画着，水名那层又是独立画的一层 ✓）。

    ``lang`` 口径跟 :func:`load_water_names` 完全相同。认不出来返回三个空 dict
    （不抛异常、不返回 None ✓）；哪一层一条都没有时由 :func:`sea_names_by_tier`
    写成 ``None``。
    """
    p = Path(root)
    key = (str(p), str(lang))
    hit = _TIER_CACHE.get(key)
    if hit is not None:
        return {t: dict(v) for t, v in hit.items()}
    try:
        out = _water_names_by_tier(p, lang)
    except Exception:                      # 契约：认不出来一律空，别往外抛
        out = {t: {} for t in WATER_TIERS}
    _TIER_CACHE[key] = out
    return {t: dict(v) for t, v in out.items()}


def sea_names_by_tier(tiers, by_tier) -> list:
    """把上面的结果摊成 ``meta.seaNamesByTier`` 那个形状。

    下标 = ``tiers`` 的下标（跟 ``meta.tiers`` 同一套：HOI4 是
    ``['1936','1939','blank','sr','st','pr']`` ✓ 见 ``_local/water_names_api2.md``）。
    不是水域视图的层（剧本层 / ``blank``）或者那一层没名字 → **``None``**
    （不是 ``{}`` —— 前端靠 null 判"这层没有，退回旧字段 ``seaNames``"）。

    ⚠ 旧的 ``meta.seaNames`` 得由调用方自己填：**填最粗那层** ``by_tier['sr']``
    （= 第一轮 :func:`load_water_names` 那份合并口径 ✓ 或者直接照旧调它 ✓）。
    """
    return [dict(by_tier[t]) if by_tier.get(t) else None for t in tiers]


class Bookmark(NamedTuple):
    """一个开局剧本。"""

    date: tuple[int, int, int]     # 开局日期
    name_key: str                  # GATHERING_STORM_NAME
    is_default: bool
    ideologies: dict               # tag -> 这个剧本里该国的执政党


class Subject(NamedTuple):
    """一个附属关系。"""

    overlord: str          # 宗主国 tag
    autonomy: str          # autonomy_puppet / autonomy_dominion / …


def _walk_blocks(entries, depth: int = 0):
    """深度优先把 ``(键, 值)`` 全摊出来（``limit`` 里的条件是判断，不算效果）。"""
    for key, value in entries:
        if key is None:
            continue
        yield key, value
        if isinstance(value, list) and key != "limit" and depth < 4:
            yield from _walk_blocks(value, depth + 1)


def parse_subjects(history_countries: Path) -> dict[str, Subject]:
    """目录里各文件顶上的开局附属关系。

    写在**宗主国**那边：``set_autonomy = { target = MAN autonomous_state = autonomy_puppet }``。
    带日期的（如果哪天出现）取最早那条 —— 也就是 1936 剧本那一份。
    """
    out: dict[str, Subject] = {}
    d = Path(history_countries)
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        tag = fp.name.split(" ")[0].split("-")[0].strip().upper()
        if not (2 <= len(tag) <= 4):
            continue
        try:
            text = fp.read_text(encoding="latin-1", errors="replace")
        except OSError:
            continue
        for key, value in _walk_blocks(parse_script(text)):
            if key != "set_autonomy" or not isinstance(value, list):
                continue
            target = _clean_tag(str(block_get(value, "target") or ""))
            auto = block_get(value, "autonomous_state")
            if target and isinstance(auto, str):
                out.setdefault(target, Subject(tag, auto.strip().strip('"')))
    return out


#: 大写、但**不是国家 tag** 的块键（HOI4 的逻辑 / 作用域关键字）。
#: 不排掉的话 ``IF = { ... }`` 里那句 cosmetic 会被算到 "IF" 头上 ✗
#: （``NOR`` 特意不在里面：它同时是逻辑运算符，但只在 ``limit`` 里那么用，
#:   而 ``limit`` 我们压根不进 ✓；TNO 的 ``NOR = { ... }`` 指的就是挪威那个国家 ✓）
_NOT_A_TAG_KEY = frozenset((
    "IF", "ELSE", "ELSE_IF", "AND", "OR", "NOT", "NAND", "XOR",
    "ROOT", "PREV", "THIS", "FROM", "OWNER", "CONTROLLER", "OVERLORD",
    "CAPITAL", "CAPITAL_SCOPE", "ALL", "ANY", "NONE",
))


#: 「造一个新国家」的效果块 —— 里面的 ``set_cosmetic_tag`` 属于**新造出来的那个
#: 动态国家**，不是当前 tag 在换名字：
#:
#:     create_dynamic_country = {
#:         original_tag = MAF
#:         set_cosmetic_tag = MAF_free_germany     # ← 新国家的名字，跟 MAF 无关
#:     }
#:
#: 抓了它的话，非洲那块在图上会写成「德国临时政府」（2026-10-13 廿九发现的）。
_SKIP_BLOCKS = frozenset(("CREATE_DYNAMIC_COUNTRY", "CREATE_COUNTRY"))


def _collect_cosmetics(entries, scope: str, out: dict[str, str], depth: int = 0) -> None:
    """在 ``entries`` 里找 ``set_cosmetic_tag``，算给**最里面那层国家作用域**。

    ``NOR = { set_cosmetic_tag = NOR_GER }`` → 这条算 **NOR** 的 ✓

    ``limit`` 里的是条件不是效果，不进去；``IF`` 这类关键字**不换作用域**，
    但里面照样要找（``IF = { limit = {...} NOR = { ... } }`` 这种得认 ✓）。
    ``create_dynamic_country`` 那种造新国家的块**整个不进去** ✗（里面的 cosmetic
    是新国家的，算给当前 tag 就串名了）。
    """
    if depth > 6:
        return
    for key, value in entries:
        if key is None:
            continue
        if key == "set_cosmetic_tag" and isinstance(value, str):
            cos = _clean_tag(value)
            if cos:
                out.setdefault(scope, cos)
            continue
        if not isinstance(value, list) or key == "limit":
            continue
        sub = str(key).strip().upper()
        if sub in _SKIP_BLOCKS:
            continue                 # 造新国家：里面的名字不是给当前 tag 的 ✗
        inner = sub if (_TAG_KEY.match(sub) and sub not in _NOT_A_TAG_KEY) else scope
        _collect_cosmetics(value, inner, out, depth + 1)


def parse_cosmetic_tags(history_countries: Path) -> dict[str, str]:
    """``set_cosmetic_tag = X`` —— 显式指定的 cosmetic tag。

    ⚠ **得看它写在谁的作用域里**。TNO 是这么写的::

        NOR = { set_cosmetic_tag = NOR_GER }
        SER = { set_cosmetic_tag = SER_GER }
        COG = { set_cosmetic_tag = COG_GER }

    —— 这几句是给 **NOR / SER / COG** 换名字的（"某某顶着德国"），
    跟写它们的那个文件（``GER - Germany.txt``）半点关系都没有 ✗

    只按"文件属于谁"认的话：德国会被判成**「挪威专员辖区」**
    （``NOR_GER`` 排在候选表最前面，把 ``GER_national_socialism`` / ``GER`` 全盖过去了），
    后面那几条还会被 ``setdefault`` 悄悄吃掉；意大利同理会被判成埃及的装饰名 ✓
    （2026-10-12 廿九在 TNO 图上看见"德国那块写着挪威"，根子就在这儿 ✓）

    原版 26 处全是各国自己文件里的平铺写法，所以加了作用域判断对原版**没有影响** ✓
    """
    out: dict[str, str] = {}
    d = Path(history_countries)
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        tag = fp.name.split(" ")[0].split("-")[0].strip().upper()
        if not (2 <= len(tag) <= 4):
            continue
        try:
            text = fp.read_text(encoding="latin-1", errors="replace")
        except OSError:
            continue
        _collect_cosmetics(parse_script(text), tag, out)
    return out


def parse_cosmetic_colors(common: Path) -> dict[str, tuple[int, int, int]]:
    """``common/countries/cosmetic.txt`` → cosmetic tag 的颜色。

    cosmetic tag 的命名约定是 ``<附属国>_<宗主国>``（``MAL_UK``、``RAJ_UK``、
    ``INS_HOL``、``CAN_UK``…），换名字的同时也换颜色。
    """
    from parsers.ck3.parser import as_rgb
    out: dict[str, tuple[int, int, int]] = {}
    fp = Path(common) / "countries" / "cosmetic.txt"
    if not fp.is_file():
        return out
    for key, value in parse_script(fp.read_text(encoding="latin-1", errors="replace")):
        if key is None or not isinstance(value, list):
            continue
        rgb = as_rgb(block_get(value, "color"))
        if rgb:
            out[key] = rgb
    return out


def parse_bookmarks(dir_path: Path) -> list[Bookmark]:
    """``common/bookmarks/*.txt`` → 按日期排好的剧本表。

    HOI4 的开局写在这儿，**不是**能拍脑袋定的 1936/1939：

    * ``the_gathering_storm.txt`` 的 date 是 ``1936.1.1.12``（默认剧本）
    * ``blitzkrieg.txt`` 的 date 是 ``1939.8.14.12`` —— **不是 1939.1.1**

    DLC 会往这些文件里塞东西（每个国家块都带 ``version = base_game`` / DLC 标记），
    所以日期和名字一律从这儿读，别写死。日期格式是 ``年.月.日.时``，取前三段。
    """
    out: list[Bookmark] = []
    d = Path(dir_path)
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        try:
            text = fp.read_text(encoding="latin-1", errors="replace")
        except OSError:
            continue
        top = block_get(parse_script(text), "bookmarks")
        if not isinstance(top, list):
            continue
        for key, value in top:
            if key != "bookmark" or not isinstance(value, list):
                continue
            raw = block_get(value, "date")
            m = _DATE_KEY.match(str(raw)) if raw is not None else None
            if m is None:
                continue
            date = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
            name_key = str(block_get(value, "name") or "").strip('"')
            default = block_get(value, "default")
            is_default = isinstance(default, str) and default.lower() in ("yes", "true")
            ideologies: dict[str, str] = {}
            for ck, cv in value:
                if ck is None or not isinstance(cv, list) or not _TAG_KEY.match(ck):
                    continue
                ide = block_get(cv, "ideology")
                if isinstance(ide, str):
                    ideologies[ck] = ide.strip().strip('"').lower()
            out.append(Bookmark(date=date, name_key=name_key,
                                is_default=is_default, ideologies=ideologies))
    out.sort(key=lambda b: b.date)
    return out


def owner_at(state: State, date: tuple[int, int, int]) -> str | None:
    """这个州在某年（含）之前最后一次改动定下来的归属。"""
    cur = state.owner
    for d, tag in state.timeline:
        if d > date:
            break
        cur = tag
    return cur


def controller_at(state: State, date: tuple[int, int, int]) -> str | None:
    """这个州在某年（含）之前最后一次改动定下来的**控制者**。

    HOI4 的政治地图是按控制者上色的：被占领的州显示占领国的颜色
    （领土还是原主的，游戏里用斜条纹表示）。实测 1939.8.14 那个剧本里
    中国有 16 个州是 CHI 所有、JAP / MEN 控制 —— 只看 owner 的话，
    日本占领区会画成国民政府的颜色。
    """
    cur = state.controller
    for d, tag in state.ctimeline:
        if d > date:
            break
        cur = tag
    return cur


def province_controllers_at(state: State, date: tuple[int, int, int]) -> dict[int, str]:
    """某年（含）之前定下来的**逐省份**控制：``{省份id: 国家}``。

    州级的 ``controller`` 是整州一个值，而中国那几个州是**一半一半**的 ——
    真正的分割写在州历史的日期块里（``JAP = { set_province_controller = 1018 }``）。
    只算 ``d <= date``，后面的覆盖前面的。
    """
    out: dict[int, str] = {}
    for d, tag, pid in state.ptimeline:
        if d > date:
            break
        out[pid] = tag
    return out


def parse_ideologies(history_countries: Path) -> dict[str, str]:
    """``history/countries/<TAG> - <名字>.txt`` → ``{tag: 执政意识形态}``。

    国家名有意识形态变体：``SOV`` 是"俄罗斯"，``SOV_communism`` 才是"苏维埃联盟"。
    1936 剧本要按执政党挑，不然苏联会显示成俄罗斯。
    """
    out: dict[str, str] = {}
    d = Path(history_countries)
    if not d.is_dir():
        return out
    pat = re.compile(r"ruling_party\s*=\s*(\w+)")
    for fp in sorted(d.glob("*.txt")):
        tag = fp.name.split(" ")[0].split("-")[0].strip().upper()
        if not (2 <= len(tag) <= 4):
            continue
        try:
            text = fp.read_text(encoding="latin-1", errors="replace")
        except OSError:
            continue
        m = pat.search(text)
        if m:
            out.setdefault(tag, m.group(1).lower())
    return out


def game_version(root: Path) -> str:
    """版本号藏在 launcher-settings.json 里。"""
    import json
    fp = Path(root) / "launcher-settings.json"
    if fp.is_file():
        try:
            data = json.loads(fp.read_text(encoding="utf-8-sig", errors="replace"))
            for k in ("version", "rawVersion", "gameVersion"):
                if data.get(k):
                    return str(data[k])
        except (OSError, ValueError):
            pass
    return "?"
