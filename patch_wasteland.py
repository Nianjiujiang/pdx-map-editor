# -*- coding: utf-8 -*-
"""荒地的全部"事后加工"，收成一个**幂等**的脚本 —— 放在这里，别再一次次手打补丁。

对一份缓存目录（data/、data_eu4/、data_eu5/、data_eu4_hd/、data_miller/…）：

  ① 每一层都指向**那块荒地自己的节点**（不再让共享灰节点当粗层替身）
  ② 补名字：CK3 → 类别名（不可通行山地）；EU4 → 汉化 mod 里的中文名；
     EU5 → **一个字都不动**（它本来就是真名，约顿海姆那种）
  ③ 荒地地名一律不显示（hideLabel）
  ④ meta.numTitles 跟 keys 对齐（免得上一次那种"颜色表装不下新节点"的坑）
  ⑤ 烘 waste_perimeter：每块荒地 → [[邻居地块号, 共享边像素数], …]
     含别的荒地 ✓ 含无主地 ✓，水不算；同一块地的内部像素不算邻居
  ⑥ 烘 waste_by_tier：按层级各算一份"接壤边长过半"的归属

模式**按数据自己的形状认**（不靠调用方传对参数）：CK3 有 deJureYear、
EU4 有 provinceColors、EU5 有 eraDates —— 认错了会把名字灌串（省份号会撞）。

跑法：
    python patch_wasteland.py                 # 默认那几套全跑
    python patch_wasteland.py data_eu4 ...    # 只跑指定的
构建器收尾也会自动调它（build_data.py / build_eu4.py / build_eu5.py）。
"""
from __future__ import annotations

import json
import sys
import zlib
from pathlib import Path

import numpy as np

import re
WATER = ("#river", "#lake", "#sea", "#impassable_sea")
#: 这些地块**不参与自动填色**（巨型荒地，涂上去太糊）—— 手涂不受影响
AUTO_SKIP_PIDS = (1466, 1464, 731, 13270)

#: 定点改名：{（数据目录名, tag）: 新名字} ✓
NAME_OVERRIDES = {
    ("data_vic3", "CHI"): "大清",   # V3 的中国 → 大清 ✓
    ("data_eu5", "CHI"): "大元",    # EU5 的中华 → 大元 ✓
    ("data_eu5_full", "CHI"): "大元",   # 原尺寸那张也得改，不然两张图一个「中华」一个「大元」✗
}
DEFAULT_DIRS = ("data", "data_miller", "data_eu4", "data_eu4_hd", "data_vic3",
                "data_eu5", "data_eu5_full")
_ZH_CACHE: dict[str, str] | None = None


def eu4_zh_names() -> dict[str, str]:
    """合并汉化 mod 的**所有**本地化文件（key→中文）。

    extract_eu4_zh.py 抽的那份是按"游戏自己命名过的省份"过滤过的 ✗ ——
    荒地全被滤掉，所以直接读 mod，别用那份缓存。
    """
    global _ZH_CACHE
    if _ZH_CACHE is not None:
        return _ZH_CACHE
    merged: dict[str, str] = {}
    ws = Path(r"C:\Steam\steamapps\workshop\content\236850")
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from parsers.eu4 import hanhua  # noqa: PLC0415
    except Exception:            # noqa: BLE001
        _ZH_CACHE = merged
        return merged
    if ws.is_dir():
        for mod in sorted(ws.iterdir()):
            loc = mod / "localisation"
            if not loc.is_dir():
                continue
            for f in sorted(loc.glob("*.yml")):
                try:
                    merged.update(hanhua.load_file(f))
                except Exception:            # noqa: BLE001
                    continue
    _ZH_CACHE = merged
    return merged



def split_blobs(D: Path, M: dict, T: dict, ids: "np.ndarray", tm: "np.ndarray",
                wl: set, own: dict, quiet: bool = False,
                cell: int = 16, min_px: int = 5000, min_frac: float = 0.03,
                min_gap: int = 128) -> tuple | int:
    """把"一个省份号画在好几处"的荒地拆开。返回 (拆了几处, 新 titlemap, 新 id 图) 或 0。

    用**粗网格 + 8 连通**聚类。为什么不用细粒度连通：荒地在地图上常是网点/斜纹画法，
    16×16 一格才能把"看起来的一片"连起来 —— 实测 CK3 的 pid 1466 正好两片：
    西伯利亚 (7112,411) 与中非 (2427,4342)，细粒度则会散成近两千片 ✗。

    只拆**又大又远**的片（≥ max(5000 像素, 该省份的 3%) 且与保留的片相距 ≥128 像素），
    碎渣留在原省份里 —— 否则 16 位号段会被微省份塞爆（第一版就这么炸的 ✗）。

    只有**荒地**才拆：普通省份（岛屿之类）在游戏里本来就是一个省，动不得。
    """
    from collections import deque

    say = (lambda *a: None) if quiet else (lambda *a: print(*a))
    H, W = ids.shape
    n = M["numProvinces"]
    pids = sorted(own)
    if not pids:
        return 0
    nxt = n
    new_nodes: list[tuple[int, int, int]] = []     # (新省份号, 源省份号, 源节点)
    MAX_NEW = 400
    for pid in pids:
        if nxt >= 60000 or len(new_nodes) >= MAX_NEW:
            break
        m = (ids == pid)
        if not m.any():
            continue
        ys, xs = np.nonzero(m)
        y0, y1 = int(ys.min()), int(ys.max()) + 1
        x0, x1 = int(xs.min()), int(xs.max()) + 1
        sub = m[y0:y1, x0:x1]
        total = int(sub.sum())
        if total < min_px:
            continue
        ph = (sub.shape[0] + cell - 1) // cell
        pw = (sub.shape[1] + cell - 1) // cell
        pad = np.zeros((ph * cell, pw * cell), dtype=bool)
        pad[:sub.shape[0], :sub.shape[1]] = sub
        grid = pad.reshape(ph, cell, pw, cell).any(axis=(1, 3))
        seen = np.zeros_like(grid)
        areas: list[list[tuple[int, int]]] = []
        for gy in range(ph):
            for gx in range(pw):
                if not grid[gy, gx] or seen[gy, gx]:
                    continue
                q = deque([(gy, gx)])
                seen[gy, gx] = True
                cells = []
                while q:
                    cy, cx = q.popleft()
                    cells.append((cy, cx))
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            ny, nx = cy + dy, cx + dx
                            if 0 <= ny < ph and 0 <= nx < pw and grid[ny, nx] \
                                    and not seen[ny, nx]:
                                seen[ny, nx] = True
                                q.append((ny, nx))
                areas.append(cells)
        if len(areas) <= 1:
            continue
        areas.sort(key=len, reverse=True)

        def box(cells):
            cy = [c[0] for c in cells]
            cx = [c[1] for c in cells]
            return (min(cx) * cell, min(cy) * cell, (max(cx) + 1) * cell, (max(cy) + 1) * cell)

        kept_boxes = [box(areas[0])]
        for cells in areas[1:]:
            approx = len(cells) * cell * cell
            if approx < max(min_px, total * min_frac):
                continue                              # 碎渣：留在原省份里
            bx0, by0, bx1, by1 = box(cells)
            far = all(bx1 + min_gap < kx0 or kx1 + min_gap < bx0
                      or by1 + min_gap < ky0 or ky1 + min_gap < by0
                      for (kx0, ky0, kx1, ky1) in kept_boxes)
            if not far:
                continue
            cm = np.zeros_like(grid)
            for (cy, cx) in cells:
                cm[cy, cx] = True
            pm = np.repeat(np.repeat(cm, cell, 0), cell, 1)[:sub.shape[0], :sub.shape[1]] & sub
            ids[y0:y1, x0:x1][pm] = nxt
            new_nodes.append((nxt, pid, own[pid]))   # 省份数组要按**源省份号**继承，节点号留给节点数组
            kept_boxes.append((bx0, by0, bx1, by1))
            nxt += 1
        say(f"    pid {pid}: {len(areas)} 片，拆出 {len(new_nodes)} 处（总 {total} 像素）")

    if not new_nodes:
        return 0

    # titlemap 补上新省份的列（每一层都指向它自己的新节点）
    base = len(T["keys"])
    new_tm = np.zeros((tm.shape[0], nxt), dtype=tm.dtype)
    new_tm[:, :n] = tm
    for i2, (pid, _src_pid, src) in enumerate(new_nodes):
        node = base + i2
        new_tm[:, pid] = node
        ys, xs = np.nonzero(ids == pid)
        area = int(ys.size)
        T["keys"].append(f"wl_{pid}")
        T["tiers"].append(T["tiers"][src])
        T["parents"].append(-1)
        T["names"].append(T["names"][src])
        if T.get("namesEn"):
            T["namesEn"].append(T["namesEn"][src])
        T["colors"].append(list(T["colors"][src]))
        T["provCount"].append(1)
        for key_name, val in (("area", area), ("blockArea", area),
                              ("lx", round(float(xs.mean()), 1) if area else None),
                              ("ly", round(float(ys.mean()), 1) if area else None),
                              ("gx", round(float(xs.mean()), 1) if area else None),
                              ("gy", round(float(ys.mean()), 1) if area else None)):
            if key_name in T and isinstance(T[key_name], list):
                T[key_name].append(val)
        if T.get("hideLabel"):
            T["hideLabel"].append(True)
        wl.add(node)

    # 按省份的数组要跟着长长（名字/原版颜色之类）
    for key_name, lst in list(T.items()):
        if not isinstance(lst, list) or len(lst) != n:
            continue
        for _new_pid, src_pid, _src in new_nodes:
            # 按省份索引的数组得用**源省份号**取值 —— 源节点号是另一个命名空间，
            # 拿它当省份下标会继承到"编号恰好等于那个节点号的另一个省份"的
            # 颜色/名字，还随 titles.json 一起落盘（拆分一真发生就是数据污染）
            val = lst[src_pid] if 0 <= src_pid < len(lst) else ""
            lst.append(list(val) if isinstance(val, list) else val)
    M["numProvinces"] = nxt
    M["numTitles"] = len(T["keys"])
    M["wasteland"] = sorted(wl)
    M["_split"] = int(M.get("_split", 0)) + len(new_nodes)
    # 注意：这里要登记成**新节点**（base + i），否则后面"每层指向自己"会把新省份指回老节点 ✗
    own.update({pid: base + i for i, (pid, _sp, _src) in enumerate(new_nodes)})
    say(f"    一共拆开 {len(new_nodes)} 处（原来一个省份号画在好几处）")
    return len(new_nodes), new_tm, ids

def _detect(M: dict, T: dict) -> str:
    """**先认清 EU4/EU5，最后才轮到 CK3** —— specialPrefix 这类字段 EU4/EU5 也有，
    放在最前面会把它们误认成 CK3，然后拿"不可通行"去刷掉它们的真名 ✗。"""
    if "provinceColors" in T:          # EU4 独有：省份原版颜色
        return "eu4"
    if "eraDates" in M:                # EU5 独有：剧本年份
        return "eu5"
    if "deJureYear" in M or "specialPrefix" in M:
        return "ck3"
    return "other"


def patch(data_dir: Path | str, quiet: bool = False) -> dict:
    """把一份缓存加工好（幂等，可重复跑）。"""
    D = Path(data_dir)
    say = (lambda *a: None) if quiet else (lambda *a: print(*a))
    meta_p, tit_p = D / "meta.json", D / "titles.json"
    tm_p, id_p = D / "titlemap.bin", D / "provinces_id.bin"
    if not meta_p.is_file():
        say(f"  {D}: 没有 meta.json，跳过")
        return {"dir": str(D), "skipped": "no-meta"}
    M = json.loads(meta_p.read_text(encoding="utf-8"))
    T = json.loads(tit_p.read_text(encoding="utf-8"))
    renamed = False      # 定点改名动过内存没有（下面那条 early return 要用）
    # **定点改名**（按"数据目录 + tag"）—— 国家节点与 tag 表一起改 ✓
    # 放最前面：V3 没有荒地，后面会 early return，放后面就白写 ✗
    # 只认 `<年份>_<tag>` 这种 key，别碰 STATE_CHUGOKU（日本的中国地方也叫中国 ✗）
    for (_gd, _tag), _nm in NAME_OVERRIDES.items():
        if _gd != D.name:
            continue
        for _i2, _k2 in enumerate(T.get("keys") or []):
            if re.fullmatch(r"\d{3,4}_" + _tag, str(_k2)):
                T["names"][_i2] = _nm
        for _holder in (M, T):
            _ct = _holder.get("countryTags")
            if isinstance(_ct, dict) and _tag in _ct and isinstance(_ct[_tag], dict):
                _ct[_tag]["n"] = _nm
        renamed = True
        say(f"    定点改名：{_tag} → {_nm}")
    n, rows = M["numProvinces"], len(M["tiers"])
    wl = set(M.get("wasteland") or [])
    if not wl:
        say(f"  {D}: 没有荒地，跳过")
        # 改名只落在内存里，这里 return 之前必须自己写盘 ——
        # 落盘在函数末尾，这条 early return 会把它整个吞掉（V3 / EU5 正是这条路 ✗）
        if renamed:
            tit_p.write_text(json.dumps(T, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            meta_p.write_text(json.dumps(M, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"dir": str(D), "skipped": "no-wasteland"}
    mode = _detect(M, T)
    tm = np.frombuffer(zlib.decompress(tm_p.read_bytes()), dtype="<u2").reshape(rows, n).copy()
    # **要 .copy()** —— frombuffer 出来的是只读数组，拆分时要往里写 ✗
    ids = np.frombuffer(zlib.decompress(id_p.read_bytes()),
                        dtype="<u2").reshape(M["mapHeight"], M["mapWidth"]).copy()
    keys = T["keys"]
    key_index = {k: i for i, k in enumerate(keys)}
    water = {i for i, k in enumerate(keys) if k in WATER}
    fine = rows - 1

    own: dict[int, int] = {}
    for pid in range(1, n):
        t = int(tm[fine, pid])
        if t in wl:
            own[pid] = t
    # **优先认 key 正好是 wl_<省份号> 的那个节点**：那是这块荒地"自己的"节点。
    # 已经拆坏过的数据（新省份的列被指回了老节点）靠这一步自愈 ✓。
    for pid in list(own):
        k2 = f"wl_{pid}"
        if k2 in key_index:
            own[pid] = key_index[k2]
    if not own:
        say(f"  {D}: 还没有逐块荒地节点（先跑构建器），跳过")
        return {"dir": str(D), "skipped": "no-own-nodes"}

    # 0) 先把"一个省份号画在好几处"的荒地拆开（西伯利亚/中非那种）
    split_n = 0
    res = split_blobs(D, M, T, ids, tm, wl, own, quiet=quiet)
    if res:
        split_n, tm, ids = res
        n = M["numProvinces"]
        keys = T["keys"]
        water = {i for i, k in enumerate(keys) if k in WATER}

    # ① 每一层都指向它自己
    moved = 0
    for pid, idx in own.items():
        if not np.all(tm[:, pid] == idx):
            tm[:, pid] = idx
            moved += 1

    # ② 名字（按模式分开，绝不串台）
    named = 0
    idxs = sorted(set(own.values()))
    if mode == "ck3":
        base, base_en = "不可通行", "Impassable"
        for i, k in enumerate(keys):
            if k.startswith("#") and i in wl:
                base = T["names"][i] or base
                if T.get("namesEn"):
                    base_en = T["namesEn"][i] or base_en
                break
        for idx in idxs:
            if T["names"][idx] != base:
                T["names"][idx] = base
                named += 1
            if T.get("namesEn") and T["namesEn"][idx] != base_en:
                T["namesEn"][idx] = base_en
    elif mode == "eu4":
        zh = eu4_zh_names()
        for pid, idx in own.items():
            nm = zh.get(f"PROV{pid}")
            if not nm:
                pn = T.get("provinceNames") or []
                nm = pn[pid] if 0 <= pid < len(pn) else ""
            if nm and T["names"][idx] != nm:
                T["names"][idx] = nm
                named += 1
    # eu5 / other：名字是真名，一个字都不动 ✓

    # ③ 荒地地名不显示
    need = len(keys)
    if not T.get("hideLabel") or len(T["hideLabel"]) < need:
        arr = [bool(x) for x in (T.get("hideLabel") or [])]
        arr += [False] * (need - len(arr))
        T["hideLabel"] = arr
    for idx in idxs:
        T["hideLabel"][idx] = True

    # ④ numTitles 对齐
    M["numTitles"] = need
    if M.get("numRealTitles", 0) > need:
        M["numRealTitles"] = need

    # ⑤ 周长表
    pids = np.array(sorted(own), dtype=np.int64)
    is_waste = np.zeros(n, dtype=bool)
    is_waste[pids] = True
    wmask = np.zeros(int(ids.max()) + 1, dtype=bool)
    wmask[pids] = True
    adj: dict[int, dict[int, int]] = {}
    for axis in (0, 1):
        a = ids[:-1, :] if axis == 0 else ids[:, :-1]
        b = ids[1:, :] if axis == 0 else ids[:, 1:]
        m = wmask[a] | wmask[b]
        if not m.any():
            continue
        pa, pb = a[m].astype(np.int64), b[m].astype(np.int64)
        keep = pa != pb                      # 同一块地的内部像素不算接壤
        if not keep.any():
            continue
        pa, pb = pa[keep], pb[keep]
        lo, hi = np.minimum(pa, pb), np.maximum(pa, pb)
        uk, uc = np.unique((lo << 20) | hi, return_counts=True)
        for code, c in zip(uk.tolist(), uc.tolist()):
            x, y = code >> 20, code & 0xFFFFF
            if x < n and is_waste[x]:
                adj.setdefault(x, {})
                adj[x][y] = adj[x].get(y, 0) + c
            if y < n and is_waste[y]:
                adj.setdefault(y, {})
                adj[y][x] = adj[y].get(x, 0) + c
    per_out = []
    for pid in sorted(own):
        nb = [[int(k), int(c)] for k, c in (adj.get(pid) or {}).items()
              if not (k < n and int(tm[fine, k]) in water)]
        nb.sort(key=lambda x: -x[1])
        per_out.append([int(pid), nb])
    M["wastelandPerimeter"] = per_out

    # ⑥ 按层级各算一份（分母 = 完整陆地周长，含别的荒地/无主地）
    by_tier = []
    for r in range(rows):
        per: dict[int, dict[int, int]] = {}
        tot: dict[int, int] = {}
        for pid, nbrs in per_out:
            for k, c in nbrs:
                t_nb = int(tm[r, k])
                tot[pid] = tot.get(pid, 0) + c
                if t_nb >= M["numRealTitles"]:
                    continue
                per.setdefault(pid, {})
                per[pid][t_nb] = per[pid].get(t_nb, 0) + c
        row = []
        for pid, dd in per.items():
            t = tot.get(pid, 0)
            if t and max(dd.values()) * 2 > t:
                row.append([int(pid), int(max(dd.items(), key=lambda kv: kv[1])[0])])
        by_tier.append(row)
    M["wastelandAutoByTier"] = by_tier
    M["wastelandAuto"] = by_tier[0] if by_tier else []
    # 不参与自动填色的地块（只登记这份缓存里**确实是荒地**的那些）
    M["wasteAutoSkip"] = sorted(p for p in AUTO_SKIP_PIDS if p in own)
    # **全部 tag 的中文名**：构建器只给了 tag → 颜色，这里按键匹配把名字补上
    # （键形如 1444_SWE / 1936_XSM；同一个 tag 取第一个非空名字 ✓）

    ct = M.get("countryTags")
    if ct:
        names_by_tag: dict[str, str] = {}
        _names = T.get("names") or []
        for k, nm in zip(keys, _names):
            if "_" not in k or not nm or nm == k:
                continue
            prefix, tag = k.split("_", 1)
            if prefix.isdigit() and tag not in names_by_tag:
                names_by_tag[tag] = nm
        # 补不到名的：EU4 的国家键**就是 tag 本身**，直接在汉化词表里再试一次 ✓
        try:
            _zh = eu4_zh_names()
        except Exception:
            _zh = {}
        for tag in ct:
            if tag not in names_by_tag and tag in _zh:
                names_by_tag[tag] = _zh[tag]
        filled = 0
        for tag, e in ct.items():
            if isinstance(e, dict) and tag in names_by_tag and e.get("n") in (None, tag):
                e["n"] = names_by_tag[tag]
                filled += 1
        if filled:
            print(f"    全部 tag 的中文名补上 {filled} 个")

    if split_n:
        # 省份图变了（多了拆出来的省份），**必须落盘** ——
        # 不然下次再跑又会从旧的图里重新拆一遍，越拆越多 ✗
        id_p.write_bytes(zlib.compress(ids.astype("<u2").tobytes(), 6))
    man_p = D / "tiles.json"
    if man_p.is_file():                      # 分块那套（原尺寸 EU5）也要跟着重切
        # 注意：这一步**不能**挂在 `if split_n` 底下 ✗ ——
        # 万一上次就是这个循环崩的（province id 已经落盘、瓦片没切完），
        # 再跑一次 split_n 是 0，瓦片就永远修不回来了 ✗（今天真踩了这个坑）
        man = json.loads(man_p.read_text(encoding="utf-8"))
        tw, th = man["tileW"], man["tileH"]
        for ent in man["files"]:
            # files 里存的是 {"name": "t_0_0.bin", ...} 这种字典，
            # 以前直接把这个字典丢给 re.match → TypeError ✗（带瓦片的数据集一跑就崩）
            name = ent["name"] if isinstance(ent, dict) else str(ent)
            m2 = re.match(r"t_(\d+)_(\d+)\.bin$", name)
            if not m2:
                continue
            # **第一个数字是行、第二个是列** ✓（清单里 t_0_1 对应 r=0 c=1）——
            # 原来写成 `c, r = group(1), group(2)`，行列表反，切出来的瓦片整块错位 ✗
            # （对角线那两块碰巧一样，所以只看着"有点不对"，得逐块对才看得出来）
            r, c = int(m2.group(1)), int(m2.group(2))
            # 防呆：清单里自己就写着 r / c，跟文件名对不上就别猜了（宁可报错）
            if isinstance(ent, dict) and "r" in ent and "c" in ent:
                if (r, c) != (int(ent["r"]), int(ent["c"])):
                    raise SystemExit(f"!! 瓦片 {name} 的行列与清单不符："
                                     f"文件名 ({r},{c}) vs 清单 ({ent['r']},{ent['c']})")
            blk = ids[r * th:(r + 1) * th, c * tw:(c + 1) * tw]
            (D / "tiles" / name).write_bytes(
                zlib.compress(blk.astype("<u2").tobytes(), 6))
    if split_n:
        if (D / "adjacency.bin").is_file():
            try:
                from build_data import build_adjacency  # noqa: PLC0415
                (D / "adjacency.bin").write_bytes(
                    zlib.compress(build_adjacency(ids, M["numProvinces"]), 6))
            except Exception as exc:             # noqa: BLE001
                say(f"    （邻接表没重算：{type(exc).__name__}）")
        if (D / "prov_pos.bin").is_file():
            flat = ids.ravel().astype(np.int64)
            ys2, xs2 = np.mgrid[0:ids.shape[0], 0:ids.shape[1]]
            cnt2 = np.bincount(flat, minlength=M["numProvinces"])[:M["numProvinces"]]
            sx = np.bincount(flat, weights=xs2.ravel().astype(np.float64),
                             minlength=M["numProvinces"])[:M["numProvinces"]]
            sy = np.bincount(flat, weights=ys2.ravel().astype(np.float64),
                             minlength=M["numProvinces"])[:M["numProvinces"]]
            den = np.maximum(cnt2, 1)
            pos = np.stack([sx / den, sy / den, cnt2.astype(np.float64)],
                           axis=1).astype(np.float32)
            (D / "prov_pos.bin").write_bytes(zlib.compress(pos.tobytes(), 6))

    tit_p.write_text(json.dumps(T, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    meta_p.write_text(json.dumps(M, ensure_ascii=False, indent=2), encoding="utf-8")
    tm_p.write_bytes(zlib.compress(tm.astype("<u2").tobytes(), 6))
    nbr_tot = sum(len(x[1]) for x in per_out)
    say(f"  {D}: [{mode}] 荒地 {len(own)} 块 · 拆开 {split_n} · 调整层指向 {moved} · 改名 {named} · "
        f"周长邻居对 {nbr_tot} · 各层有主 {[len(x) for x in by_tier]}")
    return {"dir": str(D), "mode": mode, "waste": len(own), "moved": moved,
            "named": named, "perimeter": nbr_tot, "byTier": [len(x) for x in by_tier]}


def main(argv: list[str]) -> int:
    for d in (argv[1:] or list(DEFAULT_DIRS)):
        patch(d)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
