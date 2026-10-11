"""CK3 数据解析。

包含三部分：
  * 一个通用的 CK3 脚本语法解析器（``parse_script``），用于读 landed_titles；
  * ``parse_definition`` 读 map_data/definition.csv；
  * ``parse_localisation`` 读 localization/ 下的 yml。

CK3 的脚本语法很朴素：``key = value``、``key = { ... }``、``key = { a b c }``，
``#`` 起注释，值可以带引号。这里用一次词法 + 一次递归下降把它变成 nested list。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, Iterator

# ---------------------------------------------------------------- 词法

_SPECIAL = set('{}="')


def tokenize(text: str) -> Iterator[tuple[str, str]]:
    """把 CK3 脚本切成 (kind, value) 序列。

    kind ∈ {'{', '}', '=', 'word', 'str'}。注释直接丢掉。
    """
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if c in " \t\r\n":
            i += 1
            continue
        if c == "#":
            j = text.find("\n", i)
            i = n if j < 0 else j + 1
            continue
        if c in "{}=":
            yield (c, c)
            i += 1
            continue
        if c == '"':
            j = i + 1
            buf: list[str] = []
            while j < n and text[j] != '"':
                if text[j] == "\\" and j + 1 < n:
                    buf.append(text[j + 1])
                    j += 2
                    continue
                buf.append(text[j])
                j += 1
            yield ("str", "".join(buf))
            i = j + 1
            continue
        j = i
        while j < n and text[j] not in " \t\r\n{}=":
            if text[j] == "#":
                break
            j += 1
        if j == i:  # 防御：不该发生
            j = i + 1
        yield ("word", text[i:j])
        i = j


# ---------------------------------------------------------------- 语法

#: 一个块：一串 (key|None, value) 。value 是 str 或者嵌套的块。
Block = list[tuple[str | None, object]]


class _Parser:
    def __init__(self, toks: list[tuple[str, str]]):
        self.t = toks
        self.i = 0

    def peek(self) -> tuple[str, str] | None:
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self) -> tuple[str, str]:
        tok = self.t[self.i]
        self.i += 1
        return tok

    def parse_block(self, top: bool = False) -> Block:
        items: Block = []
        while True:
            tok = self.peek()
            if tok is None:
                if not top:
                    break  # 容忍文件末尾少个 }
                break
            kind = tok[0]
            if kind == "}":
                if top:
                    self.take()  # 顶层多余的 } 直接吃
                    continue
                break
            if kind == "=":
                self.take()
                continue
            self.take()
            key = tok[1]
            nxt = self.peek()
            if nxt is not None and nxt[0] == "=":
                self.take()
                items.append((key, self.parse_value()))
            else:
                items.append((None, key))
        return items

    def parse_value(self) -> object:
        tok = self.peek()
        if tok is None:
            return None
        if tok[0] == "{":
            self.take()
            body = self.parse_block()
            if self.peek() is not None and self.peek()[0] == "}":
                self.take()
            return body
        # `color = hsv { 0.9 1 0.3 }` 这类写法：前缀本身是个值，后面还跟着一个块。
        # 必须把那个块一起吃掉 —— 否则属于它的 `}` 会跑去闭合外层的头衔，
        # 从那一行起整棵头衔树全部错位（拜占庭会变成没有子级的空壳，
        # 苏格兰、爱尔兰、安纳托利亚这些王国会掉到顶层去）。
        first = self.take()
        if self.peek() is not None and self.peek()[0] == "{":
            self.take()
            body = self.parse_block()
            if self.peek() is not None and self.peek()[0] == "}":
                self.take()
            return [(PREFIX_KEY, first[1])] + body
        return first[1]


def parse_script(text: str) -> Block:
    """把一段 CK3 脚本解析成嵌套块。"""
    return _Parser(list(tokenize(text))).parse_block(top=True)


# ---------------------------------------------------------------- 取值助手

#: `color = hsv { ... }` 这种"前缀 + 块"的写法，前缀记在这个伪键下
PREFIX_KEY = "__prefix__"


def block_get(block: Block, key: str) -> object | None:
    for k, v in block:
        if k == key:
            return v
    return None


def block_all(block: Block, key: str) -> list[object]:
    return [v for k, v in block if k == key]


def _iter_scalars(value: object):
    """把块里的纯量一个个掏出来，跳过前缀标记。"""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for k, v in value:  # type: ignore[misc]
            if k == PREFIX_KEY:
                continue
            yield from _iter_scalars(v)


def as_int_list(value: object) -> list[int]:
    """把 ``{ 1 2 3 }`` 或 ``1`` 统一成 int 列表。"""
    out: list[int] = []
    for s in _iter_scalars(value):
        try:
            out.append(int(s))
        except ValueError:
            pass
    return out


def as_float_list(value: object) -> list[float]:
    out: list[float] = []
    for s in _iter_scalars(value):
        try:
            out.append(float(s))
        except ValueError:
            pass
    return out


def hsv_to_rgb(h: float, s: float, v: float) -> tuple[int, int, int]:
    """CK3 的 hsv 写法：h 是 0~1 的色相（也兼容写成 0~360 度的）。"""
    h = (h / 360.0 if h > 1.0 else h) % 1.0
    s = min(1.0, max(0.0, s))
    v = min(1.0, max(0.0, v))
    idx = int(h * 6) % 6
    f = h * 6 - int(h * 6)
    p = v * (1 - s)
    q = v * (1 - f * s)
    t = v * (1 - (1 - f) * s)
    r, g, b = ((v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q))[idx]
    return (round(r * 255), round(g * 255), round(b * 255))


def as_rgb(value: object) -> tuple[int, int, int] | None:
    """颜色。三种写法：``{ r g b }``、``rgb { ... }``、``hsv { ... }``。

    前缀**不区分大小写** —— CK3 写的是小写 ``hsv``，HOI4 的
    ``common/countries/colors.txt`` 写的是大写 ``HSV``。
    早先只认小写，于是 HOI4 那张正表整张读不进来（德国还退回用每国文件里
    那个占位的暗绿色），表现出来就是"很多国家没有颜色"。
    """
    prefix = None
    if isinstance(value, list):
        for k, v in value:  # type: ignore[misc]
            if k == PREFIX_KEY:
                prefix = v
                break
    prefix = prefix.lower() if isinstance(prefix, str) else None

    if prefix in ("hsv", "hsv360"):
        nums = as_float_list(value)
        if len(nums) >= 3:
            h, s, v = nums[0], nums[1], nums[2]
            # ``hsv360{ 38 97 83 }`` 是**百分比**写法（色相 38 度、饱和 97%、明度 83%），
            # 维多利亚3 的国家色大量用它。当成 0~1 读的话 97 和 83 会被当满值，
            # 出来一片墨绿 —— 西班牙就是这么变绿的。
            if prefix == "hsv360":
                s, v = s / 100.0, v / 100.0
            return hsv_to_rgb(h, s, v)
        return None

    if prefix == "rgb":
        nums = as_float_list(value)
        if len(nums) >= 3:
            # rgb { 1 0 0 } 和 rgb { 255 0 0 } 都见过，按量级判断
            if max(nums[:3]) <= 1.0:
                return (round(nums[0] * 255) & 0xFF,
                        round(nums[1] * 255) & 0xFF,
                        round(nums[2] * 255) & 0xFF)
            return (int(nums[0]) & 0xFF, int(nums[1]) & 0xFF, int(nums[2]) & 0xFF)
        return None

    nums = as_int_list(value)
    if len(nums) >= 3:
        return (nums[0] & 0xFF, nums[1] & 0xFF, nums[2] & 0xFF)
    return None


# ---------------------------------------------------------------- definition.csv

def parse_definition(path: Path) -> dict[int, tuple[int, int, int, str]]:
    """读 map_data/definition.csv → {province_id: (r, g, b, 内部名)}。"""
    out: dict[int, tuple[int, int, int, str]] = {}
    with path.open(encoding="utf-8-sig", errors="replace") as f:
        for line in f:
            parts = line.rstrip("\n").split(";")
            if len(parts) < 5:
                continue
            try:
                pid = int(parts[0])
                r, g, b = int(parts[1]), int(parts[2]), int(parts[3])
            except ValueError:
                continue
            out[pid] = (r, g, b, parts[4])
    return out


# ---------------------------------------------------------------- landed_titles

TIER_ORDER = ("e", "k", "d", "c", "b")
TIER_NAME = {"e": "帝国", "k": "王国", "d": "公爵领", "c": "伯爵领", "b": "男爵领"}

# 头衔 key 除了字母数字下划线，还可能夹着连字符（e_caspian-pontic_steppe 就是）。
# 漏掉这个字符会让整个帝国连同它下面所有王国一起掉到顶层。
#
# ⚠ **`h_` 也必须认** ✗（霸权 / hegemony —— 2026 那版 CK3 新加的顶层层级 ✓）：
#   `h_china` / `h_japan`? / `h_india` / `h_roman_empire` / `h_eastern_roman_empire` /
#   `h_dar_al_islam` / `h_kingdom_of_heaven` 一共 6 个 ✓
#   它们不在编辑器那五级里（`TIER_ORDER` 不动 ✓ 地图的层级栈也不动 ✓），
#   但是**封君链会经过它们**：`history/titles` 里 `liege = h_china` 有 885 条 ✓
#   不认 `h_` 的话这些头衔根本进不了 `titles` → 历史解析时整条被丢掉 ✗
#   → 那些封臣的链断在半路 → **全被判成独立** ✓（用户看到的"东亚碎成一片" ✓）
_TITLE_RE = re.compile(r"^([ekdcbh])_([A-Za-z0-9_\-]+)$")


class Title:
    __slots__ = ("key", "tier", "color", "parent", "children",
                 "direct_provinces", "depth", "capital")

    def __init__(self, key: str, tier: str | None = None):
        self.key = key
        # 伪头衔（海/湖/河/山）没有 c_/d_/k_/e_/b_ 前缀，tier 由调用方给
        self.tier = tier if tier is not None else key[0]
        self.color: tuple[int, int, int] | None = None
        self.parent: str | None = None
        self.children: list[str] = []
        self.direct_provinces: list[int] = []
        self.capital: str | None = None       # 法理首都，指向另一个头衔 key
        self.depth = TIER_ORDER.index(self.tier) if self.tier in TIER_ORDER else -1

    def __repr__(self) -> str:
        return f"<Title {self.key} color={self.color} prov={len(self.direct_provinces)}>"


def parse_landed_titles(dir_or_files) -> dict[str, Title]:
    """解析 landed_titles 目录（或文件列表），返回 {title_key: Title}。

    头衔在 CK3 里是靠**嵌套**表达法理层级的：
        e_x = { k_y = { d_z = { c_w = { b_v = { province = 1 } } } } }
    所以边遍历边维护一条 "当前在哪些头衔里" 的路径即可。
    非头衔的块（cultural_names、can_create…）也要压栈，否则 } 会把头衔弹飞。
    """
    if isinstance(dir_or_files, (str, Path)):
        p = Path(dir_or_files)
        files = sorted(p.glob("*.txt")) if p.is_dir() else [p]
    else:
        files = [Path(f) for f in dir_or_files]

    titles: dict[str, Title] = {}

    def walk(block: Block, stack: list[str]) -> None:
        for key, value in block:
            if key is None:
                continue
            m = _TITLE_RE.match(key)
            is_title = m is not None
            if is_title:
                t = titles.get(key)
                if t is None:
                    t = titles[key] = Title(key)
                if stack:
                    t.parent = stack[-1]
                    pt = titles.get(stack[-1])
                    if pt is not None and key not in pt.children:
                        pt.children.append(key)
                stack.append(key)
                if isinstance(value, list):
                    walk(value, stack)
                stack.pop()
                continue

            # 非头衔键
            if key == "province":
                if stack:
                    cur = titles.get(stack[-1])
                    if cur is not None:
                        for pid in as_int_list(value):
                            if pid not in cur.direct_provinces:
                                cur.direct_provinces.append(pid)
                continue
            if key == "color":
                if stack:
                    cur = titles.get(stack[-1])
                    rgb = as_rgb(value)
                    if cur is not None and rgb is not None and cur.color is None:
                        cur.color = rgb
                continue
            if key == "capital":
                # 法理首都，值是另一个头衔的 key（多半是个伯爵领）
                if stack and isinstance(value, str):
                    cur = titles.get(stack[-1])
                    if cur is not None and cur.capital is None:
                        cur.capital = value
                continue
            # 其它块继续往下找（cultural_names 里没有头衔，但 can_create 之类也没有）
            if isinstance(value, list):
                walk(value, stack)

    for fp in files:
        try:
            text = fp.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        walk(parse_script(text), [])

    return titles


# ---------------------------------------------------------------- de jure 历史

#: `1066.1.1 = { ... }` 这种日期键
_DATE_KEY = re.compile(r"^(\d{3,4})\.(\d+)\.(\d+)$")

#: 改法理父级用的键
_DEJURE_KEY = "de_jure_liege"


def parse_de_jure_history(history_dir, titles: dict[str, Title],
                          until: tuple[int, int, int] = (1066, 1, 1)) -> int:
    """按某个年份，把 ``history/titles`` 里带日期的 ``de_jure_liege`` 盖到骨架上。

    ``common/landed_titles`` 里那套嵌套是**默认**法理，``history/titles`` 里带日期的
    ``de_jure_liege`` 才是各剧本的改动。所以"1066 年的法理" = 骨架 + 所有 1066 之前
    的改动。

    改完顺便重建 children 列表 —— 原来的 children 是按骨架连的，父级换了就作废了。

    :returns: 真正改了父级的头衔个数
    """
    if not history_dir.is_dir():
        return 0

    #: title -> (日期, 新父级或 None)。同一个头衔有多条就取最后一条
    pending: dict[str, tuple[tuple[int, int, int], str | None]] = {}
    for fp in sorted(history_dir.glob("*.txt")):
        try:
            text = fp.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        for key, value in parse_script(text):
            if key is None or not isinstance(value, list) or key not in titles:
                continue
            for dkey, dval in value:
                if dkey is None or not isinstance(dval, list):
                    continue
                m = _DATE_KEY.match(dkey)
                if m is None:
                    continue
                date = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
                if date > until:
                    continue
                liege = block_get(dval, _DEJURE_KEY)
                if liege is None:
                    continue
                if isinstance(liege, str) and liege.lower() in ("0", "none"):
                    liege = None
                elif not isinstance(liege, str) or liege not in titles:
                    continue          # 指向不存在的头衔，跳过
                cur = pending.get(key)
                if cur is None or date >= cur[0]:
                    pending[key] = (date, liege)

    changed = 0
    for key, (_date, liege) in pending.items():
        # 防环：新父级不能是自己或者自己的后代
        if liege is not None:
            seen: set[str] = set()
            cur: str | None = liege
            bad = False
            while cur and cur not in seen:
                if cur == key:
                    bad = True
                    break
                seen.add(cur)
                nxt = pending.get(cur)
                cur = nxt[1] if nxt is not None else (
                    titles[cur].parent if cur in titles else None)
            if bad:
                continue
        if titles[key].parent != liege:
            titles[key].parent = liege
            changed += 1

    # 父级换过了，children 得按新的重连
    for t in titles.values():
        t.children = []
    for t in titles.values():
        if t.parent and t.parent in titles:
            titles[t.parent].children.append(t.key)
    return changed


# ---------------------------------------------------------------- 持有者 / 封君

#: 「谁占着这块地」用的两个键
_HOLDER_KEY = "holder"
_LIEGE_KEY = "liege"


def parse_title_history(history_dir,
                        titles: dict[str, "Title"],
                        until: tuple[int, int, int] = (1066, 9, 15),
                        ) -> tuple[dict[str, int | str], dict[str, str | None], dict[str, str]]:
    """``history/titles`` 里 **<= until** 的最后一条 ``holder`` / ``liege``（按头衔）。

    CK3 的封臣关系写在**头衔**上 ✗ 不是角色上 ✓：``liege = k_mesopotamia``
    的意思是"这个头衔的持有者是 k_mesopotamia 持有者的封臣" ✓
    所以"**谁不是封臣**"= 从这个头衔顺着 liege 一路往上，走到没有 liege 的那一级 ✓

    ⚠ 同一份数据里同一个头衔会有很多条日期段 ✗（867 一条、1066 一条…）
      这里要的是"那一刻的状态"，所以**按日期比大小**取最新那条 ✓
      （只按文件顺序覆盖会串：后读到的文件里那条更早的日期会把晚的盖掉 ✓）

    ⚠ **holder 有两种写法** ✗ 数字（``holder = 145292`` ✓）和**字符串 id**
      （``holder = japanese_fujiwara_9`` / ``ce3_pope_bonifatius_vii`` ✓）。
      后者有一万四千多条（日本 / 中国 / 教宗那些新加的行政头衔都用它 ✓）——
      只认数字的话那些地方会整片判成"无主" ✗ 这里两种都收，字符串当**不透明 id** ✓
      （只用来判"有没有人持"和"是不是同一个人" ✓ 不需要解析成数字 ✓）

    :returns: ``(holders, lieges)``
              ``holders[title] = 角色号 / 字符串 id``（**0 或 "none" = 空** ✓）
              ``lieges[title] = 上级头衔 key``，``None`` = 独立（没有封君 ✓）
    """
    holders: dict[str, int | str] = {}
    lieges: dict[str, str | None] = {}
    governments: dict[str, str] = {}
    h_at: dict[str, tuple[int, int, int]] = {}
    l_at: dict[str, tuple[int, int, int]] = {}
    g_at: dict[str, tuple[int, int, int]] = {}
    if not history_dir.is_dir():
        return holders, lieges, governments

    for fp in sorted(history_dir.glob("*.txt")):
        try:
            text = fp.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        for key, value in parse_script(text):
            if key is None or not isinstance(value, list) or key not in titles:
                continue
            for dkey, dval in value:
                if dkey is None or not isinstance(dval, list):
                    continue
                m = _DATE_KEY.match(dkey)
                if m is None:
                    continue
                date = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
                if date > until:
                    continue
                h = block_get(dval, _HOLDER_KEY)
                if h is not None:
                    if isinstance(h, bool):
                        h = None
                    elif isinstance(h, (int, float)):
                        h = int(h)
                    elif isinstance(h, str):
                        h = h.strip()
                        h = 0 if h.lower() in ("0", "none") else h
                    else:
                        h = None          # holder = { ... } 这种块：不认识，跳过 ✓
                    if h is not None and (key not in h_at or date >= h_at[key]):
                        holders[key] = h
                        h_at[key] = date
                l = block_get(dval, _LIEGE_KEY)
                if l is not None and (key not in l_at or date >= l_at[key]):
                    s = str(l)
                    lieges[key] = None if s.lower() in ("0", "none") else s
                    l_at[key] = date
                g = block_get(dval, "government")
                if isinstance(g, str) and (key not in g_at or date >= g_at[key]):
                    governments[key] = g
                    g_at[key] = date
    return holders, lieges, governments


def _has_obedience(block) -> bool:
    """块里（含嵌套，`government_rules = { obedience = yes }` 那种 ✓）有没有 obedience ✓"""
    for k, v in block:
        if k == "obedience" and str(v).lower() in ("yes", "true", "1"):
            return True
        if isinstance(v, list) and _has_obedience(v):
            return True
    return False


def parse_governments(gov_dir) -> set[str]:
    """哪些政府用 `obedience`（"效忠"而不是封建契约 ✓）

    ⚠ 用户点名的：**obedience 不算封臣** ✗ ——
      游牧（`nomad_government`）/ 草原行政（`steppe_admin_government`）这些
      新玩法用的是 obedience 那一套 ✓ 它们之间不构成"封君—封臣" ✓
      而 `history/titles` 里那些 `liege = e_great_liao` 是**没开 DLC** 那套旧写法 ✗
      （乃蛮那份文件里 1040 那条上面自己写着注释 `# Liao Dynasty` ✓）
      照它算的话，整个草原都会被并进辽 ✓（用户报的"辽在乃蛮王国有领土" ✓）

    :returns: 用了 obedience 的政府 key 集合（如 {"nomad_government", ...}）
    """
    out: set[str] = set()
    if gov_dir is None or not Path(gov_dir).is_dir():
        return out
    for fp in sorted(Path(gov_dir).glob("*.txt")):
        try:
            text = fp.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        for key, value in parse_script(text):
            if key is None or not isinstance(value, list):
                continue
            if _has_obedience(value):
                out.add(key)
    return out


def liege_of(key: str,
             titles: dict[str, "Title"],
             lieges: dict[str, str | None],
             governments: dict[str, str] | None = None,
             obedient: set[str] | None = None) -> str | None:
    """这个头衔的封君是谁（头衔 key）—— **只看历史里写没写** ✓

    ⚠ **不能拿"法理父级"当默认封君** ✗（我试过，用户当场抓到"大辽吃掉了
      蒙古帝国法理下一堆独立部落" ✓）：
      · CK3 的 `history/titles` **把封臣关系写全了** ✓ → **没写 = 独立** ✓
      · 法理父级 ≠ 封君：大辽法理上管着一大片草原，可 1066 那些部落是各自独立的 ✓
    ⚠ **用了 obedience 的政府不算封臣** ✗（用户点名的 ✓ 见 parse_governments ✓）：
      那些头衔历史上写着 liege ✗ 但游戏里走的是"效忠"那一套 ✓ 不当封臣算 ✓
    """
    if obedient and governments:
        g = governments.get(key)
        if g and g in obedient:
            return None                       # 效忠那一套：不算封臣 ✓
    if key in lieges:
        return lieges[key]                    # 写过：写了谁就是谁（None = 独立 ✓）
    return None


def top_liege(key: str,
              titles: dict[str, "Title"],
              holders: dict[str, int | str],
              lieges: dict[str, str | None],
              governments: dict[str, str] | None = None,
              obedient: set[str] | None = None) -> str | None:
    """这个头衔的持有者，一路往上找到**那个不是封臣的**头衔 ✓

    规则（跟游戏里一致）：
      · 从最细的那一级开始，**第一层有持有者的头衔**才是"谁占着这块地" ✓
        （男爵领常年没有 holder —— 那就是伯爵自己拿着 ✓）
      · 拿到人以后顺着封君往上一级一级走（`liege_of` ✓ 显式 liege 优先、
        没有就认法理父级 ✓）；上级头衔要是**没人持**（历史里没写），
        就停在他这儿 ✓（总比把这块地判成无主强 ✓）
      · ``holder = 0`` 那一段是空的 → 继续往上找 ✓

    :returns: 顶层头衔 key；整条链都没人持 → ``None``（**无主**）
    """
    seen: set[str] = set()
    cur: str | None = key
    while cur and cur not in seen:
        seen.add(cur)
        if not holders.get(cur):                     # 这一层没人 → 往上一级
            t = titles.get(cur)
            cur = t.parent if t is not None else None
            continue
        top = cur
        lg = liege_of(cur, titles, lieges, governments, obedient)
        while lg and lg not in seen:
            seen.add(lg)
            if not holders.get(lg):
                break                                # 上级头衔历史里没人持：到此为止
            top = lg
            lg = liege_of(lg, titles, lieges, governments, obedient)
        return top
    return None


# ---------------------------------------------------------------- localisation

# 值里允许出现 \" 转义；行尾的 #注释 不锚定末尾，否则会把带注释的条目整条漏掉
# （CK3 给东亚/东南亚的头衔名几乎都带一条注释，早先就是栽在这里）
_LOC_LINE = re.compile(r'^\s*([A-Za-z0-9_.\'\-]+)\s*:\s*(\d+)?\s*"((?:[^"\\]|\\.)*)"')

#: 本地化文件可能的编码，按尝试顺序
_LOC_ENCODINGS = ("utf-8-sig", "utf-8", "cp1252", "latin-1")

#: 值里的 $key$ / $key|U$ 变量引用
_LOC_VAR = re.compile(r"\$([A-Za-z0-9_.'\-]+)(?:\|[A-Za-z]+)?\$")

_MAX_EXPAND_DEPTH = 8


def _expand(value: str, table: dict[str, str], depth: int = 0) -> str:
    """展开 $key$ 引用。循环引用或太深的直接放弃，保留原文。"""
    if "$" not in value or depth >= _MAX_EXPAND_DEPTH:
        return value

    def sub(m: re.Match) -> str:
        target = table.get(m.group(1))
        if target is None or target == value:
            return m.group(0)
        return _expand(target, table, depth + 1)

    return _LOC_VAR.sub(sub, value)


def _clean(value: str) -> str:
    """把游戏里的换行/制表标记压成空格，剩下的排版交给编辑器。"""
    for a, b in (("\\n", " "), ("\\t", " "), ("\u00a0", " ")):
        value = value.replace(a, b)
    return " ".join(value.split())


def parse_localisation(lang_dir: Path, keys: Iterable[str] | None = None) -> dict[str, str]:
    """读某个语言目录下所有 yml，返回 {key: 显示名}。

    先把整张表读进来再按 keys 过滤 —— 因为 $key$ 展开需要引用表外的条目，
    边读边过滤会导致大量名字展开不出来。
    """
    if not lang_dir.is_dir():
        return {}

    table: dict[str, str] = {}
    for fp in sorted(lang_dir.glob("*.yml")):
        text = None
        for enc in _LOC_ENCODINGS:
            try:
                text = fp.read_text(encoding=enc)
                break
            except (UnicodeDecodeError, OSError):
                continue
        if text is None:
            continue
        for line in text.splitlines():
            m = _LOC_LINE.match(line)
            if m:
                table.setdefault(m.group(1), m.group(3))

    want = set(keys) if keys is not None else None
    out: dict[str, str] = {}
    for key, value in table.items():
        if want is not None and key not in want:
            continue
        cleaned = _clean(_expand(value, table))
        if cleaned:
            out[key] = cleaned
    return out

