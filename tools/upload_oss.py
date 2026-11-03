# -*- coding: utf-8 -*-
"""把地图包传到阿里云 OSS 桶里（编辑器的国内快路第一跳）。

为什么要这一步：
    编辑器取包时按 `PACK_HOPS` 顺序试：OSS → Cloudflare Worker → 公共加速代理 → 直连。
    第一个能通的就用；所以 OSS 里必须有**和 GitHub Release 附件同名**的那份文件 ✓
    （前端只按附件文件名拼 OSS 地址 —— `web/js/app.js` 里的 `packOSSUrl()` ✓）

    OSS 桶的跨域要能读到字节（实测已配好：`Access-Control-Allow-Origin: *`、
    `Access-Control-Allow-Methods: GET, HEAD`）—— 换桶或改配置后请自己再验一遍。

用法：
    # 0) 先看看会传什么，不真的动
    py tools/upload_oss.py --dry-run

    # 1) 真传（密钥从环境变量读，别写进命令历史）
    $env:OSS_ACCESS_KEY_ID = "xxx"      # bash: export OSS_ACCESS_KEY_ID=xxx
    $env:OSS_ACCESS_KEY_SECRET = "yyy"
    py tools/upload_oss.py

    # 2) 只传某几个
    py tools/upload_oss.py packs/pdx-eu4-vanilla.pdxmap

    # 3) 传完顺便 HEAD 一遍验大小与跨域头
    py tools/upload_oss.py --verify

密钥从哪儿读（按顺序，先到先用）：
    1. 环境变量 `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET`
    2. 项目根目录的 `.publish.env`（`KEY=VALUE` 每行一条，**已进 .gitignore** ✓）

    ⚠ 建议用 RAM 子账号，权限只给这个桶的 `PutObject` / `GetObject` / `ListObjects` ✗
      别用主账号 AccessKey ✓

约定：
    * 只认 `.pdxmap`（跟 `publish_packs.py` 一致 ✓）
    * 同名对象直接覆盖（OSS PUT 天然幂等 ✓）
    * 不删任何东西 —— 要清理自己去控制台 ✓
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from email.utils import formatdate

#: 桶与区域（跟 `web/js/app.js` 的 `PACK_OSS` 必须一致 —— 改了那边这里也得改 ✓）
BUCKET = os.environ.get('PDX_OSS_BUCKET', 'beilunzhitu-map-packs')
ENDPOINT = os.environ.get('PDX_OSS_ENDPOINT', 'oss-cn-hangzhou.aliyuncs.com')

#: 上传用的 Content-Type。OSS 要求签名里的它和请求头**完全一致** ✓
CTYPE = 'application/octet-stream'

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def say(msg: str) -> None:
    print(msg, flush=True)


def human(n: int) -> str:
    if n >= 1048576:
        return '%.2f MB' % (n / 1048576.0)
    if n >= 1024:
        return '%.0f KB' % (n / 1024.0)
    return '%d B' % n


def read_secret_file() -> dict:
    """读 `.publish.env`（没有就返回空）。格式：`KEY=VALUE`，`#` 开头是注释。"""
    p = os.path.join(ROOT, '.publish.env')
    out = {}
    if not os.path.isfile(p):
        return out
    with open(p, 'r', encoding='utf-8') as f:
        for ln in f:
            s = ln.strip()
            if not s or s.startswith('#') or '=' not in s:
                continue
            k, v = s.split('=', 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def get_key(name: str, box: dict) -> str:
    return (os.environ.get(name) or box.get(name) or '').strip()


def sign(verb: str, obj_key: str, date: str, ak_id: str, ak_secret: str,
         ctype: str = CTYPE) -> str:
    """OSS V1 签名。字符串拼法见官方文档「在 Header 中包含签名」。"""
    resource = '/' + BUCKET + '/' + urllib.parse.quote(obj_key, safe='/')
    to_sign = '\n'.join([verb, '', ctype, date, resource])
    mac = hmac.new(ak_secret.encode('utf-8'), to_sign.encode('utf-8'), hashlib.sha1)
    return 'OSS %s:%s' % (ak_id, base64.b64encode(mac.digest()).decode('ascii'))


def obj_url(obj_key: str) -> str:
    return 'https://%s.%s/%s' % (BUCKET, ENDPOINT, urllib.parse.quote(obj_key, safe='/'))


def put_file(path: str, ak_id: str, ak_secret: str, dry: bool) -> bool:
    name = os.path.basename(path)
    size = os.path.getsize(path)
    if dry:
        say('  · 会传 %s（%s）→ %s' % (name, human(size), obj_url(name)))
        return True
    date = formatdate(usegmt=True)
    auth = sign('PUT', name, date, ak_id, ak_secret)
    with open(path, 'rb') as f:
        body = f.read()
    req = urllib.request.Request(obj_url(name), data=body, method='PUT', headers={
        'Date': date,
        'Content-Type': CTYPE,
        'Content-Length': str(len(body)),
        'Authorization': auth,
    })
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            ok = 200 <= r.status < 300
        say('  %s %s（%s）' % ('✓' if ok else '✗', name, human(size)))
        return ok
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')[:400]
        say('  ✗ %s → HTTP %s\n     %s' % (name, e.code, detail))
        if e.code in (403, 401):
            say('     密钥不对 / 没权限（RAM 子账号要给这个桶的 PutObject）')
        return False
    except Exception as e:
        say('  ✗ %s → %s' % (name, e))
        return False


def verify(name: str) -> bool:
    """HEAD 一下：大小 + 跨域头。没配 CORS 的话前端照样取不到 ✗"""
    req = urllib.request.Request(obj_url(name), method='HEAD',
                                 headers={'Origin': 'https://example.com'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            size = r.headers.get('Content-Length', '?')
            acao = r.headers.get('Access-Control-Allow-Origin') or '(缺)'
            ok = acao != '(缺)'
            say('  %s %s  %s B   ACAO=%s' % ('✓' if ok else '✗', name, size, acao))
            return ok
    except urllib.error.HTTPError as e:
        say('  ✗ %s → HTTP %s（对象没传上去？）' % (name, e.code))
        return False
    except Exception as e:
        say('  ✗ %s → %s' % (name, e))
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description='把 .pdxmap 传到阿里云 OSS 桶')
    ap.add_argument('files', nargs='*', help='要传的文件（默认 packs/*.pdxmap）')
    ap.add_argument('--dry-run', action='store_true', help='只打印，不真的传')
    ap.add_argument('--verify', action='store_true', help='传完 HEAD 一遍验大小与 CORS')
    args = ap.parse_args()

    files = list(args.files)
    if not files:
        pd = os.path.join(ROOT, 'packs')
        if not os.path.isdir(pd):
            say('✗ 找不到 packs/ 目录')
            return 2
        files = sorted(os.path.join(pd, f) for f in os.listdir(pd)
                       if f.lower().endswith('.pdxmap'))
    files = [f for f in files if f.lower().endswith('.pdxmap')]
    if not files:
        say('✗ 没有 .pdxmap 可传')
        return 2

    box = read_secret_file()
    ak_id = get_key('OSS_ACCESS_KEY_ID', box)
    ak_secret = get_key('OSS_ACCESS_KEY_SECRET', box)
    if not args.dry_run and (not ak_id or not ak_secret):
        say('✗ 缺密钥。任选一种：')
        say('   1) 环境变量：OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET')
        say('   2) 项目根目录建 .publish.env，写：')
        say('        OSS_ACCESS_KEY_ID=xxx')
        say('        OSS_ACCESS_KEY_SECRET=yyy')
        say('   （.publish.env 已在 .gitignore 里，别提交 ✓）')
        return 2

    say('桶 %s（%s）← 传 %d 个文件%s' % (BUCKET, ENDPOINT, len(files),
                                    '（只打印，不真传）' if args.dry_run else ''))
    bad = 0
    for p in files:
        if not put_file(p, ak_id, ak_secret, args.dry_run):
            bad += 1
    if args.verify and not args.dry_run:
        say('验一遍（大小 + 跨域头）：')
        for p in files:
            if not verify(os.path.basename(p)):
                bad += 1
    say('完事：%d 个成功 / %d 个失败' % (len(files) - bad, bad))
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
