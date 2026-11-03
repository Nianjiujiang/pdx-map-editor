# -*- coding: utf-8 -*-
"""把 `packs/*.pdxmap` 传到 GitHub Release 附件（可选顺手上传阿里云 OSS）。

为什么要这么干：
    编辑器「下载地图包」那个列表，是每次进下载页时现拉
    `api.github.com/repos/<repo>/releases/latest` 的**附件**、再筛 `.pdxmap`。
    所以"发一个新包"= 往**最新那个 release** 挂一个附件，没有别的地方要改。

    想让它走国内那条快路（阿里云 OSS → Worker → 各种加速代理 → 直连），
    还得把**同一份同名文件**放进 OSS 桶里 —— 前端只按附件文件名去取。

用法：
    # 1) 先看看会传什么，不真的动
    py tools/publish_packs.py --tag v1.10.3 --dry-run

    # 2) 真传（token 从环境变量读，别写进命令历史）
    set GITHUB_TOKEN=ghp_xxx          # PowerShell: $env:GITHUB_TOKEN="ghp_xxx"
    py tools/publish_packs.py --tag v1.10.3

    # 3) 不写 --tag 就传到最后那个 release（即 latest）
    py tools/publish_packs.py

    # 4) 只传某几个文件
    py tools/publish_packs.py --tag v1.10.3 packs/pdx-eu5-full.pdxmap

约定：
    * 只认 `.pdxmap`；
    * 同名附件已存在时**先删再传**（GitHub 不允许同名覆盖），删之前会打印名字；
    * 传完不刷新任何缓存 —— 编辑器每次进下载页都是 `cache: 'no-store'`，刷新页面就能看到。

⚠ 这个脚本**不碰仓库**、不提交任何东西，只走 GitHub 的 Release API。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO = 'Nianjiujiang/pdx-map-editor'
API = 'https://api.github.com'
UPLOAD = 'https://uploads.github.com'
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def read_secret_file() -> dict:
    """读项目根的 `.publish.env`（`KEY=VALUE`，`#` 注释）。没有就返回空。"""
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

# Windows 控制台默认 GBK，打印 ✓ / 中文提示会炸 ✗（跟仓库里别的脚本一个坑）
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass


def say(msg: str) -> None:
    print(msg, flush=True)


def _req(url: str, token: str, method: str = 'GET', data=None, ctype: str | None = None,
         accept: str = 'application/vnd.github+json'):
    headers = {
        'Authorization': 'Bearer ' + token,
        'Accept': accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pdx-map-editor-publish',
    }
    if ctype:
        headers['Content-Type'] = ctype
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    return urllib.request.urlopen(req, timeout=120)


def get_release(token: str, tag: str | None) -> dict:
    if tag:
        url = API + '/repos/' + REPO + '/releases/tags/' + urllib.parse.quote(tag)
    else:
        url = API + '/repos/' + REPO + '/releases/latest'
    with _req(url, token) as r:
        return json.loads(r.read().decode('utf-8'))


def create_release(token: str, tag: str, name: str, body: str) -> dict:
    """建一个正式 release（tag 不存在时 GitHub 会自动在当前分支 HEAD 上打）"""
    payload = json.dumps({
        'tag_name': tag, 'name': name or tag, 'body': body,
        'draft': False, 'prerelease': False,
    }).encode('utf-8')
    with _req(API + '/repos/' + REPO + '/releases', token,
              method='POST', data=payload, ctype='application/json') as r:
        return json.loads(r.read().decode('utf-8'))


def delete_asset(token: str, asset_id: int) -> None:
    with _req(API + '/repos/' + REPO + '/releases/assets/' + str(asset_id), token, method='DELETE'):
        pass


def upload_asset(token: str, release_id: int, path: str) -> dict:
    name = os.path.basename(path)
    url = (UPLOAD + '/repos/' + REPO + '/releases/' + str(release_id) + '/assets?name='
           + urllib.parse.quote(name))
    with io.open(path, 'rb') as f:
        body = f.read()
    with _req(url, token, method='POST', data=body, ctype='application/octet-stream') as r:
        return json.loads(r.read().decode('utf-8'))


def human(n: int) -> str:
    if n >= 1048576:
        return '%.1f MB' % (n / 1048576.0)
    if n >= 1024:
        return '%.0f KB' % (n / 1024.0)
    return '%d B' % n


def main() -> int:
    ap = argparse.ArgumentParser(description='把 packs/*.pdxmap 传到 GitHub Release 附件')
    ap.add_argument('files', nargs='*', help='要传的文件（默认 packs/*.pdxmap）')
    ap.add_argument('--tag', default=None, help='release 的 tag；不写就传最后那个（latest）')
    ap.add_argument('--dry-run', action='store_true', help='只打印，不真的传')
    ap.add_argument('--with-html', action='store_true',
                    help='连根目录的 pdx-map-editor.html / pdx-map-editor-mobile.html 一起传')
    ap.add_argument('--create-release', action='store_true',
                    help='tag 还不存在时顺手建一个正式 release（要配合 --tag）')
    ap.add_argument('--notes', default=None, help='release 正文文件（默认 release-notes-<tag>.md）')
    ap.add_argument('--name', default=None, help='release 标题（默认「地图编辑器 <tag> 正式版」）')
    args = ap.parse_args()

    files = args.files or []
    if not files:
        packs_dir = os.path.join('packs')
        if not os.path.isdir(packs_dir):
            say('✗ 找不到 packs/ 目录，把要传的文件名直接列在命令后面')
            return 2
        files = sorted(os.path.join(packs_dir, f) for f in os.listdir(packs_dir)
                       if f.lower().endswith('.pdxmap'))
    if args.with_html:
        for h in ('pdx-map-editor.html', 'pdx-map-editor-mobile.html'):
            if os.path.isfile(h):
                files.append(h)
            else:
                say('!! 没找到 %s —— 先跑 py mobile/build.py 再传' % h)
    files = [f for f in files if f.lower().endswith(('.pdxmap', '.html'))]
    if not files:
        say('✗ 一个 .pdxmap 都没有')
        return 2
    for f in files:
        if not os.path.isfile(f):
            say('✗ 文件不存在：' + f)
            return 2

    total = sum(os.path.getsize(f) for f in files)
    say('要传 %d 个包，合计 %s：' % (len(files), human(total)))
    for f in files:
        say('  · %-34s %s' % (os.path.basename(f), human(os.path.getsize(f))))

    if args.dry_run:
        say('\n--dry-run：到此为止，什么都没传 ✓')
        return 0

    box = read_secret_file()
    token = (os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
             or box.get('GITHUB_TOKEN') or '').strip()
    if not token:
        say('\n✗ 没有 GITHUB_TOKEN。两种给法：')
        say('   1) PowerShell:  $env:GITHUB_TOKEN="github_pat_xxx"')
        say('   2) 项目根目录 .publish.env 里写一行 GITHUB_TOKEN=github_pat_xxx')
        say('   token 在 https://github.com/settings/personal-access-tokens/new 建，')
        say('   Contents 权限设为 Read and write ✓')
        return 2

    try:
        rel = get_release(token, args.tag)
    except urllib.error.HTTPError as e:
        if e.code == 404 and args.create_release and args.tag:
            notes_path = args.notes or ('release-notes-%s.md' % args.tag)
            body = ''
            if os.path.isfile(notes_path):
                with io.open(notes_path, 'r', encoding='utf-8') as f:
                    body = f.read()
            else:
                say('!! 找不到 %s，release 正文留空' % notes_path)
            try:
                rel = create_release(token, args.tag, args.name or ('地图编辑器 %s 正式版' % args.tag), body)
                say('✓ 建好 release：%s' % args.tag)
            except urllib.error.HTTPError as e2:
                say('✗ 建 release 失败：HTTP %s %s' % (e2.code, e2.read()[:200]))
                return 2
        else:
            say('✗ 读 release 失败：HTTP %s（tag 写错了？还是 token 没权限？）' % e.code)
            return 2
    except Exception as e:  # noqa: BLE001
        say('✗ 读 release 失败：%s' % e)
        return 2

    rel_id = int(rel['id'])
    say('\n目标 release：%s（%s）' % (rel.get('tag_name'), rel.get('name') or ''))
    have = {a.get('name'): int(a.get('id')) for a in (rel.get('assets') or [])}

    ok = 0
    for f in files:
        name = os.path.basename(f)
        try:
            if name in have:
                say('  · %s 已存在，先删掉旧的…' % name)
                delete_asset(token, have.pop(name))
            info = upload_asset(token, rel_id, f)
            say('  ✓ %s 传好了（%s）' % (name, human(int(info.get('size') or 0))))
            ok += 1
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read().decode('utf-8', 'replace')[:200]
            except Exception:
                pass
            say('  ✗ %s 失败：HTTP %s %s' % (name, e.code, detail))
        except Exception as e:  # noqa: BLE001
            say('  ✗ %s 失败：%s' % (name, e))

    say('\n完成：%d / %d ✓' % (ok, len(files)))
    say('别忘了：想走国内 OSS 快路的话，把同一份同名文件也放进 OSS 桶；'
        '否则它们会退回 Worker / 加速代理 / 直连。')
    return 0 if ok == len(files) else 1


if __name__ == '__main__':
    sys.exit(main())
