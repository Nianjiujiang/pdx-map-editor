"""本地服务：把编辑器跑起来。

    python server.py            # 起服务并打开浏览器
    python server.py --port 9000 --no-open
"""

from __future__ import annotations

import argparse
import io
import json
import posixpath
import re
import sys
import threading
import time
import urllib.parse
import webbrowser
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

#: 头衔层级 → CK3 里检查用的前缀说明（导出 mod 时写进说明文件）
TIER_LABEL = {"e": "帝国", "k": "王国", "d": "公爵领", "c": "伯爵领", "b": "男爵领"}


class Handler(SimpleHTTPRequestHandler):
    server_version = "CK3MapEditor/1.0"

    # ---------------------------------------------------------- 路由
    def translate_path(self, path: str) -> str:
        # 父类会先 normpath 掉 `..`，这里整个重写了就得自己做 —— 不然
        # GET /../server.py 这类路径会被 OS 解析到 WEB 之外，本机任意
        # 进程都能借这个端口读文件。
        raw = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
        denied = str(ROOT / "__denied__")   # 必然不存在的路径 → 404
        # /data/、/data_miller/ 之类都映射到项目下的同名目录
        m = re.match(r"^/(data[a-z0-9_]*)/(.*)$", raw)
        if m:
            sub = posixpath.normpath(m.group(2))
            if sub.startswith(".."):
                return denied
            return str(ROOT / m.group(1) / sub)
        if raw.startswith("/api/"):
            return denied   # API 不走文件系统（未知 API 由 do_GET/do_POST 回 404）
        if raw in ("/", ""):
            return str(WEB / "index.html")
        rel = posixpath.normpath(raw.lstrip("/"))
        if rel in ("", "."):
            return str(WEB / "index.html")
        if rel.startswith(".."):
            return denied
        return str(WEB / rel)

    def do_GET(self):  # noqa: N802
        route = self.path.split("?")[0]
        if route == "/api/status":
            return self.send_json(self.status_payload())
        if route.startswith("/api/"):
            return self.send_json({"ok": False, "error": "unknown api"}, 404)
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        route = self.path.split("?")[0]
        if route == "/api/export":
            return self.handle_export()
        self.send_error(404, "unknown api")

    # ---------------------------------------------------------- 工具
    def send_json(self, obj, status: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def status_payload(self) -> dict:
        meta = {}
        mp = DATA / "meta.json"
        if mp.is_file():
            try:
                meta = json.loads(mp.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                meta = {}
        return {"ok": True, "time": time.time(), "meta": meta, "hasData": bool(meta)}

    def end_headers(self) -> None:
        # 本地开发服务器，一律禁缓存。按后缀挑着禁会漏（`/` 这个路径就不以 .html 结尾），
        # 漏一次的表现就是"改完没反应、得手动加 ?v=N"，所以干脆全禁。
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def guess_type(self, path):
        p = str(path).lower()
        if p.endswith((".html", ".htm")):
            return "text/html; charset=utf-8"
        if p.endswith(".js"):
            return "text/javascript; charset=utf-8"
        if p.endswith(".css"):
            return "text/css; charset=utf-8"
        if p.endswith(".json"):
            return "application/json; charset=utf-8"
        if p.endswith(".bin"):
            return "application/octet-stream"
        return super().guess_type(path)

    # ---------------------------------------------------------- 导出 CK3 mod
    def handle_export(self) -> None:
        """把改过的颜色打包成一个 CK3 mod（zip）。

        CK3 对 landed_titles 是**按块覆盖**的：后加载的文件里同名的头衔块
        会盖掉前面的。所以只需要把动过的颜色写出去，不必复制整份原文件。
        """
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return self.send_error(400, "bad payload")

        changes = payload.get("changes") or []   # [{key, tier, color:[r,g,b]}]
        mod_name = (payload.get("name") or "CK3颜色编辑").strip() or "CK3颜色编辑"
        if not changes:
            # send_error 的短语要按 latin-1 编码，中文会直接把错误路径炸掉
            #（客户端收到的是连接被掐断，不是 400）
            return self.send_json({"ok": False, "error": "还没有改过任何颜色"}, 400)

        # 按层级分组，写多个文件，方便在 CK3 里单独关掉某一层
        by_tier: dict[str, list[dict]] = {}
        for ch in changes:
            key = str(ch.get("key", ""))
            tier = key[:1] if key else "?"
            if tier not in TIER_LABEL:
                continue
            by_tier.setdefault(tier, []).append(ch)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            safe = "".join(c for c in mod_name if c not in '\\/:*?"<>|').strip() or "ck3_colors"
            z.writestr(
                "descriptor.mod",
                "\n".join([
                    # name 原样嵌进引号 —— 名字里带个引号 descriptor.mod 就废了
                    f'name="{mod_name.replace(chr(34), chr(39)).replace(chr(10), " ")}"',
                    'version="1.0.0"',
                    'tags={ "Utilities" }',
                    'supported_version="1.16.*"',
                    f'path="mod/{safe}"',
                ]) + "\n",
            )
            for tier, items in sorted(by_tier.items()):
                lines = [
                    f"# {TIER_LABEL[tier]}颜色（由 CK3 地图编辑器导出）",
                    "# 只写了颜色，其它字段保持游戏原样。",
                    "",
                ]
                for ch in sorted(items, key=lambda x: x["key"]):
                    r, g, b = (int(v) & 0xFF for v in ch["color"])
                    lines.append(f"{ch['key']} = {{")
                    lines.append(f"\tcolor = {{ {r} {g} {b} }}")
                    lines.append("}")
                    lines.append("")
                z.writestr(f"common/landed_titles/zz_editor_{tier}.txt",
                           "\n".join(lines).encode("utf-8"))

        body = buf.getvalue()
        stamp = time.strftime("%Y%m%d_%H%M%S")
        filename = f"ck3_colors_{stamp}.zip"
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        msg = fmt % args
        if "/data/" in msg and "200" in msg:
            return  # 别刷屏
        sys.stderr.write(f"  {msg}\n")


def main() -> int:
    ap = argparse.ArgumentParser(description="CK3 地图编辑器服务")
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()

    if not (DATA / "meta.json").is_file():
        print("!! data/ 里还没有缓存，先跑一次：python build_data.py")
        return 1

    url = f"http://{args.host}:{args.port}/"
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print("=" * 56)
    print("  CK3 地图编辑器已启动")
    print(f"  {url}")
    print("  Ctrl+C 停止")
    print("=" * 56)

    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n拜拜～")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
