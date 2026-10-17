# -*- coding: utf-8 -*-
"""把 app.js 注释里被吞掉的中文标点还原回去。

    python tools/fix_comments.py --dry    # 只看会改哪几处
    python tools/fix_comments.py          # 真改

替换表在 tools/comment_fixes.json 里，一条一条写死的（精确片段匹配）——
不做任何"猜标点"的规则推断：猜错一次就是往注释里塞一句错话，
而注释错了没人查得出来。

背景：app.js 的注释在很久以前被某种编码事故伤过一轮 ——
`——`、`"`、`。`、反引号 被换成了 ASCII 单引号，还连带吃掉紧挨着的一个字
（`编辑器 —— 主逻辑` 成了 `编辑'—'主逻辑'`）。git 的每一版、`_local/_webbak`、
连发布出去的 37MB 单文件版都带着它，没有干净版本可以回滚，只能按语义补。

只动注释：非注释行（JS 字符串、代码）一处都不碰，表里也全是注释片段。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "web" / "js" / "app.js"
DEFAULT_TABLE = Path(__file__).resolve().parent / "comment_fixes.json"


def main() -> int:
    dry = "--dry" in sys.argv
    rest = [a for a in sys.argv[1:] if not a.startswith("--")]
    table = Path(rest[0]) if rest else DEFAULT_TABLE
    pairs = json.loads(table.read_text(encoding="utf-8"))["pairs"]
    text = TARGET.read_text(encoding="utf-8")

    print("表的来路：%s" % table.name)

    changed = 0
    missing: list[str] = []
    skipped: list[str] = []
    for old, new in pairs:
        n = text.count(old)
        if n == 0:
            missing.append(old)
            continue
        if n > 1:
            skipped.append("%d×  %s" % (n, old))
            continue
        idx = text.index(old)
        line_start = text.rfind("\n", 0, idx) + 1
        line = text[line_start:text.find("\n", idx)]
        s = line.strip()
        if not (s.startswith("//") or s.startswith("*") or s.startswith("/*")):
            skipped.append("不在注释里：" + old)
            continue
        text = text.replace(old, new, 1)
        changed += 1

    print("替换表 %d 条 -> 改了 %d 处" % (len(pairs), changed))
    if missing:
        print("\n!! 有 %d 条原文里找不到（片段可能已被别的改动动过）：" % len(missing))
        for m in missing:
            print("   ", m[:100])
    if skipped:
        print("\n!! 有 %d 条不唯一 / 不在注释里，没改：" % len(skipped))
        for a in skipped:
            print("   ", a[:100])

    if not dry:
        TARGET.write_text(text, encoding="utf-8")
        print("\n已写入 %s" % TARGET)
    else:
        print("\n（--dry：没写盘）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
