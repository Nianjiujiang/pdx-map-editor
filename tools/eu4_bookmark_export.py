# -*- coding: utf-8 -*-
"""导出 EU4 全部历史剧本（bookmark）的开场白：英文原文 + 汉化译文。

英文：本体 ``common/bookmarks/*.txt`` 只给词条名，正文在
      ``localisation/*_l_english.yml``（纯 UTF-8）。
中文：创意工坊汉化 mod 顶替 english 槽位，走本项目既有的双字节解码器
      ``parsers.eu4.hanhua``（见该文件顶上的编码说明）。

    python eu4_bookmark_export.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")

from parsers.eu4 import hanhua

EU4 = Path(r"C:\Steam\steamapps\common\Europa Universalis IV")
WORKSHOP = Path(r"C:\Steam\steamapps\workshop\content")
APPID = 236850
OUT = ROOT / "EU4剧本开场白.md"

#: 汉化 mod 的工坊 id → 说明（本地装了什么就写什么）
MOD_NOTES = {
    "2976470733": ("Chinese Language Mod for 1.37", "主汉化，覆盖 `localisation/` 全部词条"),
    "1999055990": ("Chinese Language Supplementary Mod for 1.37", "补充包，含 `common/`、`events/`、`history/`、`missions/` 等"),
    "3468672461": ("简中地图字体-颜真卿多宝塔碑体", "中文字体（汉化显示所需）"),
}

_LINE = re.compile(r'(?m)^\s*([A-Za-z0-9_.\'\-]+)\s*:\s*\d*\s*"(.*)"\s*$')


def load_plain(loc_dir: Path) -> dict[str, str]:
    """读本体（普通 UTF-8）localisation 目录 → {key: 文本}。"""
    out: dict[str, str] = {}
    for fp in sorted(Path(loc_dir).glob("*.yml")):
        txt = fp.read_text(encoding="utf-8", errors="replace").replace("\ufeff", "")
        for m in _LINE.finditer(txt):
            out.setdefault(m.group(1), m.group(2))
    return out


def main() -> None:
    # 先把 15 个剧本的词条名收齐，用来给候选汉化打分
    bookmark_files = sorted((EU4 / "common" / "bookmarks").glob("*.txt"))
    want: set[str] = set()
    for fp in bookmark_files:
        t = fp.read_text(encoding="utf-8")
        want |= set(re.findall(r'(?:name|desc)\s*=\s*"([^"]+)"', t))

    # find_hanhua 的启发式会误判（比如带中文的界面 mod），所以按
    # "能解出多少剧本词条 → 是不是纯翻译 mod → 词条总数" 来挑。
    # 大型整合 mod（如风云世纪两千年）也带汉化文本，但它不是"汉化模组"。
    def is_translation(mod: Path) -> bool:
        d = mod / "descriptor.mod"
        return d.is_file() and '"Translation"' in d.read_text(encoding="utf-8", errors="replace")

    best, best_cn, best_key = None, {}, (-1, False, -1)
    for mod in hanhua.find_hanhua(WORKSHOP, APPID):
        d = hanhua.load_dir(mod / "localisation")
        key = (len(want & set(d)), is_translation(mod), len(d))
        print(f"  候选 {mod.name:>12}  词条 {len(d):>7}  命中剧本词条 {key[0]}  纯翻译 {key[1]}")
        if key > best_key:
            best, best_cn, best_key = mod, d, key
    if best is None:
        raise SystemExit("没找到汉化 mod")
    print("采用汉化 mod：", best.name)
    cn = best_cn

    en = load_plain(EU4 / "localisation")

    rows = []
    for fp in bookmark_files:
        t = fp.read_text(encoding="utf-8")
        pick = lambda p: (re.search(p, t).group(1) if re.search(p, t) else "")
        rows.append(dict(
            file=fp.name,
            name=pick(r'name\s*=\s*"([^"]+)"'),
            desc=pick(r'desc\s*=\s*"([^"]+)"'),
            date=pick(r'date\s*=\s*([\d.]+)'),
            countries=list(dict.fromkeys(re.findall(r'(?m)^\s*country\s*=\s*([A-Z0-9]{3})', t))),
            easy=set(re.findall(r'(?m)^\s*easy_country\s*=\s*([A-Z0-9]{3})', t)),
        ))
    rows.sort(key=lambda r: [int(x) for x in r["date"].split(".")])

    L: list[str] = []
    L.append("# EU4 全部 15 个历史剧本 · 开场白全文")
    L.append("")
    L.append("英文原文取自游戏本体：`common/bookmarks/*.txt` 只指定词条名，正文在 `localisation/*_l_english.yml`。")
    L.append("中文取自创意工坊汉化 mod `Chinese Language Mod for 1.37`（顶替 english 槽位）解码后的显示文本。")
    L.append("")

    for r in rows:
        y, m, d = r["date"].split(".")
        L.append(f"## {y} 年 {int(m)} 月 {int(d)} 日 — {cn.get(r['name'], '（汉化缺失）')}（{en.get(r['name'], r['name'])}）")
        L.append("")
        L.append(f"* 脚本文件：`common/bookmarks/{r['file']}`　词条：`{r['name']}` / `{r['desc']}`")
        if r["countries"]:
            names = "、".join(
                ("★" if c in r["easy"] else "") + f"{cn.get(c, c)}（{c}）" for c in r["countries"]
            )
            L.append(f"* 剧本国家：{names}　（★＝新手推荐）")
        L.append("")
        L.append("**【汉化】开场白**")
        L.append("")
        L.append("> " + cn.get(r["desc"], "（汉化缺失）").replace("\n", "\n> "))
        L.append("")
        L.append("**【英文原文】**")
        L.append("")
        L.append("> " + en.get(r["desc"], "（原文缺失）").replace("\n", "\n> "))
        L.append("")
        L.append("---")
        L.append("")

    L.append("## 附：本机装的汉化模组")
    L.append("")
    L.append("| 模组 | 创意工坊 ID | 说明 |")
    L.append("| --- | --- | --- |")
    for mid, (nm, note) in MOD_NOTES.items():
        L.append(f"| {nm} | {mid} | {note} |")
    L.append("")
    L.append("链接：" + " ｜ ".join(
        f"https://steamcommunity.com/sharedfiles/filedetails/?id={m}" for m in MOD_NOTES))
    L.append("")
    L.append("### 汉化文本的「双字节」是怎么解的")
    L.append("")
    L.append("汉化 mod 的 yml 直接打开是一堆控制字符，它套了两层：")
    L.append("")
    L.append("1. 外层：整份文件是**原始字节流按 cp1252 解码后**再存成 UTF-8 的，所以要 `utf-8 读 → cp1252 编`倒回字节流。")
    L.append("   必须是 cp1252 不能是 latin-1 —— `0x80–0x9F` 那一段两者不同，用 latin-1 会把 `9A`、`97` 这类字节弄丢。")
    L.append("2. 内层：汉字三字节一组 `<标记> <低字节> <高字节>`，码位 = `(高 << 8 | 低) + 偏移(标记)`。标记字节 `0x10–0x13`，低两位是标志位：")
    L.append("")
    L.append("   | 标记 | 偏移 |")
    L.append("   | --- | --- |")
    L.append("   | `0x10` | 0 |")
    L.append("   | `0x11` | `-0x0E` |")
    L.append("   | `0x12` | `+0x900` |")
    L.append("   | `0x13` | `+0x8F2`（= `0x900 - 0x0E`） |")
    L.append("")
    L.append("ASCII（`$变量$`、`§Y` 颜色码、`£adm`、`¤`）原样单字节。")
    L.append("解码器是项目里已有的 `parsers/eu4/hanhua.py`，本文件由 `eu4_bookmark_export.py` 生成。")

    OUT.write_text("\n".join(L), encoding="utf-8")
    print("写出：", OUT, "剧本数：", len(rows))


if __name__ == "__main__":
    main()
