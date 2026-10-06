# -*- coding: utf-8 -*-
"""把**荒地节点挪到真头衔后面**，让它成为"伪头衔" —— 幂等，可重复跑。

跑法（项目根目录）：

    python patch_waste_pseudo.py                  # 默认：所有缓存（已经对的自动跳过）
    python patch_waste_pseudo.py data_eu5 data_eu5_full
    python patch_waste_pseudo.py --dry-run        # 只看会怎么挪，不写盘

为什么需要它
------------
app 的着色器里有一条根深蒂固的假设：**"伪头衔"（序号 >= numRealTitles）就是
海 / 湖 / 河 / 荒地 / 不可通行这些背景地形** ✓。CK3 / EU4 / EU4HD 的数据正好如此
（荒地整块排在真头衔后面 ✓）。

**EU5 不是** ✗：它的荒地是游戏里真实存在的 location（阿卜杜勒库里岛那种 ✓），
序号**散落在真头衔中间**（data_eu5：1819 个荒地里 1818 个 < numRealTitles ✗）。
于是：
  · 着色器里"荒地边单独走一趟"的判据（只看 LUT 标记那条 ✓）会被别的
    "必须是伪头衔"的前置挡掉 ✗ → 荒地轮廓画成"本层那条线"的 50% ✗（用户报过 ✓）
  · 任何拿 `t >= numRealTitles` 当"这是背景地形"的地方，在 EU5 上都会认错 ✗

这个脚本把荒地**整体搬到 id 空间的末尾**，并把 `numRealTitles` 降到"真头衔个数"，
让 EU5 跟别的模式一个形状 ✓。

要一起改的东西（一个都不能漏 ✗）
--------------------------------
* `titles.json` 里**所有按 id 排的数组**（脚本按"长度 == 头衔数"自动认 ✓）
  —— 其中 `parents` 存的是**头衔号**，值也要过一遍映射 ✓
* `meta.json`：`wasteland`（头衔号 ✓）、`wastelandAuto`（[地块号, **头衔号**] ✓）、
  `wastelandAutoByTier`（每个 tier 一张上面的表 ✓）
  ⚠ **`wastelandPerimeter` 一个字都不许动** ✗ —— 它长这样
  `[[地块号, [[邻居地块号, 权重], …]], …]`：**里外全是地块号** ✓
  （我第一版把它当"头衔号"改了 ✗ → 周长表当场错乱：冒出"自己接壤自己"、
    自动上色把海的颜色涂上荒地 ✗ 全被测试逮住了 ✓）
* `titlemap.bin`：**每一格**的头衔号（含空白剧本那一行 ✓）
* `numRealTitles` = 真头衔个数 ✓（`numTitles` 不变 ✓）

顺序：真头衔保持原相对次序 → 荒地 → 其它伪头衔（#sea / #lake / #impassable ✓）
"""
from __future__ import annotations

import json
import sys
import zlib
from pathlib import Path

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

#: 打包单文件版时会用到的几份缓存（data_eu4_hd 只在本地测，也一起看 ✓）
DEFAULT_DIRS = ("data", "data_eu4", "data_eu4_hd", "data_hoi4", "data_hoi4_alt",
                "data_vic3", "data_eu5", "data_eu5_full")


def _remap_pair_list(lst, perm):
    """[[地块号, 头衔号], …] 这种表：只改第二格 ✓（第二格不是单个整数的原样留着 ✓）"""
    out = []
    for it in lst or []:
        if isinstance(it, list) and len(it) == 2 and isinstance(it[1], int) and it[1] in perm:
            out.append([it[0], perm[it[1]]])
        else:
            out.append(it)
    return out


def patch(data_dir: Path | str, quiet: bool = False, dry_run: bool = False) -> dict:
    """把一份缓存里的荒地挪成伪头衔（幂等 ✓）。"""
    D = Path(data_dir)
    say = (lambda *a: None) if quiet else (lambda *a: print(*a))
    meta_p, tit_p, tm_p = D / "meta.json", D / "titles.json", D / "titlemap.bin"
    if not meta_p.is_file() or not tit_p.is_file():
        say(f"  {D}: 没有 meta/titles，跳过")
        return {"dir": str(D), "skipped": "no-data"}

    M = json.loads(meta_p.read_text(encoding="utf-8"))
    T = json.loads(tit_p.read_text(encoding="utf-8"))
    keys = T["keys"]
    n = len(keys)
    n_real = int(M.get("numRealTitles", n))
    waste = [int(t) for t in (M.get("wasteland") or [])]

    # 需要变成伪头衔的 = 荒地 ∪ 现在就已经是伪头衔的那些 ✓
    pseudo_old = set(waste) | {i for i in range(n_real, n)}
    below = [t for t in waste if t < n_real]
    if not below:
        say(f"  {D}: 荒地 {len(waste)} 个**已经全是伪头衔**了（>= {n_real}）—— 跳过 ✓")
        return {"dir": str(D), "skipped": "already-pseudo", "wastelands": len(waste)}

    order = [i for i in range(n) if i not in pseudo_old] + sorted(pseudo_old)
    if len(order) != n or len(set(order)) != n:
        raise RuntimeError(f"{D}: 排不出来（order 长度 {len(order)}）")
    perm = {old: new for new, old in enumerate(order)}
    new_real = len([i for i in range(n) if i not in pseudo_old])

    if dry_run:
        say(f"  {D}: [试跑] 真头衔 {n_real} → {new_real}，"
            f"荒地 {len(below)} 个挪到 {new_real}..{new_real + len(below) - 1} ✓（不写盘）")
        return {"dir": str(D), "dryRun": True, "newReal": new_real, "moved": len(below)}

    # ---- titles.json：所有"按 id 排"的数组整体重排 ✓
    n_arrays = 0
    for k, v in list(T.items()):
        if isinstance(v, list) and len(v) == n:
            T[k] = [v[order[i]] for i in range(n)]
            n_arrays += 1
    # parents 存的是**头衔号** → 值也要过映射 ✓（-1 / None 之类原样留着 ✓）
    if isinstance(T.get("parents"), list):
        T["parents"] = [perm[p] if isinstance(p, int) and p in perm else p for p in T["parents"]]

    # ---- meta.json：**含头衔号**的字段 ✓
    #   ⚠ wastelandPerimeter 不动 ✗（它里外都是地块号 ✓）
    M["wasteland"] = sorted(perm[t] for t in waste)
    if "wastelandAuto" in M:
        M["wastelandAuto"] = _remap_pair_list(M["wastelandAuto"], perm)
    if "wastelandAutoByTier" in M:
        M["wastelandAutoByTier"] = [_remap_pair_list(x, perm) for x in (M["wastelandAutoByTier"] or [])]
    M["numRealTitles"] = new_real

    # ---- titlemap：每一格的头衔号都过一遍映射 ✓（含空白剧本那一行 ✓）
    raw = zlib.decompress(tm_p.read_bytes())
    tm = np.frombuffer(raw, dtype="<u2").reshape(-1, int(M["numProvinces"])).copy()
    no_title = int(M.get("noTitle", 65535))
    lut = np.arange(65536, dtype="<u2")
    for old, new in perm.items():
        if old <= 65535:
            lut[old] = new
    keep = tm == no_title
    tm = lut[tm]
    tm[keep] = no_title
    tm_p.write_bytes(zlib.compress(tm.astype("<u2").tobytes(), 6))

    meta_p.write_text(json.dumps(M, ensure_ascii=False, indent=2), encoding="utf-8")
    tit_p.write_text(json.dumps(T, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    say(f"  {D}: 真头衔 {n_real} → {new_real} · 挪走荒地 {len(below)} 个 · "
        f"重排 {n_arrays} 个字段 · titlemap {tm.shape[0]} 行 ✓")
    return {"dir": str(D), "done": True, "oldReal": n_real, "newReal": new_real,
            "moved": len(below), "arrays": n_arrays}


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("-")]
    dry = "--dry-run" in argv
    dirs = args or list(DEFAULT_DIRS)
    print(("试跑：" if dry else "开始：") + "、".join(dirs))
    moved = 0
    for d in dirs:
        p = Path(d)
        if p.is_dir():
            r = patch(p, dry_run=dry)
            moved += int(r.get("moved", 0) or 0)
        else:
            print(f"  {d}: 目录不存在，跳过")
    print(("试跑完成（没写盘）" if dry else "完成") + f" · 共挪动 {moved} 个荒地 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
