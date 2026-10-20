"""EU4 的历史归属。

## 省份的归属

写在 ``history/provinces/<id> - <名字>.txt`` 里，格式是"先一个无日期段，再一串带日期
的改动"：

    owner = BYZ
    controller = BYZ
    ...
    1453.5.29 = { owner = TUR controller = TUR }
    1683.9.12 = { owner = TUR }

所以**某年某省的归属** = 日期不晚于那年的最后一条改动；一条都没有就用开头那段。
无日期段代表 1444 剧本（EU4 最早的剧本是 1444.11.11）的状态。

解析走 ``ck3.parser.parse_script`` —— EU4 的历史文件和 CK3 是同一套语法，
而且必须用**块**解析：``add_permanent_province_modifier = { ... }`` 里也可能出现
形似 owner 的键，按行扫会误判。

## 国家颜色

``common/country_tags/*.txt`` 里 ``SWE = "countries/Sweden.txt"``，
再去 ``common/countries/Sweden.txt`` 里取 ``color = { r g b }``。
"""

from __future__ import annotations

import re
from pathlib import Path

from parsers.ck3.parser import as_rgb, block_get, parse_script

#: 省份历史文件名里的编号：``1 - Uppland.txt`` / ``1.txt``
_FILE_ID = re.compile(r"^(\d+)")

#: ``1535.1.1`` 这种日期键
_DATE_KEY = re.compile(r"^(\d{3,4})\.(\d+)\.(\d+)$")


def parse_owner_timeline(path: Path) -> tuple[str | None, list[tuple[tuple[int, int, int], str]]]:
    """一个省份历史文件 → (无日期段的归属, [(日期, 归属), …] 按时间排好)。"""
    try:
        # EU4 的历史文件是 cp1252/ANSI
        text = path.read_text(encoding="latin-1", errors="replace")
    except OSError:
        return None, []

    base: str | None = None
    timeline: list[tuple[tuple[int, int, int], str]] = []

    for key, value in parse_script(text):
        if key is None:
            continue
        if key == "owner" and isinstance(value, str):
            if base is None:
                base = _clean_tag(value)
            continue
        m = _DATE_KEY.match(key)
        if m is None or not isinstance(value, list):
            continue
        own = block_get(value, "owner")
        if not isinstance(own, str):
            continue          # 这条改动没动归属，继承前面的
        tag = _clean_tag(own)
        if tag:
            timeline.append(((int(m.group(1)), int(m.group(2)), int(m.group(3))), tag))

    timeline.sort(key=lambda x: x[0])
    return base, timeline


def _clean_tag(raw: str) -> str | None:
    """``owner = SWE`` 里的 SWE。``---`` 之类的占位符当无主。"""
    t = raw.strip().strip('"')
    if not t or set(t) <= {"-"} or t.lower() in ("none", "null"):
        return None
    return t


def owner_at(base: str | None, timeline, date: tuple[int, int, int]) -> str | None:
    """某年（含）之前的最后一次改动定的归属。"""
    cur = base
    for d, tag in timeline:
        if d > date:
            break
        cur = tag
    return cur


def load_province_history(history_dir: Path) -> dict[int, tuple[str | None, list]]:
    """整个 ``history/provinces`` 目录 → {省份 id: (base, timeline)}。"""
    out: dict[int, tuple[str | None, list]] = {}
    d = Path(history_dir)
    if not d.is_dir():
        return out
    for fp in d.glob("*.txt"):
        m = _FILE_ID.match(fp.name)
        if m is None:
            continue
        pid = int(m.group(1))
        out[pid] = parse_owner_timeline(fp)
    return out


# ---------------------------------------------------------------- 国家


def parse_country_tags(game: Path) -> dict[str, str]:
    """``common/country_tags`` → {tag: 相对 common/ 的文件路径}。"""
    out: dict[str, str] = {}
    d = Path(game) / "common" / "country_tags"
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        for line in fp.read_text(encoding="latin-1", errors="replace").splitlines():
            m = re.match(r'^\s*([A-Z0-9]{2,4})\s*=\s*"([^"]+)"', line)
            if m:
                out.setdefault(m.group(1), m.group(2))
    return out


def parse_country_colors(game: Path, tags: dict[str, str]) -> dict[str, tuple[int, int, int]]:
    """每个 tag 的国旗色。取不到的就跳过（调用方自己给个兜底色）。"""
    out: dict[str, tuple[int, int, int]] = {}
    common = Path(game) / "common"
    for tag, rel in tags.items():
        fp = common / rel.replace("\\", "/")
        if not fp.is_file():
            continue
        text = fp.read_text(encoding="latin-1", errors="replace")
        for key, value in parse_script(text):
            if key == "color":
                rgb = as_rgb(value)
                if rgb:
                    out[tag] = rgb
                break
    return out


# ---------------------------------------------------------------- 附庸关系

#: 哪些关系算「附庸」—— 编辑地图时都该跟着宗主上色 ✓
#:  ⚠ `tributary_state`（朝贡）**不算** ✗ —— 朝贡只是进贡，地图上历来是**独立着色**的 ✓
#:    用户点名的是「附庸」✓ 那就只收真正的从属关系 ✓
_SUBJECT_KEYS = ("vassal", "march", "client_state", "personal_union", "union")


def parse_subject_relations(history_dir: Path) -> list[tuple[str, str, tuple[int, int, int], tuple[int, int, int] | None]]:
    """``history/diplomacy/*.txt`` → [(宗主, 附庸, 起始日, 结束日)]。

    文件长这样（2026-10-19 从原版 1.37 抄的 ✓）：
    ```
    # Tibet and Manchu
    vassal = {
        first = QNG
        second = UTS
        start_date = 1724.1.1
        end_date = 1792.11.1
    }
    ```
    ``first`` 是宗主、``second`` 是附庸 ✓（这俩名字反直觉，别搞反 ✗）

    ⚠ `end_date` 可以没有（= 一直持续 ✓）
    ⚠ 文件是 ANSI（cp1252）编码 ✓ 跟省份历史同一个口径 ✓
    ⚠ 解析不来的一律跳过 —— **宁可少合并，也别合并错** ✓
    """
    out: list[tuple[str, str, tuple[int, int, int], tuple[int, int, int] | None]] = []
    d = Path(history_dir) / "diplomacy"
    if not d.is_dir():
        return out

    def _date(v) -> tuple[int, int, int] | None:
        if not isinstance(v, str):
            return None
        m = _DATE_KEY.match(v.strip())
        if m is None:
            return None
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)))

    for fp in sorted(d.glob("*.txt")):
        try:
            text = fp.read_text(encoding="latin-1", errors="replace")
        except OSError:
            continue
        for key, value in parse_script(text):
            if key not in _SUBJECT_KEYS or not isinstance(value, list):
                continue
            a = block_get(value, "first")
            b = block_get(value, "second")
            if not isinstance(a, str) or not isinstance(b, str):
                continue
            start = _date(block_get(value, "start_date"))
            if start is None:
                start = (1, 1, 1)          # 没写起始日 = 从头就有 ✓
            end = _date(block_get(value, "end_date"))
            out.append((_clean_tag(a) or a, _clean_tag(b) or b, start, end))
    return out


def subject_at(rels, date: tuple[int, int, int]) -> dict[str, str]:
    """某个日期上，谁是谁的附庸 → {附庸: 宗主}。

    ⚠ 同一天可能有多条（历史上换过宗主 ✓）—— **后面的覆盖前面的** ✓
      （文件按名字排完再读，同一份里靠后的那条就是后写的 ✓）
    """
    out: dict[str, str] = {}
    for overlord, subject, start, end in rels:
        if date < start:
            continue
        if end is not None and date >= end:
            continue
        out[subject] = overlord
    return out
