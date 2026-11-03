"""把根目录的单文件产物传到 GitHub release（覆盖同名附件）。

用法：
    set SSL_CERT_FILE=C:/Users/lyc20/.git-certs/ca-bundle-pdx.pem
    py tools/upload_assets.py --tag v1.11.0 pdx-map-editor.html pdx-map-editor-mobile.html
    py tools/upload_assets.py --tag v1.11.0 --dry-run pdx-map-editor.html

为什么要 SSL_CERT_FILE：这台机器上 GitHub 的证书由 Watt Toolkit 中间人签发，
Python 默认信任不了；指向 git 用的那份合并 CA（Git 自带 + SteamTools）就能过。

令牌从环境变量 GITHUB_TOKEN / GH_TOKEN 或 .publish.env 里读。
"""

import argparse
import hashlib
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = "Nianjiujiang/pdx-map-editor"
API = "https://api.github.com"


def read_token():
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok:
        return tok.strip()
    env_file = os.path.join(ROOT, ".publish.env")
    if os.path.exists(env_file):
        with open(env_file, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                for key in ("GITHUB_TOKEN=", "GH_TOKEN="):
                    if line.startswith(key):
                        return line.split("=", 1)[1].strip()
    sys.exit("找不到令牌：请设 GITHUB_TOKEN 环境变量，或写进根目录 .publish.env")


def make_ctx():
    cafile = os.environ.get("SSL_CERT_FILE")
    if cafile and os.path.exists(cafile):
        return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


def call(ctx, tok, url, method="GET", data=None, ctype="application/json"):
    headers = {
        "Authorization": "Bearer " + tok,
        "Accept": "application/vnd.github+json",
        "User-Agent": "pdx-map-editor/upload-assets",
    }
    if data is not None:
        headers["Content-Type"] = ctype
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=120) as r:
            body = r.read()
            return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        sys.exit(f"GitHub 返回 {e.code}：{detail}")


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser(description="把文件传到 GitHub release，覆盖同名附件")
    ap.add_argument("files", nargs="+", help="要传的本地文件（相对项目根目录）")
    ap.add_argument("--tag", default="v1.11.0", help="release 标签，默认 v1.11.0")
    ap.add_argument("--dry-run", action="store_true", help="只打印要做什么")
    args = ap.parse_args()

    tok = read_token()
    ctx = make_ctx()

    status, rel = call(ctx, tok, f"{API}/repos/{REPO}/releases/tags/{args.tag}")
    if status != 200 or not rel:
        sys.exit(f"取不到 release {args.tag}")
    rel_id = rel["id"]
    have = {a["name"]: a for a in rel["assets"]}

    for name in args.files:
        path = os.path.join(ROOT, name)
        if not os.path.exists(path):
            sys.exit(f"本地没有这个文件：{name}")
        size = os.path.getsize(path)
        digest = sha256_of(path)
        old = have.get(os.path.basename(name))
        print(f"{os.path.basename(name)}  本地 {size} B  sha256 {digest[:12]}…")
        if old:
            print(f"  远端已有同名附件：{old['size']} B（id {old['id']}）→ 先删再传")
        else:
            print("  远端没有，直传")
        if args.dry_run:
            continue
        if old:
            call(ctx, tok, f"{API}/repos/{REPO}/releases/assets/{old['id']}", method="DELETE")
        with open(path, "rb") as f:
            blob = f.read()
        up = (
            f"https://uploads.github.com/repos/{REPO}/releases/{rel_id}/assets"
            f"?name={urllib.request.quote(os.path.basename(name))}"
        )
        status, asset = call(ctx, tok, up, method="POST", data=blob,
                             ctype="application/octet-stream")
        if status not in (200, 201):
            sys.exit(f"上传失败：{status}")
        print(f"  ✓ 传好了：{asset['size']} B  {asset['browser_download_url']}")

    # 收尾核验：重新拉一遍，逐项比字节数
    status, rel2 = call(ctx, tok, f"{API}/repos/{REPO}/releases/tags/{args.tag}")
    after = {a["name"]: a["size"] for a in rel2["assets"]}
    print("\n附件现状：")
    ok = True
    for name in args.files:
        base = os.path.basename(name)
        local = os.path.getsize(os.path.join(ROOT, name))
        remote = after.get(base)
        mark = "✓" if remote == local else "✗"
        if remote != local:
            ok = False
        print(f"  {mark} {base}: 远端 {remote} / 本地 {local}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
