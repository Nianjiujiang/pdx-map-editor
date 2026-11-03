#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 MapChart 的 SVG 地图烤成编辑器缓存，再打包成 .pdxmap。

数据源（已经下到本地，不联网）：

  * `_local/_mapchart/china.svg`   MapChart 中国图（328 KB，33 个省级 path，**没有台湾**）
  * `_local/_mapchart/world.svg`   MapChart 世界图（1.3 MB，267 个 path，含美国州 / 加拿大省 / 英国四块）

SVG 里是一个个 `<path id="Shanghai" d="…">`，没有 transform，所以直接按
viewBox 缩放到栅格就行。**画的是浏览器**（`_local/_mapchart/raster.js` 会起
无头 Edge），因为路径里有孔洞——Path2D 的 nonzero 填充天然画得对，自己写
扫描线在环方向不一致的地方会填错。

层级（两张图都是四层）：

    0  2025    剧本层：中国 / 世界
    1  blank   空白剧本
    2  reg     大区 / 大洲
    3  st      省 / 国家

运行：

    py -3 build_mapchart.py china --pack
    py -3 build_mapchart.py world --pack --size 4096
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import subprocess
import sys
import time
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
MC = ROOT / "_local" / "_mapchart"
NE_DIR = ROOT / "_local" / "ne"

TIERS = ["2025", "blank", "reg", "st"]
TIER_KEYS = ["2025", "blank", "reg_", "st_"]
ERA_DATES = ["2025.1.1", ""]
NO_TITLE = 65535
PSEUDO_TIER = len(TIERS)
SEA_COLOR = (46, 74, 104)


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- 颜色


def hsl_to_rgb(h: float, s: float, l: float) -> tuple[int, int, int]:
    h = h % 360.0
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h / 60.0) % 2 - 1))
    m = l - c / 2
    if h < 60:
        r, g, b = c, x, 0
    elif h < 120:
        r, g, b = x, c, 0
    elif h < 180:
        r, g, b = 0, c, x
    elif h < 240:
        r, g, b = 0, x, c
    elif h < 300:
        r, g, b = x, 0, c
    else:
        r, g, b = c, 0, x
    return (int(round((r + m) * 255)), int(round((g + m) * 255)), int(round((b + m) * 255)))


def hue_of(rgb):
    r, g, b = [v / 255.0 for v in rgb]
    mx, mn = max(r, g, b), min(r, g, b)
    if mx == mn:
        return 0.0
    d = mx - mn
    if mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return h * 60


def shade(rgb, dh=0.0, ds=0.0, dl=0.0):
    return hsl_to_rgb(hue_of(rgb) + dh, max(0.0, min(1.0, 0.4 + ds)),
                      max(0.15, min(0.85, 0.56 + dl)))


def color_hash(code: str) -> tuple[int, int, int]:
    h = (zlib.crc32(code.encode()) % 3600) / 10.0
    return hsl_to_rgb(h, 0.46, 0.58)


# ---------------------------------------------------------------- 中国


REGION_COLOR = {
    "华北": (203, 140, 92),
    "东北": (118, 154, 194),
    "华东": (126, 176, 118),
    "华中": (198, 172, 98),
    "华南": (176, 124, 178),
    "西南": (106, 170, 168),
    "西北": (196, 142, 108),
}

#: (SVG path id, 显示名, 大区)，顺序只影响画序：香港澳门必须压在广东上面
CHINA = [
    ("Beijing", "北京", "华北"),
    ("Tianjin", "天津", "华北"),
    ("Hebei", "河北", "华北"),
    ("Shanxi", "山西", "华北"),
    ("Inner_Mongolia", "内蒙古", "华北"),
    ("Liaoning", "辽宁", "东北"),
    ("Jilin", "吉林", "东北"),
    ("Heilongjiang", "黑龙江", "东北"),
    ("Shanghai", "上海", "华东"),
    ("Jiangsu", "江苏", "华东"),
    ("Zhejiang", "浙江", "华东"),
    ("Anhui", "安徽", "华东"),
    ("Fujian", "福建", "华东"),
    ("Jiangxi", "江西", "华东"),
    ("Shandong", "山东", "华东"),
    ("Henan", "河南", "华中"),
    ("Hubei", "湖北", "华中"),
    ("Hunan", "湖南", "华中"),
    ("Guangdong", "广东", "华南"),
    ("Guangxi", "广西", "华南"),
    ("Hainan", "海南", "华南"),
    ("Chongqing", "重庆", "西南"),
    ("Sichuan", "四川", "西南"),
    ("Guizhou", "贵州", "西南"),
    ("Yunnan", "云南", "西南"),
    ("Tibet_Autonomous_Region", "西藏", "西南"),
    ("Shaanxi", "陕西", "西北"),
    ("Gansu", "甘肃", "西北"),
    ("Qinghai", "青海", "西北"),
    ("Ningxia", "宁夏", "西北"),
    ("Xinjiang", "新疆", "西北"),
    ("Hong_Kong", "香港", "华南"),
    ("Macau", "澳门", "华南"),
]


# ---------------------------------------------------------------- 世界

CONT_ORDER = ["Asia", "Europe", "Africa", "North America", "South America", "Oceania", "Antarctica"]
CONT_ZH = {
    "Asia": "亚洲", "Europe": "欧洲", "Africa": "非洲", "North America": "北美洲",
    "South America": "南美洲", "Oceania": "大洋洲", "Antarctica": "南极洲",
    "Seven seas (open ocean)": "公海",
}
CONT_COLOR = {
    "Asia": (226, 186, 122), "Europe": (150, 178, 210), "Africa": (206, 160, 104),
    "North America": (150, 196, 158), "South America": (196, 156, 190),
    "Oceania": (130, 190, 190), "Antarctica": (190, 200, 210),
}

#: NE 里查不到 / 中文名不合适 / 大洲别扭的，手工兜底
ZH_FIX = {
    "China": ("中国", "Asia"),
    "Taiwan": ("台湾", "Asia"),
    "North_Korea": ("朝鲜", "Asia"),
    "South_Korea": ("韩国", "Asia"),
    "United_Kingdom": ("英国", "Europe"),
    "United_Arab_Emirates": ("阿联酋", "Asia"),
    "Bosnia_and_Herzegovina": ("波黑", "Europe"),
    "Central_African_Republic": ("中非", "Africa"),
    "Dominican_Republic": ("多米尼加", "North America"),
    "Eswatini": ("斯威士兰", "Africa"),
    "Czechia": ("捷克", "Europe"),
    "Mauritius": ("毛里求斯", "Africa"),
    "French_Southern_and_Antarctic_Lands": ("法属南部领地", "Antarctica"),
    "Réunion": ("留尼汪", "Africa"),
    "Guadeloupe": ("瓜德罗普", "North America"),
    "Martinique": ("马提尼克", "North America"),
    "French_Guiana": ("法属圭亚那", "South America"),
    "South_Georgia_and_the_South_Sandwich_Islands": ("南乔治亚和南桑威奇群岛", "Antarctica"),
    "Türkiye": ("土耳其", "Asia"),
    "DR_Congo": ("刚果（金）", "Africa"),
    "Palestinian_Territories": ("巴勒斯坦", "Asia"),
    "Vatican": ("梵蒂冈", "Europe"),
}

#: 美国州 / 加拿大省 / 英国四块并进所属国家（世界图是国家级）
def country_of(svg_id: str) -> str:
    if svg_id.startswith("USA_"):
        return "United_States"
    if svg_id.endswith("_CA"):
        return "Canada"
    if svg_id in ("England", "Scotland", "Wales", "Northern_Ireland"):
        return "United_Kingdom"
    return svg_id


def strip_key(s: str) -> str:
    import unicodedata
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("&", " and ")
    return re.sub(r"[^0-9a-zA-Z]+", " ", s).strip().lower()


def load_ne_names() -> dict:
    geo = json.loads((NE_DIR / "ne_10m_admin_0_countries.geojson").read_text("utf-8"))
    by_name, by_other = {}, {}
    for f in geo["features"]:
        p = f["properties"]
        if p.get("NAME"):
            by_name.setdefault(strip_key(p["NAME"]), p)
        for k in ("NAME_LONG", "ADMIN", "FORMAL_EN"):
            if p.get(k):
                by_other.setdefault(strip_key(p[k]), p)
    return {"name": by_name, "other": by_other}


def world_countries(svg_ids: list) -> list:
    ne = load_ne_names()
    order, groups = [], {}
    for i in svg_ids:
        c = country_of(i)
        if c not in groups:
            groups[c] = []
            order.append(c)
        groups[c].append(i)
    out = []
    for c in order:
        if c in ZH_FIX:
            zh, cont = ZH_FIX[c]
        else:
            p = ne["name"].get(strip_key(c)) or ne["other"].get(strip_key(c))
            if p:
                zh = p.get("NAME_ZH") or p.get("NAME") or c
                cont = p.get("CONTINENT") or "Asia"
            else:
                zh, cont = c, "Asia"
        if cont not in CONT_ORDER:
            cont = "Africa" if "Africa" in str(cont) else "Asia"
        out.append({"key": c, "name": zh, "cont": cont, "paths": groups[c]})
    return out


# ---------------------------------------------------------------- 栅格


def raster(spec_path: Path, out_path: Path) -> np.ndarray:
    log("栅格化（起无头 Edge 画 SVG）…")
    t0 = time.time()
    # 输出写进文件而不是捕获管道 —— Windows 上 CreatePipe 偶尔会被拦
    # （PermissionError [WinError 5]），而且真实文件堆栈也更好查 ✓
    o_log = MC / ".raster-out.txt"
    e_log = MC / ".raster-err.txt"
    with open(o_log, "wb") as fo, open(e_log, "wb") as fe:  # noqa: S603
        rc = subprocess.call(
            ["node", str(MC / "raster.js"), str(spec_path)],
            cwd=str(MC), stdout=fo, stderr=fe,
        )
    r_out = o_log.read_bytes().decode("utf-8", "replace")
    r_err = e_log.read_bytes().decode("utf-8", "replace")
    if rc != 0:
        log(r_out[-3000:])
        log(r_err[-3000:])
        raise SystemExit("栅格化失败")
    for line in r_err.splitlines():
        if line.strip():
            log("  " + line.strip())
    raw = zlib.decompress(out_path.read_bytes())
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    ids = np.frombuffer(raw, dtype=np.uint16).copy().reshape(int(spec["h"]), int(spec["w"]))
    log(f"  解码 {ids.size} 个像素（{time.time()-t0:.0f}s）")
    n = despeckle(ids, int(spec["bgPid"]))
    log(f"  揉掉边境散点 {n} 个")
    return ids


# ---------------------------------------------------------------- 去散点
#
# ⚠ **抗锯齿的决心**：地图 SVG 按像素画的时候，边境那 1~2 行像素是两种颜色
#   混出来的，就近取色偶尔会落到一个**离得很远**的地块头上 → 每个国家边境上
#   都趴着一两个像素的"飞地"（用户 2026-11-01 报的）。
#   栅格器里已经先用 8 邻域投票压过一轮，但被**画在后面的**国家压住的那一侧
#   还是会漏 —— 这里再做一次：只动"小小一坨、四周全是别人"的孤立像素，
#   顺手把 1 像素宽的毛边揉平 ✓（大面积的真地块一个都不碰）


def despeckle(ids: np.ndarray, sea_pid: int, max_island: int = 6, min_keep: int = 8000) -> int:
    """把"趴在别人家地盘上"的小散点并到邻居身上（2×2 这种也算）

    判据三条，缺一个都不动：
      ① 这一坨 ≤ max_island 像素（抗锯齿就只留这么点残渣）；
      ② 四周**大多是陆地**——在海上孤零零的就当它是真岛，留着
         （印尼、巴哈马、特立尼达这种群岛国家全靠这条活下来 ✓）；
      ③ 这个地块自己不小（总数 > min_keep），小国整体就是几个像素，不能动 ✓
    """
    h, w = ids.shape
    tot = np.bincount(ids.ravel())
    same8 = np.zeros((h, w), dtype=np.uint8)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            same8 += (np.roll(ids, (dy, dx), axis=(0, 1)) == ids).astype(np.uint8)
    cand = same8 <= 3
    ys, xs = np.nonzero(cand)
    done = np.zeros((h, w), dtype=bool)
    moved = 0
    for y, x in zip(ys, xs):
        if done[y, x]:
            continue
        pid = int(ids[y, x])
        stack = [(y, x)]
        done[y, x] = True
        comp = []
        big = False
        while stack:
            cy, cx = stack.pop()
            comp.append((cy, cx))
            if len(comp) > max_island:
                big = True
                break
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dy == 0 and dx == 0:
                        continue
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w and not done[ny, nx] and ids[ny, nx] == pid:
                        done[ny, nx] = True
                        stack.append((ny, nx))
        if big or pid >= len(tot) or tot[pid] <= min_keep or pid == sea_pid:
            continue
        nb = {}
        for cy, cx in comp:
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < h and 0 <= nx < w:
                        v = int(ids[ny, nx])
                        if v != pid:
                            nb[v] = nb.get(v, 0) + 1
        if not nb:
            continue
        best = max(nb.items(), key=lambda kv: kv[1])[0]
        if best == sea_pid and nb[sea_pid] * 2 > sum(nb.values()):
            continue                      # 四周是海 → 真岛，留着
        for cy, cx in comp:
            ids[cy, cx] = best
        moved += len(comp)
    return moved


def write_spec(name: str, svg: Path, w: int, h: int, groups: list, bg_pid: int) -> tuple[Path, Path]:
    spec_path = MC / f"spec_{name}.json"
    out_path = MC / f"ids_{name}.bin"
    spec_path.write_text(json.dumps({
        "svg": str(svg), "w": w, "h": h, "out": str(out_path),
        "bgPid": bg_pid, "groups": groups,
    }, ensure_ascii=False), encoding="utf-8")
    return spec_path, out_path


# ---------------------------------------------------------------- 统计


def stats(ids: np.ndarray, w: int, h: int, n_prov: int):
    counts = np.zeros(n_prov, dtype=np.int64)
    xsum = np.zeros(n_prov, dtype=np.float64)
    ysum = np.zeros(n_prov, dtype=np.float64)
    for y0 in range(0, h, 512):
        y1 = min(h, y0 + 512)
        blk = ids[y0:y1].astype(np.int64)
        counts += np.bincount(blk.ravel(), minlength=n_prov)[:n_prov]
        ys = np.arange(y0, y1, dtype=np.float64)[:, None]
        ysum += np.bincount(blk.ravel(), weights=np.repeat(ys, w, axis=1).ravel(),
                            minlength=n_prov)[:n_prov]
        xs = np.tile(np.arange(w, dtype=np.float64), y1 - y0)
        xsum += np.bincount(blk.ravel(), weights=xs, minlength=n_prov)[:n_prov]
    nz = counts > 0
    cx = np.zeros(n_prov, dtype=np.float64)
    cy = np.zeros(n_prov, dtype=np.float64)
    cx[nz] = xsum[nz] / counts[nz]
    cy[nz] = ysum[nz] / counts[nz]
    return counts, cx, cy


def adjacency(ids: np.ndarray, n_prov: int) -> bytes:
    chunks = []
    for a, b in ((ids[:, :-1], ids[:, 1:]), (ids[:-1, :], ids[1:, :])):
        u = a.ravel()
        v = b.ravel()
        m = (u != v) & (u > 0) & (v > 0)
        uu = u[m].astype(np.int64)
        vv = v[m].astype(np.int64)
        lo = np.minimum(uu, vv)
        hi = np.maximum(uu, vv)
        chunks.append(lo * np.int64(n_prov) + hi)
    code = np.unique(np.concatenate(chunks))
    lo = (code // n_prov).astype(np.int64)
    hi = (code % n_prov).astype(np.int64)
    src = np.concatenate([lo, hi])
    dst = np.concatenate([hi, lo])
    order = np.argsort(src, kind="stable")
    src = src[order]
    dst = dst[order]
    offsets = np.zeros(n_prov + 1, dtype=np.uint32)
    np.cumsum(np.bincount(src, minlength=n_prov), out=offsets[1:])
    log(f"  邻接边 {len(src)//2} 条")
    return offsets.tobytes() + dst.astype(np.uint16).tobytes()


# ---------------------------------------------------------------- 组装


def finish(out: Path, ids: np.ndarray, w: int, h: int, titles_raw: list, n_land: int,
           pid_title: list, pid_name: list, label_zoom: list, entity: str,
           default_tier: int, kind_of: list) -> None:
    """titles_raw: [{key,name,tier,parent,color}]；pid_title[tier][pid] 已经在外面算好。"""
    n_prov = n_land + 2                      # 0 是背景，1..n_land 是地块，最后一个留给海
    sea_pid = n_prov - 1
    titles = titles_raw + [{"key": "#sea", "name": "海洋", "tier": PSEUDO_TIER,
                            "parent": None, "color": list(SEA_COLOR)}]
    n_titles = len(titles)

    tm = np.full((len(TIERS), n_prov), NO_TITLE, dtype=np.uint16)
    for tier in range(len(TIERS)):
        row = pid_title[tier]
        for pid in range(1, n_land + 1):
            tid = row.get(pid)
            if tid is not None:
                tm[tier, pid] = tid
    tm[:, sea_pid] = n_titles - 1
    tm[:, 0] = NO_TITLE

    counts, cx, cy = stats(ids, w, h, n_prov)
    empty = [p for p in range(1, n_land + 1) if counts[p] == 0]
    if empty:
        log(f"  ⚠ {len(empty)} 个地块一个像素都没有：{empty[:12]}")

    # 头衔统计
    prov_count = [0] * n_titles
    area = [0] * n_titles
    lx = [None] * n_titles
    ly = [None] * n_titles
    for pid in range(1, n_land + 1):
        for tier in range(len(TIERS)):
            tid = pid_title[tier].get(pid)
            if tid is None:
                continue
            prov_count[tid] += 1
            area[tid] += int(counts[pid])
    prov_count[n_titles - 1] = 1
    area[n_titles - 1] = int(counts[sea_pid])

    # 标注点：自己那堆像素的面积加权重心
    for tid, t in enumerate(titles):
        sx = sy = sw = 0.0
        if t["tier"] == PSEUDO_TIER:
            if counts[sea_pid] > 0:
                lx[tid] = round(float(cx[sea_pid]), 1)
                ly[tid] = round(float(cy[sea_pid]), 1)
            continue
        for pid in range(1, n_land + 1):
            if pid_title[t["tier"]].get(pid) != tid:
                continue
            c = float(counts[pid])
            if c <= 0:
                continue
            sx += float(cx[pid]) * c
            sy += float(cy[pid]) * c
            sw += c
        if sw > 0:
            lx[tid] = round(sx / sw, 1)
            ly[tid] = round(sy / sw, 1)
    # 父节点（大区 / 大洲 / 中国 / 世界）按子节点面积加权
    for tid in range(n_titles - 1, -1, -1):
        if lx[tid] is not None:
            continue
        sx = sy = sw = 0.0
        for tid2, t2 in enumerate(titles):
            if t2.get("parent") == tid and lx[tid2] is not None:
                w2 = max(1, area[tid2])
                sx += lx[tid2] * w2
                sy += ly[tid2] * w2
                sw += w2
        if sw > 0:
            lx[tid], ly[tid] = round(sx / sw, 1), round(sy / sw, 1)

    kind = np.zeros(n_prov, dtype=np.uint8)
    for pid in range(1, n_land + 1):
        kind[pid] = kind_of[pid - 1]
    kind[sea_pid] = 2

    names_latin = [bool(re.search(r"[A-Za-z]", str(t["name"]))) for t in titles]
    payload = {
        "keys": [t["key"] for t in titles],
        "tiers": [t["tier"] for t in titles],
        "parents": [(-1 if t["parent"] is None else t["parent"]) for t in titles],
        "names": [t["name"] for t in titles],
        "colors": [t["color"] for t in titles],
        "provCount": prov_count,
        "area": area,
        "lx": lx,
        "ly": ly,
        "gx": list(lx),
        "gy": list(ly),
        "hideLabel": names_latin,
        "provinceNames": [""] + [pid_name[p] for p in range(1, n_land + 1)] + ["海洋"],
    }

    meta = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "game": "hoi4",
        "label": None,                       # 外面填
        "mapWidth": w,
        "mapHeight": h,
        "numProvinces": n_prov,
        "numTitles": n_titles,
        "numRealTitles": n_titles - 1,
        "kindMask": base64.b64encode(kind.tobytes()).decode("ascii"),
        "tiers": TIERS,
        "tierNames": None,
        "tierKeys": TIER_KEYS,
        "entity": entity,
        "defaultTier": default_tier,
        "eraDates": ERA_DATES,
        "labelZoom": label_zoom,
        "noTitle": NO_TITLE,
        "specialPrefix": "#",
        "colorLutWidth": 256,
        "wasteland": [],
    }

    out.mkdir(parents=True, exist_ok=True)
    (out / "titles.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                                     encoding="utf-8")
    (out / "titlemap.bin").write_bytes(zlib.compress(tm.tobytes(), 6))
    (out / "provinces_id.bin").write_bytes(zlib.compress(ids.tobytes(), 6))
    (out / "adjacency.bin").write_bytes(zlib.compress(adjacency(ids, n_prov), 6))
    pos = np.stack([cx, cy, counts.astype(np.float64)], axis=1).astype(np.float32)
    (out / "prov_pos.bin").write_bytes(zlib.compress(pos.tobytes(), 6))
    return meta, payload, n_prov


def pid_colors(titles: list, last_row: dict, n_prov: int) -> list:
    """给预览图用的 pid → 颜色（按最细那一层上色）。"""
    out = [tuple(SEA_COLOR)] * n_prov
    out[0] = (18, 24, 32)
    for pid, tid in last_row.items():
        if 0 < pid < n_prov:
            out[pid] = tuple(titles[tid]["color"])
    return out


def preview(ids: np.ndarray, w: int, h: int, colors: list, path: Path) -> None:
    lut = np.zeros((256, 3), dtype=np.uint8)
    lut[0] = (20, 26, 34)
    for pid, c in enumerate(colors):
        if 0 < pid < 256:
            lut[pid] = c
    rgb = lut[np.minimum(ids, 255)]
    im = Image.fromarray(rgb, "RGB")
    im = im.resize((min(640, w), max(1, round(min(640, w) * h / w))), Image.NEAREST)
    im.save(path, quality=88)
    log(f"  预览图 {path.name}（{im.width}×{im.height}）")


# ---------------------------------------------------------------- 两张图


def svg_size(src: str) -> tuple[float, float]:
    """要的是 SVG 的用户坐标系尺寸：有 viewBox 用 viewBox，没有就退回 width/height。"""
    m = re.search(r'viewBox="\s*([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)[ ,]+([-\d.]+)', src)
    if m:
        return float(m.group(3)), float(m.group(4))
    w = re.search(r'\bwidth="([\d.]+)"', src)
    h = re.search(r'\bheight="([\d.]+)"', src)
    if not w or not h:
        raise SystemExit("SVG 里找不到 viewBox / width / height")
    return float(w.group(1)), float(h.group(1))


def build_china(out: Path, width: int) -> dict:
    svg = MC / "china.svg"
    src = svg.read_text("utf-8")
    vbw, vbh = svg_size(src)
    w = width
    h = round(w * vbh / vbw)
    sea_pid = len(CHINA) + 1

    groups = [{"pid": i + 1, "ids": [p[0]]} for i, p in enumerate(CHINA)]
    spec_path, ids_path = write_spec("china", svg, w, h, groups, sea_pid)
    ids = raster(spec_path, ids_path).reshape(h, w)

    titles = []
    def add(key, name, tier, parent, color):
        titles.append({"key": key, "name": name, "tier": tier, "parent": parent, "color": list(color)})
        return len(titles) - 1

    root = add("CHN", "中国", 0, None, (188, 96, 88))
    reg_tid = {}
    for reg, col in REGION_COLOR.items():
        reg_tid[reg] = add("reg_" + reg, reg, 2, root, col)

    pid_title = [dict(), dict(), dict(), dict()]
    pid_name = [""] * (len(CHINA) + 2)
    kinds = []
    for i, (svg_id, name, reg) in enumerate(CHINA):
        pid = i + 1
        base = REGION_COLOR[reg]
        tid = add(svg_id.lower(), name, 3, reg_tid[reg],
                  shade(base, dh=((i * 37) % 46) - 23, dl=((i * 13) % 18) / 100.0 - 0.09))
        pid_title[0][pid] = root
        pid_title[2][pid] = reg_tid[reg]
        pid_title[3][pid] = tid
        pid_name[pid] = name
        kinds.append(1)

    meta, payload, n_prov = finish(
        out, ids, w, h, titles, len(CHINA), pid_title, pid_name,
        [8, 8, 40, 80], "省", 3, kinds)

    meta["label"] = "MapChart 中国"
    meta["tierNames"] = ["2025", "空白剧本", "大区", "省级行政区"]
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    preview(ids, w, h, pid_colors(titles, pid_title[-1], n_prov), out / "preview.jpg")
    log(f"  中国：{len(CHINA)} 省 / {len(REGION_COLOR)} 大区 / {w}×{h} / {n_prov} 个 pid")
    return meta


def build_world(out: Path, width: int) -> dict:
    svg = MC / "world.svg"
    src = svg.read_text("utf-8")
    vbw, vbh = svg_size(src)
    w = width
    h = round(w * vbh / vbw)
    svg_ids = re.findall(r'<path\b[^>]*\bid="([^"]*)"', src)
    countries = world_countries(svg_ids)
    n = len(countries)
    sea_pid = n + 1

    groups = [{"pid": i + 1, "ids": c["paths"]} for i, c in enumerate(countries)]
    spec_path, ids_path = write_spec("world", svg, w, h, groups, sea_pid)
    ids = raster(spec_path, ids_path).reshape(h, w)

    titles = []
    def add(key, name, tier, parent, color):
        titles.append({"key": key, "name": name, "tier": tier, "parent": parent, "color": list(color)})
        return len(titles) - 1

    root = add("WORLD", "世界", 0, None, (120, 132, 148))
    cont_tid = {}
    for i, cont in enumerate(CONT_ORDER):
        cont_tid[cont] = add("reg_" + cont.lower().replace(" ", "_"), CONT_ZH[cont], 2, root,
                             shade(CONT_COLOR[cont], dh=i * 9, dl=-0.10))

    pid_title = [dict(), dict(), dict(), dict()]
    pid_name = [""] * (n + 2)
    kinds = []
    for i, c in enumerate(countries):
        pid = i + 1
        base = CONT_COLOR[c["cont"]]
        h32 = zlib.crc32(c["key"].encode())
        col = shade(base, dh=(h32 % 74) - 37, ds=0.06 if (h32 >> 12) & 1 else -0.04,
                    dl=((h32 >> 8) % 26) / 100.0 - 0.13)
        tid = add(c["key"].lower(), c["name"], 3, cont_tid[c["cont"]], col)
        pid_title[0][pid] = root
        pid_title[2][pid] = cont_tid[c["cont"]]
        pid_title[3][pid] = tid
        pid_name[pid] = c["name"]
        kinds.append(1)

    meta, payload, n_prov = finish(
        out, ids, w, h, titles, n, pid_title, pid_name,
        [8, 8, 30, 60], "国家", 3, kinds)

    meta["label"] = "MapChart 世界"
    meta["tierNames"] = ["2025", "空白剧本", "大洲", "国家"]
    (out / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    preview(ids, w, h, pid_colors(titles, pid_title[-1], n_prov), out / "preview.jpg")
    log(f"  世界：{n} 国 / 7 大洲 / {w}×{h} / {n_prov} 个 pid")
    return meta


def main() -> int:
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="MapChart SVG → 编辑器地图包")
    ap.add_argument("which", choices=["china", "world", "both"], help="做哪张")
    ap.add_argument("--size", type=int, default=None, help="栅格宽度（中国默认 2048，世界默认 4096）")
    ap.add_argument("--pack", action="store_true", help="顺手打包成 _local/*.pdxmap")
    args = ap.parse_args()

    jobs = []
    if args.which in ("china", "both"):
        jobs.append(("china", ROOT / "data_mapchart_china", args.size or 2048,
                     "mapchart-china-2025", "MapChart 中国",
                     "省级行政区 33 个 · 划成七个大区 · 数据来自 mapchart.net/china.html"))
    if args.which in ("world", "both"):
        jobs.append(("world", ROOT / "data_mapchart_world", args.size or 4096,
                     "mapchart-world-2025", "MapChart 世界",
                     "国家 199 个 · 七大洲 · 数据来自 mapchart.net/world.html"))

    for which, out, width, pack_id, label, desc in jobs:
        t0 = time.time()
        log(f"===== {label}（宽 {width}）=====")
        if which == "china":
            build_china(out, width)
        else:
            build_world(out, width)
        for name in ("meta.json", "titles.json", "titlemap.bin", "provinces_id.bin",
                     "adjacency.bin", "prov_pos.bin"):
            log(f"  {name:18s} {(out/name).stat().st_size / 1048576:7.2f} MB")
        if args.pack:
            import argparse as _ap
            import pack_map
            ns = _ap.Namespace(
                id=pack_id, label=label, note=None, version="1.0.0",
                author="", license="地图数据来自 mapchart.net（自由使用，请标明出处）",
                homepage="https://www.mapchart.net/",
                description=desc, preview=str(out / "preview.jpg"),
                out=str(ROOT / "_local" / f"{pack_id}.pdxmap"), data_dir=str(out))
            pack_map.build_pack(ns, quiet=False)
        log(f"  用时 {time.time()-t0:.0f}s\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
