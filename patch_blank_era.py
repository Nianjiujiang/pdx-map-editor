# -*- coding: utf-8 -*-
"""给一份缓存加一层「空白剧本」——**幂等，可重复跑**。

跑法（在项目根目录）：

    python patch_blank_era.py                 # 默认：所有非 CK3 的缓存
    python patch_blank_era.py data_eu4        # 只补指定的那几份

空白剧本 = 一层**跟别的剧本同样规矩**的年份层，唯一区别是：
**陆地地块一律"无主"**（不上色、没有标记 ✓），海 / 湖 / 荒地那些**伪头衔照抄**
（海还是海、荒地还是那层灰 ✓）—— 就是 app 里现成的"无主地"表现
（中性灰 + 海岸线，见 gl.js 的 `colorOfTier`/`tid == NONE` 那一段）。

几个约定（改动这儿之前先看）：

* **插在剧本块的最前面**（index 0）✓ —— 因为 app 里"离当前视图最近的那个剧本"
  是 `Math.min(tier, eraDates.length - 1)`（= 剧本块最后一层）。空白层要是插在
  最后，细层视图下那个"最近剧本"就变成空白层了 ✗ → 「更新国名」、
  无主地的身份、国名落点那一套全跟着变 ✗。
* 插一层 = **所有层级下标整体 +1**，所以下面这些一起挪：
  meta 的 `tiers / tierNames / tierKeys / labelZoom / eraDates /
  wastelandAutoByTier / bookmarks / defaultTier`，以及 titles.json 的 `tiers` ✓
* 空白层那一行**照抄最细那层的伪头衔**（海/湖/荒地/不可通行），
  其余一律写成 `noTitle` ✓

CK3 不加（它本来就没有剧本层 ✓）。
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

#: 打包单文件版时会用到的几份缓存（data_eu4_hd 只在本地测，也一起补 ✓）
DEFAULT_DIRS = ("data_eu4", "data_eu4_hd", "data_hoi4", "data_hoi4_alt",
                "data_vic3", "data_eu5", "data_eu5_full")

BLANK_KEY = "blank"       # meta.tiers 里那一格（app 拿它当层级 key 用）
BLANK_NAME = "空白"        # 视图那一排按钮上写的字


def patch(data_dir: Path | str, quiet: bool = False) -> dict:
    """把一份缓存补上空白剧本（幂等，可重复跑）。"""
    D = Path(data_dir)
    say = (lambda *a: None) if quiet else (lambda *a: print(*a))
    meta_p, tit_p, tm_p = D / "meta.json", D / "titles.json", D / "titlemap.bin"
    if not meta_p.is_file():
        say(f"  {D}: 没有 meta.json，跳过")
        return {"dir": str(D), "skipped": "no-meta"}
    M = json.loads(meta_p.read_text(encoding="utf-8"))
    if not (M.get("eraDates") or []):
        say(f"  {D}: 没有剧本层（CK3 那种），跳过")
        return {"dir": str(D), "skipped": "no-era"}
    n = int(M["numProvinces"])
    tiers = list(M["tiers"])
    rows = len(tiers)
    T = json.loads(tit_p.read_text(encoding="utf-8"))
    t_tiers = T["tiers"]
    no_title = int(M.get("noTitle", 65535))
    wl = set(M.get("wasteland") or [])

    #: 这一格算不算"背景地形"（海 / 湖 / 河 / 荒地 / 不可通行 ✓）——
    #  空白层照抄的就是这些，其余一律无主 ✓
    #  判据用 app 自己那两条：key 以 '#' 开头（水域/不可通行），或者在 meta.wasteland 里 ✓
    #  （EU5 的荒地条目里有"阿卜杜勒库里岛"这种**序号在真头衔范围内**的节点 ✗ ——
    #    只按"序号 >= numRealTitles"判会把它们清掉，海/荒地就跟着变灰了 ✗）
    keys = T["keys"]
    def is_bg(t: int) -> bool:
        return str(keys[t]).startswith("#") or t in wl

    # ---- 空白那一行：照抄最细那层的**背景地形**（海 / 湖 / 荒地 ✓）
    tm = np.frombuffer(zlib.decompress(tm_p.read_bytes()),
                       dtype="<u2").reshape(rows, n).copy()
    fine = rows - 1
    if BLANK_KEY in tiers:
        # 已经加过：只把**那一行**按最新规则重写一遍 ✓（幂等，反复跑不会越改越歪 ✓）
        k = tiers.index(BLANK_KEY)
        blank = np.full(n, no_title, dtype="<u2")
        keep = 0
        for pid in range(1, n):
            t = int(tm[fine, pid])
            if t != no_title and t < len(keys) and is_bg(t):
                blank[pid] = t
                keep += 1
        tm[k] = blank
        tm_p.write_bytes(zlib.compress(tm.astype("<u2").tobytes(), 6))
        say(f"  {D}: 已经有「{BLANK_NAME}」层（第 {k} 层）—— 只把那一行按最新规则重写 ✓"
            f"（背景地形 {keep} 格 · 其余 {n - 1 - keep} 块无主）")
        return {"dir": str(D), "refreshed": True, "tier": k, "bgCells": keep}

    blank = np.full(n, no_title, dtype="<u2")
    keep = 0
    ref = tm[fine]                      # 最细那一层：陆地上全是真头衔 ✓
    for pid in range(1, n):
        t = int(ref[pid])
        if t != no_title and t < len(keys) and is_bg(t):
            blank[pid] = t
            keep += 1
    if keep == 0:
        say(f"  {D}: 最细那层连一个背景地形都没有，跳过（数据不对吧）")
        return {"dir": str(D), "skipped": "no-bg"}

    new_tm = np.empty((rows + 1, n), dtype="<u2")
    new_tm[0] = blank
    new_tm[1:] = tm
    tm_p.write_bytes(zlib.compress(new_tm.astype("<u2").tobytes(), 6))

    # ---- meta / titles：所有按层级排的数组整体后移一位 ✓
    k = 0
    _insert = lambda key, val: (M[key].insert(k, val)
                                if isinstance(M.get(key), list) else None)
    M["tiers"].insert(k, BLANK_KEY)
    _insert("tierNames", BLANK_NAME)
    _insert("tierKeys", BLANK_NAME)
    _insert("labelZoom", (M.get("labelZoom") or [20])[0])      # 跟原第一层同档 ✓
    _insert("eraDates", "")
    _insert("wastelandAutoByTier", [])                          # 没有主 → 无从自动上色 ✓
    if isinstance(M.get("bookmarks"), list):
        M["bookmarks"].insert(k, {"date": "", "key": "", "name": BLANK_NAME,
                                  "default": False})
    if isinstance(M.get("defaultTier"), int):
        M["defaultTier"] += 1
    T["tiers"] = [int(t) + 1 for t in t_tiers]

    meta_p.write_text(json.dumps(M, ensure_ascii=False, indent=2), encoding="utf-8")
    tit_p.write_text(json.dumps(T, ensure_ascii=False, separators=(",", ":")),
                     encoding="utf-8")
    say(f"  {D}: 加了「{BLANK_NAME}」层（第 0 层）· 层数 {rows} → {rows + 1} · "
        f"这一层留了 {keep} 个背景地形格（海/湖/荒地）· 其余 {n - 1 - keep} 块全无主")
    return {"dir": str(D), "added": True, "tier": k, "bgCells": keep,
            "rowsBefore": rows, "rowsAfter": rows + 1}


def main(argv: list[str]) -> int:
    for d in (argv[1:] or list(DEFAULT_DIRS)):
        patch(d)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
