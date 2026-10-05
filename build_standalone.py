"""把编辑器打成一个自包含的 HTML —— 双击就能用，不用起服务。

    python build_standalone.py

出来的 ``pdx-map-editor.html`` 约 30 MB：网页、脚本和六套游戏自带地图的数据
全在里面。file:// 协议下 fetch 和 ES module 都会被浏览器拦掉，
所以这里把 JS 合成一段普通脚本、数据用 base64 内嵌，绕开这两个限制。

要跑 ``build_data.py`` 生成 data/ 之后才用得了。
"""

from __future__ import annotations

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

#: 拼接顺序有讲究：data/zip/bmp 先，app 最后（app 一加载就会跑起来）
MODULES = ("data.js", "zip.js", "bmp.js", "gl.js", "labels.js", "tilemap.js", "tutorial.js", "app.js")


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
    if not (DATA / "meta.json").is_file():
        print("!! 还没构建缓存，先跑 python build_data.py")
        return 1

    print("读取前端资源 …")
    html = (WEB / "index.html").read_text(encoding="utf-8")
    css = (WEB / "style.css").read_text(encoding="utf-8")

    parts = []
    for name in MODULES:
        src = (WEB / "js" / name).read_text(encoding="utf-8")
        parts.append(f"// ==================== {name} ====================\n{strip_module(src)}")
    js = "\n\n".join(parts)

    print("压数据 …")
    # 有几套地图就压几套 —— **只压游戏自带的那几套** ✓
    # 创意工坊模组那两张图没拿到模组作者授权，不进这个对外发的文件 ✗
    # （本地留着，走 `python server.py` 照常能用 ✓）
    maps = [("vanilla", ROOT / "data"),
            ("eu4", ROOT / "data_eu4"),
            ("hoi4", ROOT / "data_hoi4"),
            ("hoi4alt", ROOT / "data_hoi4_alt"),      # HOI4 换了自己改过的边界图
            ("vic3", ROOT / "data_vic3"),
            ("eu5", ROOT / "data_eu5"),
            ("eu5full", ROOT / "data_eu5_full")]
    blocks = []
    for key, d in maps:
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

    if not blocks:
        print("!! 一套地图数据都没有，先跑 python build_data.py")
        return 1

    payload = "window.__CK3_EMBEDDED__={maps:{\n" + ",\n".join(blocks) + "\n}};"
    print(f"  内嵌数据合计 {len(payload) / 1048576:.2f} MB（base64 后）")

    # ---- 拼 HTML
    # 1) 外链 CSS 换成内联
    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{css}\n</style>")

    # 2) 删掉那段 file:// 拦截（单文件版本来就该用 file:// 打开）
    start = html.find("<script>")
    end = html.find("</script>", start)
    if start != -1 and "location.protocol" in html[start:end]:
        html = html[:start] + html[end + len("</script>"):]

    # 3) 模块入口换成内联的普通脚本
    html = html.replace(
        '<script type="module" src="js/app.js"></script>',
        f"<script>\n{payload}\n{js}\n</script>",
    )

    if "__CK3_EMBEDDED__" not in html:
        print("!! 没找到 <script type=\"module\" src=\"js/app.js\">，index.html 结构变了？")
        return 1

    OUT.write_text(html, encoding="utf-8")
    print(f"\n写好了：{OUT}")
    print(f"  {OUT.stat().st_size / 1048576:.2f} MB —— 双击这个文件就能用")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
