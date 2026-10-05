"""EU5（Europa Universalis V）的地图数据。

跟前面几套都不一样的地方（都是翻文件翻出来的）：

* **数据在 ``game/in_game/`` 下面**（EU5 的新布局），不是 ``game/``。
* **地理层级是现成的一棵树**：``map_data/definitions.txt`` 里就是

      europe = {                      ← continent
        western_europe = {            ← subcontinent
          scandinavian_region = {     ← region
            svealand_area = {         ← area
              uppland_province = {    ← province
                stockholm norrtalje … ← location（叶子，裸词）

  所以 6 层不用自己攒：continent / subcontinent / region / area / province / location。
* **地块图是 16384×8192**（``map_data/locations.png``），像素色就是地块色；
  名字与颜色的对照在 ``map_data/named_locations/00_default.txt``：
  ``stockholm = dda910``。
* **1337 的开局归属不在明文数据里**：``setup/countries/*.txt`` 只有颜色/文化/宗教，
  ``common/`` 120 个目录里没有 setup/history 类目录，全文搜 ``owner =`` 只命中事件脚本。
  所以那一层先不做，等找到（多半在二进制 ``nodes.dat`` 里）。
"""

from __future__ import annotations

import re
from pathlib import Path

from parsers.ck3.parser import as_rgb, block_all, block_get, parse_script

#: 层级名字的顺序（第 0 层在最下面）
LEVELS = ("continent", "subcontinent", "region", "area", "province", "location")

#: 唯一键（``层号:名字``）→ 它真正的名字。查本地化/颜色之前都要过这一层
NAME_OF: dict[str, str] = {}

#: ``stockholm = dda910``
#: ``stockholm = dda910``；**很多行后面还有注释**（``shangyuan = 669c74 # 上元 (Nanjing)``），
#: 注释是可选的 —— 早先要求"等号后面就是行尾"，于是所有带注释的行都被跳过，
#: 中国区那片（注释特别密）整片认不出名字，看着就像"这些地块没有归属"。
#: ``stockholm = dda910``。两个坑：
#:   ① 很多行后面带注释（``shangyuan = 669c74 # 上元``）；
#:   ② **前导零会被省掉**（``skwierzyna = 3bfb`` 其实是 ``003bfb``）——
#:      这一条以前要求"正好 6 位"，于是所有 R=0 的颜色行全被跳过，
#:      那些地块就变成"没有颜色、没有像素、没有归属"。
_NAME_COLOR = re.compile(r"^\s*([A-Za-z0-9_'\-]+)\s*=\s*([0-9a-fA-F]{1,6})\s*(?:#.*)?$")

#: localisation 行：``KEY: "文本"`` / ``KEY:0 "文本"``
_LOC_LINE = re.compile(r'^\s*([A-Za-z0-9_.\'\-]+)\s*:\s*(\d+)?\s*"((?:[^"\\]|\\.)*)"')


def parse_hierarchy(path: Path):
    """``map_data/definitions.txt`` → 层级表。

    返回 ``(parent, level, locs)``：

    * ``parent[key] = 上一层节点名``（continent 的父是 ``None``）
    * ``level[key] = 0..4``（continent … province）
    * ``locs[province] = [location, …]``（叶子那一串裸词）

    层数不靠名字后缀猜，直接按**嵌套深度**定 —— 这棵树是严格分层的。
    """
    top = parse_script(Path(path).read_text(encoding="utf-8-sig", errors="replace"))
    parent: dict[str, str | None] = {}
    level: dict[str, int] = {}
    locs: dict[str, list[str]] = {}

    def walk(entries, depth: int, up: str | None):
        for key, value in entries:
            if key is None or not isinstance(value, list):
                continue
            # **每个节点用"层号:名字"当键**：同一个字符串可以在不同层级各出现一次
            # （省叫 xxx_province、地区也可能叫 xxx_province，海也一样），
            # 只用字符串当键的话后写的会覆盖先写的 —— 自环、缺一层归属、
            # 海的名字跑到省份视图里，全是这么来的。
            uid = f"{depth}:{key}"
            NAME_OF[uid] = key
            words = [str(v) for k, v in value if k is None and isinstance(v, str)]
            if words and not any(isinstance(v, list) for _, v in value):
                # 叶子（province）：里面那串裸词就是 location
                locs[uid] = [f"{depth + 1}:{w}" for w in words]
                for w in words:
                    wu = f"{depth + 1}:{w}"
                    NAME_OF[wu] = w
                    parent[wu] = uid
                    level[wu] = depth + 1
                parent[uid] = up
                level[uid] = depth
                continue
            parent[uid] = up
            level[uid] = depth
            walk(value, depth + 1, uid)

    walk(top, 0, None)
    return parent, level, locs


def parse_named_locations(path: Path) -> dict[str, tuple[int, int, int]]:
    """``map_data/named_locations/*.txt`` → ``{地名: (r,g,b)}``。

    每行一个 ``名字 = RRGGBB``（就是 PNG 里那个像素色）。
    """
    out: dict[str, tuple[int, int, int]] = {}
    d = Path(path)
    files = sorted(d.glob("*.txt")) if d.is_dir() else [d]
    for fp in files:
        if not fp.is_file():
            continue
        for line in fp.read_text(encoding="utf-8-sig", errors="replace").splitlines():
            m = _NAME_COLOR.match(line)
            if not m:
                continue
            hexv = m.group(2).rjust(6, "0")      # 3bfb → 003bfb
            out[m.group(1)] = (int(hexv[0:2], 16), int(hexv[2:4], 16), int(hexv[4:6], 16))
    return out


def parse_named_colors(dir_path: Path) -> dict[str, tuple[int, int, int]]:
    """命名色（``color = map_swedish`` 里的 ``map_swedish``）。

    EU5 把国家主色写成一个名字，定义挂在 ``common/scripted_geography/`` 这类地方，
    形状不确定，所以这里宽松地收：任何 ``名字 = <颜色>``（``rgb`` / ``hsv`` / ``hsv360``
    / 裸的 ``{ r g b }``）都收进表里，取不到就返回空表、由调用方退回 ``color2``。
    """
    out: dict[str, tuple[int, int, int]] = {}
    d = Path(dir_path)
    if not d.is_dir():
        return out
    for fp in sorted(d.rglob("*.txt")):
        text = fp.read_text(encoding="utf-8-sig", errors="replace")
        for key, value in parse_script(text):
            if key is None or value is None:
                continue
            if isinstance(value, list):
                rgb = as_rgb(value)
            elif isinstance(value, str):
                rgb = None
            else:
                rgb = None
            if rgb:
                out.setdefault(key, rgb)
    return out


def load_loc(root: Path, lang: str, keys=None) -> dict[str, str]:
    """递归读 ``localization/<语言>/`` 下的 yml（EU5 在 ``game/main_menu/`` 那侧）。

    先把整张表读进来再过滤：``$key$`` 展开可能引用表外的条目。
    """
    out: dict[str, str] = {}
    r = Path(root)
    cands = []
    for up in (r, r / "game"):
        cands += [up / "main_menu" / "localization", up / "localization",
                  up / "in_game" / "localization"]
    for base in cands:
        if not base.is_dir():
            continue
        for fp in sorted(base.rglob("*.yml")):
            if lang not in fp.parts:
                continue
            try:
                text = fp.read_bytes().decode("utf-8-sig", errors="replace")
            except OSError:
                continue
            for line in text.splitlines():
                m = _LOC_LINE.match(line)
                if m and m.group(1) not in out:
                    out[m.group(1)] = m.group(3)
    def expand(value: str, depth: int = 0) -> str:
        if "$" not in value or depth >= 6:
            return value
        return re.sub(r"\$([A-Za-z0-9_.\-]+)\$",
                      lambda m: expand(out.get(m.group(1), m.group(0)), depth + 1), value)

    # **无论传不传 keys 都要展开**：EU5 的中文表大量用 `$别的键$` 引用，
    # 不展开的话图上会出现 `$bermuda$`、`$leon_province$` 这种原样字符串。
    if keys is None:
        return {k: expand(v) for k, v in out.items()}
    return {k: expand(out[k]) for k in keys if k in out}


if __name__ == "__main__":       # 自带自检：python -m eu5.parser
    import collections
    import sys
    sys.stdout.reconfigure(encoding="utf-8")

    G = Path(r"C:\Game NIANJIU\EU5\game\in_game")
    parent, level, locs = parse_hierarchy(G / "map_data" / "definitions.txt")
    by_level = collections.Counter(level.values())
    print("层级节点数:", {LEVELS[k]: v for k, v in sorted(by_level.items())})
    print("province 数:", len(locs), " location 数:",
          sum(len(v) for v in locs.values()))

    nc = parse_named_locations(G / "map_data" / "named_locations")
    print("地名↔色:", len(nc), "条；抽样:",
          list(nc.items())[:3])

    sgeo = G / "common" / "scripted_geography"
    print("scripted_geography 存在:", sgeo.is_dir(),
          len(list(sgeo.glob('*.txt'))) if sgeo.is_dir() else 0, "个 txt")
    col = parse_named_colors(sgeo)
    print("命名色:", len(col), "条；抽样:", list(col.items())[:4])
    if not col:
        for fp in sorted(sgeo.glob("*.txt")):
            print(f"   --- {fp.name} 头 8 行 ---")
            for line in fp.read_text(encoding="utf-8-sig", errors="replace").splitlines()[:8]:
                print("     ", line[:90])

    loc = load_loc(Path(r"C:\Game NIANJIU\EU5"), "simp_chinese",
                   {"stockholm", "SWE", "uppland_province", "svealand_area"})
    print("中文抽样:", loc)

def parse_default_map(path: Path) -> dict:
    """``map_data/default.map`` 里的四张"按名字列"的表。

    实测有 ``sea_zones`` / ``lakes`` / ``impassable_mountains`` / ``non_ownable`` 四段，
    里面是 **location 名字**（裸词），跟层级树用的是同一套名字 ——
    所以"哪些地块是水"完全能从数据里对出来，不用猜颜色。
    """
    out: dict[str, list[str]] = {}
    fp = Path(path)
    if not fp.is_file():
        return out
    text = fp.read_text(encoding="utf-8-sig", errors="replace")
    for key, value in parse_script(text):
        if key is None or not isinstance(value, list):
            continue
        words = [str(v).strip('"') for k, v in value if k is None and isinstance(v, str)]
        if words:
            out[key] = words
    return out
