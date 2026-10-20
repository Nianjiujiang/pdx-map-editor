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
import base64
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
ERA_TIER = "1337"
ERA_ROW = 0
#: 层级树里的层级号 → 归属表行号。
#:
#: 树里是 continent0 → sub1 → region2 → area3 → province4 → location5 ✓
#:
#: 🔴🔴 **2026-10-19：大洲 / 次大陆接进来了** ✗✗（用户："加入大区和大洲"✓
#:   EU5 这边对应的是"大洲 / 次大陆"两层 ✓）
#:
#:   原来这两层**故意不要** ✗ —— 注释写的是"前端按序号超范围判为锁住"✓
#:   可它们是 EU5 真实存在的两层地理（continent / subcontinent ✓），
#:   白解析了一遍却不让看 ✓ 用户要的就是把它们放出来 ✓
#:   → 现在树层号**原样**当行号：cont0 → 行 0？不行，行 0 是 1337 ✗
#:     所以整体后移 1：cont → 1、sub → 2、reg → 3、area → 4、prov → 5、loc → 6 ✓
#:     （行 0 留给 1337 剧本层 ✓）
def tree_row(lv: int) -> int:
    return lv + 1
#: **1337 + 大洲 / 次大陆 / 区域 / 地区 / 省份 / 地点**（七层）
TIER_ORDER = (ERA_TIER, "cont", "sub", "reg", "area", "prov", "loc")
TIER_NAME = {"1337": "1337", "cont": "大洲", "sub": "次大陆", "reg": "区域",
             "area": "地区", "prov": "省份", "loc": "地点"}
TIER_KEY = {"1337": "国家", "cont": "大洲", "sub": "次大陆", "reg": "区域",
            "area": "地区", "prov": "省份", "loc": "地点"}


def _label_zoom() -> list[int]:
    """每层"标签从多大缩放开始出现"—— **按层数现生成** ✓（2026-10-19 加）

    剧本层统一 12：EU5 的地图很大（8192 宽的全图视角约 16% ✓
      1337 那层得**低于**全图视角才看得见国名 ✓ 12 够 ✓）
    地理层从 30 等差排到 240（大洲最粗、地点最细 ✓）

    ⚠ 以前这里是**写死的 5 个数** ✗ —— 加了大洲 / 次大陆之后是 8 层，
      前两层取不到值（undefined）→ 那层**一个标签都不画** ✓
    用户看不出"为什么大洲那层没名字"，只会觉得坏了 ✓ 所以按层数生成 ✓
    """
    out: list[int] = []
    # 剧本层有几个：`ERA_TIER`（1337）在 TIER_ORDER 里占几格就算几层 ✓
    #   ⚠ EU5 只有 1337 这一层 ✓ 以后要是学 EU4 加年份层，这里自动跟上 ✓
    n_era = sum(1 for t in TIER_ORDER if t == ERA_TIER)
    out += [12] * n_era
    rest = len(TIER_ORDER) - n_era
    if rest > 0:
        if rest == 1:
            out.append(120)
        else:
            out += [int(round(30 + (240 - 30) * (i / (rest - 1)))) for i in range(rest)]
    return out


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

    # 4. 归属表（七层：1337 + 大洲 / 次大陆 / 区域 / 地区 / 省份 / 地点）
    titlemap = np.full((len(TIER_ORDER), n_prov), NO_TITLE, dtype=np.uint16)
    # ⚠ 这里原来是 `for name, idx in loc_index.items(): ... titlemap[lv] = titlemap[lv]`
    #   一个**纯 noop 的循环**（自己赋值给自己 ✓ 注释也写着"太绕"✓）——
    #   真正的填表在下面那段 pid → location 反查里 ✓ 2026-10-19 删掉 ✓
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
            # ⚠ 判的是**行号**（`tree_row(lv)`），不是树层级号 ✗ ——
            #   树层号一直是 0~5，而行号是 0=1337 + 1..6=地理层 ✓
            #   （写 `lv < len(TIER_ORDER)` 会把大洲/次大陆整层跳过 —— 那正是改之前的样子 ✓）
            if lv is not None and cur in index_of:
                _row = tree_row(lv)
                if 0 <= _row < len(TIER_ORDER):
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
        c = largest_block_centre(m, offsets, neigh, counts, pcx, pcy, map_w=w)          # 跨接缝的块 x 走展开坐标 ✓（见函数说明 ✓）
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
    # 🔴🔴 **水的名字一律照常显示** ✗✗（2026-10-15 用户定的 ✓）
    #   用户原话："为什么你不给水域填名字啊……我是不是记得每个水域都有上层名字" ✓
    #     "原本游戏的文件的水域单位是**地点**而不是像素！" ✓ —— 他说得对 ✓
    #     （实取：水地块 5709 个、2 278 万像素（占全图 68% ✓）、
    #       南太平洋一块 170 万 px ✓、北太平洋 138 万 ✓ —— 是我把
    #       `titles.area`（=地块个数）念成像素了 ✗）
    #   以前这儿有**三道闸**，把水的名字全憋住了 ✗：
    #     ①「水域上级（下属地块全是水）隐藏名字」604 个 ——
    #        正是**南太平洋 / 北太平洋 / 印度洋**这些占满屏幕的大块 ✗
    #     ②「含岛屿的洋（大西洋系）只隐藏地名」1077 格 ✗ —— 同上 ✗
    #     ③「水名在任何层级都不显示」—— 连地点层逐块的名也清了 ✗
    #   三道**全撤** ✓ —— 水从此跟陆地一个待遇：
    #     · 地点层显示**这块水自己**的名字（南太平洋 / 楚科奇海 / 安塔拉角 ✓）
    #     · 粗层显示**它那一层祖先**的名字（波罗的海 / 北海 ✓ = 用户说的"上层名字" ✓）
    #   ⚠ 名字本来就在数据里（树节点自带、本地化齐 ✓）—— 这里**一个都不编** ✓
    #     位置 / 面积 / 可涂性 / 边界一个字节不动 ✓
    hide_label = [False] * len(names)
    # **水域优先**：impassable_mountains 里有些其实是海（跟 sea_zones 重叠），
    # 不扣掉的话会被当成陆地染成棕色 —— 实际该是"不可通行的海"。
    if "#impassable" in cat:
        water = cat.get("#sea", set()) | cat.get("#lake", set())
        overlap = cat["#impassable"] & water
        cat["#impassable"] -= water
        if overlap:
            log(f"  （{len(overlap)} 个既在 impassable 又在 sea/lakes，按水域处理）")

    # 🔴🔴 **水名表提前解析** ✗✗（2026-10-14 ✓ 为了让海/湖能**按海区**分片 ✓）
    #
    #   用户点破的基本思维（原话）：
    #     "province.bmp 里面那些小碎块是**省份级水域**，上面是地区级，
    #      再上面是战略级，每个水域不同的层级**按游戏内容给名字**，
    #      反正是**遵循陆地那样的思路**" ✓
    #   → 关键在"**每个水域**"✗ 不是"每一层"✓
    #     每一层里还得**按海区分成 N 片** ✓ 片名就是那个海区的名字 ✓
    #
    #   ⚠ 我第一版只做了"每层一个节点" ✗（`#sea_reg_0` 一片盖住全部 4791 个海格 ✓）
    #     → 整层的海共用一个名字 ✓ 那不是"按游戏内容给名字"✓
    #     实测就露馅了：回填只中了 8 个节点（5 层 × 海/湖 各一个 ✓）✓
    #
    #   ⚠ 原来这段在文件后半 ✗（`seaNamesByTier` 写完 meta 那儿 ✓）——
    #     那时节点早建完了 ✓ 名字只能"回填"✓ 而回填做不到"一片一个名"✗
    #     （一个节点只能有一个名字 ✓ 想按海区分就得**建的时候就分开** ✓）
    #   → 所以**挪到这儿** ✓ 后面那段改成复用它 ✓
    _sea_by_tier: dict[str, dict[int, str]] = {}
    try:
        _t0 = E.load_water_names_by_tier(root)
        _arr0 = E.sea_names_by_tier_array(_t0, TIER_ORDER)
        for _r0, _tn0 in enumerate(TIER_ORDER):
            if _r0 < len(_arr0) and _arr0[_r0]:
                _sea_by_tier[_tn0] = {int(k): str(v) for k, v in _arr0[_r0].items()}
        _WL_TBL = {int(k): str(v) for k, v in (_t0.get("wasteland") or {}).items()}
        _AREA_TBL = {int(k): str(v) for k, v in (_t0.get("area") or {}).items()}
        log(f"水名表（提前）：{[len(_sea_by_tier.get(t, {})) for t in TIER_ORDER]} · 荒地 {len(_WL_TBL)} 条")
    except Exception as _e0:
        _WL_TBL = {}
        _AREA_TBL = {}
        log(f"水名表（提前）解析跳过：{_e0}")
    # 🔴🔴 **水域不再是伪头衔** ✗✗（2026-10-14 ✓ 用户要求 ✓）
    #
    #   用户："你就不能把水域变成一个**仅仅是不能填色的地块**吗……
    #     最底层的单位也有自己的 Province id"✓
    #     "和陆地一样啊，**大名，河北，华北**，这样下来"（= 逐块 / 地区 / 大区 ✓）
    #     "只是水域**带一个小标签**来让他在**边界和颜色**等方面听从相关的开关，
    #      **其他逻辑不变**"
    #
    #   → 所以 `locked` 里**只剩 `#impassable`** ✓（海 / 湖两个**不再建节点** ✓）
    #     水域从此"所有层都无主"✓ 身份靠 `pid` + `meta.waterMask`（那个"小标签"✓）
    #     颜色走海域色 ✓ 边界听水域那两条开关 ✓ 高亮按 pid ✓ 别的全跟普通地块一样 ✓
    #
    #   ⚠ **`#impassable` 留着** ✗ —— 它是"不可通行**山地**"✓ 不是水 ✓
    #     而且它能"一块块涂色"✓（细层不盖、保留真节点 ✓ 见下面那个分支 ✓）
    #   ⚠⚠ **EU5 有真层级** ✗（`reg` / `area` / `prov` / `loc` ✓）——
    #     按用户"大名 / 河北 / 华北"那条口径，**粗层本该保留** ✓
    #     但这一刀先做到"**最细层回归逐块**"✓（那是关键 ✓）
    #     粗层怎么补见文件末尾 TODO ✓（`seaNamesByTier` 还在 ✓ 数据没丢 ✓）
    _water_all = np.zeros(int(n_prov), dtype=bool)
    for _wcat in ("#sea", "#lake"):
        for _wp in (cat.get(_wcat) or ()):
            _wpi = int(_wp)
            if 0 <= _wpi < _water_all.size:
                _water_all[_wpi] = True
    log(f"水域标签：{int(_water_all.sum())} 个地块"
        f"（不再是伪头衔 ✓ 身份靠 pid + waterMask ✓）")


    # 🔴🔴 **水陆混片拆分**（HOI4 口径——同名拆两片 ✓ 2026-10-15 用户要求 ✓）
    #
    #   用户原话："在 EU5 原版，有一些大区域同时包含了水体和陆地。但这个办法其实
    #     在 HOI4 已经解决过了……他们被分开成了两个同名区域，从而分开了水陆。" ✓
    #     （点名的 5023 英格兰 / 5452 美索美洲，在区域层就是"不列颠"/"美索美洲"
    #      底下的水陆 ✓）
    #   HOI4 那边怎么做的（见 `build_hoi4.py`）：海省**不在州里** ✓
    #     水片由 `build_special_titles` 按层单独造、**名字取那一层的区域名** ✓
    #     —— 于是岛屿和它周围那片海是**两个同名片** ✓ 这里照做 ✓
    #
    #   实测（数据核对）：EU5 的水格在区域/地区/省份三层**全指着陆地的树节点** ✗
    #     区域层 82 片里 74 片水陆混杂（行 2 = reg ✓）、地区层 237 片、省份层 466 片 ✓
    #   → 拆：水格指给**同名新片** ✓ 陆格原地不动（涂色 / 边界 / 名字一个字节不变 ✓）
    #
    #   ⚠⚠ **行号 = `TIER_ORDER` 的序号** ✗✗
    #     `TIER_ORDER = (ERA_TIER, "reg", "area", "prov", "loc")` = 5 行 ✓
    #     所以 **reg / area / prov = 行 1 / 2 / 3** ✓
    #     （上一版写成 2/3/4 ✗ → 拆的是 area/prov/loc：**区域层一片没动** ✗
    #       而 loc 层本来就逐块一片 ✓ 白拆 ✓）
    #   ⚠⚠ **海 / 湖 分开拆、分开上色** ✗✗
    #     一个树节点里海格湖格都有时拆**两片**：
    #       · 海 = `<键>_sea`  色 (32,57,92) ✓
    #       · 湖 = `<键>_lake` 色 (47,110,150) ✓
    #     （跟 EU4 / HOI4 / VIC3 / build_data 那套类色**同一组常量** ✓）
    #     上一版海湖**共用一个海蓝** ✗ → 用户："湖泊莫名其妙变成了海域的颜色"✗
    #   ⚠⚠ **新片必须带标签位置** ✗✗
    #     没有 lx/ly 的话 `LabelLayer` 压根不收（它要 lx/ly/area 三样 ✓）
    #     → 海面上一个名字都出不来 ✗ 用户报的"海域们失去了自己的名字"就是它 ✓
    #     → 用跟第 9 步**同一个算法**当场算（`largest_block_centre` = 最大连通块重心 ✓）
    #       成员只取**水格** ✓ 于是标正好落在水面上 ✓
    #   ⚠ 纯水片（北太平洋 / 巴哈马海域那种）**不拆** ✗ —— 它没有陆格、无从"分" ✓
    #     它们的名字是**故意清的**（见上面"水域上级隐藏名字"那段 ✓）别在这儿补 ✗
    _SEA_RGB = (32, 57, 92)                 # 海 ✓
    _LAKE_RGB = (47, 110, 150)              # 湖 ✓
    _WASTE_RGB = (94, 94, 94)               # 荒地（不可通行）✓
    _sea_pids = set(cat.get("#sea", ()) or ())
    _lake_pids = set(cat.get("#lake", ()) or ())
    _split_log: dict[str, int] = {}
    for _grow in (1, 2, 3):                 # reg / area / prov ✓
        _rowd = titlemap[_grow]
        _mem: dict[int, list[int]] = {}
        for _pp in np.nonzero(_rowd != NO_TITLE)[0]:
            _t = int(_rowd[_pp])
            if keys[_t].startswith("#"):
                continue                    # 伪头衔 / 无名色块不动 ✓
            _mem.setdefault(_t, []).append(int(_pp))
        for _t, _mps in _mem.items():
            _w_sea = [q for q in _mps if q in _sea_pids]
            _w_lake = [q for q in _mps if q in _lake_pids]
            if len(_w_sea) + len(_w_lake) == len(_mps):
                # 纯水片（北太平洋 / 波罗的海那种 ✓）**不拆** ✓ —— 没陆格可拆 ✓
                # 但**颜色要按类色**✗✗（原来是随手配的杂色 ✗ —— 用户报的
                # "海域、湖泊没有应有的上色"里粗层那半就是它 ✓）
                colors[_t] = _SEA_RGB if len(_w_sea) >= len(_w_lake) else _LAKE_RGB
                continue
            for _suf, _w, _rgb in (("_sea", _w_sea, _SEA_RGB),
                                   ("_lake", _w_lake, _LAKE_RGB)):
                if not _w:
                    continue                # 这一片没有这类水格 ✓
                _new_key = f"{keys[_t]}{_suf}"
                if _new_key in index_of:
                    continue                # 幂等 ✓
                _idx = len(keys)
                _ctr = largest_block_centre(_w, offsets, neigh, counts, pcx, pcy,
                                            map_w=w)      # 同上 ✓
                keys.append(_new_key)
                names.append(names[_t])     # **同名两片** ✓（HOI4 就是这样 ✓）
                names_en.append(names_en[_t])
                # ⚠「不打标签」也一起继承 ✗（"北大西洋诸岛"那种洋名原节点是憋住的 ✓
                #   新片不继承的话，那个标签会从水里冒出来 ✗）
                hide_label.append(bool(hide_label[_t]))
                level[_new_key] = level[keys[_t]]
                parent[_new_key] = parent.get(keys[_t])
                index_of[_new_key] = _idx
                ordered_keys.append(_new_key)
                colors = np.vstack([colors, np.array([_rgb], dtype=np.uint8)])
                _px = int(sum(int(counts[q]) for q in _w))
                area = np.concatenate([area, np.array([_px], dtype=np.int64)])
                block_area = np.concatenate(
                    [block_area, np.array([int(_ctr[2]) if _ctr else 0], dtype=np.int64)])
                lx = np.concatenate(
                    [lx, np.array([float(_ctr[0]) if _ctr else np.nan], dtype=np.float32)])
                ly = np.concatenate(
                    [ly, np.array([float(_ctr[1]) if _ctr else np.nan], dtype=np.float32)])
                _rowd[np.array(_w, dtype=np.int64)] = _idx
                _tag = ("区域" if _grow == 1 else "地区" if _grow == 2 else "省份") + _suf
                _split_log[_tag] = _split_log.get(_tag, 0) + 1
    n_nodes = len(keys)
    if _split_log:
        log("水陆混片拆分（HOI4 口径）："
            + " · ".join(f"{k} {v} 片" for k, v in sorted(_split_log.items())) + " ✓")


    # 自己建伪头衔（`build_special_titles` 按 blank 过滤，我们这批是"已知锁定"，
    # 不走那条路）：节点排在真实节点之后，前端按序号判锁。
    # 🔴 **只剩"不可通行"** ✗（海 / 湖 2026-10-14 起不建 ✓ 见上面那段说明 ✓）
    locked = [("#impassable", "不可通行", (94, 94, 94))]
    added = 0
    waste_tids: list[int] = []       # 荒地节点（细层每块一个 + 粗层那个伪头衔）
    waste_pids: list[int] = []
    #: 哪些伪头衔是**水**（算边长时不算）—— 荒地那些要算（无主地、荒地之间的边都是"地"）
    water_tids: set[int] = set()
    for key, label, rgb in locked:
        ids_l = sorted(cat.get(key, ()))
        if not ids_l:
            continue
        # 🔴🔴 **每层一片** ✗✗（2026-10-14 ✓ 跟 EU4 / HOI4 / VIC3 / CK3 对齐）
        #
        #   用户点破的基本思维（原话）：
        #     "province.bmp 里面那些小碎块是**省份级水域**，上面是地区级，
        #      再上面是战略级，每个水域不同的层级**按游戏内容给名字**，
        #      反正是**遵循陆地那样的思路**" ✓
        #   → 所以海 / 湖**每一层各有一片** ✓ 键名 `#sea_<层>_<序号>` ✓
        #     （原来这里是"整片一个节点"`titlemap[:, ids_l] = idx` ✗ ——
        #      所有层共用一个 `#sea` ✓ 于是换层时海域范围根本不变 ✓
        #      正是用户报的"地区/省份模式下都按战略地区"那个毛病 ✓）
        #
        #   ⚠ **`#impassable` 不在此列** ✗ —— 它保持原样（见下面那个分支 ✓）：
        #     它的地块**本来就在层级树里有自己的节点和名字** ✓ 细层不盖 ✓
        #     "每层一片"只对**海 / 湖**做 ✓（它们才是"数据里没有细层归属"的那种 ✓）
        #
        #   ⚠ 名字这一步**先给类名** ✗（"海洋" / "湖泊" ✓）——
        #     真名要等 `seaNamesByTier` 解析完（见文件后半 ✓）再回填 ✓
        #     回填之前前端会判成"类名 → 没名字"✓ 那是**安全**的 ✓
        #     反过来（先编个假名）会让"没有名字的片"顶着别人的名字出标 ✗
        _layers = TIER_ORDER if key != "#impassable" else [None]
        for _r, _tname in enumerate(_layers):
            idx = len(keys)
            keys.append(f"{key}_{_tname}_0" if _tname else key)
            names.append(label)
            names_en.append(label)
            # 层级号 = **这一层自己** ✓（原来给"超出所有层"✗ 那是"整片"的写法 ✓
            #   ⚠ 给超出值的话地名层会跳过它 ✓ 于是水域片既不出地名也不出片名 ✗）
            level[f"{key}_{_tname}_0" if _tname else key] = _r
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
                # 🔴 **按海区分组** ✗✗ —— 不是"每层一个节点"，是"每层 N 个" ✓
                #   分组的依据 = **这一层那一张水名表里的名字** ✓
                #     · 同一个名字的地块 = 同一个海区 → 一片 ✓
                #     · 表里没有的地块 → 全归"无名组"一片 ✓ 名字用类名 ✓
                #       （前端判"类名 = 没名字"→ 不出标 ✓ 正是"没有就是没有" ✓）
                #   ⚠ 顺序要**稳定** ✗ —— 按名字排序 ✓ 不然每次烤出来的序号都不一样 ✓
                #     （序号进了 `titlemap` 和 `keys` ✓ 变了就是"包每次都不一样" ✓）
                _tbl = _sea_by_tier.get(_tname) or {}
                _groups: dict[str, list[int]] = {}
                for _pid in ids_l:
                    _groups.setdefault(_tbl.get(_pid) or "", []).append(_pid)
                for _gi, (_nm, _pids) in enumerate(sorted(_groups.items())):
                    idx = len(keys)
                    keys.append(f"{key}_{_tname}_{_gi}")
                    names.append(_nm or label)
                    names_en.append(_nm or label)
                    level[f"{key}_{_tname}_{_gi}"] = _r
                    colors = np.vstack([colors, np.array([rgb], dtype=np.uint8)])
                    area = np.concatenate([area, np.zeros(1, dtype=np.int64)])
                    block_area = np.concatenate([block_area, np.zeros(1, dtype=np.int64)])
                    lx = np.concatenate([lx, np.full(1, np.nan, dtype=np.float32)])
                    ly = np.concatenate([ly, np.full(1, np.nan, dtype=np.float32)])
                    titlemap[_r, np.array(_pids, dtype=np.int64)] = idx
                    if key in ("#sea", "#lake"):
                        water_tids.add(idx)
                    added += 1
                log(f"  锁住 {key}（{label}）第 {_r} 层（{_tname}）："
                    f"{len(ids_l)} 个地块 → {len(_groups)} 片")
                # 海/湖自己的名字不出现在图上（照旧 ✓）
                for pid_l in ids_l:
                    nm_l = loc_id_to_name.get(pid_l)
                    if nm_l and nm_l in index_of:
                        names[index_of[nm_l]] = ""
                        names_en[index_of[nm_l]] = ""
                continue
            if key in ("#sea", "#lake"):
                water_tids.add(idx)
            added += 1
            log(f"  锁住 {key}（{label}）：{len(ids_l)} 个地块 → 节点 {idx}")
    n_nodes += added

    # 🔴🔴 **水 / 荒地的"应有的颜色"** ✗✗（2026-10-15 用户报的 ✓）
    #   用户："EU5 海域、湖泊、荒地没有应有的上色" ✓
    #   实况（实跑核对过）：
    #     · 地点层的水格拿的是**游戏地图色**（一格格亮青/亮蓝：(34,175,181) /
    #       (119,204,251) / (0,159,241) … ✓）
    #     · 地点层的荒地也是地图色（(238,220,6) 亮黄 / (136,60,151) 紫 /
    #       (68,127,56) 绿 … ✓）
    #   → 整张图看着就是"海没蓝、湖没湖蓝、荒地没灰" ✗
    #   别的游戏（EU4 / HOI4 / VIC3 / build_data ✓）这三类**一律类色** ✓ 这里补齐：
    #     海 = (32,57,92) ✓ 湖 = (47,110,150) ✓ 荒地 = (94,94,94) ✓（同一组常量 ✓）
    #   ⚠ 只动**颜色** ✗ —— 名字 / 归属 / 可涂性 / 边界一个字节不动 ✓
    #   ⚠ 只落**地点层**（`titlemap[_fine_row]` ✓）——
    #     粗层的纯水片在上面拆分段里已按类色刷过 ✓、粗层荒地本来就是 `#impassable` 灰 ✓
    _fine_row = len(TIER_ORDER) - 1
    _rgb_fixed = 0
    for _pool, _rgb in ((cat.get("#sea", ()) or (), _SEA_RGB),
                        (cat.get("#lake", ()) or (), _LAKE_RGB),
                        (waste_pids, _WASTE_RGB)):
        for _p in _pool:
            _t = int(titlemap[_fine_row, int(_p)])
            if 0 < _t < len(colors):
                if tuple(colors[_t]) != _rgb:
                    _rgb_fixed += 1
                colors[_t] = _rgb
    log(f"水域 / 荒地按类色上色：{_rgb_fixed} 个地点节点 "
        f"（海 32,57,92 · 湖 47,110,150 · 荒地 94,94,94 ✓）")


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
    # 🔴 **跨接缝标记（`wrapLabel`）已退役** ✗✗（2026-10-16 ✓ 用户定 ✓）
    #   那套是给"全体像素求几何中心 → 太平洋的名字落在地图正中"打的补丁 ✓
    #   现在前端按**连通域**取点（见 app.js 的 `buildPlaceComponents` ✓），
    #   而邻接表只连**图内 4 邻域**、没有跨左右边界的边 →
    #   跨 180° 经线的那片海**本来就是两块** ✓ 自然就左右各出一个名 ✓
    #   → 这里不再打标，`titles.json` 里也没有 `wrapLabel` 这一项了 ✓
    #     （旧数据里那枚布尔数组前端也不读了 ✗ 留着无害 ✓）

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
        # ⚠ **长度基准用 `len(keys)`** ✗✗ —— 别用 `n_nodes` ✓（2026-10-14 修 ✓）
        #   `provCount` 是"每个头衔有多少个地块"✓ 而 `np.bincount` 只统计
        #   **最细层（loc）出现过**的节点 ✗ —— 于是：
        #     · `#impassable`（建在最后 ✓ 恰好不在最细层 ✓）
        #     · 剧本层的 `#sea_1337_0` / `#lake_1337_0`
        #   这些**一个都不在里面** ✓ → 长度比 `n_nodes` 短 ✓
        #   → 包校验（`pack.js`）要求它跟 `numTitles` **等长** ✗ 不等长整个包导不进来 ✓
        #     （实跑：改"每层一片"之后短了 10 项 ✓ 41538 vs 41548 ✓
        #      正好是我新加的那些"只出现在某一层"的节点 ✓）
        #   ⚠ `n_nodes` 跟 `len(keys)` 在正常路径上应该相等 ✗ ——
        #     但 `n_nodes` 是个累加变量 ✓ 中间任何一步漏加就悄悄错位 ✓
        #     `len(keys)` 是**事实** ✓ 用事实当基准 ✓
        "provCount": np.bincount(titlemap[len(TIER_ORDER) - 1][titlemap[len(TIER_ORDER) - 1] != NO_TITLE].astype(np.int64),
                                 minlength=len(keys))[:len(keys)].tolist(),
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

    # 🔴🔴 **底层地块的"身份标"** ✗✗（2026-10-15 用户定 ✓）
    #   用户原话："你可以给不是这些玩意的普通陆地加上陆地标记，就像给他们加上海洋河流
    #     标记一样。这个标记统一加给所有底层 prov 的 id 设置，反正不管怎么切换也无法
    #     改变他们的身份" ✓
    #   → `meta.kindMask`：每地块 **1 字节**、base64（跟当年那个 `waterMask` 一个形状 ✓）
    #     1 陆地（**兜底** ✓ 不属于下面几类的全是它）/ 2 海洋 / 3 湖泊 / 4 河流 /
    #     5 不可通行海域 / 6 不可通行区域 ✓
    #   ⚠ **无归属区域不进这枚标** ✗（用户明确交代：无归属是**剧本 / 归属**决定的，
    #     不是地块身份 ✓ 它继续按运行时算 —— 见前端那行 `set-unpainted` ✓）
    #   ⚠ EU5 **没有河流 / 不可通行海域** ✗（`cat` 里就是空集 ✓）——
    #     空集就老实留空 ✓ 那两格全图落进"陆地" ✓ 不编假数据 ✓
    #   ⚠ 判据是构建期那几套现成类别集合（`cat` ✓），跟"水域优先"一条口径
    #     （`#impassable` 里跟水重叠的 47 格早就扣掉了 ✓ 它们按海/湖算 ✓）
    import base64 as _b64                                          # noqa: PLC0415
    from build_tier_pieces import kind_mask as _kind_mask          # noqa: PLC0415
    _kind_b64 = _kind_mask(n_prov, cat)
    _kind_n = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0}
    for _b in _b64.b64decode(_kind_b64):
        if int(_b) in _kind_n:
            _kind_n[int(_b)] += 1
    log("身份标 kindMask：" + " · ".join(f"{_k}={_kind_n[_k]}" for _k in sorted(_kind_n))
        + f"（1~6 合计 {sum(_kind_n.values())} = numProvinces-1 ✓）")

    meta = {
        "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
        "game": "eu5", "label": args.label, "gameRoot": str(root),
        # **底层地块身份标**（每地块 1 字节 base64 ✓ 见上面那段说明 ✓）
        "kindMask": _kind_b64,
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
        # 默认停在**省份**层 —— EU5 最细那层是「地点」，跟 EU4 / V3 的"省份"不是
        # 一个东西；写 `len(TIER_ORDER) - 1` 会默认落到「地点」，跟已发布的行为、
        # 以及 EU5 那条测试的期望都不一致 ✗
        "defaultTier": TIER_ORDER.index("prov"),
        # 🔴 **2026-10-19：按层数生成，不再写死 5 个** ✗✗
        #   原来是 `[12, 30, 60, 120, 240]` 五个数 —— 那是**6 层时代**（1337+reg/area/prov/loc）✓
        #   加了大洲/次大陆之后是 8 层 → 数组只有 6 个 → 前两层（大洲/次大陆）
        #   **取不到门槛**（undefined）→ 那层标签永远不出现 ✗
        #   （测试当场报"大洲 42px"✓ 逮住了 ✓）
        #   现在：剧本层统一 12（一进去就该看见国名 ✓）、地理层从 30 等差排到 240 ✓
        "labelZoom": _label_zoom(),
        "eraDates": ["1337.4.1"], "noTitle": NO_TITLE, "specialPrefix": "#",
        "colorLutWidth": 256, "lockedKinds": [],
        # 荒地（不可通行）：哪些节点算荒地（前端据此决定"荒漠涂色"关着时显示灰），
        # 以及每块荒地按接壤边长过半算出来的归属（[地块号, 国家节点号]）。
        "wasteland": sorted(set(waste_tids)),
        "scaleDown": args.scale, "sourceSize": [im.width * args.scale, im.height * args.scale],
        "matchRate": round(100.0 * float(hit[inverse].sum()) / ids.size, 2),
    }
    # **水域名**（2026-10-13 ✓ 出处见 docs/水域名调研.md、接口见 _local/water_names_api2.md）
    #   ⚠ **按视图层各一套** ✗（用户要求："EU4/5 在不同的视图下，海域包括的范围也不一样"✓）
    #     `seaNamesByTier` 的下标 = `meta["tiers"]` 的下标（reg/area/prov/loc ✓ 剧本层给 None）
    #   `seaNames` 仍然写 **area 层** ✓ —— 那是第一轮验过的口径（5709 条 ✓），
    #     留着当"没有 byTier 时的兜底"；写最粗的 reg 层会让老前端退回时名字突然变很粗 ✗
    #   **荒地名字**也一并收（用户要求："EU4 和 EU5 的荒地有自己的名字，你怎么还是隐藏了"✓）
    try:
        _t = E.load_water_names_by_tier(root)
        _arr = E.sea_names_by_tier_array(_t, meta["tiers"])
        if any(_arr):
            meta["seaNamesByTier"] = [
                ({str(k): str(v) for k, v in x.items()} if x else None) for x in _arr
            ]
        _area = _t.get("area") or {}
        if _area:
            meta["seaNames"] = {str(k): str(v) for k, v in _area.items()}
        _wl = _t.get("wasteland") or {}
        if _wl:
            meta["wastelandNames"] = {str(k): str(v) for k, v in _wl.items()}
        log(f"水域名：分层 {[len(x or {}) for x in _arr]} · 荒地 {len(_wl)} 条")
        # 🔴 **回填"每层一片"的真名** ✗✗（2026-10-14 ✓ 见上面 locked 循环里那段说明）
        #   上面建节点时名字先给了**类名**（"海洋" / "湖泊" ✓）——
        #   因为那时 `seaNamesByTier` 还没解析 ✓ 现在有了 ✓ 该回填了 ✓
        #
        #   一片的名字怎么定：**取这一层那一坨地块里第一个有名字的** ✓
        #     · 同一片（同一层同一节点 ✓）本来就是一个海区 ✓ 名字一致 ✓
        #     · 全都没名字 → **保持类名** ✗ 前端会判成"类名 = 没名字"→ 不出标 ✓
        #       这正是用户要的"**按游戏内容给名字**，没有就是没有" ✓
        #   ⚠ 只回填 `#sea_*` / `#lake_*` ✗ 别碰 `#impassable`（它有自己的真名 ✓）
        _back = 0
        for _r, _tname in enumerate(TIER_ORDER):
            _row = titlemap[_r]
            # ⚠ **按层名去 `meta["tiers"]` 里查下标** ✗✗ —— 别用 `_arr[_r]` 硬对 ✓
            #   我第一版就是 `_arr[_r]` ✗ → 回填只中了 8 个节点 ✓（该有几千个 ✓）
            #   根因：`TIER_ORDER` 是 **5 层**（1337/reg/area/prov/loc ✓）
            #     而 `meta["tiers"]` 是 **6 层**（中间多一个 blank ✓ 见 build_eu5 后面
            #     那个"加空白剧本层"的步骤 ✓）→ 差一格 → `_arr[1]` 拿到的是 blank 的 None ✓
            #   ⚠ `_arr` 的长度跟 `meta["tiers"]` 对齐 ✗ 不是跟 `TIER_ORDER` ✓
            _ti = meta["tiers"].index(_tname) if _tname in meta["tiers"] else -1
            _tbl = (_arr[_ti] if 0 <= _ti < len(_arr) else None) or {}
            if not _tbl:
                continue
            # 这一层用到的、属于"海 / 湖"的那些片节点
            _seen: dict[int, str] = {}
            for _pid, _nm in _tbl.items():
                _tid = int(_row[int(_pid)])
                if _tid <= 0 or _tid in _seen:
                    continue
                _k = str(keys[_tid])
                if not (_k.startswith("#sea_") or _k.startswith("#lake_")):
                    continue
                _seen[_tid] = str(_nm)
            for _tid, _nm in _seen.items():
                if _nm and names[_tid] != _nm:
                    names[_tid] = _nm
                    names_en[_tid] = _nm
                    _back += 1
        if _back:
            log(f"  水片真名回填：{_back} 个节点（每层一片 ✓ 没名字的保持类名 ✓）")
    except Exception as _e:
        log(f"水域名解析跳过：{_e}")
    (DATA / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2),
                                    encoding="utf-8")
    log("全部完成 ✔")

    # 荒地的事后加工（幂等）：每层都指向它自己 / 周长表 / 按层归属 / 名字 / 隐藏地名
    from patch_wasteland import patch as _patch_waste
    _patch_waste(DATA)
    # **荒地挪成伪头衔**（幂等）：EU5 的荒地序号混在真头衔里 ✗ ——
    #   app 里"伪头衔（>= numRealTitles）= 背景地形"那条假设在 EU5 上不成立，
    #   于是荒地轮廓被画成"本层那条线"的 50% ✗（用户报过 ✓）
    #   放在荒地加工**之后**（它已经把那几张表烘好了 ✓）、
    #   空白剧本**之前**（空白那一行照抄的是最终编号 ✓）
    from patch_waste_pseudo import patch as _patch_waste_pseudo
    _patch_waste_pseudo(DATA)
    # 再补一层**空白剧本**（幂等）：放在荒地之后 —— 它照抄的是"最终这版"的背景地形 ✓
    from patch_blank_era import patch as _patch_blank
    _patch_blank(DATA)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
