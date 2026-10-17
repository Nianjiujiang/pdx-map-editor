"""维多利亚3 的地图数据。

跟前面三套都不一样的地方（都是翻文件翻出来的）：

* **省份 id 是 24 位**。``map_data/provinces.png`` 就是一张普通 RGB 图，
  像素的 ``xRRGGBB`` 直接是省份 id（实测 99.2% 能对上 ``state_regions`` 里
  引用的那批）。所以**没有 definition.csv** 这种东西 —— 不查表。
  渲染管线是 R16UI（上限 65535），24 位装不下，构建缓存时要把 id
  **重映射成密集序号 1..N**（映射表只在这边用，前端只认序号）。
* 层级是 **4 层**：1836 归属 / 战略区 / 州（state region）/ 省份。
  （V3 只有一个开局 —— 1836.1.1，没有剧本系统。）
* ``common/strategic_regions/*.txt`` 自带 ``map_color``，那一层的配色是**官方数据**；
  战略区列的是**州**（``states = { STATE_... }``），不是省份。
* 归属在 ``common/history/states/00_states.txt``：一个 ``STATES = { ... }`` 大块，
  ``s:STATE_MINSK = { create_state = { country = c:RUS owned_provinces = { x... } } }``。
* 中文在 ``localization/simp_chinese/``（**美式拼写**，跟 CK3 一样），
  而且要**递归**找 —— 底下还有 character/ map/ 这些分类目录。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import NamedTuple

import numpy as np
from PIL import Image

from parsers.ck3.parser import as_float_list, as_int_list, block_get, parse_script

#: 省份 id 写成 ``x0974E5``
_HEX_ID = re.compile(r"x([0-9A-Fa-f]{6})")

#: 本地化行：``KEY: "文本"`` 或 ``KEY:0 "文本"``
_LOC_LINE = re.compile(r'^\s*([A-Za-z0-9_.\'\-]+)\s*:\s*(\d+)?\s*"((?:[^"\\]|\\.)*)"')


class StateRegion(NamedTuple):
    key: str               # STATE_SVEALAND
    id: int
    provinces: list        # 24 位 id
    city: int              # 主城省份 id（0 = 没有）
    port: int
    hubs: dict = {}        # 字段名 → 省份 id（city / port / farm / mine / wood …）
                           # 每个 hub 都有自己的名字：HUB_NAME_<州>_<字段>


class StrategicRegion(NamedTuple):
    key: str               # region_nile_basin
    states: list           # 州 key
    color: tuple           # map_color（官方配色）
    capital: int


def parse_provinces(path: Path) -> tuple[np.ndarray, int, int]:
    """``provinces.png`` → 每像素的 24 位省份 id 数组（``(R<<16)|(G<<8)|B``）。"""
    im = Image.open(path)
    if im.mode != "RGB":
        im = im.convert("RGB")
    w, h = im.size
    a = np.asarray(im, dtype=np.uint32)
    ids = (a[:, :, 0] << 16) | (a[:, :, 1] << 8) | a[:, :, 2]
    return ids.astype(np.uint32), w, h


def hex_id(value) -> int:
    """``"x0974E5"`` / ``x0974E5`` → 整数。取不出来返回 0。"""
    m = _HEX_ID.search(str(value))
    return int(m.group(1), 16) if m else 0


def _ids(value) -> list:
    return [hex_id(x) for x in re.findall(r"x[0-9A-Fa-f]{6}", str(value))]


def _words(value) -> list:
    """块里的**裸词**（``states = { STATE_A STATE_B }`` 这种，没有键）。"""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip('"') for k, v in value if k is None and isinstance(v, str)]
    return []


def parse_state_regions(dir_path: Path) -> dict[str, StateRegion]:
    """``map_data/state_regions/*.txt`` → ``{STATE_XXX: StateRegion}``。"""
    out: dict[str, StateRegion] = {}
    d = Path(dir_path)
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        text = fp.read_text(encoding="utf-8-sig", errors="replace")
        for key, value in parse_script(text):
            if key is None or not isinstance(value, list) or not key.startswith("STATE_"):
                continue
            sid = block_get(value, "id")
            try:
                sid = int(sid)
            except (TypeError, ValueError):
                sid = 0
            # 值是单个 hex 的字段就是 hub（city / port / farm / mine / wood …），
            # 这些地块在游戏里**是有地名的**
            hubs: dict[str, int] = {}
            for hk, hv in value:
                if isinstance(hk, str) and isinstance(hv, str):
                    hp = hex_id(hv)
                    if hp:
                        hubs[hk] = hp
            out[key] = StateRegion(
                key=key,
                id=sid,
                provinces=_ids(block_get(value, "provinces")),
                city=hex_id(block_get(value, "city") or ""),
                port=hex_id(block_get(value, "port") or ""),
                hubs=hubs,
            )
    return out


def parse_strategic_regions(dir_path: Path) -> dict[str, StrategicRegion]:
    """``common/strategic_regions/*.txt`` → ``{region_x: StrategicRegion}``。

    ``states = { ... }`` 里是**裸词**，得走 ``_words``；``map_color`` 是官方配色。
    """
    out: dict[str, StrategicRegion] = {}
    d = Path(dir_path)
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        text = fp.read_text(encoding="utf-8-sig", errors="replace")
        for key, value in parse_script(text):
            if key is None or not isinstance(value, list):
                continue
            states = _words(block_get(value, "states"))
            col = as_float_list(block_get(value, "map_color"))
            # round 不是 int：0~1 浮点 × 255 用 int() 截断会系统性少 1（0.5→127 应 128）
            rgb = (min(255, round(col[0] * 255)), min(255, round(col[1] * 255)),
                   min(255, round(col[2] * 255))) if len(col) >= 3 else None
            out[key] = StrategicRegion(
                key=key,
                states=[s for s in states if s.startswith("STATE_")],
                color=rgb or (150, 150, 150),
                capital=hex_id(block_get(value, "capital_province") or ""),
            )
    return out


class OwnedState(NamedTuple):
    """一条 ``create_state``：某个国家在某个州里**实际占着**哪些省份。"""

    state: str             # STATE_XXX
    country: str           # 占着的那一方
    provinces: list        # owned_provinces


def parse_states_history(path: Path) -> list[OwnedState]:
    """``common/history/states/00_states.txt`` → 每条 ``create_state`` 一项。

    **一个州块里可以有好几条 ``create_state``** —— 州被几个国家瓜分时就是这样
    （实测 675 个州块里 ``create_state`` 出现 **1148** 次，也就是四百多个州是分开的）。
    所以这里返回列表，不做"州 → 国家"的字典：归属得看**最低单位**，
    每条 ``create_state`` 里的 ``owned_provinces`` 才是真正占着的地。
    """
    out: list[OwnedState] = []
    fp = Path(path)
    if not fp.is_file():
        return out
    text = fp.read_text(encoding="utf-8-sig", errors="replace")
    top = block_get(parse_script(text), "STATES")
    for key, value in (top if isinstance(top, list) else []):
        if key is None or not isinstance(value, list):
            continue
        name = key.split(":", 1)[1] if ":" in key else key
        for ck, cv in value:
            if ck not in ("create_state", "create_state_with_owners"):
                continue
            if not isinstance(cv, list):
                continue
            c = block_get(cv, "country")
            country = ""
            if isinstance(c, str):
                country = c.split(":", 1)[1] if ":" in c else c
            provinces = _ids(block_get(cv, "owned_provinces"))
            if provinces:
                out.append(OwnedState(state=name, country=country, provinces=provinces))
    return out


def parse_default_map(path: Path) -> dict[str, list]:
    """``map_data/default.map`` → 几个名单（``sea_starts`` / ``lakes`` …）。"""
    fp = Path(path)
    if not fp.is_file():
        return {}
    text = fp.read_text(encoding="utf-8-sig", errors="replace")
    return {k: _ids(block_get(parse_script(text), k))
            for k in ("sea_starts", "lakes", "impassable")}


def parse_province_terrains(path: Path) -> dict[int, str]:
    """``map_data/province_terrains.txt`` → ``{省份 id: 地形名}``。

    格式是 ``x48E2A5="desert"``（等号两边没空格、值带引号）。
    地形名里有 ``impassable`` 的那些是**不可通行**地块，要锁住。
    """
    out: dict[int, str] = {}
    fp = Path(path)
    if not fp.is_file():
        return out
    for line in fp.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        m = re.match(r'^\s*(x[0-9A-Fa-f]{6})\s*=\s*"?([A-Za-z_]+)"?', line)
        if m:
            out[int(m.group(1)[1:], 16)] = m.group(2).lower()
    return out


def parse_country_definitions(dir_path: Path) -> dict[str, tuple]:
    """``common/country_definitions/*.txt`` → ``{TAG: (颜色, 等级)}``。"""
    from parsers.ck3.parser import as_rgb
    out: dict[str, tuple] = {}
    d = Path(dir_path)
    if not d.is_dir():
        return out
    for fp in sorted(d.glob("*.txt")):
        text = fp.read_text(encoding="utf-8-sig", errors="replace")
        for key, value in parse_script(text):
            if key is None or not isinstance(value, list) or not re.match(r"^[A-Z0-9]{3}$", key):
                continue
            rgb = as_rgb(block_get(value, "color"))
            tier = block_get(value, "tier")
            out.setdefault(key, (rgb, str(tier or "").strip('"')))
    return out


def load_loc(root: Path, lang: str, keys=None) -> dict[str, str]:
    """递归读 ``localization/<语言>/`` 下的 yml —— V3 底下还有分类目录。

    先把整张表读进来再过滤：``$key$`` 展开要引用表外的条目。
    """
    base = Path(root) / "localization"
    out: dict[str, str] = {}
    if not base.is_dir():
        return out
    for fp in sorted(base.rglob("*.yml")):
        if lang not in fp.parts:
            continue
        try:
            text = fp.read_bytes().decode("utf-8-sig", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            m = _LOC_LINE.match(line)
            if m:
                out.setdefault(m.group(1), m.group(3))
    if keys is None:
        return out
    # $VAR$ 展开（V3 的国家名里常见 $ADJ$ 之类）
    def expand(value: str, depth: int = 0) -> str:
        if "$" not in value or depth >= 6:
            return value
        return re.sub(r"\$([A-Za-z0-9_.\-]+)\$",
                      lambda m: expand(out.get(m.group(1), m.group(0)), depth + 1), value)

    want = {k for k in keys if k in out}
    return {k: expand(out[k]) for k in want}


#: 接口收的语言简称 → VIC3 的本地化目录名（目录叫 ``simp_chinese``，不叫 ``zh``）
_LOC_DIR = {
    "zh": "simp_chinese",
    "zh_cn": "simp_chinese",
    "zh-hans": "simp_chinese",
    "cn": "simp_chinese",
    "simp_chinese": "simp_chinese",
    "en": "english",
    "english": "english",
}


def game_dir(root: Path) -> Path:
    """VIC3 的数据全在**安装根目录下的 ``game/``** 里（比别的游戏多一层）。

    传进来的可能是安装根（``…/Victoria 3``），也可能已经是 ``game/`` 本身 ——
    看有没有 ``map_data`` 认一下，两种都给对。
    """
    r = Path(root)
    if (r / "game" / "map_data").is_dir():
        return r / "game"
    return r


def _read_loc_file(path: Path) -> dict[str, str]:
    """读**一个** yml 本地化文件 → ``{键: 文本}``。

    ``KEY: "…"`` 和 ``KEY:0 "…"`` 两种写法并存（``#UNUSED`` 段普遍带 ``:0``），
    ``_LOC_LINE`` 两种都吃；版本号字段一律不依赖。
    """
    out: dict[str, str] = {}
    fp = Path(path)
    if not fp.is_file():
        return out
    text = fp.read_bytes().decode("utf-8-sig", errors="replace")
    for line in text.splitlines():
        m = _LOC_LINE.match(line)
        if m:
            out.setdefault(m.group(1), m.group(3))
    return out


def dense_province_ids(root: Path) -> dict[int, int]:
    """24 位省 id（``xRRGGBB``）→ 编辑器序号。**跟 ``build_vic3.py`` 同一套口径**。

    渲染管线是 R16UI（上限 65535），装不下 24 位，所以构建缓存时把 id 重映射成
    密集序号 1..N：``known`` = 省份图像素里出现过的 ∪ 所有州引用的 ∪
    ``default.map`` 的 ``sea_starts``/``lakes``，**排序后第 i 个 → ``i + 1``**。
    这里把同一张表重算一遍 —— 水域名要按编辑器那套编号给。

    省份图读不到就**算不出来**（``known`` 少一大截、序号整体错位），返回 ``{}``：
    宁可没有名字，也不能把名字画到错的地块上。
    """
    g = game_dir(root)
    png = g / "map_data" / "provinces.png"
    if not png.is_file():
        return {}
    try:
        raw = parse_provinces(png)[0]
    except (OSError, ValueError):
        return {}
    known = {int(x) for x in np.unique(raw)}
    known.discard(0)
    for s in parse_state_regions(g / "map_data" / "state_regions").values():
        known.update(s.provinces)
    dm = parse_default_map(g / "map_data" / "default.map")
    known.update(dm.get("sea_starts", []))
    known.update(dm.get("lakes", []))
    return {rid: i + 1 for i, rid in enumerate(sorted(known))}


def load_water_names(root: Path, *, lang: str = "zh") -> dict[int, str]:
    """VIC3 的水域名 → ``{编辑器地块 id : 水域名}``，认不出来返回 ``{}``。

    三层拼起来（水陆在 VIC3 里**原生分开**，不用猜）：

    * ``map_data/state_regions/99_seas.txt`` —— 海州 **106 条**（``id = 3000…``），
      每条**正好一个省**（``provinces = { "xRRGGBB" }``）。**这份是权威名单**。
    * ``common/strategic_regions/water_strategic_regions.txt`` —— 海州 → 水战略区，1:1。
    * ``localization/<lang>/map/seas_l_<lang>.yml`` —— ``STATE_XXX`` 的名字。

    ⚠ ``seas_l_*.yml`` 里有 **168** 个 ``STATE_`` 键，分三段：
    ``#Current sea state regions`` 106 + ``#Lakes`` 2 + ``#UNUSED`` 60。
    后 62 条在 ``state_regions`` 里**查不到任何定义**（预留 / 废弃名），
    **必须按"在不在 99_seas.txt 里"过滤** —— 不然会凭空画出 62 个不存在的水域。

    ⚠ 返回的 key 是**编辑器那套密集序号**（``data_vic3/provinces_id.bin`` 里的值），
    **不是** ``xRRGGBB`` —— 见 :func:`dense_province_ids`。

    ⚠ 数据在安装根的 ``game/`` 下（多一层），传根或传 ``game/`` 都认。
    """
    g = game_dir(root)
    seas_path = g / "map_data" / "state_regions" / "99_seas.txt"
    if not seas_path.is_file():
        return {}
    states = parse_state_regions(g / "map_data" / "state_regions")
    # 权威名单：只在 99_seas.txt 里出现过的 STATE_ 键才算真水域
    sea_keys = {k for k, v in parse_script(
        seas_path.read_text(encoding="utf-8-sig", errors="replace"))
        if isinstance(k, str) and isinstance(v, list) and k.startswith("STATE_")}
    if not sea_keys:
        return {}
    dense_of = dense_province_ids(g)
    if not dense_of:
        return {}

    # 海州 → 水战略区（名字键大多就写在这儿，值是 $STATE_XXX$ 引用）
    ref: dict[str, str] = {}
    sr_path = g / "common" / "strategic_regions" / "water_strategic_regions.txt"
    if sr_path.is_file():
        for key, value in parse_script(sr_path.read_text(encoding="utf-8-sig", errors="replace")):
            if not isinstance(key, str) or not isinstance(value, list):
                continue
            for skey in _words(block_get(value, "states")):
                ref.setdefault(skey, key)

    # 名字：先要的语言，缺的条目落回英文（两个都没有的跳过那一条）
    d0 = _LOC_DIR.get(str(lang).lower(), str(lang))
    primary = _read_loc_file(g / "localization" / d0 / "map" / f"seas_l_{d0}.yml")
    fallback = {} if d0 == "english" else _read_loc_file(
        g / "localization" / "english" / "map" / "seas_l_english.yml")

    def expand(value: str) -> str:
        for _ in range(4):
            if "$" not in value:
                break
            value = re.sub(r"\$([A-Za-z0-9_.\-]+)\$",
                           lambda m: primary.get(m.group(1)) or fallback.get(m.group(1))
                           or m.group(0), value)
        return value

    sr_loc = _read_loc_file(g / "localization" / d0 / "map" / f"strategic_regions_l_{d0}.yml")

    out: dict[int, str] = {}
    for key in sorted(sea_keys):
        st = states.get(key)
        if st is None or not st.provinces:
            continue                      # 名字挂着、定义没有 —— 就是那 62 条废名
        name = primary.get(key) or fallback.get(key)
        if not name:
            rk = ref.get(key)
            name = expand(sr_loc[rk]) if rk and rk in sr_loc else ""
        if not name:
            continue
        for rid in st.provinces:
            d = dense_of.get(rid)
            if d:
                out[d] = name
    return out


def load_water_names_by_tier(root: Path, *, lang: str = "zh") -> dict[str, dict[int, str]]:
    """**按层**给水域名 —— 让 VIC3 也走"每层一片"那套 ✓（2026-10-13 补 ✓）

    返回 ``{"sr": {...}, "st": {...}, "pr": {...}, "wasteland": {}}``
    （键名跟 `build_vic3.py` 的层名对齐 ✓ 见那边的 `meta["tiers"]` ✓）

    🔴 **VIC3 只有一层水域数据** ✗ —— 这不是偷懒，是游戏就这样：
      · `map_data/state_regions/99_seas.txt` 里**一个海州正好一个省** ✓
      · `water_strategic_regions.txt` 是 **1:1**（海州 → 水战略区 ✓ 没有更粗的归并 ✓）
      → 所以"省份级 / 州级 / 战略区级"**是同一批东西** ✓
        跟 HOI4 那个"省份级水域 = 地区级"是**同一类情况** ✓

    用户点破的基本思维（原话）：
      "province.bmp 里面那些小碎块是**省份级水域**，上面是地区级，再上面是战略级，
       每个水域不同的层级**按游戏内容给名字**，……只不过 Hoi4 的省份级水域和地区级
       是同一个东西，而且没有名字而已" ✓
    → **"按游戏内容给名字"** 就是这里：VIC3 的内容只有一层 ✓ 三层就返回同一张 ✓
      （**没有的东西不要编** ✗ —— 别拿别层的名去填 ✓）

    ⚠ 真正的实现只有一份 ✗ —— 直接调 `load_water_names` ✓ 别复制那段解析 ✓
      （那段有"过滤 62 条废名"的讲究 ✓ 复制一份早晚会两边不一致 ✓）
    """
    one = load_water_names(root, lang=lang)
    return {"sr": dict(one), "st": dict(one), "pr": dict(one), "wasteland": {}}
