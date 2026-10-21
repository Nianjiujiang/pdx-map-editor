"""把编辑器打成一个自包含的 HTML —— 双击就能用，不用起服务。

    python build_standalone.py            # **轻量版**：不内嵌地图（约 0.6 MB）✓ 默认
    python build_standalone.py --all-maps # 全量版：把所有地图烘进去（约 35 MB）

2026-10-12 起**默认出轻量版** ✗ —— 地图改成 `.pdxmap` 包单独发（见 `build_packs.py`）：
一个 0.6 MB 的编辑器 + 玩家按需下 0.8~12 MB 的地图包，比"人人下 35 MB"划算得多 ✓
全量版（`--all-maps`）留着：本地自用、或者要发"离线一把梭"的版本时用 ✓

file:// 协议下 fetch 和 ES module 都会被浏览器拦掉，
所以这里把 JS 合成一段普通脚本、数据用 base64 内嵌，绕开这两个限制。
（**轻量版没有内嵌数据**，但拼接方式不变 —— 只是 maps 空着 ✓）

要烘地图才需要先跑 ``build_data.py``（轻量版不需要）。
"""

from __future__ import annotations

import argparse
import base64
import gzip
import json
import re
import sys
import time
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"
OUT = ROOT / "pdx-map-editor.html"

#: 可选的地图 —— **一份表，两个用途** ✓
#:   ① `--all-maps` 时把它们烘进单文件（全量版）
#:   ② `build_packs.py` 按同一份表打 `.pdxmap` 地图包（轻量版的配菜）
#: **别在别处再抄一份** ✗ 抄两份迟早对不上（拍平清单就抄了三份，为此踩过两回 ✓）
#:
#: 字段：emb 键（app.js 的 MAP_CHOICES 认这个）/ 包 id / 显示名 / 缓存目录 / 卡片副标题
#: ⚠ **EU4HD 不在这张表里**：那是创意工坊模组的地图，没拿到作者授权 ——
#:   既不内嵌、也不打包对外发 ✓（本地想用就把条目加回来，走 `python server.py` 照样看得到）
MAPS = (
    ("vanilla", "pdx-ck3-vanilla", "CK3 原版", "data", "9216 × 4608"),
    ("eu4", "pdx-eu4-vanilla", "EU4 原版", "data_eu4", "5632 × 2048"),
    ("hoi4", "pdx-hoi4-vanilla", "HOI4 原版", "data_hoi4", "5632 × 2048"),
    ("hoi4alt", "pdx-hoi4-alt", "HOI4 修改边界", "data_hoi4_alt", "5632 × 2048"),  # note 保持跟旧包一致（见下 ✓）
    # 🔴 2026-10-16 用户定的：显示名「VIC3」（原来是 `V3` ✓）
    #   ⚠ 只改**给人看的名字** ✗ —— 包 id（`pdx-vic3-vanilla`）与缓存目录
    #     （`data_vic3`）一律不动 ✓（那是数据 / 发布物的标识 ✓ 改了老包就接不上 ✓）
    ("vic3", "pdx-vic3-vanilla", "VIC3 原版", "data_vic3", "8192 × 3616"),
    ("eu5", "pdx-eu5-vanilla", "EU5 原版", "data_eu5", "8192 × 4096"),
    ("eu5full", "pdx-eu5-full", "EU5 原尺寸", "data_eu5_full", "16384 × 8192"),
)

#: 拼接顺序有讲究：log 最前（报错日志要在 app 跑之前就挂上 ✓），app 最后
#: （app 一加载就会跑起来）。tools/lib/browser_stub.js 里有一份同样的清单，
#: 改这里记得一起改 —— 漏了的话那套桩里没有 PDXLOG，app.js 一取就炸 ✗
#:
#: pack.js / packstore.js 是「导入式地图」那套（见 docs/导入式地图-策划.md）：
#:   pack.js      校验器（纯函数，自带流式 SHA-256）
#:   packstore.js 存到 IndexedDB（映射包、导出备份）
#: 这两个必须在 data.js **前面**：data.js 的第三数据源要调 packstore 的 getFile ✓
#: ⚠ 拍平只认行首那种静态 import ✗ —— 里面别写 `await import('./zip.js')`，
#:   那种写法会被原样留在产物里，file:// 下必炸 ✓
MODULES = ("log.js", "pack.js", "zip.js", "packstore.js", "fonts.js", "bitmapfont.js", "data.js", "bmp.js",
           "gl.js", "labels.js", "tilemap.js", "tutorial.js", "app.js")


def strip_module(src: str) -> str:
    """把 ES module 拍平成普通脚本：去掉 import，剥掉 export。"""
    out = []
    for line in src.splitlines():
        s = line.strip()
        if s.startswith("import ") or s.startswith("import{"):
            continue
        if s.startswith("export "):
            line = line.replace("export ", "", 1)
        out.append(line)
    return "\n".join(out)


def _tiles_js(d) -> str:
    """把 tiles.json 与每一块都嵌成 base64（单文件版没法 fetch ✗）。"""
    man = (d / "tiles.json").read_text(encoding="utf-8")
    files = []
    for f in __import__("json").loads(man)["files"]:
        raw = (d / "tiles" / f["name"]).read_bytes()
        # 键名**必须加引号** ✗ —— t_0_0.bin 不加会被 JS 当成 "t_0_0 点 bin"，
        # 于是整个内嵌数据在第 1314 行左右报 Unexpected token '.'
        files.append('"%s":"%s"' % (f["name"], b64(raw)))
    return f'manifest:{man},files:{{' + ",".join(files) + "}"


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


#: 「本机路径」的样子：盘符开头 / UNC / 根斜杠开头
_ABS_PATH = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|/)")


def strip_local_paths(meta_text: str) -> tuple[str, list[str]]:
    """把 meta 里**做数据那台机器**上的路径去掉 —— 单文件是要发出去的 ✗

    这些字段是烘数据时记下来的来路（游戏装在哪、本工程在哪、覆盖图在哪），
    **编辑器运行时一个都不用**（只有 gameVersion 会被读来显示版本号 ✓），
    留着只会把本机目录结构一起发出去。data/ 里的那份原样不动 ——
    开发时的 server/preview/重烘脚本还要看它们 ✓
    """
    meta = json.loads(meta_text)
    dropped: list[str] = []
    for k in list(meta.keys()):
        v = meta[k]
        if isinstance(v, str) and _ABS_PATH.match(v.strip()):
            dropped.append(f"{k}={v}")
            del meta[k]
    if not dropped:
        return meta_text, dropped
    return json.dumps(meta, ensure_ascii=False, separators=(",", ":")), dropped


def main() -> int:
    ap = argparse.ArgumentParser(
        description="把编辑器打成一个自包含的 HTML",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--all-maps", action="store_true",
                    help="把所有地图烘进去（约 35 MB）；不加就是轻量版（约 0.6 MB）✓")
    ap.add_argument("--out", default=None, help="输出文件，默认 pdx-map-editor.html")
    args = ap.parse_args()

    want_maps = list(MAPS) if args.all_maps else []
    if want_maps and not (DATA / "meta.json").is_file():
        print("!! 要内嵌地图就得先构建缓存：python build_data.py")
        return 1

    print("读取前端资源 …")
    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "style.css").read_text(encoding="utf-8")

    # ---- 构建戳（2026-10-17 加）
    # 启动页 / 诊断报告里的"版本戳"**不能拿 document.lastModified** ✗ ——
    # 单文件版 / 某些浏览器里它是**当前时间**，看着像版本戳一直在变 ✓
    # 这里把打包时间写进 <meta name="pdx-build">，产物里就是固定的那一份 ✓
    build_stamp = time.strftime("%Y-%m-%d %H:%M")
    _meta_dev = '<meta name="pdx-build" content="dev">'
    if _meta_dev in html:
        html = html.replace(_meta_dev, f'<meta name="pdx-build" content="{build_stamp}">')
        print(f"  构建戳 {build_stamp}")
    else:
        print("!! 没找到 pdx-build meta —— 启动页版本戳会留空（web/index.html 结构变了？）")

    parts = []
    for name in MODULES:
        src = (WEB / "js" / name).read_text(encoding="utf-8")
        parts.append(f"// ==================== {name} ====================\n{strip_module(src)}")
    js = "\n\n".join(parts)

    blocks = []
    if want_maps:
        print("压数据 …")
        # 只压表里那几张游戏自带的 ✓
        # 创意工坊模组那两张图没拿到模组作者授权，既不内嵌也不打包 ✗
        # （本地留着，走 `python server.py` 照常能用 ✓）
        for key, _pack_id, _label, dirname, _note in want_maps:
            d = ROOT / dirname
            if not (d / "meta.json").is_file():
                print(f"  跳过 {key}：{d.name}/ 里没有 meta.json")
                continue
            titles_gz = gzip.compress((d / "titles.json").read_bytes(), 9)
            # 带 tiles.json 的地图（EU5 原尺寸）走分块：**不嵌整图 id** ✗
            # （原尺寸那张解压后 256MB，分块路径根本不用它）
            # 带分块的地图**也要**嵌整图 id —— 它是"分块初始化失败"时的兜底 ✗
            # （不嵌的话，一旦那条路出错，退回普通路径也会因为空数据炸掉 → 白屏 ✗）
            provinces = (d / "provinces_id.bin").read_bytes()
            titlemap = (d / "titlemap.bin").read_bytes()
            adjacency = (d / "adjacency.bin").read_bytes()
            prov_pos = (d / "prov_pos.bin").read_bytes()
            meta = (d / "meta.json").read_text(encoding="utf-8")
            meta, _dropped = strip_local_paths(meta)
            for _d in _dropped:
                print(f"    （去掉本机路径：{_d}）")
            print(f"  {key}: 头衔表 {len(titles_gz) / 1024:.0f} KB（gzip）"
                  f" / 省份图 {len(provinces) / 1024:.0f} KB")
            blocks.append(
                f"{key}:{{\n"
                f"meta:{meta},\n"
                f'titles:"{b64(titles_gz)}",\n'
                f'provinces:"{b64(provinces)}",\n'
                f'titlemap:"{b64(titlemap)}",\n'
                f'adjacency:"{b64(adjacency)}",\n'
                f'provPos:"{b64(prov_pos)}"'
                + ((",\ntiles:{" + _tiles_js(d) + "}") if (d / "tiles.json").is_file() else "")
                + "\n}"
            )

    payload = "window.__CK3_EMBEDDED__={maps:{\n" + ",\n".join(blocks) + "\n}};"
    if blocks:
        print(f"  内嵌数据合计 {len(payload) / 1048576:.2f} MB（base64 后）")
    else:
        print("  没内嵌任何地图 —— 这是**轻量版** ✓")
        print("  玩家在选图那一页导入 .pdxmap 就能用；那些包由 build_packs.py 打 ✓")

    # ---- 拼 HTML
    # 1) 外链 CSS 换成内联
    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{css}\n</style>")

    # 2) 删掉那段 file:// 拦截（单文件版本来就该用 file:// 打开）
    #    ⚠ **不能只看第一个 `<script>`** ✗（2026-10-20 踩到 ✓）
    #      用户在 `<head>` 里加了个"先定主题"的小脚本 → 它成了第一个，
    #      于是这儿检查到的是主题脚本、拦截图原样留在产物里 ✗
    #    → 按内容找：哪个 script 里有 `location.protocol` 就删哪个 ✓
    m = re.search(r'[ \t]*<script>(?:(?!</script>).)*?location\.protocol(?:(?!</script>).)*?</script>[ \t]*\r?\n?',
                  html, re.S)
    if m:
        html = html[:m.start()] + html[m.end():]

    # 3) 模块入口换成内联的普通脚本
    html = html.replace(
        '<script type="module" src="js/app.js"></script>',
        f"<script>\n{payload}\n{js}\n</script>",
    )

    # 4) 🔴 **删掉那两个「传统脚本」标签** ✗✗（2026-10-14 ✓ 用户报的 ✓）
    #
    #   用户报的："Failed to load resource: **net::ERR_FILE_NOT_FOUND**  tutorial.js:1"
    #
    #   ⚠ `web/index.html` 里有**三句** script ✗：
    #       <script src="js/log.js"></script>        ← 传统脚本（给 window.PDXLOG ✓）
    #       <script src="js/tutorial.js"></script>   ← 传统脚本
    #       <script type="module" src="js/app.js">   ← 模块入口（上面那句替换的就是它 ✓）
    #     而 `MODULES` 里**这两个都已经内联进 payload 了** ✓（见上面那份名单 ✓）
    #     → 留着这两句，单文件版会去抓**旁边根本不存在的** `js/log.js` / `js/tutorial.js` ✗
    #       控制台就报 `ERR_FILE_NOT_FOUND` ✓（桌面版 + 手机版都有 ✓ 实跑确认过 ✓）
    #
    #   ⚠ 顺序不受影响 ✗ —— 拍平是按 `MODULES` 的顺序来的 ✓
    #     `log.js` 在第一位、`tutorial.js` 在 `app.js` 前面 ✓ 跟原来那两句的先后一致 ✓
    #   ⚠ **别去删 `web/index.html` 里那两句** ✗ —— 开发版（直接开 `web/index.html`）
    #     还得靠它们加载 ✓ 这里删的只是**烤出来的那一份** ✓
    for _tag in ('<script src="js/log.js"></script>',
                 '<script src="js/tutorial.js"></script>'):
        html = html.replace(_tag, '')
    # 顺手把整行（含缩进和换行）也收掉，别在产物里留一串空行 ✓
    html = re.sub(r'[ \t]*<script src="js/(?:log|tutorial)\.js"></script>[ \t]*\r?\n',
                  '', html)

    if "__CK3_EMBEDDED__" not in html:
        print("!! 没找到 <script type=\"module\" src=\"js/app.js\">，index.html 结构变了？")
        return 1

    out = Path(args.out) if args.out else OUT
    out.write_text(html, encoding="utf-8")
    print(f"\n写好了：{out}")
    print(f"  {out.stat().st_size / 1048576:.2f} MB —— 双击这个文件就能用")
    if not blocks:
        print("  （轻量版：把 packs/ 里的 .pdxmap 一起发出去，玩家在选图那页导入 ✓）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
