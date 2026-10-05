# -*- coding: utf-8 -*-
"""把手机端那三块（CSS / JS / HTML）打进去、或者退出来。

用法（在项目根目录）：
    python mobile/patch.py apply      # 把 mobile/*.txt 合进 web/ 三个文件
    python mobile/patch.py revert     # 把 web/ 三个文件退回上一条提交

桌面版和手机版**共用同一套源码** ✓ 区别只有"打不打这个补丁" ✓

平时不用手跑这个 —— 直接：
    python mobile/build.py
一键出手机版，而且**不会碰电脑版那个文件** ✓

注意 revert：它走 git checkout，所以要求那三个文件**没有未提交的改动** ✓
（要带着未提交的改动烤手机版，就用 build.py —— 它会自己拍字节快照 ✓）
"""
import subprocess
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
FILES = ["web/index.html", "web/style.css", "web/js/app.js"]

P_CSS = HERE / "mobile_css.txt"
P_JS = HERE / "mobile_js.txt"
P_HTML = HERE / "mobile_html.txt"

# "已经打过补丁了吗"的标记 —— 必须是**真在补丁文件里存在**的字符串 ✓
# （老版本拿 #mob-bar 当标记，可它压根不在文件里 ✗ 于是重复打就叠一份 CSS ✗）
MARK_CSS = "#mob-ui"
MARK_JS = "function bindMobile()"
MARK_HTML = "手机版的界面（一级六入口"


def read(p):
    with open(ROOT / p, "r", encoding="utf-8", newline="") as f:
        return f.read()


def write(p, s):
    with open(ROOT / p, "w", encoding="utf-8", newline="") as f:
        f.write(s)


def apply():
    css = P_CSS.read_text(encoding="utf-8")
    js = P_JS.read_text(encoding="utf-8")
    html = P_HTML.read_text(encoding="utf-8").rstrip("\n")
    did = []

    s = read("web/style.css")
    if MARK_CSS not in s:
        write("web/style.css", s + css)
        did.append("style.css")

    s = read("web/js/app.js")
    if MARK_JS not in s:
        anchor = "function bindEvents() {"
        assert s.count(anchor) == 1, "app.js 里找不到 bindEvents 的定义，锚点变了"
        s = s.replace(anchor, js + "\n" + anchor)
        call = "    bindEvents();"
        assert s.count(call) == 1, "app.js 里找不到 bindEvents() 的调用点，锚点变了"
        s = s.replace(call, "    bindEvents();\n    bindMobile();       // 手机端：抽屉 + 触摸手势 ✓")
        write("web/js/app.js", s)
        did.append("app.js")

    s = read("web/index.html")
    if MARK_HTML not in s:
        anchor = '<footer class="statusbar">'
        assert s.count(anchor) == 1, "index.html 里找不到 statusbar，锚点变了"
        write("web/index.html", s.replace(anchor, html))
        did.append("index.html")

    print("  ✓ 手机端补丁：" + ("、".join(did) + " 已打上" if did else "本来就已经打过了"))


def revert():
    r = subprocess.run(["git", "status", "--porcelain", "--"] + FILES, cwd=str(ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    dirty = [l.strip() for l in r.stdout.splitlines() if l.strip()]
    if dirty:
        print("  ✗ 这三个文件有未提交的改动，git checkout 会把它们一起抹掉 ✗")
        for l in dirty[:6]:
            print("     " + l)
        print("  → 先提交，或者改用 python mobile/build.py（它会拍字节快照 ✓）")
        raise SystemExit(1)
    subprocess.run(["git", "checkout", "--"] + FILES, cwd=str(ROOT), check=True)
    print("  ✓ web/ 三个文件已退回上一条提交（桌面版原样）")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "apply"
    if what == "revert":
        revert()
    else:
        apply()
