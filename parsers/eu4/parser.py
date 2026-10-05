"""EU4 数据解析。

跟 CK3 那套完全不是一回事，所以单独一包：

  * ``definition.csv`` 是**分号分隔**的 CSV，而且是 ANSI（cp1252）编码的 ——
    用 utf-8 读会把 Östergötland 读成乱码。
  * 行政区划不是嵌套的 ``landed_titles``，而是四张**平行**的列表文件：
      area.txt        province → area
      region.txt      area     → region
      superregion.txt region   → superregion
      continent.txt   province → continent   ← 注意是直接挂在省份上的
    所以大洲这一层没法顺着树推，只能按省份投票。
  * 每张表里的分组都可能夹着 ``color = { r g b }``（地区自带配色），
    数省份 id 时必须先把 color 块挖掉，否则 118、99、151 会被当成省份号。
  * 地图是 ``provinces.bmp``：24 位、5632×2048、**自下而上**存放。
    Pillow 会自动翻正，所以读出来跟别的图一样用。
"""

from __future__ import annotations

import re
from pathlib import Path

from parsers.ck3.parser import _LOC_LINE, _clean, _expand

# ---------------------------------------------------------------- 层级

#: 从上到下。跟 CK3 的 e/k/d/c/b 是同一个 index 体系，
#: 这样 titlemap 的排布、前端的 5 个视图按钮全都不用改。
TIER_ORDER = ("ct", "sr", "rg", "ar", "pr")
TIER_NAME = {
    "ct": "大洲",
    "sr": "大区",
    "rg": "区域",
    "ar": "地区",
    "pr": "省份",
}
#: 悬停卡片左边那个小徽章。CK3 是 key 的前缀，EU4 没有 key，
#: 就用层级的短名 —— 中文两字在 10px 等宽下放得进原来的位置。
TIER_KEY = {"ct": "洲", "sr": "大区", "rg": "区域", "ar": "地区", "pr": "省"}

#: EU4 的官方大洲只有这 6 个。continent.txt 里另外两个键
#: （island_check_provinces / new_world）是脚本用的分组，不是大洲。
CONTINENTS = ("europe", "asia", "africa", "north_america", "south_america", "oceania")

#: area/region/superregion 的 key 后缀，去掉之后当名字使
_SUFFIXES = {"_superregion", "_region", "_area"}


# ---------------------------------------------------------------- 通用

def strip_comments(src: str) -> str:
    """EU4 的注释也是 # 到行尾。"""
    return "\n".join(
        line[: line.find("#")] if line.find("#") >= 0 else line
        for line in src.splitlines()
    )


def read_text(path: Path) -> str:
    """EU4 几乎所有数据文件都是 cp1252（不是 latin-1 —— 0x9A š、0x97 — 这些
    高区字节 latin-1 解出来是看不见的控制符，得按 cp1252 映射回标点）。"""
    return path.read_text(encoding="cp1252", errors="replace")


def parse_groups(path: Path) -> dict[str, str]:
    """把 ``name = { ... }`` 一层层切出来，值就是大括号里的原文。

    只切**顶层**分组：往下继续扫的时候是从上一个分组的收尾大括号之后开始的，
    所以嵌套的 ``color = { ... }``、``areas = { ... }`` 都留在父分组的正文里，
    由调用方自己再挖。
    """
    src = strip_comments(read_text(path))
    out: dict[str, str] = {}
    i, n = 0, len(src)
    head = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{")
    while i < n:
        m = head.search(src, i)
        if not m:
            break
        depth, j = 1, m.end()
        while j < n and depth:
            c = src[j]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
            j += 1
        out[m.group(1)] = src[m.end(): j - 1]
        i = j
    return out


def cut_block(body: str, key: str) -> tuple[str, str | None]:
    """把 ``key = { ... }`` 从 body 里挖出来，返回 (剩下的正文, 块内文)。

    找不到就返回 (body, None)。
    """
    m = re.search(re.escape(key) + r"\s*=\s*\{", body)
    if not m:
        return body, None
    depth, j = 1, m.end()
    while j < len(body) and depth:
        c = body[j]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        j += 1
    return body[: m.start()] + body[j:], body[m.end(): j - 1]


def parse_color(body: str) -> tuple[tuple[int, int, int] | None, str]:
    """地区可能自带 ``color = { r g b }``。挖出来，顺便把正文还回去。"""
    rest, inner = cut_block(body, "color")
    if inner is None:
        return None, body
    nums = [int(x) for x in re.findall(r"\d+", inner)]
    if len(nums) < 3:
        return None, rest
    return (nums[0] & 0xFF, nums[1] & 0xFF, nums[2] & 0xFF), rest


def ints(text: str) -> list[int]:
    return [int(x) for x in re.findall(r"\b(\d+)\b", text)]


def words(text: str) -> list[str]:
    return re.findall(r"\b([a-z_][a-z0-9_]*)\b", text)


def humanize(key: str) -> str:
    """游戏里查不到名字时，把 key 收拾成人看的：``west_american_sea_superregion``
    → ``West American Sea``。这是**显示兜底**，不是编数据 —— 名字本来就长这样，
    只是去掉了后缀和分隔符。"""
    for suf in _SUFFIXES:
        if key.endswith(suf):
            key = key[: -len(suf)]
            break
    return " ".join(w.capitalize() for w in key.split("_") if w)


# ---------------------------------------------------------------- definition.csv

def parse_definition(path: Path) -> dict[int, tuple[int, int, int, str]]:
    """``province;red;green;blue;name;x`` —— 分号分隔、cp1252、第 5 列是名字。"""
    out: dict[int, tuple[int, int, int, str]] = {}
    for line in read_text(path).splitlines():
        if not line.strip():
            continue
        parts = line.split(";")
        if len(parts) < 5:
            continue
        try:
            pid = int(parts[0])
            r, g, b = int(parts[1]), int(parts[2]), int(parts[3])
        except ValueError:
            continue          # 表头那行
        if pid <= 0:
            continue
        out[pid] = (r, g, b, parts[4].strip())
    return out


# ---------------------------------------------------------------- 四张划表

def parse_areas(path: Path) -> tuple[dict[str, list[int]], dict[str, tuple[int, int, int]]]:
    """area.txt → (地区 → 省份 id 列表, 地区 → 自带配色)。

    889 个地区里只有 50 个写了 color，其余要自己配。
    """
    areas: dict[str, list[int]] = {}
    colors: dict[str, tuple[int, int, int]] = {}
    for name, body in parse_groups(path).items():
        col, rest = parse_color(body)
        if col:
            colors[name] = col
        areas[name] = ints(rest)
    return areas, colors


def parse_regions(path: Path) -> dict[str, list[str]]:
    """region.txt → 区域 → 它下面的地区名。只认 ``areas = { ... }`` 里的词。"""
    out: dict[str, list[str]] = {}
    for name, body in parse_groups(path).items():
        _rest, inner = cut_block(body, "areas")
        out[name] = words(inner) if inner is not None else []
    return out


def parse_superregions(path: Path) -> dict[str, list[str]]:
    """superregion.txt → 大区 → 它下面的区域名。

    正文里除了区域名还有 ``restrict_charter`` 这类标记，按 ``_region`` 后缀筛掉。
    """
    out: dict[str, list[str]] = {}
    for name, body in parse_groups(path).items():
        _col, rest = parse_color(body)
        out[name] = [w for w in words(rest) if w.endswith("_region")]
    return out


def parse_continents(path: Path) -> dict[str, list[int]]:
    """continent.txt → 大洲 → 省份 id。

    这一层是**直接挂在省份上**的，不经过大区，所以「大区属于哪个洲」
    只能拿成员的省份投票决定。
    """
    return {name: ints(body) for name, body in parse_groups(path).items()}


# ---------------------------------------------------------------- default.map

def parse_map_lists(path: Path, keys) -> dict[str, set[int]]:
    """EU4 的 default.map 是多行列表：``sea_starts = { \\n 1252 1253 … }``。

    逐行正则会漏，必须按大括号配对来切。
    """
    groups = parse_groups(path)
    return {k: set(ints(groups[k])) for k in keys if k in groups}


# ---------------------------------------------------------------- 本地化

def parse_localisation_files(paths, keys=None) -> dict[str, str]:
    """读指定的几个 yml。

    不走 ck3.parser 那个按目录扫的版本 —— EU4 的 localisation 目录里
    英法德西四种语言平铺在一起，整目录扫会被法语抢先。
    """
    table: dict[str, str] = {}
    for fp in paths:
        p = Path(fp)
        if not p.is_file():
            continue
        text = None
        for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
            try:
                text = p.read_text(encoding=enc)
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
