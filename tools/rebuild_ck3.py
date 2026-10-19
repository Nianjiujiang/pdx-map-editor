# -*- coding: utf-8 -*-
"""重烤 CK3 的一条龙：构建 → 汉化后处理 → 同名海域归组

  为什么需要它：build_data.py 里的自动汉化覆盖还不如 _local 那套脚本 ✓，
  而归组必须在"名字定稿"之后做 ✓，所以三者按顺序走一遍最稳 ✓
  用法：python rebuild_ck3.py            （只烤原版）
        python rebuild_ck3.py --miller   （顺带烤米勒投影，需要那张图）
"""

import argparse
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent
PY = sys.executable

#: 只留不丢字的步骤：英文名反查 + 词序。
#: 去前缀/去尾词那几个（_deprefix/_normloc/_stripimp*）已废弃 ——
#: 它们会把黑海砍成黑，正确做法是拿原名直接查本地化。
STEPS_POST = ["_deen.py", "_wordorder.py"]


def run(desc, args):
    print(f"  ▶ {desc}")
    r = subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="ignore")
    tail = (r.stdout or "").strip().splitlines()[-1:] or [""]
    print(f"    {tail[0][:120]}")
    if r.returncode != 0:
        print("    ! 失败：", (r.stderr or "")[-400:])
        raise SystemExit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--miller", action="store_true", help="顺带烤米勒投影")
    ap.add_argument("--skip-build", action="store_true", help="跳过构建，只跑后处理")
    a = ap.parse_args()

    if not a.skip_build:
        run("构建原版 data/", [PY, "build_data.py"])
    for s in STEPS_POST:
        p = ROOT / "_local" / s
        if p.is_file():
            run(f"汉化后处理 {s}", [PY, str(p)])
    if a.miller:
        run("构建米勒投影 data_miller/", [PY, "build_data.py", "--map",
                                          str(ROOT / "_local" / "map_miller" / "provinces.png"),
                                          "--out", "data_miller", "--label", "CK3 米勒投影"])
    print("  ✔ CK3 数据一条龙完成")


if __name__ == "__main__":
    main()
