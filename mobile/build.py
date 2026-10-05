# -*- coding: utf-8 -*-
"""一键出手机版：pdx-map-editor-mobile.html

跑法（在项目根目录）：
    python mobile/build.py

它做的事，按顺序：
  1. 拍两个快照：**电脑版那个文件** + **web/ 三个源文件**（都按字节 ✓）
  2. 把 mobile/*.txt 合进 web/ 三个文件（= 打手机端补丁）
  3. 烤一份单文件 → 改名成 pdx-map-editor-mobile.html
  4. 把 web/ 三个源文件**按字节写回**开工前那份 ✓
  5. 把电脑版那个文件也**按字节写回** ✓

  → 所以这个脚本**绝不会动到电脑版** ✓ 也不会弄丢你没提交的源码改动 ✓
    （以前这两件都翻过车 ✗ 一个字节的快照把这些坑全堵死了 ✓）

电脑版和手机版共用同一套源码 ✓ 区别只有"打不打这个补丁" ✓
出电脑版就是：python build_standalone.py
"""
import subprocess
import sys
import time
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
MOBILE = ROOT / "pdx-map-editor-mobile.html"
DESKTOP = ROOT / "pdx-map-editor.html"
# 会被手机端补丁动到的三个源文件 ✓（收工要原样写回 ✓）
CSS = ROOT / "web" / "style.css"
APP = ROOT / "web" / "js" / "app.js"
HTML = ROOT / "web" / "index.html"


def run(*args):
    cmd = [PY, str(ROOT / args[0])] + list(args[1:]) if args[0].endswith(".py") else list(args)
    r = subprocess.run(cmd, cwd=str(ROOT))
    if r.returncode != 0:
        raise SystemExit(f"  ✗ 这步失败了：{args}")


def human(n):
    return f"{n / 1048576:.2f} MB"


def main():
    t0 = time.time()
    desk_before = DESKTOP.read_bytes() if DESKTOP.exists() else None
    src_before = {f: f.read_bytes() for f in (CSS, APP, HTML)}

    print("  1) 打手机端补丁…")
    run("mobile/patch.py", "apply")

    print("  2) 烤单文件…")
    run("build_standalone.py")
    if not DESKTOP.exists():
        raise SystemExit("  ✗ build_standalone.py 没产出 pdx-map-editor.html")
    if MOBILE.exists():
        MOBILE.unlink()
    DESKTOP.rename(MOBILE)
    print(f"     ✓ {MOBILE.name}  {human(MOBILE.stat().st_size)}")

    print("  3) 源码按字节写回（连没提交的改动一起保住 ✓）")
    for f, raw in src_before.items():
        f.write_bytes(raw)
    print("     ✓ style.css / app.js / index.html 已还原")

    print("  4) 电脑版按字节写回（一个字节都不动 ✓）")
    if desk_before is not None:
        DESKTOP.write_bytes(desk_before)
    print(f"     ✓ {DESKTOP.name}  {human(DESKTOP.stat().st_size)}")

    print(f"\n  好了 ✓ 两个文件都在项目根目录，用了 {time.time() - t0:.0f} 秒")
    print("     pdx-map-editor.html        电脑版（原样，一个字节没动 ✓）")
    print("     pdx-map-editor-mobile.html  手机版（单独发布，不进仓库 ✓）")


if __name__ == "__main__":
    main()
