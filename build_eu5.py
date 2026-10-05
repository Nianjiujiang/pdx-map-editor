#!/usr/bin/env python3
"""从 EU5 安装目录构建地图编辑器所需的缓存 → ``data_eu5/``。

六层（EU5 自己就有这棵树，不用攒）：

    continent → subcontinent → region → area → province → location

跟前面几套不一样的地方：

* 数据在 ``game/in_game/`` 下面（EU5 的新布局）。
* **地块图是 16384×8192**，像素色就是地块色；名字与颜色的对照在
  ``map_data/named_locations/00_default.txt``（``stockholm = dda910``）。
  一半的 location 是按颜色认出来的 —— 所以要先把"颜色 → location 序号"
  压成一张表，再整图查（33M 像素逐像素查字典会慢到没法用）。
* 默认**降采样到一半**（8192×4096）出缓存：16384 宽的纹理正好顶到常见显卡
  上限、显存也吃不下（单张 R16UI 就要 268 MB）。分块上传是后面单独一轮的事。
* **1337 开局归属还找不到**（不在明文数据里，多半在二进制 nodes.dat），
  所以"EU5 那年头的地图"这一层暂时缺席，先做地理六层。

用法::

    python build_eu5.py
    python build_eu5.py --eu5 "C:\\Game NIANJIU\\EU5" --scale 1     # 原尺寸
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from build_data import NO_TITLE, build_adjacency, log                      # noqa: E402
from build_eu4 import Node, build_special_titles, pick_color               # noqa: E402
from parsers.eu5 import parser as E                                               # noqa: E402

DATA = ROOT / "data_eu5"

#: 六层，从粗到细
#: 第 0 层 = **1337 年的归属**（来自 eu5_1337_location_owners.csv，
#: 就是那份 1337.4.1 开局档解出来的），后面六层是 EU5 自己的地理分类。
#: 因为多了一层，树里的层级号要整体 +1 才是它在归属表里的行号。
ERA_TIER = "1337"
ERA_ROW = 0
TREE_ROW0 = 1
#: 层级树里的层级号 → 归属表行号。
#: 树里是 continent0 → sub1 → region2 → area3 → province4 → location5，
#: 归属表行是 0=1337、1=区域、2=地区、3=省份、4=地块 —— 所以 region 及更细才有行，
#: 大洲/次大陆（0、1）没有行 → 给一个"超出范围"的号（前端据此判为锁住、不可涂）。
def tree_row(lv: int) -> int:
    return lv - 1 if lv >= 2 else len(TIER_ORDER)
#: **1337 + 区域 / 地区 / 省份 / 地块**（大洲、次大陆两层不要）。
#: 层级树里那两层节点还在，但没有对应行 → 前端按"序号超范围"判为锁住，不可涂。
TIER_ORDER = (ERA_TIER, "reg", "area", "prov", "loc")
TIER_NAME = {"1337": "1337", "cont": "大洲", "sub": "次大陆", "reg": "区域",
             "area": "地区", "prov": "省份", "loc": "地点"}
TIER_KEY = {"1337": "国家", "cont": "大洲", "sub": "次大陆", "reg": "区域",
            "area": "地区", "prov": "省", "loc": "地点"}


def find_eu5(explicit: str | None = None) -> Path:
    for p in ([Path(explicit)] if explicit else []) + [
            Path(r"C:\Game NIANJIU\EU5"),
            Path(r"D:\Game NIANJIU\EU5"),
            Path(r"C:\Steam\steamapps\common\Europa Universalis V")]:
        if (p / "game" / "in_game" / "map_data" / "locations.png").is_file():
            return p
    raise SystemExit("找不到 EU5（用 --eu5 指定根目录，里面要有 game/in_game/map_data）")


def main() -> int:
    global DATA
    ap = argparse.ArgumentParser(description="从 EU5 构建地图缓存")
    ap.add_argument("--eu5", help="EU5 根目录（含 game/in_game）")
    ap.add_argument("--out", help="缓存目录，默认 data_eu5/")
    ap.add_argument("--label", default="EU5 原版", help="写进 meta 的显示名")
    ap.add_argument("--scale", type=int, default=2,
                    help="整图缩小几倍（默认 2 = 8192×4096）")
    args = ap.parse_args()

    root = find_eu5(args.eu5)
    G = root / "game" / "in_game"
    if args.out:
        DATA = Path(args.out).resolve()
    DATA.mkdir(parents=True, exist_ok=True)
    log(f"EU5 @ {root}")
    log(f"输出目录 {DATA}（缩 1/{args.scale}）")

    # 1. 层级树 + 地名色表 + 中文
    parent, level, locs = E.parse_hierarchy(G / "map_data" / "definitions.txt")
    ncolor = E.parse_named_locations(G / "map_data" / "named_locations")
    log(f"层级：continent {sum(1 for v in level.values() if v == 0)}"
        f" / sub {sum(1 for v in level.values() if v == 1)}"
        f" / region {sum(1 for v in level.values() if v == 2)}"
        f" / area {sum(1 for v in level.values() if v == 3)}"
        f" / province {sum(1 for v in level.values() if v == 4)}"
        f" / location {sum(1 for v in level.values() if v == 5)}")
    log(f"地名↔色 {len(ncolor)} 条")

    # 2. 节点顺序：按层级从粗到细，同层按名字排（结果稳定、可复现）
    ordered_keys: list[str] = []
    index_of: dict[str, int] = {}
    for want in range(len(E.LEVELS)):
        for key in sorted(k for k, v in level.items() if v == want):
            index_of[key] = len(ordered_keys)
            ordered_keys.append(key)

    # 3. 图：像素色 → location 序号
    src = G / "map_data" / "locations.png"
    im = Image.open(src)
    if args.scale > 1:
        im = im.resize((im.width // args.scale, im.height // args.scale), Image.NEAREST)
    arr = np.asarray(im.convert("RGB"), dtype=np.uint32)
    h, w = arr.shape[:2]
    pid_map = (arr[:, :, 0] << 16) | (arr[:, :, 1] << 8) | arr[:, :, 2]
    log(f"地块图 {w}×{h}，不同颜色 {len(np.unique(pid_map))} 个")

    # 颜色 → location 序号（只对唯一色查一次）
    # 两种序号要分清：
    #   loc_index[name] —— 这个 location 在**节点表**里的位置（给树用）
    #   loc_ord[name]   —— 它在**省份轴**上的下标 1..N（给 titlemap 用）
    loc_index = {name: index_of[name] for name in index_of
                 if level.get(name) == 5}
    loc_ord = {name: i + 1 for i, name in enumerate(sorted(loc_index))}
    color_of_loc: dict[str, int] = {}
    plain = lambda k: E.NAME_OF.get(k, k)
    for name, rgb in ncolor.items():
        if name in loc_index:
            color_of_loc[name] = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]
    for name in list(loc_index):
        if name not in color_of_loc and plain(name) in ncolor:
            r0, g0, b0 = ncolor[plain(name)]
            color_of_loc[name] = (r0 << 16) | (g0 << 8) | b0
    lut_colors = np.fromiter(color_of_loc.values(), dtype=np.uint32)
    lut_ids = np.fromiter((loc_ord[n] for n in color_of_loc), dtype=np.uint16)
    order = np.argsort(lut_colors)
    lut_colors, lut_ids = lut_colors[order], lut_ids[order]

    uniq, inverse = np.unique(pid_map.ravel(), return_inverse=True)
    slot = np.searchsorted(lut_colors, uniq)
    slot = np.clip(slot, 0, len(lut_colors) - 1)
    hit = lut_colors[slot] == uniq

    # 没认出来的颜色**也各发一个号**：它们多半是海/湖/荒地（不在 named_locations 里，
    # 所以查不到名字），但颜色就明明白白在图上。给它们编号之后地图 100% 有颜色，
    # 跟游戏里长得一样；因为没名字，它们也不会跑到地名层去。
    miss = ~hit
    extra_colors = uniq[miss]
    extra_ids = (np.arange(len(extra_colors), dtype=np.uint32) + len(loc_ord) + 1)
    dense_lut = np.zeros(len(uniq), dtype=np.uint32)
    dense_lut[hit] = lut_ids[slot[hit]]
    dense_lut[miss] = extra_ids
    ids = dense_lut[inverse].reshape(h, w)
    n_prov = len(loc_ord) + len(extra_colors) + 1
    known = int(hit.sum())
    log(f"多出来 {len(extra_colors)} 种颜色（海/湖/荒地等），已各自编号")
    # 那些无名颜色各配一个节点（挂在这一层，名字空着）
    extra_of_pid: dict[int, tuple[int, int, int]] = {}
    for i, c in enumerate(extra_colors.tolist()):
        pid = len(loc_ord) + 1 + i
        key = f"#u{pid}"
        index_of[key] = len(ordered_keys)
        ordered_keys.append(key)
        level[key] = 5
        parent[key] = None
        extra_of_pid[pid] = ((c >> 16) & 255, (c >> 8) & 255, c & 255)
    n_nodes = len(ordered_keys)
    log(f"节点共 {n_nodes} 个（其中无名色 {len(extra_of_pid)} 个）")
    log(f"颜色匹配：{known}/{len(uniq)} 种认出来了（覆盖 {100.0*int(hit[inverse].sum())/ids.size:.1f}% 的像素）")

    # 4. 归属表（六层）
    titlemap = np.full((len(TIER_ORDER), n_prov), NO_TITLE, dtype=np.uint16)
    for name, idx in loc_index.items():
        # location 自己
        rgb = ncolor.get(name)
        # 往上一层一层填祖先
        cur = name
        lv = level.get(name, 5)
        while cur is not None and lv >= 0:
            key = TIER_ORDER[lv] if lv < len(TIER_ORDER) else None
            if key:
                titlemap[lv] = titlemap[lv]  # noop，保持结构清晰
            cur = parent.get(cur)
            lv -= 1
    # 上面那种写法太绕，直接用 pid → location 反查表
    loc_id_to_name = {v: k for k, v in loc_ord.items()}
    for pid in np.unique(ids):
        if pid == 0:
            continue
        name = loc_id_to_name.get(int(pid))
        if name is None:
            continue
        # **每个祖先按它自己的实际层级落位**（不是"往上数一格填一层"）：
        # 树里偶尔会有跳级的嵌套（比如某块地直接挂在 area 下面），
        # 按步数走会让整条链错位一格，看上去就是"归属莫名其妙"。
        cur = name
        guard = 0
        while cur is not None and guard < 12:
            lv = level.get(cur)
            # 注意：这里要判**行号**，不能判树层级号 —— 层级树一直是 0~5，
            # 而 TIER_ORDER 现在只有 4 层，写 `lv < len(TIER_ORDER)` 会把
            # 省份(4)/地块(5) 整层跳过（之前 1618/1789 那种「两层空掉」就是这么来的）。
            if lv is not None and cur in index_of:
                _row = tree_row(lv)
                if _row < len(TIER_ORDER):        # 没有行的那三层（大洲/次大陆/区域）跳过
                    titlemap[_row, pid] = index_of[cur]
            cur = parent.get(cur)
            guard += 1
    for pid, _rgb in extra_of_pid.items():
        # **六层都挂**：海/湖/荒地在每个视图里都该在场，不然粗层会露出空洞
        titlemap[:, pid] = index_of[f"#u{pid}"]
    log(f"归属表 {titlemap.shape} 填好")

    # 5. 颜色：location 用游戏自己的色，其余层现配
    colors = np.zeros((n_nodes, 3), dtype=np.uint8)
    for name, idx in loc_index.items():
        rgb = ncolor.get(plain(name))
        if rgb:
            colors[idx] = rgb
    for pid, rgb in extra_of_pid.items():
        colors[index_of[f"#u{pid}"]] = rgb
    placed: list = []
    for want in range(5):                      # 粗到细现配：大洲…省份
        base = (want * 61.0) % 360.0
        for key in sorted(k for k, v in level.items() if v == want):
            colors[index_of[key]] = pick_color((base + index_of[key] * 7.0) % 360.0,
                                               58.0, placed)

    # 6. 名字
    zh = E.load_loc(root, "simp_chinese")
    en = E.load_loc(root, "english")
    log(f"中文 {len(zh)} 条 / 英文 {len(en)} 条")
    keys = [ordered_keys[i] for i in range(n_nodes)]
    names = ["" if k.startswith("#u") else (zh.get(plain(k)) or en.get(plain(k), "") or plain(k))
             for k in keys]
    names_en = [en.get(plain(k), "") for k in keys]
    zh_used = sum(1 for k in keys if zh.get(plain(k)))
    log(f"  {zh_used}/{n_nodes} 个节点有中文名")

    # 7. 像素数 / 质心
    counts = np.bincount(ids.ravel().astype(np.int64), minlength=n_prov)[:n_prov]
    ys, xs = np.mgrid[0:h, 0:w]
    ysum = np.bincount(ids.ravel().astype(np.int64), weights=ys.ravel().astype(np.float64),
                       minlength=n_prov)[:n_prov]
    xsum = np.bincount(ids.ravel().astype(np.int64), weights=xs.ravel().astype(np.float64),
                       minlength=n_prov)[:n_prov]
    pcx = np.where(counts > 0, xsum / np.maximum(counts, 1), 0.0).astype(np.float32)
    pcy = np.where(counts > 0, ysum / np.maximum(counts, 1), 0.0).astype(np.float32)

    # 8. 面积 / 成员
    area = np.zeros(n_nodes, dtype=np.int64)
    for lv in range(len(TIER_ORDER)):
        row = titlemap[lv]
        vals, cnt = np.unique(row[row != NO_TITLE], return_counts=True)
        for v, c in zip(vals.tolist(), cnt.tolist()):
            if v < n_nodes:
                area[v] += c

    # 9. 邻接 + 标注位置（location 层）
    adj = build_adjacency(ids, n_prov)
    offsets = np.frombuffer(adj, dtype=np.uint32, count=n_prov + 1)
    neigh = np.frombuffer(adj, dtype=np.uint16, offset=(n_prov + 1) * 4)
    from build_eu4 import largest_block_centre
    lx = np.full(n_nodes, np.nan, dtype=np.float32)
    ly = np.full(n_nodes, np.nan, dtype=np.float32)
    block_area = np.zeros(n_nodes, dtype=np.int64)
    members: dict[int, list[int]] = {}
    # 用 location 层的成员往上聚合（简单可靠）
    loc_row = titlemap[len(TIER_ORDER) - 1]   # 最细那层 = 地块
    for pid in np.nonzero(loc_row != NO_TITLE)[0]:
        members.setdefault(int(loc_row[pid]), []).append(int(pid))
    for lv in range(len(TIER_ORDER) - 1, -1, -1):
        row = titlemap[lv]
        agg: dict[int, list[int]] = {}
        for pid in np.nonzero(row != NO_TITLE)[0]:
            agg.setdefault(int(row[pid]), []).append(int(pid))
        for k, v in agg.items():
            members.setdefault(k, v)
    for i, m in members.items():
        c = largest_block_centre(m, offsets, neigh, counts, pcx, pcy)
        if c is not None:
            lx[i], ly[i] = c[0], c[1]
            block_area[i] = c[2]
    log("标注位置：每块地取像素最多的那个连通块的重心")

    # 10. 写盘

    # ---- 1337 归属层（第 0 层）----
    # 数据来自 1337.4.1 开局档解出来的 CSV：location, owner_tag, owner_id。
    # 名字用游戏自己的中文表（<TAG>），颜色用 setup/countries 里那个真实色值 color2。
    import csv as _csv
    owners: dict[str, str] = {}
    _csv_path = Path(__file__).resolve().parent / "eu5_1337_location_owners.csv"
    if _csv_path.is_file():
        for row in _csv.DictReader(_csv_path.open(encoding="utf-8-sig")):
            if row.get("owner_tag"):
                owners[row["location"]] = row["owner_tag"]
        log(f"1337 归属：CSV {len(owners)} 条")
    else:
        log("！ 没找到 eu5_1337_location_owners.csv（跳过 1337 层）")

    # 国家颜色分两步：
    # ① setup/countries/*.txt 里 `color = map_XXX` —— map_XXX 是**命名色**，
    #    真正的定义在 game/main_menu/common/named_colors/02_map.txt
    #    （**在 main_menu 下**，不在 in_game 下 ✗ 我前面一直在 in_game 里翻，所以找不到）。
    # ② 取不到命名色就退回 color2（那是每国共用的次要色，只是兜底）。
    named: dict[str, tuple[int, int, int]] = {}
    # 注意：命名色在 **game/main_menu/** 下，不在 game/in_game/ 下 ✗
    # （G 指向 in_game，拼成 G/main_menu 会指向一个不存在的目录）
    _nc = root / "game" / "main_menu" / "common" / "named_colors"
    for _fp in sorted(_nc.glob("*.txt")):
        try:
            _txt = _fp.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        _body = E.parse_script(_txt)
        for _k0, _v0 in _body:                       # 先解开 colors = { … } 那一层
            if _k0 == "colors" and isinstance(_v0, list):
                _body = _v0
                break
        for _k, _v in _body:
            if _k and isinstance(_v, list):
                _rgb = E.as_rgb(_v) if hasattr(E, "as_rgb") else None
                if _rgb:
                    named[_k] = tuple(int(x) for x in _rgb)
    log(f"命名色 {len(named)} 条（map_* 地图色）")

    cmap: dict[str, str] = {}          # tag → 命名色键（如 map_FRA）
    ccol: dict[str, tuple[int, int, int]] = {}
    for fp in sorted((G / "setup" / "countries").glob("*.txt")):
        try:
            txt = fp.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        # **按块正确切分**：原来是 `[\s\S]*?` 非贪婪匹配到第一个行首 `}`
        # → 每个文件只取到第一个国家的颜色，其余全落空、最后都成了兜底灰 ✗。
        # 这里做配对花括号扫描，逐个国家取 color2。
        for m in re.finditer(r"(?m)^\s*([A-Z]{3})\s*=\s*\{", txt):
            tag = m.group(1)
            if tag in ccol:
                continue
            depth, k2 = 1, m.end()
            while k2 < len(txt) and depth:
                if txt[k2] == "{":
                    depth += 1
                elif txt[k2] == "}":
                    depth -= 1
                k2 += 1
            blk = txt[m.end():k2]
            c2 = re.search(r"color2\s*=\s*rgb\s*\{\s*(\d+)\s+(\d+)\s+(\d+)", blk)
            if c2:
                ccol[tag] = (int(c2.group(1)), int(c2.group(2)), int(c2.group(3)))
            # `color` 有两种写法：命名色 `map_XXX`，或者**直接写死的 rgb/hsv360**
            # （`AAC = { color = rgb { 157 51 167 } }` 这种 ✗ 早先只认命名色，于是它们全落空）
            c1 = re.search(r"\bcolor\s*=\s*(map_[A-Za-z0-9_]+)", blk)
            if c1:
                cmap[tag] = c1.group(1)
            else:
                c3 = re.search(r"\bcolor\s*=\s*(rgb|hsv360|hsv)\s*\{([^}]*)\}", blk)
                if c3:
                    # 注意：**别转 int** ✗ —— `hsv { 0 0 0.60 }` 是 0~1 的小数，
                    # 转 int 会把 0.60 截成 0（姆扎卜那种国家就变成纯黑了）。
                    # 原样把数字字符串交给 as_rgb，它分得清 hsv(0~1) 与 hsv360(0~360)。
                    _nums = re.findall(r"-?\d+(?:\.\d+)?", c3.group(2))
                    if len(_nums) >= 3:
                        _rgb = E.as_rgb([("__prefix__", c3.group(1))]
                                        + [(None, v) for v in _nums[:3]])
                        if _rgb:
                            ccol[tag] = tuple(int(x) for x in _rgb)

    # 就地读一遍本地化（这一段跑在构建器前半段，后面的 zh/en 还没加载）
    _zh = E.load_loc(root, "simp_chinese")
    _en = E.load_loc(root, "english")

    era_nodes: dict[str, int] = {}
    for tag in sorted(set(owners.values())):
        key = f"1337_{tag}"
        idx = len(keys)
        index_of[key] = idx
        keys.append(key)
        names.append(_zh.get(tag) or _en.get(tag, "") or tag)
        names_en.append(_en.get(tag, ""))
        colors = np.vstack([colors, np.array([named.get(cmap.get(tag, ""), None)
                                                       or ccol.get(tag, (160, 160, 160))],
                                                      dtype=np.uint8)])
        area = np.concatenate([area, np.zeros(1, dtype=np.int64)])
        block_area = np.concatenate([block_area, np.zeros(1, dtype=np.int64)])
        lx = np.concatenate([lx, np.full(1, np.nan, dtype=np.float32)])
        ly = np.concatenate([ly, np.full(1, np.nan, dtype=np.float32)])
        level[key] = ERA_ROW
        parent[key] = None
        era_nodes[tag] = idx
        n_nodes += 1
    log(f"1337 国家节点 {len(era_nodes)} 个")

    # loc_ord 的键是唯一键（"5:stockholm"），要按**显示名**查
    _by_display = {E.NAME_OF.get(k, k): v for k, v in loc_ord.items()}
    filled = 0
    for loc_name, tag in owners.items():
        pid = _by_display.get(loc_name)
        node = era_nodes.get(tag)
        if pid and node is not None:
            titlemap[ERA_ROW, pid] = node
            filled += 1
    log(f"1337 层填了 {filled} 个地块（共 {n_prov - 1}）")

    # 面积 + 标注位置：**面积/位置那两步在本段之前就跑过了** ✗，
    # 所以国家节点得在这儿自己补一次（不补的话标签层会跳过它们：没面积 = 不画）。
    # 位置用"按像素加权的重心"，够国家名用。
    _row0 = titlemap[ERA_ROW]
    _vals, _cnt = np.unique(_row0[_row0 != NO_TITLE], return_counts=True)
    for _v, _c in zip(_vals.tolist(), _cnt.tolist()):
        if _v < n_nodes:
            area[_v] += int(_c)
    # 位置跟别的模式**用同一套**：取"像素最多的那一块连通域"的几何中心 ✗
    # （早先这里图省事写成"全部领地按像素加权的重心" ✗ —— 一个横跨大洋的国家
    #   重心会被殖民地拽到海里，跟 EU4/CK3 的观感就不一样了。）
    from build_eu4 import largest_block_centre as _lbc
    _adj0 = build_adjacency(ids, n_prov)
    _off0 = np.frombuffer(_adj0, dtype=np.uint32, count=n_prov + 1)
    _ngb0 = np.frombuffer(_adj0, dtype=np.uint16, offset=(n_prov + 1) * 4)
    _m = _row0 != NO_TITLE
    _r0 = _row0[_m]
    _order = np.argsort(_r0, kind="stable")
    _sorted = _r0[_order]
    _bounds = np.searchsorted(_sorted, np.arange(n_nodes))
    _ends = np.searchsorted(_sorted, np.arange(n_nodes), side="right")
    _pids_all = np.nonzero(_m)[0][_order]
    for _i in range(n_nodes):
        _a, _b2 = int(_bounds[_i]), int(_ends[_i])
        if _b2 <= _a:
            continue
        _c = _lbc(_pids_all[_a:_b2].tolist(), _off0, _ngb0, counts, pcx, pcy)
        if _c is not None:
            lx[_i], ly[_i] = float(_c[0]), float(_c[1])
            block_area[_i] = int(_c[2])

    log(f"1337 节点的面积与位置补好（{int(np.isfinite(lx[:n_nodes]).sum() and sum(1 for _i in range(n_nodes) if lx[_i] == lx[_i]))} 个有位置）")

    n_real_titles = n_nodes      # 伪头衔之前的真实节点数（前端的锁就按这个判）

    # ---- 9b. 水域 / 不可通行：锁住的伪头衔 ----
    # default.map 里 sea_zones / lakes / impassable_mountains 三张表是按**名字**列的，
    # 跟层级树同一套名字 —— 对出来就是地块号，不用猜颜色。锁的机制跟 CK3/EU4/V3 一样：
    # 节点排在 numRealTitles 之后，前端按"序号 ≥ 真实节点数"判为锁住。
    dmap = E.parse_default_map(G / "map_data" / "default.map")
    cat: dict[str, set] = {}
    by_name: dict[str, list] = {}
    for uid_, disp_ in E.NAME_OF.items():
        by_name.setdefault(disp_, []).append(uid_)
    water_names: set = set()
    for key, cat_key in (("sea_zones", "#sea"), ("lakes", "#lake"),
                         ("impassable_mountains", "#impassable")):
        s = set()
        for nm in dmap.get(key, []):
            for uid_ in by_name.get(nm, []):
                if uid_ in loc_ord:
                    s.add(loc_ord[uid_])
            if key != "impassable_mountains":
                water_names.add(nm)
        if s:
            cat[cat_key] = s
    # **递归上推判水**：某个节点下属的地块全是水 → 它自己就是水域，名字不显示。
    # 不按名字猜（"大洋洲"名字里也有"洋"，但那是陆地）。
    water_all = cat.get("#sea", set()) | cat.get("#lake", set())
    has_land: set = set()
    for uid_, _d in E.NAME_OF.items():
        if level.get(uid_) != 5 or loc_ord.get(uid_) in water_all:
            continue
        cur_, g_ = parent.get(uid_), 0
        while cur_ is not None and g_ < 12:
            has_land.add(cur_)
            cur_ = parent.get(cur_)
            g_ += 1
    hid = 0
    for k_ in keys:
        if level.get(k_, 5) >= 5 or k_ not in E.NAME_OF or k_ in has_land:
            continue
        i_ = index_of.get(k_)
        if i_ is not None and names[i_]:
            names[i_] = ""
            names_en[i_] = ""
            hid += 1
    log(f"  水域上级（下属地块全是水）隐藏名字 {hid} 个")

    # 含岛屿的洋（大西洋系）"全是水"判不出来，单独标成"不显示地名" ——
    # 只是不打标签，节点照旧可涂、悬停也照旧能查到名字。
    hide_label = [False] * len(names)
    OCEAN_NAMES = ("大西洋", "太平洋", "印度洋", "南大洋", "北冰洋")
    hid2 = 0
    for i_, n_ in enumerate(names):
        if n_ and any(o in n_ for o in OCEAN_NAMES) and names[i_]:
            hide_label[i_] = True
            hid2 += 1
    log(f"  只隐藏地名（仍可涂）：{hid2} 个")

    # 水名出现在**任何层级**（比如 eastern_baltic_sea 既是海也是省）都不显示
    for uid_, disp_ in E.NAME_OF.items():
        if disp_ in water_names and uid_ in index_of:
            names[index_of[uid_]] = ""
            names_en[index_of[uid_]] = ""
    # **水域优先**：impassable_mountains 里有些其实是海（跟 sea_zones 重叠），
    # 不扣掉的话会被当成陆地染成棕色 —— 实际该是"不可通行的海"。
    if "#impassable" in cat:
        water = cat.get("#sea", set()) | cat.get("#lake", set())
        overlap = cat["#impassable"] & water
        cat["#impassable"] -= water
        if overlap:
            log(f"  （{len(overlap)} 个既在 impassable 又在 sea/lakes，按水域处理）")
    # 自己建三个伪头衔（build_special_titles 按 blank 过滤，我们这批是"已知锁定"，
    # 不走那条路）：节点排在真实节点之后，前端按序号判锁。
    locked = [("#sea", "海洋", (30, 54, 82)),
              ("#lake", "湖泊", (58, 104, 138)),
              ("#impassable", "不可通行", (94, 94, 94))]
    added = 0
    waste_tids: list[int] = []       # 荒地节点（细层每块一个 + 粗层那个伪头衔）
    waste_pids: list[int] = []
    #: 哪些伪头衔是**水**（算边长时不算）—— 荒地那些要算（无主地、荒地之间的边都是"地"）
    water_tids: set[int] = set()
    for key, label, rgb in locked:
        ids_l = sorted(cat.get(key, ()))
        if not ids_l:
            continue
        idx = len(keys)
        keys.append(key)
        names.append(label)
        names_en.append(label)
        # 层级号给"超出所有层"：地名层按这个跳过它们，于是海/不可通行不出地名
        # （其余几套的伪头衔也是这么排的）
        level[key] = len(TIER_ORDER)
        colors = np.vstack([colors, np.array([rgb], dtype=np.uint8)])
        area = np.concatenate([area, np.zeros(1, dtype=np.int64)])
        block_area = np.concatenate([block_area, np.zeros(1, dtype=np.int64)])
        lx = np.concatenate([lx, np.full(1, np.nan, dtype=np.float32)])
        ly = np.concatenate([ly, np.full(1, np.nan, dtype=np.float32)])
        if key == "#impassable":
            # **最细那层不盖** ✗ —— 不可通行的地块本来就在层级树里有自己的节点和
            # 名字（约顿海姆、哈当厄尔高原…）。整片盖住的话，1818 块荒地共用一个
            # 颜色，想给其中一块单独上色根本做不到。留着它们，细层就能一块一色。
            fine_row = len(TIER_ORDER) - 1
            rows = np.array([r for r in range(len(TIER_ORDER)) if r != fine_row])
            titlemap[np.ix_(rows, np.array(ids_l, dtype=np.int64))] = idx
            waste_tids.append(idx)                       # 粗层那个灰节点
            waste_pids.extend(ids_l)
            for pid_l in ids_l:
                nm_l = loc_id_to_name.get(pid_l)
                if nm_l and nm_l in index_of:
                    waste_tids.append(index_of[nm_l])    # 细层用它自己的节点
        else:
            titlemap[:, np.array(ids_l)] = idx           # 海/湖：照旧六层都在场
            # 海/湖自己的名字不出现在图上
            for pid_l in ids_l:
                nm_l = loc_id_to_name.get(pid_l)
                if nm_l and nm_l in index_of:
                    names[index_of[nm_l]] = ""
                    names_en[index_of[nm_l]] = ""
        if key in ("#sea", "#lake"):
            water_tids.add(idx)
        added += 1
        log(f"  锁住 {key}（{label}）：{len(ids_l)} 个地块 → 节点 {idx}")
    n_nodes += added

    # ---- 9c. 荒地自动上色：按"跟周边国家接壤的边长占比" ----
    # 边长用**边界像素对**数（四邻）来量，比"挨着几个省"准得多：
    # 一块荒漠旁边或许挨着三个省，但其中 80% 的边属于同一个国家 —— 那就该是那一国。
    waste_auto: list[list[int]] = []
    if waste_pids:
        n_pid = int(ids.max()) + 1
        wmask = np.zeros(n_pid, dtype=bool)
        wmask[np.array(sorted(set(waste_pids)), dtype=np.int64)] = True
        pair_cnt: dict[int, int] = {}
        for axis in (0, 1):
            a = ids[:-1, :] if axis == 0 else ids[:, :-1]
            b = ids[1:, :] if axis == 0 else ids[:, 1:]
            aw = wmask[a]
            bw = wmask[b]
            m = aw != bw                       # 一边是荒地、一边不是
            if not m.any():
                continue
            pa = a[m].astype(np.int64)
            pb = b[m].astype(np.int64)
            awm = aw[m]
            wp = np.where(awm, pa, pb)         # 规范成 (荒地, 邻居)
            nb = np.where(awm, pb, pa)
            key = (wp << 16) | nb
            uk, uc = np.unique(key, return_counts=True)
            for k_, c_ in zip(uk.tolist(), uc.tolist()):
                pair_cnt[k_] = pair_cnt.get(k_, 0) + c_
        per_waste: dict[int, dict[int, int]] = {}
        edge_tot: dict[int, int] = {}          # 这块荒地的**整条陆地周长**
        for k_, c_ in pair_cnt.items():
            wp, nb = k_ >> 16, k_ & 0xFFFF
            t_nb = int(titlemap[0, nb])
            if t_nb in water_tids:             # 水不算边长
                continue
            edge_tot[wp] = edge_tot.get(wp, 0) + c_
            if t_nb >= n_real_titles:          # 无主地/别的荒地：算进分母，但不是"某个国家"
                continue
            d = per_waste.setdefault(wp, {})
            d[t_nb] = d.get(t_nb, 0) + c_
        for wp, per in per_waste.items():
            tot = edge_tot.get(wp, 0)          # ← 分母是整条周长，不再只是"有主的那部分"
            if not tot:
                continue
            best_cty, best_n = max(per.items(), key=lambda kv: kv[1])
            if best_n * 2 > tot:               # **严格过半**才算
                waste_auto.append([int(wp), int(best_cty)])
        log(f"  荒地自动上色：{len(waste_auto)}/{len(waste_pids)} 块有主（边缘过半）")

    # ---- 分块（全像素渲染用）----
    # 16384×8192 一张纹理正好顶到 MAX_TEXTURE_SIZE、还要 268MB 显存 ✗，
    # 所以原尺寸走"切成 4×4 张 4096×2048"这条路（半尺寸那套不受影响）。
    TILE_W, TILE_H = 4096, 2048
    # **只有一张纹理真装不下才分块** ✗ —— 原来写的是 `w > TILE_W`，
    # 而半尺寸是 8192×4096，照样满足，于是半尺寸那份数据也被切了块、
    # 前端就走进"占位数组"那条路（悬停/导出/测试全乱）。
    # 8192×4096 单张纹理装得下（常见上限 16384），16384×8192 才需要切。
    if w > 8192 or h > 8192:
        import json as _json
        tdir = DATA / "tiles"
        tdir.mkdir(exist_ok=True)
        cols = (w + TILE_W - 1) // TILE_W
        rows = (h + TILE_H - 1) // TILE_H
        manifest = {"tileW": TILE_W, "tileH": TILE_H, "cols": cols, "rows": rows,
                    "mapW": w, "mapH": h, "files": []}
        for r in range(rows):
            for c in range(cols):
                y0, x0 = r * TILE_H, c * TILE_W
                sub = ids[y0:y0 + TILE_H, x0:x0 + TILE_W]
                raw = sub.astype("<u2").tobytes()
                name = f"t_{r}_{c}.bin"
                (tdir / name).write_bytes(zlib.compress(raw, 6))
                manifest["files"].append({"r": r, "c": c, "name": name,
                                          "w": int(sub.shape[1]), "h": int(sub.shape[0])})
        (DATA / "tiles.json").write_text(_json.dumps(manifest), encoding="utf-8")
        log(f"  分块 {cols}×{rows} 张（每张 {TILE_W}×{TILE_H}）→ tiles/ + tiles.json")

    # 整条管线把 id/节点号写进 uint16（R16UI 纹理、titlemap、tiles、邻接表）——
    # 超过 65535 会**静默回绕**，前端的 id 全部错乱。EU5 是 16384×8192 的大图，
    # 碎色一多就有真实风险，写盘前加一道护栏。
    if n_prov > 65535 or n_nodes > 65535:
        raise SystemExit(f"!! 省份数 {n_prov} / 节点数 {n_nodes} 超过 uint16 上限 65535："
                         "先加大降采样 scale 减少碎色，或把载体换成 uint32")

    log("写出缓存 …")
    raw = titlemap.astype("<u2").tobytes()
    packed = zlib.compress(raw, 9)
    (DATA / "titlemap.bin").write_bytes(packed)
    log(f"  titlemap.bin  {len(raw)/1024:.0f} KB → {len(packed)/1024:.0f} KB")

    # hide_label 是按当时的 names 定长的，后面追加的伪头衔没跟着长 —— 写盘前补齐
    if len(hide_label) < len(names):
        hide_label += [False] * (len(names) - len(hide_label))

    payload = {
        "keys": [plain(k) for k in keys], "names": names, "namesEn": names_en,
        "locKeys": [plain(k) for k in keys],
        "tiers": [(ERA_ROW if k.startswith("1337_") else
                    (len(TIER_ORDER) if k in ("#sea", "#lake", "#impassable", "#u")
                     or str(k).startswith("#u") else tree_row(level.get(k, 5))))
                   for k in keys],
        "parents": [index_of.get(parent.get(k) or "", -1) if parent.get(k) else -1
                    for k in keys],
        "colors": colors.tolist(),
        "provCount": np.bincount(titlemap[len(TIER_ORDER) - 1][titlemap[len(TIER_ORDER) - 1] != NO_TITLE].astype(np.int64),
                                 minlength=n_nodes)[:n_nodes].tolist(),
        "area": area.tolist(),
        "hideLabel": hide_label,
        "blockArea": block_area.tolist(),
        "lx": [None if np.isnan(v) else round(float(v), 1) for v in lx],
        "ly": [None if np.isnan(v) else round(float(v), 1) for v in ly],
        "gx": [None if np.isnan(v) else round(float(v), 1) for v in lx],
        "gy": [None if np.isnan(v) else round(float(v), 1) for v in ly],   # 原来错写成 lx，y 坐标全是 x 的
    }
    (DATA / "titles.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"  titles.json   {(DATA / 'titles.json').stat().st_size/1024/1024:.1f} MB")

    pid_raw = ids.astype("<u2").tobytes()
    (DATA / "provinces_id.bin").write_bytes(zlib.compress(pid_raw, 6))
    (DATA / "adjacency.bin").write_bytes(zlib.compress(adj, 6))
    pos = np.stack([pcx, pcy, counts.astype(np.float64)], axis=1).astype(np.float32)
    (DATA / "prov_pos.bin").write_bytes(zlib.compress(pos.tobytes(), 6))
    log(f"  provinces_id.bin {len(pid_raw)/1024/1024:.1f} MB（压缩后 "
        f"{(DATA / 'provinces_id.bin').stat().st_size/1024/1024:.1f} MB）")

    meta = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "game": "eu5", "label": args.label, "gameRoot": str(root),
        "provinceMap": "locations.png", "nameLang": "zh", "entity": "地点",
        "mapWidth": w, "mapHeight": h, "numProvinces": n_prov, "numTitles": n_nodes,
        "numRealTitles": n_real_titles, "tiers": list(TIER_ORDER),
        "tierNames": [TIER_NAME[t] for t in TIER_ORDER],
        "tierKeys": [TIER_KEY[t] for t in TIER_ORDER],
        # **全部 tag** 的名字 + 颜色（含当前年代没地盘的）—— 搜索/取色要用 ✓
        # 名字先放 tag：中文名由 patch_wasteland 从 titles.json 统一补 ✓
        # color = map_XXX（named）和直接写死 rgb/hsv（ccol）的国家都要收进来
        "countryTags": {tag: {"n": (zh.get(tag) or zh.get(str(tag).lower()) or zh.get(str(tag).upper())
                                    or en.get(tag) or en.get(str(tag).lower()) or tag),
                              "c": list(named[cmap[tag]] if cmap.get(tag) in named else ccol[tag])}
                        for tag in sorted(set(cmap) | set(ccol))
                        if cmap.get(tag) in named or tag in ccol},
        "defaultTier": len(TIER_ORDER) - 1, "labelZoom": [12, 30, 60, 120, 240],   # 1337 那层门槛要低于全图视角（8192 宽的图约 16%）
        "eraDates": ["1337.4.1"], "noTitle": NO_TITLE, "specialPrefix": "#",
        "colorLutWidth": 256, "lockedKinds": [],
        # 荒地（不可通行）：哪些节点算荒地（前端据此决定"荒漠涂色"关着时显示灰），
        # 以及每块荒地按接壤边长过半算出来的归属（[地块号, 国家节点号]）。
        "wasteland": sorted(set(waste_tids)),
        "wastelandAuto": waste_auto,
        "scaleDown": args.scale, "sourceSize": [im.width * args.scale, im.height * args.scale],
        "matchRate": round(100.0 * float(hit[inverse].sum()) / ids.size, 2),
    }
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                    encoding="utf-8")
    log("全部完成 ✔")

    # 荒地的事后加工（幂等）：每层都指向它自己 / 周长表 / 按层归属 / 名字 / 隐藏地名
    from patch_wasteland import patch as _patch_waste
    _patch_waste(DATA)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
