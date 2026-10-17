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
    """``map_data/default.map`` 里那几张"按名字列"的表。

    实测有 ``sea_zones``（本机 4821 词 / 去重 4793）/ ``lakes``（919 / 918）/
    ``impassable_mountains``（1878）/ ``non_ownable``（153）/ ``volcanoes`` /
    ``earthquakes`` 这些段，里面是 **location 名字**（裸词），跟层级树用的是同一套
    名字 —— 所以"哪些地块是水"完全能从数据里对出来，不用猜颜色。
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


#: ``lang`` → 本地化目录名。写目录名就照用，认不出来原样试一次再退回英文。
#: （EU5 的简中目录叫 ``simp_chinese``，跟 HOI4 一个口径 ✓）
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


def _water_lang_dirs(lang: str) -> tuple[str, ...]:
    """``lang`` → 本地化目录名列表（先中文后英文，前面的优先）。"""
    raw = str(lang or "").strip()
    if not raw:
        return ("simp_chinese", "english")
    hit = _WATER_LANG_DIRS.get(raw.lower().replace("-", "_"))
    if hit is not None:
        return hit
    return (raw, "english") if raw != "english" else ("english",)


def _loc_root(root: Path) -> Path:
    """找出 ``load_loc`` 该用的根（游戏根 / ``game/`` / ``game/in_game/`` 都认）。

    先认带 ``main_menu/localization`` 的那个 —— EU5 的内容本地化只在那儿，
    ``in_game/localization`` 底下的 jomini 系统提示会把人骗过去 ✗。
    """
    root = Path(root)
    cands = (root, root / "game", root.parent, root.parent.parent)
    for cand in cands:
        if (cand / "main_menu" / "localization").is_dir():
            return cand
    for cand in cands:
        if (cand / "localization").is_dir():
            return cand
    return root


def _map_data_dir(root: Path) -> Path | None:
    """找 ``map_data/``（给游戏根 / ``game/`` / ``game/in_game/`` 都认）。"""
    root = Path(root)
    for cand in (root / "game" / "in_game" / "map_data", root / "map_data",
                 root / "in_game" / "map_data"):
        if (cand / "default.map").is_file():
            return cand
    return None


#: ---------- 水名 / 荒地名：按**视图层**各切一套 ----------
#:
#: 游戏里换视图，海域**合并的范围**就跟着变 —— 一层一张表，不能只做一层。
#: 层级树（``parse_hierarchy`` 的 depth，从 0 数起）是
#:
#:     0 continent / 1 subcontinent / 2 region / 3 area / 4 province / 5 location
#:
#: 编辑器那套 ``meta.tiers`` 是 ``['1337', 'blank', 'reg', 'area', 'prov', 'loc']``
#: —— 前两层是剧本（水名给 ``null``），后四层正好对上树里的 2..5：
TIER_LEVEL: dict[str, int] = {"reg": 2, "area": 3, "prov": 4, "loc": 5}

#: 哪几层**允许退回水块自己的名字**。
#: 祖先底下还有陆地时（湖坐在陆地 area / 陆地 province 里），祖先的名字是**陆地**地名
#: ——``malaren``（梅拉伦湖）的 area 是 ``svealand_area`` = 斯韦阿兰、province 是
#: ``sodermanland_province`` = 南曼兰 —— 往湖上顶就不对了，所以改用湖**自己**的名字 ✓。
#: ``reg`` **不在**里面：region 本来就是"陆 + 海一起分"的一层（``indonesia_region``
#: = 印度尼西亚、``polynesia_region`` = 波利尼西亚、``canada_region`` = 加拿大，
#: 大半面积是海），到这一层正是该**合并成区名**的地方（跟 HOI4 的战略区一个道理）
#: —— 不然最粗那层反而跟 loc 一样碎，粒度就反了 ✗。
TIERS_KEEP_OWN = ("area", "prov")

#: 荒地（不可通行 / 无主地）：``default.map`` 里这两份名单，装的也是 location 名。
WASTELAND_LISTS = ("impassable_mountains", "non_ownable")


def _tier_ancestor(uid: str, want: int, parent: dict, level: dict, limit: int = 12):
    """``uid`` 在 ``want`` 那一层归哪个祖先。

    往上找第一个 ``level <= want`` 的节点。树是严格分层的，正常就是正好等于 ——
    万一层跳了（某个 location 直接挂在 area 下面），就按"它在那一层落在哪个块里"
    算，跟编辑器画出来的是同一件事。找不到（或超出 limit）返回 ``None``。
    """
    cur, guard = parent.get(uid), 0
    while cur is not None and guard < limit:
        if level.get(cur, 99) <= want:
            return cur
        cur, guard = parent.get(cur), guard + 1
    return None


def load_water_names_by_tier(root: Path, *, lang: str = "zh") -> dict[str, dict[int, str]]:
    """EU5 的**分层**水域名 + 荒地名。认不出来返回 ``{}``。

    返回 ``{"reg": {id: 名}, "area": {...}, "prov": {...}, "loc": {...},
    "wasteland": {id: 名}}``，键是**编辑器地块 id**（跟 ``provinces_id.bin``
    同一套编号 ✓），值是中文优先的水名 / 荒地名。

    四层怎么切：**某个水块在那一层属于哪个祖先，就用那个祖先的名字**
    （loc = location 自己、prov = 它所在的 province、area = 它所在的 area、
    reg = 它所在的 region）。游戏里就是这么做合并的，所以

    * ``loc`` 最细 —— 5709 个水块各一个名字（``north_sea4`` 也是有名有姓的：
      雷维特浅滩 / Revet，不是"自动切片编号"✗ 那是早先的误判）；
    * ``area`` / ``prov`` —— 祖先底下**没有陆地**（纯水域）才跟祖先；
      落在陆地 area / province 里的湖退回**湖自己的名字**（见 ``TIERS_KEEP_OWN``）；
    * ``reg`` 最粗 —— region 名（斯堪的纳维亚 / 印度尼西亚…），这一层就是合并口径。

    ``wasteland`` 走 ``default.map`` 的 ``impassable_mountains`` / ``non_ownable``
    （本机 1865 + 153 个 location），名字同样是 location 自己的名字（叙拉纳山 /
    尤通黑门山 / 提米蒙盆地走廊）—— 这些名字以前被滤掉了 ✗，现在单出一组。
    **跟水重叠的算水**（本机 47 个既在 ``impassable_mountains`` 又在
    ``sea_zones``/``lakes``；跟 ``build_eu5.py`` 第 9b 段"水域优先"一个口径），
    不扣掉的话它们在地图上会被当成荒地染成灰的 ✗。

    链路（跟 ``build_eu5.py`` 完全一致，不然 id 就对不上）：

    1. ``definitions.txt`` 的 level-5 叶子按名字排序，序号 1..N 就是编辑器那套
       **省份轴**（``build_eu5`` 的 ``loc_ord``）。地块图上的 id 就是它 ——
       对过 ``data_eu5/titlemap.bin``，22860 个陆地 location 一个不差 ✓。
    2. 名字 → location：``sea_zones`` / ``lakes`` / 荒地那两份名单里的名字回查叶子。
    3. 判断"祖先是不是水域"用的是**它底下有没有陆地 location**，不是名字：
       ``james_bay_lowlands_area`` = "西詹姆斯湾"装的是 28 块陆地（外带 1 个湖），
       ``hudson_bay_coast_area`` = "哈得孙湾海岸"一个水块都没有 —— 猜名字必踩 ✗。
    4. 名字走本文件已有的 :func:`load_loc`（会展开 ``$granada_area$`` 那种 ``$引用$``）：
       中文缺的条目回退英文，两边都没有的那条跳过（本机四层 + 荒地一条都没缺 ✓）。

    :param root: 游戏根目录（``C:\\Game NIANJIU\\EU5``，含 ``game/in_game`` 与
        ``game/main_menu``）；给 ``game/in_game`` 或 ``game`` 也认。
    :param lang: ``zh``（默认，= ``simp_chinese``）/ ``en``，也可以直接给目录名。
    """
    try:
        root = Path(root)
        map_data = _map_data_dir(root)
        if map_data is None:
            return {}
        dmap = parse_default_map(map_data / "default.map")
        # 去重但保序：名单里同一个名字偶尔写两遍
        zones = list(dict.fromkeys(dmap.get("sea_zones") or ()))
        lakes = list(dict.fromkeys(dmap.get("lakes") or ()))
        if not zones and not lakes:
            return {}

        parent, level, _ = parse_hierarchy(map_data / "definitions.txt")
        loc_uids = sorted(u for u, lv in level.items() if lv == 5)
        if not loc_uids:
            return {}
        loc_ord = {u: i + 1 for i, u in enumerate(loc_uids)}
        by_name: dict[str, list[str]] = {}
        for u in loc_uids:
            by_name.setdefault(u.split(":", 1)[1], []).append(u)

        water: set[str] = set()
        for nm in zones + lakes:
            water.update(by_name.get(nm, ()))
        if not water:
            return {}

        # 哪些节点下头**有陆地**（有陆地 = 不是纯水域）
        land_holder: set[str] = set()
        for u in loc_uids:
            if u in water:
                continue
            cur, guard = parent.get(u), 0
            while cur is not None and guard < 12:
                land_holder.add(cur)
                cur = parent.get(cur)
                guard += 1

        # 每一层：水块 → **拿谁的名字当标签**（用 uid 记，读本地化之前先别散成字符串）
        label_uid: dict[str, dict[str, str]] = {}
        for tier, want_lv in TIER_LEVEL.items():
            picked: dict[str, str] = {}
            for u in water:
                key_uid = u                                  # loc 层 = 自己
                if tier != "loc":
                    a = _tier_ancestor(u, want_lv, parent, level)
                    if a is not None and (a not in land_holder
                                          or tier not in TIERS_KEEP_OWN):
                        key_uid = a                          # 纯水域祖先：跟祖先
                picked[u] = key_uid
            label_uid[tier] = picked

        # 荒地：两份名单 − 水（水域优先）
        wasteland: set[str] = set()
        for key in WASTELAND_LISTS:
            for nm in dmap.get(key) or ():
                wasteland.update(by_name.get(nm, ()))
        wasteland -= water

        def shown(uid: str) -> str:
            return NAME_OF.get(uid) or uid.split(":", 1)[1]

        # 四层 + 荒地要的名字一次读全（load_loc 反正整张表都读，分四次读纯浪费）
        want: set[str] = {shown(u) for u in wasteland}
        for picked in label_uid.values():
            want.update(shown(k) for k in picked.values())
        loc_root = _loc_root(root)
        names: dict[str, str] = {}
        for sub in _water_lang_dirs(lang):
            got = load_loc(loc_root, sub, want)
            for k, v in got.items():
                names.setdefault(k, v)         # 前面的语言优先，后面的只补空缺
            if want <= names.keys():
                break                          # 全齐了，不用再读第二个语言

        out: dict[str, dict[int, str]] = {}
        for tier, picked in label_uid.items():
            table: dict[int, str] = {}
            for uid in sorted(water, key=loc_ord.__getitem__):
                name = names.get(shown(picked[uid]))
                if name:
                    table[loc_ord[uid]] = name
            out[tier] = table
        waste: dict[int, str] = {}
        for uid in sorted(wasteland, key=loc_ord.__getitem__):
            name = names.get(shown(uid))
            if name:
                waste[loc_ord[uid]] = name
        out["wasteland"] = waste
        return out
    except Exception:                          # 契约：认不出来一律 {}，不抛给调用方
        return {}


def sea_names_by_tier_array(names_by_tier: dict, tiers) -> list:
    """把上面那坨摆成 ``meta.seaNamesByTier`` 要的形状。

    那个字段是**数组**，下标就是 ``meta.tiers`` 的下标（第 0 项 = 最粗那层）；
    某一层拿不到名字就写 ``None``（前端靠 ``None`` 判"这层没有、退回旧字段
    ``seaNames``"，别写 ``{}`` ✗）。``1337`` / ``blank`` 两层自然落到 ``None``。
    键统一转成字符串（跟 ``meta.seaNames`` 一个口径 ✓）。
    """
    out: list = []
    for t in tiers or ():
        table = (names_by_tier or {}).get(str(t).lower())
        out.append({str(k): str(v) for k, v in table.items()} if table else None)
    return out


def load_water_names(root: Path, *, lang: str = "zh") -> dict[int, str]:
    """EU5 的水域名 → ``{编辑器地块 id: 水域名}``，**只取 area 那一层**。

    第一轮就这一张表（``meta.seaNames`` 用它），所以这个入口原样留着 ——
    它等价于 :func:`load_water_names_by_tier` 返回的 ``"area"``，一个字没变 ✓。
    要按视图层分的那四张表 + 荒地名，用 :func:`load_water_names_by_tier`。

    EU5 的水**不叫** ``sea_starts`` 了，改成 ``map_data/default.map`` 里的两份
    **按名字列**的名单：``sea_zones``（本机 4821 条、去重 4793）和 ``lakes``
    （919 / 918）。两份都是 location 名，跟层级树同一套；``in_game/localization``
    那边只有 jomini 的系统提示，**内容的本地化在 ``main_menu/localization``**。

    贴标签（跟 ``build_eu5.py`` 第 9b 段完全一致，不然 id 就对不上）：

    1. ``definitions.txt`` 的 level-5 叶子按名字排序，序号 1..N 就是编辑器那套
       **省份轴**（``build_eu5`` 的 ``loc_ord``）。地块图上的 id 就是它 ——
       对过 ``data_eu5/titlemap.bin``，22860 个陆地 location 一个不差 ✓。
    2. 名字 → location：``sea_zones`` / ``lakes`` 里的名字回查那批叶子。
    3. 贴标签：水块的 **area 祖先**（``north_sea_area`` / ``inner_baltic_sea_area``）
       名字才是给人看的。判断"祖先是不是水域"用的是**它底下有没有陆地 location**，
       不是名字：``james_bay_lowlands_area`` = "西詹姆斯湾"装的是 28 块陆地（外带 1 个湖），
       ``hudson_bay_coast_area`` = "哈得孙湾海岸"一个水块都没有 —— 猜名字必踩 ✗。
    4. 落在**陆地 area** 里的水块是湖：那时 area 名是陆地名字（``malaren`` 的
       area 是 ``svealand_area`` = 斯韦阿兰 ✗），所以改用湖**自己**的名字
       （``malaren`` → 梅拉伦湖）。两边都取不到就跳过，不编。

    :param root: 游戏根目录（``C:\\Game NIANJIU\\EU5``，含 ``game/in_game`` 与
        ``game/main_menu``）；给 ``game/in_game`` 或 ``game`` 也认。
    :param lang: ``zh``（默认，= ``simp_chinese``）/ ``en``，也可以直接给目录名。
    """
    try:
        return load_water_names_by_tier(root, lang=lang).get("area", {})
    except Exception:                          # 契约：认不出来一律 {}，不抛给调用方
        return {}

