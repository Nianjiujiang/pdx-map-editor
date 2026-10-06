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
    """读一个语言目录里的名字，顺手把 ``§G`` 这类排版码去掉。"""
    raw = parse_localisation(Path(lang_dir), keys)
    return {k: _LOC_MARKUP.sub("", v).strip() for k, v in raw.items()}


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


def parse_cosmetic_tags(history_countries: Path) -> dict[str, str]:
    """``set_cosmetic_tag = X`` —— 显式指定的 cosmetic tag（20 来个国家）。"""
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
        for key, value in _walk_blocks(parse_script(text)):
            if key == "set_cosmetic_tag" and isinstance(value, str):
                cos = _clean_tag(value)
                if cos:
                    out.setdefault(tag, cos)
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
