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
from parsers.eu4 import hanhua

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


# ---------------------------------------------------------------- bookmarks

def parse_bookmarks(dir_path: Path) -> list[tuple[tuple[int, int, int], str]]:
    """``common/bookmarks/*.txt`` → ``[((年, 月, 日), 名字键)]``，按日期排好。

    EU4 的剧本写在这些文件里（一个文件一个 ``bookmark = { name = … date = 1444.11.11 }``），
    **不是**能拍脑袋定的 —— 尤其 mod：换个 mod 开局日期整个不一样 ✓
    （风云世纪两千年 111 个 bookmark，从公元 4 年排到 2025 ✓）

    ⚠ 同一个日期可能有好几个 bookmark（不同推荐国家）✓ 去重由调用方做 ✓
    """
    out: list[tuple[tuple[int, int, int], str]] = []
    d = Path(dir_path)
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        try:
            text = strip_comments(read_text(fp))
        except OSError:
            continue
        rest, inner = cut_block(text, "bookmark")
        if inner is None:
            continue
        dm = re.search(r"\bdate\s*=\s*(\d{1,4})\.(\d{1,2})\.(\d{1,2})", inner)
        if not dm:
            continue
        date = (int(dm.group(1)), int(dm.group(2)), int(dm.group(3)))
        nm = re.search(r'\bname\s*=\s*"([^"]*)"', inner)
        out.append((date, nm.group(1) if nm else fp.stem))
    out.sort(key=lambda x: x[0])
    return out


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


# ---------------------------------------------------------------- 水域名

#: ``map/default.map`` 里这两份名单是"这块地是水"的**唯一权威判据**。
#:
#: 千万别拿 area / region 的键名或译名去猜水陆 —— 名字里带 sea / bay / ocean
#: 的一大半是陆地：``red_sea_coast_area`` = 红海**沿岸**、``massachusetts_bay_area``
#: = 马萨诸塞、``salish_sea_area`` = 普吉特湾、``indian_ocean_islands_area`` = 一堆岛。
#: 反过来也是，所以一律回查名单。
WATER_LISTS = ("sea_starts", "lakes")

#: EU4 的 appid。官方只带英法德西四种语言，中文得靠 workshop 上那批
#: "顶替 english 槽位"的汉化包 —— 所以下面要顺着装目录去 workshop 里翻。
EU4_APPID = 236850

#: 汉化文件把 CJK 塞进 0x10–0x1F 那一段标记字节里。普通 yml 是纯文本，
#: 不会这么密 —— 拿这个当"这是不是汉化"的判据（跟 hanhua.is_hanhua 同一套）。
_PROBE_BYTES = 4096
_PROBE_MIN = 40

#: 同一份 root + lang 只算一次：构建器会反复问，目录里有十几 MB 的 yml。
_WATER_CACHE: dict[tuple[str, str], dict[int, str]] = {}
_NAME_CACHE: dict[tuple[str, str, frozenset[str]], dict[str, str]] = {}


def is_doublebyte_loc(path: Path) -> bool:
    """粗判一个 yml 是不是"双字节汉化"（只看开头几 KB）。"""
    try:
        with open(path, "rb") as fp:
            head = fp.read(_PROBE_BYTES)
    except OSError:
        return False
    return sum(1 for b in head if 0x10 <= b <= 0x1F) > _PROBE_MIN


def read_loc_file(path: Path) -> dict[str, str]:
    """读一个本地化 yml → {key: 值}（还没做 $VAR$ 展开）。

    汉化那批**不能按 UTF-8 直读**，会读出一堆控制字符 —— 认出来就交给
    ``hanhua`` 解；其余按 utf-8 → cp1252 试。
    """
    p = Path(path)
    if not p.is_file():
        return {}
    if is_doublebyte_loc(p):
        return hanhua.load_file(p)

    try:
        data = p.read_bytes()
    except OSError:
        return {}
    if data[:3] == b"\xef\xbb\xbf":
        data = data[3:]
    text = None
    for enc in ("utf-8", "cp1252", "latin-1"):
        try:
            text = data.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if text is None:
        return {}
    out: dict[str, str] = {}
    for line in text.splitlines():
        m = _LOC_LINE.match(line)
        if m:
            out.setdefault(m.group(1), m.group(3))
    return out


def read_loc_dir(directory: Path, *, pick=None) -> dict[str, str]:
    """把一个 localisation 目录（含子目录）整个读了。

    普通文件先到先得，``replace/`` 最后读而且**覆盖** —— 那是 Paradox 的
    覆盖机制。伏尔泰的噩梦就把自家地名整份放在 ``localisation/replace/`` 下，
    外面那层反而是原版 EU4 的汉化；只读外面的话，它的核心海域名会退回原版那套，
    跟它的地图对不上。

    ``pick`` 是个 ``文件名 → 要不要读`` 的筛子。汉化包整个目录有十几 MB，
    而 area / region 的名字总是躺在文件名带 area / region 的那几份里 ——
    先拿筛子过一遍，没找全再整目录翻。覆盖规则跟全量读一模一样。
    """
    d = Path(directory)
    if not d.is_dir():
        return {}
    plain: list[Path] = []
    override: list[Path] = []
    for fp in sorted(d.rglob("*.yml")):
        if pick is not None and not pick(fp.name):
            continue
        (override if "replace" in fp.relative_to(d).parts[:-1] else plain).append(fp)

    out: dict[str, str] = {}
    for fp in plain:
        for k, v in read_loc_file(fp).items():
            out.setdefault(k, v)
    for fp in override:
        out.update(read_loc_file(fp))
    return out


def _area_file(name: str) -> bool:
    """文件名像不像装 area / region 名字的那几份（汉化包里也照这个挑）。"""
    low = name.lower()
    return "area" in low or "region" in low


def _workshop_appid_dir(root: Path) -> Path | None:
    """顺着装目录往上找 ``steamapps/workshop/content/236850``。

    本体的 root 是 ``…/steamapps/common/Europa Universalis IV``，
    模组的 root 直接就在 ``…/workshop/content/236850/<id>`` —— 两种都得认。
    """
    for anc in (root, *root.parents):
        if anc.name == str(EU4_APPID) and anc.parent.name == "content":
            return anc
        cand = anc / "workshop" / "content" / str(EU4_APPID)
        if cand.is_dir():
            return cand
    return None


def _hanhua_dirs(root: Path) -> list[Path]:
    """能用得上的汉化 localisation 目录：root 自己算一个，workshop 里的再翻一遍。"""
    out: list[Path] = []
    own = root / "localisation"
    if own.is_dir() and any(is_doublebyte_loc(f) for f in own.glob("*_l_english.yml")):
        out.append(own)
    ws = _workshop_appid_dir(Path(root))
    if ws is not None:
        for entry in sorted(ws.iterdir()):
            loc = entry / "localisation"
            if not loc.is_dir():
                continue
            if any(is_doublebyte_loc(f) for f in entry.glob("localisation/**/*_l_english.yml")):
                if loc not in out:
                    out.append(loc)
    return out


def _pick_hanhua(dirs: list[Path], root: Path) -> Path | None:
    """汉化包可能装了好几个，挑最对口的那一个。

    排序（大的优先）：

    1. **就是这张地图自己带的文本**（``root/localisation``）—— 模组自带汉化的情况，
       伏尔泰的噩梦就是这样，它改过的地名只有它自己知道；
    2. **纯翻译包**（自己不带 ``map/default.map``）—— 不然会拿另一个大型模组
       ``replace/`` 里的地名去套本体的图，张冠李戴；
    3. ``areas_regions_l_english.yml`` 的条数（覆盖面）。

    分只看这一份文件：它正好是我们唯一要的那批键，比把每个包整个目录读一遍便宜得多。
    """
    root = Path(root)

    def rank(d: Path) -> tuple:
        n = sum(len(hanhua.load_file(fp))
                for fp in Path(d).rglob("areas_regions_l_english.yml"))
        own = Path(d) == root / "localisation"
        pure = not (Path(d).parent / "map" / "default.map").is_file()
        return (own, pure, n)

    best, best_rank = None, None
    for d in dirs:
        r = rank(d)
        if best_rank is None or r > best_rank:
            best, best_rank = d, r
    return best


def _water_name_table(root: Path, lang: str, keys: set[str]) -> dict[str, str]:
    """area / region / superregion 的显示名。

    ``lang="zh"`` 优先汉化，汉化没覆盖的键退回游戏自带的英文；
    其它语言一律读 ``*_l_english.yml``。

    ⚠ superregion 那批**有一部分不在** ``areas_regions_l_english.yml`` 里：
    比如 ``north_european_sea_superregion`` = "North Atlantic" 躺在
    ``emperor_content_l_english.yml``（DLC 内容包）里，所以英文那份要整个目录扫。
    """
    ck = (str(root), str(lang), frozenset(keys))
    hit = _NAME_CACHE.get(ck)
    if hit is not None:
        return hit

    raw: dict[str, str] = {}
    if lang.lower().startswith("zh"):
        picked = _pick_hanhua(_hanhua_dirs(Path(root)), Path(root))
        if picked is not None:
            partial = read_loc_dir(picked, pick=_area_file)
            # 还有键没着落，就别省那点 IO，整目录翻 —— 名字藏在哪份里都不吃亏
            raw = partial if all(k in partial for k in keys) else read_loc_dir(picked)

    # 汉化没覆盖的键，退回游戏自带的英文（只翻还没着落的那批，别白读 13 MB）。
    #
    # 英文只认 root 自己那份。**不**去本体装目录里捞英文来补模组的图：
    # 模组会拿本体的键名装自己的地名（伏尔泰的噩梦就重用了 western_mediterrenean_area
    # 之类的键），本体的英文对上去会张冠李戴 —— 实测它的亚得里亚海那一串
    # 会被套成 "Mediterranean Sea"。宁可没名字，不给错名字。
    en: dict[str, str] = {}
    need = keys - set(raw)
    loc = Path(root) / "localisation"
    if need and loc.is_dir():
        for fp in sorted(loc.glob("*_l_english.yml")):
            if is_doublebyte_loc(fp):       # 汉化包占了 english 槽，别当英文读
                continue
            for k, v in read_loc_file(fp).items():
                if k in need:
                    en.setdefault(k, v)

    out: dict[str, str] = {}
    for k, v in {**en, **raw}.items():       # 中文赢
        if k not in keys:
            continue
        cleaned = _clean(_expand(v, {**en, **raw}))
        if cleaned:
            out[k] = cleaned
    _NAME_CACHE[ck] = out
    return out


def _prov_name_table(root: Path, lang: str, pids: list[int]) -> dict[int, str]:
    """**省份自己的名字**（``PROV<id>`` 键）—— 给"没落进任何 area"的水省兜底 ✓

    为什么非要有这一条（2026-10-13 补的，用户当场质疑"游戏里明明有名字啊"✓）：

      EU4 的**湖一个都不在任何 area 里**（125/125 ✗），
      于是 `area → region → superregion` 那条链对它们**完全走不通** ✓
      可游戏里它们的名字明明有 —— 就在本地化的 ``PROV<id>`` 上：
        ``PROV1250:0 "Vänern"`` / 汉化包里的「维纳恩湖」✓
      （``map/definition.csv`` 第 5 列也有，但那是**英文原名**、还带 ``Unused\\d+``
        这种占位垃圾 ✗ 所以优先走本地化，能拿到中文 ✓）

    ⚠ **判据仍是 ``default.map`` 的名单** ✗ 这里只负责"把名单里那些水省的名字查出来"，
      一个陆地省都不会混进来 ✓
    """
    keys = {f"PROV{p}" for p in pids}
    if not keys:
        return {}
    ck = (str(root), str(lang), frozenset(keys))
    hit = _NAME_CACHE.get(ck)
    if hit is not None:
        return dict(hit)

    raw: dict[str, str] = {}
    if lang.lower().startswith("zh"):
        picked = _pick_hanhua(_hanhua_dirs(Path(root)), Path(root))
        if picked is not None:
            # 省份名散得到处都是，别费劲猜文件名了，整目录翻一遍 ✓（每个 root 一次）
            raw = read_loc_dir(picked)

    en: dict[str, str] = {}
    need = keys - set(raw)
    loc = Path(root) / "localisation"
    if need and loc.is_dir():
        for fp in sorted(loc.glob("*_l_english.yml")):
            if is_doublebyte_loc(fp):       # 汉化包占了 english 槽，别当英文读 ✓
                continue
            for k, v in read_loc_file(fp).items():
                if k in need:
                    en.setdefault(k, v)

    merged = {**en, **raw}                   # 中文赢 ✓
    out: dict[int, str] = {}
    for p in pids:
        v = merged.get(f"PROV{p}")
        if not v:
            continue
        cleaned = _clean(_expand(v, merged))
        if cleaned:
            out[p] = cleaned
    _NAME_CACHE[ck] = out
    return out


def _water_names(root: Path, lang: str) -> dict[int, str]:
    map_dir = root / "map"
    if not (map_dir / "default.map").is_file():
        return {}

    # 水域 = sea_starts ∪ lakes。这一步是判水陆的**唯一**依据。
    water: set[int] = set()
    for ids in parse_map_lists(map_dir / "default.map", WATER_LISTS).values():
        water |= ids
    if not water:
        return {}

    # area → 省（最细，一个水省只能属于一个 area）
    areas, _colors = parse_areas(map_dir / "area.txt")
    prov_area: dict[int, str] = {}
    for aname, pids in areas.items():
        for pid in pids:
            prov_area.setdefault(pid, aname)

    # area → region → superregion（两张平行表，自己拼出层级）
    regions = parse_regions(map_dir / "region.txt")
    supers = parse_superregions(map_dir / "superregion.txt")
    area_region: dict[str, str] = {}
    for rname, alist in regions.items():
        for a in alist:
            area_region.setdefault(a, rname)
    region_super: dict[str, str] = {}
    for sname, rlist in supers.items():
        for r in rlist:
            region_super.setdefault(r, sname)

    # 名字分两趟查。
    #
    # 第一趟只要 area 的键 —— 装水域省的 area 一共就几十个，汉化包里十有八九
    # 全在这几份带 area / region 名的文件里，省得为了几个键把十几 MB 整个翻一遍。
    # 真的没查到名字的省才进第二趟，去找它的 region / superregion。
    # 原版里第二趟是空集（889 个 area 一个不缺名字），所以这一趟通常白拿。
    used = {area for pid, area in prov_area.items() if pid in water}
    names = _water_name_table(root, lang, used)

    out: dict[int, str] = {}
    pending: list[tuple[int, str | None, str | None]] = []
    for pid in sorted(water):
        area = prov_area.get(pid)
        if area is None:
            continue                    # 没落进任何 area，名字无从谈起
        if names.get(area):
            out[pid] = names[area]      # area 的名字最细，优先用它
            continue
        region = area_region.get(area)
        pending.append((pid, region, region_super.get(region) if region else None))

    if pending:
        fb = _water_name_table(root, lang,
                               {k for _p, r, s in pending for k in (r, s) if k})
        for pid, region, superregion in pending:
            for candidate in (region, superregion):
                if candidate and fb.get(candidate):
                    out[pid] = fb[candidate]
                    break

    # **最后一趟兜底：省自己的名字**（2026-10-13 补 ✓）
    #   area 那条链走不通的就是**湖**（它们不在任何 area 里 ✗）——
    #   而湖名游戏里有的是（PROV<id> 键 ✓）。不补的话它们在地图上就是无名 ✓
    #   ⚠ 只查**名单里**还没拿到名字的水省 ✗ 不会多出陆地 ✓
    missing = [p for p in sorted(water) if not out.get(p)]
    if missing:
        prov = _prov_name_table(root, lang, missing)
        for pid in missing:
            if prov.get(pid):
                out[pid] = prov[pid]
    return out


def load_water_names(root: Path, *, lang: str = "zh") -> dict[int, str]:
    """返回 { 编辑器地块 id : 水域名 }，认不出来返回 {}。

    id 空间就是**省份号**（``default.map`` 的 ``sea_starts`` / ``lakes`` 那套），
    跟编辑器缓存 ``data_<游戏>/provinces_id.bin`` 里的编号是同一个。

    名字的取法：水省 → ``map/area.txt`` 的 area → 拿 area 的键去本地化里查；
    area 那级没名字（或者压根不在 area 里）就退到 ``region.txt`` 的 region，
    再退到 superregion。三层都没有就跳过那条 —— 不编名字。

    ⚠ ``lakes`` 那 125 个省和一部分远洋省**不在任何 area 里**，按这套规矩
    拿不到名字，会直接从结果里缺席（水域本身不靠这个函数判定）。这是实测结果，
    不是 bug：想要它们也上名字，得改用别的出处（``definition.csv`` 的第 5 列
    有逐省名，但调研那份没列它，所以这里没接）。

    ``lang`` 只有 "zh"（含 "zh-cn" 之类前缀）走汉化，其它一律当英语读；两者都
    取不到就跳过那一条。模组自己的地图如果没有英文文本，``lang="en"`` 会返回
    ``{}`` —— 那是实话，不是没实现。
    """
    p = Path(root)
    key = (str(p), str(lang))
    hit = _WATER_CACHE.get(key)
    if hit is not None:
        return dict(hit)
    try:
        out = _water_names(p, lang)
    except Exception:                    # 契约：认不出来返回 {}，别往外抛
        out = {}
    _WATER_CACHE[key] = out
    return dict(out)


# ------------------------------------------------- 分层水域名 + 荒地名（第二轮）
#
# 第一轮交的是**一张合并表**（``load_water_names`` ✓ 482 → 566 条）：
# 同一个 area 里的海共用 area 名，湖借自己的 PROV 名 —— 那是"最粗那层"的口径。
#
# 用户这轮提了三点，全在这一段里解决：
#
#   ① 「EU4 的海域明明有每个块的具体名字，你却没有做出来」
#      → 精确到**每一块水省**：``map/definition.csv`` 第 5 列 + 本地化 ``PROV<id>``。
#        （第一轮只在"area 查不到"时才去查 PROV ✗ 现在每层都查得到 ✓）
#   ② 「EU4 的荒地有自己的名字，你怎么还是隐藏了」
#      → 荒地那些省（编辑器里是 ``wl_<pid>`` 那批节点）也在 ``PROV<id>`` 上有真名，
#        另开一组 ``wasteland`` 返回 ✓ 判据跟水域**完全分开**，不混。
#   ③ 「EU4 的地图在不同的视图下，海域包括的范围也不一样」
#      → 按层各切一套：``rg`` = 区域名 / ``ar`` = 地区名 / ``pr`` = 省自己的名字。
#        层名跟 ``data_eu4/meta.json`` 的 ``tiers`` 尾部一一对应
#        （``['1444','1618','1789','blank','rg','ar','pr']``）✓
#
# ⚠ 判水陆**永远**只看 ``default.map`` 的 ``sea_starts`` / ``lakes`` ✓
#   名字里带 sea / bay / ocean 的一大半是陆地（红海沿岸、马萨诸塞湾、普吉特湾…），
#   拿键名或译名去猜一定会错 —— 这条坑第一轮踩过，这里照旧。

#: 三层水域视图的层名。跟 ``meta.tiers`` 的**尾部**对齐（rg 最粗 → pr 最细）。
WATER_TIERS = ("rg", "ar", "pr")

#: ``definition.csv`` 里的占位名 —— ``Unused`` / ``Unused976`` 这种是随机新世界
#: 的预留位，不是地名 ✗ 宁可不给名字，也别把 "Unused42" 发到地图上。
_UNUSED_NAME = re.compile(r"^\s*unused\s*\d*\s*$", re.I)

#: 同一份 root + lang 的分层结果只算一次（构建器会反复问）。
_TIER_CACHE: dict[tuple[str, str], dict] = {}


def _def_name(defs: dict, pid: int) -> str | None:
    """``definition.csv`` 第 5 列那个名字 —— 占位垃圾不算。"""
    row = defs.get(pid)
    if not row:
        return None
    nm = (row[3] or "").strip()
    return None if (not nm or _UNUSED_NAME.match(nm)) else nm


def _water_basemap(root: Path):
    """把分层水域名要用的几份定义一次读齐。

    返回 ``(water, wasteland, prov_area, area_region, region_super, defs)``，
    读不到 ``default.map`` 就返回 ``None``。
    """
    map_dir = root / "map"
    default_map = map_dir / "default.map"
    if not default_map.is_file():
        return None

    lists = parse_map_lists(default_map, (*WATER_LISTS, "only_used_for_random"))
    water: set[int] = set()
    for key in WATER_LISTS:
        water |= lists.get(key, set())
    rnw = lists.get("only_used_for_random", set())

    defs = parse_definition(map_dir / "definition.csv") \
        if (map_dir / "definition.csv").is_file() else {}

    # area → 省（最细，一个省只能落进一个 area）
    areas, _colors = parse_areas(map_dir / "area.txt") \
        if (map_dir / "area.txt").is_file() else ({}, {})
    prov_area: dict[int, str] = {}
    for aname, pids in areas.items():
        for pid in pids:
            prov_area.setdefault(pid, aname)

    # area → region → superregion（两张平行表，自己拼）
    regions = parse_regions(map_dir / "region.txt") \
        if (map_dir / "region.txt").is_file() else {}
    supers = parse_superregions(map_dir / "superregion.txt") \
        if (map_dir / "superregion.txt").is_file() else {}
    area_region: dict[str, str] = {}
    for rname, alist in regions.items():
        for a in alist:
            area_region.setdefault(a, rname)
    region_super: dict[str, str] = {}
    for sname, rlist in supers.items():
        for r in rlist:
            region_super.setdefault(r, sname)

    # **荒地省**：``definition.csv`` 里有、不是水、又不在任何 area 里 ——
    # 再扣掉 ``only_used_for_random`` 那 976 个随机新世界预留位。
    #
    # 这条判据是跟 ``build_eu4.py`` 的结果**逐一对过**的：原版 EU4 上算出来
    # 正好 87 个省，跟 ``titles.json`` 里 ``wl_*`` 那 87 个节点**一个不差**
    # （不扣 only_used_for_random 会多出 789 个 RNW 省 ✗）。
    # ⚠ 跟水域判据**各走各的**，谁也不套谁。
    wasteland = sorted(p for p in defs
                       if p not in water and p not in prov_area and p not in rnw)
    return water, wasteland, prov_area, area_region, region_super, defs


def _water_names_by_tier(root: Path, lang: str) -> dict[str, dict[int, str]]:
    base = _water_basemap(root)
    if base is None:
        return {t: {} for t in (*WATER_TIERS, "wasteland")}
    water, wasteland, prov_area, area_region, region_super, defs = base

    empty = {t: {} for t in (*WATER_TIERS, "wasteland")}
    if not water and not wasteland:
        return empty

    # 水省沿三条链往上要用的那些键，一次问齐（本地化目录翻一遍就够）。
    wanted: set[str] = set()
    for pid in water:
        an = prov_area.get(pid)
        if not an:
            continue
        wanted.add(an)
        rn = area_region.get(an)
        if rn:
            wanted.add(rn)
            sn = region_super.get(rn)
            if sn:
                wanted.add(sn)
    names = _water_name_table(root, lang, wanted) if wanted else {}

    # **省自己的名字**（``PROV<id>``）。水和荒地一起问 —— 只翻一次本地化目录 ✓
    prov = _prov_name_table(root, lang, sorted(water | set(wasteland))) \
        if (water or wasteland) else {}

    def own(pid: int) -> str | None:
        return prov.get(pid) or _def_name(defs, pid)

    layers: dict[str, dict[int, str]] = {t: {} for t in WATER_TIERS}
    for pid in sorted(water):
        an = prov_area.get(pid)
        rn = area_region.get(an) if an else None
        sn = region_super.get(rn) if rn else None
        a_nm = names.get(an) if an else None
        r_nm = names.get(rn) if rn else None
        s_nm = names.get(sn) if sn else None
        me = own(pid)

        # 每层的**首选**就是那层的粒度；首选落空就顺着退 ——
        # 退到"省自己的名字"是最后一步。用户要的是**每块都有名字**，
        # 不是"尽量齐全"：湖一个都不在任何 area 里，不退它就整层是空的 ✗
        for tier, chain in (
            ("rg", (r_nm, a_nm, s_nm, me)),      # 区域级：整片海共用区域名
            ("ar", (a_nm, r_nm, s_nm, me)),      # 地区级：一个 area 一个名
            ("pr", (me, a_nm, r_nm, s_nm)),      # 省级：每块地自己的名
        ):
            for cand in chain:
                if cand:
                    layers[tier][pid] = cand
                    break

    waste = {}
    for pid in wasteland:
        nm = own(pid)
        if nm:
            waste[pid] = nm

    return {"rg": layers["rg"], "ar": layers["ar"], "pr": layers["pr"],
            "wasteland": waste}


def load_water_names_by_tier(root: Path, *, lang: str = "zh") -> dict[str, dict[int, str]]:
    """**按视图层**分开的水域名 + 荒地名（第二轮）。

    返回::

        {
          "rg": {省号: 区域名},      # map/region.txt —— 区域级，整片海共用一个名
          "ar": {省号: 地区名},      # map/area.txt   —— 地区级
          "pr": {省号: 省自己的名},  # PROV<id> / definition.csv 第 5 列 —— 逐块
          "wasteland": {省号: 荒地名},  # 不可通行荒地，跟水域判据分开
        }

    三层的**省号集合是同一个**：``default.map`` 的 ``sea_starts ∪ lakes``
    （判水陆的唯一依据 ✓ 名字里带 sea 的陆地不会混进来）。
    变的只是每层取哪个粒度的名字：rg 优先区域名、ar 优先地区名、
    pr 优先这一块自己的名字；首选缺了就顺着往下退（区域 → 地区 → 大区 → 省自己），
    所以**每一层都是满的** —— 湖不在任何 area 里也照样有名字 ✓

    键是**编辑器地块 id**，就是省份号，跟 ``data_<游戏>/provinces_id.bin``
    里那套编号一致。认不出来返回四个空 dict（不抛异常、不返回 None）。

    ``wasteland`` 的判据是：``definition.csv`` 里有、不是水、又不在 ``area.txt``
    任何 area 里的那些省（再扣掉 ``default.map`` 的 ``only_used_for_random``）。
    原版 EU4 上正好 87 个省，与 ``titles.json`` 的 ``wl_*`` 节点一一对上。

    ``lang`` 口径同 :func:`load_water_names`：``zh`` 优先汉化、缺的退英文。
    模组没带对应语言的文本时这一组就是空的 —— 那是实话，不是没实现。
    """
    p = Path(root)
    key = (str(p), str(lang))
    hit = _TIER_CACHE.get(key)
    if hit is not None:
        return {t: dict(v) for t, v in hit.items()}
    try:
        out = _water_names_by_tier(p, lang)
    except Exception:                    # 契约：认不出来返回空，别往外抛
        out = {t: {} for t in (*WATER_TIERS, "wasteland")}
    _TIER_CACHE[key] = out
    return {t: dict(v) for t, v in out.items()}


def sea_names_by_tier(tiers, by_tier) -> list:
    """把上面的结果摊成 ``meta.seaNamesByTier`` 那个形状。

    下标 = ``tiers`` 的下标（跟 ``meta.tiers`` 同一套）✓
    某一层不是水域视图（剧本三层 / ``blank``）或者拿不到名字 → **``None``**
    （不是 ``{}`` —— 前端靠 null 判"这层没有，退回旧字段 seaNames"）。

    按**层名**对，不是按写死的下标 —— ``patch_blank_era`` 会把 ``blank``
    插进 tiers 中间（6 层 → 7 层），写死下标就会错位 ✗
    所以 ``build_eu4`` 拿到补完的 tiers 直接传进来就行，两种长度都对。

    ``wasteland`` 不是一层视图，不出现在这个数组里，它跟着 ``wl_*`` 节点走。
    """
    out = []
    for t in tiers:
        layer = by_tier.get(t)
        out.append(dict(layer) if layer else None)
    return out
