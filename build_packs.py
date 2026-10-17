#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把游戏自带的那几张地图打成 `.pdxmap` 包 —— 轻量版的配菜。

    python build_packs.py                 # 打到 packs/（默认）
    python build_packs.py --out 某个目录    # 换个地方

为什么要有它：编辑器的单文件从 2026-10-12 起**默认不内嵌地图**（约 0.6 MB）✓
地图改成"要用哪张下哪张"：CK3 2.4 MB、EU5 原尺寸 12.2 MB，比人人下 35 MB 划算得多 ✓
（原先那套全量单文件还留着：`python build_standalone.py --all-maps`）

地图清单**只有一份** —— `build_standalone.py` 里的 `MAPS` ✓
这里只是照着它循环，别在这儿另抄一张表 ✗（拍平清单抄了三份、为此踩过两回）
⚠ 表里没有 EU4HD：那是创意工坊模组的地图，没拿到作者授权，不打包对外发 ✓
"""

from __future__ import annotations

import argparse
import os
import sys
from argparse import Namespace
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from build_standalone import MAPS                       # noqa: E402  （同一份地图表 ✓）
from pack_map import build_pack                         # noqa: E402  （打包那套流程 ✓）

#: 默认输出目录。**不进仓库**（见 .gitignore）—— 建出来传给 Release 当附件的 ✓
OUT_DIR = ROOT / "packs"

#: 每个包写进 manifest 的版本号 = **烘这份数据时那个游戏本体的版本** ✓
#: 卡片左下角显示成「v1.20.0.4」，玩家一眼就知道这图是哪一版游戏上的。
#: ⚠ **这张表是手写的**：CK3 / V3 / EU5 的 `meta.gameVersion` 要么没有、要么是 `?`
#:   （烘数据那会儿没记下来），从 meta 读只会读出一串空的 ✗
#:   游戏打了补丁、重烘了数据，就回来改这里。
#: **留空 = 卡片上不显示版本** —— 别退回去填个假的 1.0.0 ✗（那跟"没说"一样，
#: 还容易被当成真版本 ✓）
PACK_VERSIONS = {
    "pdx-ck3-vanilla": "1.20.0.4",      # Crusader Kings III · launcher/launcher-settings.json
    "pdx-eu4-vanilla": "1.37.5.0",      # EU4 · meta.gameVersion 里就有 ✓
    "pdx-hoi4-vanilla": "1.19.3.0",     # HOI4 的 rawVersion ✓
    "pdx-hoi4-alt": "1.19.3.0",         # （"Operation Postern … (5632)" 有 39 字，超 version 上限 ✗）
    "pdx-vic3-vanilla": "1.13.11",      # Victoria 3 · launcher/launcher-settings.json
    "pdx-eu5-vanilla": "1.2.4",         # EU5 · 版本**编在 exe 里**，见下面那段 ⚠
    "pdx-eu5-full": "1.2.4",
}

#: ⚠ EU5 这两个包为什么也在手写表里：
#:   本机那份 EU5 是**第三方整合版**（`C:\Game NIANJIU\EU5`，没有 launcher），
#:   而 `launcher-settings.json` 是**启动器写出来的** —— 整合版里根本没这个文件 ✓
#:   版本号其实**编在 `binaries/eu5.exe` 里**，是一条独立的字符串常量：
#:   偏移 `0x630FD64`，紧挨着前面就是代号串 `Echinades`（PDS 那套「版本 + 代号」，
#:   跟 CK3 的 `1.20.0.4 (Crozier)` / V3 的 `1.13.11 (Matcha)` 一个格式 ✓），
#:   周围全是 `C:\mnt\gsg\caesar\...` 的调试源码路径 —— 就是编译期的字符串表 ✓
#:   （2026-10-12 查证：全盘 24806 个文本文件里搜 `1.2.4`，只有 4 处是公元 211 年的历史日期 ✗）
#:   所以 `build_eu5.py` 去读 launcher-settings.json 只会读到空 —— **这张表不是偷懒，是没别的路** ✓
#:   将来装了 Steam 正版 EU5，就能改回从 meta 读了。


def main() -> int:
    ap = argparse.ArgumentParser(
        description="把游戏自带的地图打成 .pdxmap 包",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(OUT_DIR), help=f"输出目录，默认 {OUT_DIR.name}/")
    ap.add_argument("--version", default=None,
                    help="统一指定版本号（默认按包各自查 PACK_VERSIONS）")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    todo = list(MAPS)
    print(f"打 {len(todo)} 个地图包 → {out_dir}/")
    made = []
    skipped = []
    for emb_key, pack_id, label, dirname, note in todo:
        data_dir = ROOT / dirname
        if not (data_dir / "meta.json").is_file():
            skipped.append(f"{label}（{dirname}/ 里没有 meta.json）")
            continue

        #: 跟命令行那条路走**同一个** build_pack ✓ 它自己会自检（hash / 长度公式 / 省份号）
        ns = Namespace(
            data_dir=str(data_dir), id=pack_id, label=label, note=note,
            # 版本 = 这份数据烘自哪个游戏版本（表见文件头）；作者**不写** ✓
            version=(args.version or PACK_VERSIONS.get(pack_id, "")), author="", license="",
            homepage="", description="", preview=None,
            out=str(out_dir / f"{pack_id}.pdxmap"),
        )
        path, manifest = build_pack(ns, quiet=True)
        size = os.path.getsize(path)
        made.append((label, path, size, manifest["stats"]))
        print(f"  ✓ {label:<12} {size / 1048576:6.2f} MB  →  {os.path.basename(path)}")

    if skipped:
        print("\n跳过（本地没这份缓存）：")
        for s in skipped:
            print(f"  · {s}")

    if not made:
        print("\n!! 一个包都没打出来 —— 先跑 build_data.py 把缓存建起来")
        return 1

    total = sum(m[2] for m in made)
    print(f"\n一共 {len(made)} 个包，合计 {total / 1048576:.2f} MB")
    print(f"  这些就是跟 pdx-map-editor.html（轻量版）一起发出去的东西 ✓")
    print("  玩家在选图那一页「＋ 导入地图包…」把它们导进去即可")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
