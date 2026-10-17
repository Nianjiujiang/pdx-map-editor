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

* **插在剧本块的最右边**（region 就是 `eraDates` 的末尾 ✓）：
  视图那一排读作 `1444 / 1618 / 1789 / 空白剧本 / 区域 / 地区 / 省份` ✓
  ⚠ 因为这样一插，"离当前视图最近的剧本层"（app 里的 `min(tier, eraDates.length-1)`）
  在细层视图下就指向空白层了 ✗ —— app 那边专门有个 `countryTier()` 把空白层跳过去 ✓
  （它按 `meta.tiers` 里的 `'blank'` 认 ✓ 空白层不在最后的老数据自动退回老行为 ✓）
* 插一层 = **它后面的层级下标整体 +1**（它前面的不动 ✓），所以下面这些要一起挪：
  meta 的 `tiers / tierNames / tierKeys / labelZoom / eraDates /
  wastelandAutoByTier / bookmarks` 插一格 ✓、`defaultTier` 在后面就 +1 ✓，
  以及 titles.json 的 `tiers`（下标 ≥ 插入位置的那些 +1 ✓）
* 空白层那一行**照抄最细那层的背景地形**（海/湖/荒地/不可通行），
  其余一律写成 `noTitle` ✓

**每一套缓存都补**（CK3 从 2026-10-11 起也有剧本层了 —— 1066 那一层 ✓
所以链上读作 `1066 / 空白剧本 / 帝国 / 王国 / 公爵领 / 伯爵领 / 男爵领` ✓）。
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

#: 打包单文件版时会用到的几份缓存（data = CK3 那份；data_eu4_hd 只在本地测，也一起补 ✓）
#: ⚠ **`data_ck2` 没列在这儿** ✓ —— 它的「空白剧本」由 `build_ck2.py` 收尾时自己调本脚本 ✓
#:   （那边先建好 **1066 剧本层**、再让本脚本往剧本块最右边插一格 ✓ 于是空白层落在第 1 层 ✓
#:    左边那一格就是 1066，背景地形照抄得到 ✓ 一切都对 ✓）
#:   ⚠ 而且**重复跑是幂等的** ✗（`k = len(eraDates) - 1 = 1` = `tiers.index('blank')` ✓
#:     走「刷新」那一支、照抄的还是 tm[0] ✓ 结果一模一样 ✓）——
#:     所以列进来也不会有害 ✓ 只是没必要 ✓；真要手动补，`py patch_blank_era.py data_ck2` 也行 ✓
DEFAULT_DIRS = ("data", "data_eu4", "data_eu4_hd", "data_hoi4", "data_hoi4_alt",
                "data_vic3", "data_eu5", "data_eu5_full")

BLANK_KEY = "blank"        # meta.tiers 里那一格（app 拿它当层级 key 用）
BLANK_NAME = "空白剧本"     # 视图那一排按钮上写的字


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

    # ---- 插在**剧本块的最右边**（= 最后一个剧本之后、第一个地理层之前 ✓）
    tm = np.frombuffer(zlib.decompress(tm_p.read_bytes()),
                       dtype="<u2").reshape(rows, n).copy()
    fine = rows - 1                      # 最细那一层：陆地上全是真头衔 ✓
    k = len(M.get("eraDates") or [])     # 真剧本的层数 = 插入位置 ✓
    if BLANK_KEY in tiers:
        k -= 1                           # 已经加过：eraDates 里已经把空白那一格算进去了 ✓
        # 已经加过：位置/名字都对 → 只把**那一行**按最新规则重写一遍 ✓
        #（幂等，反复跑不会越改越歪 ✓）；位置或名字不对 → 说一声，别静默留着旧布局 ✗
        old_k = tiers.index(BLANK_KEY)
        old_name = (M.get("tierNames") or [])[old_k] if old_k < len(M.get("tierNames") or []) else ""
        if old_k != k or old_name != BLANK_NAME:
            say(f"  {D}: 已经有「{old_name}」层（第 {old_k} 层），"
                f"但位置/名字跟现在这套对不上（应该是第 {k} 层「{BLANK_NAME}」）—— "
                f"先把旧的去掉再跑，或者从备份还原一份干净的重来 ✓")
            return {"dir": str(D), "skipped": "stale-layout", "tier": old_k}
        # 🔴 **这一支也要照抄左边那层的水域** ✗✗（2026-10-14 ✓ 用户点破 ✓）
        #   ⚠ 幂等重跑时**必须跟新建那一支算得一模一样** ✗ ——
        #     只改新建那支的话，第二次跑就把刚填好的海色又清掉了 ✓
        #     （我上一轮就栽在这儿：只改了新建那支 ✓ 实跑"改了没用"✓）
        blank = np.full(n, no_title, dtype="<u2")
        keep = 0
        if old_k > 0:
            _prev = tm[old_k - 1]
            for pid in range(1, n):
                t = int(_prev[pid])
                if t != no_title and t < len(keys) and is_bg(t):
                    blank[pid] = t
                    keep += 1
        tm[old_k] = blank
        tm_p.write_bytes(zlib.compress(tm.astype("<u2").tobytes(), 6))
        # ⚠ **顺手把按层的数组校准长度** ✗（2026-10-13）
        #   这一支是"空白层已经在了"（幂等重跑 ✓）—— 上面那次新建插好了，
        #   但**这一版之前跑过的缓存**里 `seaNamesByTier` 是**短的**（少插了一格 ✓）
        #   长度对不上就当场补齐/截掉 ✓ 不然地图按层查表会整体错位 ✓
        _sbt = M.get("seaNamesByTier")
        if isinstance(_sbt, list) and len(_sbt) != rows:
            if len(_sbt) < rows:
                _sbt.insert(old_k if old_k <= len(_sbt) else len(_sbt), None)
            else:
                _sbt.pop(old_k if old_k < len(_sbt) else len(_sbt) - 1)
            meta_p.write_text(json.dumps(M, ensure_ascii=False, indent=2), encoding="utf-8")
            say(f"  {D}: 顺手把 seaNamesByTier 的长度校准成 {len(_sbt)}（跟层数对齐 ✓）")
        say(f"  {D}: 已经有「{BLANK_NAME}」层（第 {old_k} 层）—— 只把那一行按最新规则重写 ✓"
            f"（背景地形 {keep} 格 · 其余 {n - 1 - keep} 块无主）")
        return {"dir": str(D), "refreshed": True, "tier": old_k, "bgCells": keep}

    # 🔴🔴 **空白层：陆地留空、水域照抄左边那层** ✗✗（2026-10-14 ✓ 用户点破 ✓）
    #
    #   用户原话："空白剧本**依旧看不见海洋在哪**"
    #     "我知道了，你是不是**没给你刚刚分配给他们的这个 ID 配一个海蓝色**"
    #   ⚠ 完全对 ✗ —— 我上一版把空白层**整层清空**了（`no_title` 一路到底 ✓）——
    #     那时是对的（剧本层水域本来就没归属 ✓）
    #     可现在**剧本层的水域有归属了** ✗（每一类一个"海洋"节点 ✓
    #       见 `build_tier_pieces` 的 `script_tiers` ✓）
    #     → 空白层却还是全空 ✓ → 它的海是 `NONE` → **显示成"未上色"的灰** ✗
    #       （用户看到的"看不见海洋在哪"✓）
    #
    #   ✅ 正解：**空白层的水域 / 荒地照抄它左边那一格**（`tm[k - 1]` ✓
    #     也就是最后一个真剧本层，比如 EU4 的 `1789` ✓）——
    #     拿到的正是 `#sea_all_1789` 那种"整类一片"节点 ✓
    #     **颜色 / 名字 / 边界行为全都对** ✓（它们本来就该跟剧本层一致 ✓）
    #   ⚠ **陆地仍旧留空** ✗ —— 空白剧本 = 全无主、拿来从零涂的那一层 ✓
    #     它的意义就是"谁都没有"✓ 所以只抄**背景地形**（水域 + 荒地 ✓）
    #   ⚠ 判据用"那一格的键名是不是 `#` 开头 / 在 `meta.wasteland` 里"✗ ——
    #     跟 `apply_rows` 那套同一口径 ✓ 别另编 ✗
    #   ⚠ 抄的是**归属**不是"重新造节点" ✗ —— 节点本身在上一步就有了 ✓
    #     （`script_tiers` 造的那批 ✓ 空白层只是**指向**它们 ✓）
    blank = np.full(n, no_title, dtype="<u2")
    keep = 0
    if k > 0:
        _prev = tm[k - 1]
        for pid in range(1, n):
            t = int(_prev[pid])
            if t != no_title and t < len(keys) and is_bg(t):
                blank[pid] = t
                keep += 1
    say(f"  {D}: 空白层：背景地形（水域 / 荒地）照抄左边那层 {keep} 格，"
        f"陆地 {n - 1 - keep} 块全无主 ✓")

    new_tm = np.empty((rows + 1, n), dtype="<u2")
    new_tm[:k] = tm[:k]
    new_tm[k] = blank
    new_tm[k + 1:] = tm[k:]
    tm_p.write_bytes(zlib.compress(new_tm.astype("<u2").tobytes(), 6))

    # ---- meta / titles：按层级排的数组在 k 处插一格，k 后面的下标整体 +1 ✓
    _insert = lambda key, val: (M[key].insert(k, val)
                                if isinstance(M.get(key), list) else None)
    M["tiers"].insert(k, BLANK_KEY)
    _insert("tierNames", BLANK_NAME)
    _insert("tierKeys", BLANK_NAME)
    _insert("labelZoom", (M.get("labelZoom") or [20])[k if k < len(M.get("labelZoom") or []) else 0])
    _insert("eraDates", "")
    # ⚠ **按层的数组都得跟着插** ✗（2026-10-13 踩过的坑）
    #   `seaNamesByTier` 的下标 = `tiers` 的下标 ✓ 上面插了一层它不插 →
    #   **整条链错位一格** ✓ 细层的水名会跑到剧本层去、地图上按层查表全错 ✓
    #   ⚠ 只在"长度跟得上"时才插 ✗ 老缓存压根没这个字段，别凭空造一个 ✓
    if isinstance(M.get("seaNamesByTier"), list) and len(M["seaNamesByTier"]) == rows:
        M["seaNamesByTier"].insert(k, None)      # 空白层没有水域 ✓ 给 None ✓
    if isinstance(M.get("bookmarks"), list):
        M["bookmarks"].insert(k, {"date": "", "key": "", "name": BLANK_NAME,
                                  "default": False})
    if isinstance(M.get("defaultTier"), int) and M["defaultTier"] >= k:
        M["defaultTier"] += 1                     # 在空白层右边 → 跟着挪 ✓
    T["tiers"] = [int(t) + 1 if int(t) >= k else int(t) for t in t_tiers]

    meta_p.write_text(json.dumps(M, ensure_ascii=False, indent=2), encoding="utf-8")
    tit_p.write_text(json.dumps(T, ensure_ascii=False, separators=(",", ":")),
                     encoding="utf-8")
    say(f"  {D}: 加了「{BLANK_NAME}」层（第 {k} 层，剧本块最右边）· 层数 {rows} → {rows + 1} · "
        f"这一层留了 {keep} 个背景地形格（海/湖/荒地）· 其余 {n - 1 - keep} 块全无主")
    return {"dir": str(D), "added": True, "tier": k, "bgCells": keep,
            "rowsBefore": rows, "rowsAfter": rows + 1}


def main(argv: list[str]) -> int:
    for d in (argv[1:] or list(DEFAULT_DIRS)):
        patch(d)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))


# 2026-10-12 · 地图编辑器 v1.9（本版未改动此脚本）
