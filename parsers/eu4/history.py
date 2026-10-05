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
