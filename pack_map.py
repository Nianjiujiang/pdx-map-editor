#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一份缓存目录（data_xxx/）打成地图包 .pdxmap。

地图包 = 现有的 data_xxx/ 原样 + 一个 manifest.json，装在一个 zip 里。
编辑器导入端认的就是这个格式（见 `docs/导入式地图-策划.md` 第二节）。

用法：

    python pack_map.py data --id kr-ck3-demo --game ck3 \\
        --label "KR 地图（示例）" --author "某人" --license "署名-非商业" \\
        --out _local/packs/kr-ck3-demo.pdxmap

这个脚本是**给地图作者当范例 + 给我们自己造测试包**用的，不是本期交付重点 ✓
（编辑器只负责导入 ✗ 打包 ✗）

几个必须守住的点：

* **.bin 已经是 deflate 过的**（Python zlib 压的，头两字节 78 9c），
  zip 里再压一遍纯属浪费 CPU 而且几乎不缩小 → 一律 store ✓（见 RECOMPRESS 那段说明）
* **本机绝对路径必须清掉**：meta.json 里有 `ck3_root` / `gameRoot`，
  带着就泄露作者的用户名和磁盘布局 ✗（打之前扫一遍，见 sanitize_meta）
* **打完自己解一遍**：hash、长度公式、json 能不能解析，全都再验一次 ✓（见 self_check）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import zipfile
import zlib

#: 包格式版本。改动 zip 内布局时 +1（编辑器按 formatVersion 决定收不收）
FORMAT = "pdxmap"
FORMAT_VERSION = 1

#: **缓存数据结构版本**。build_*.py / patch_*.py 改了缓存结构（比如又加一类伪头衔）就 +1，
#: 编辑器声明自己支持的范围，范围外的包拒绝 —— 这样旧包不会悄悄把新编辑器弄坏 ✓
DATA_SCHEMA = 1

#: 这六个游戏之一。术语 / 层级 / 导出格式全走那个游戏现成的设定 ✓
#: ⚠ 跟 ``web/js/pack.js`` 的 ``PACK_GAMES`` **必须一起改** ✗ ——
#:   打包端放行、导入端拒收（或者反过来）就是"自己打的包自己导不进来" ✓
#:   （CK2 是 2026-10-15 加的 ✓ 两头同时加 ✓）
GAMES = ("ck2", "ck3", "eu4", "hoi4", "vic3", "eu5")

#: 必需文件。名字、格式跟 data_xxx/ 里一模一样，编辑器那边一个字节都不用改 ✓
REQUIRED = (
    "meta.json",
    "titles.json",
    "provinces_id.bin",
    "titlemap.bin",
    "adjacency.bin",
    "prov_pos.bin",
)

#: 可选文件：preview.jpg 由 --preview 传进来，tiles/ 整个目录跟着 meta 走 ✓
OPTIONAL_FILES = ("tiles.json", "preview.jpg")

#: 上限（跟编辑器的校验器同一套数字，两边必须一致）
MAX_PACK_BYTES = 300 * 1024 * 1024
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_RAW_BYTES = 1024 * 1024 * 1024

#: 字段长度上限。超了直接报错，**不要截断**（截断出来的包名字会莫名其妙）
LIMITS = {
    "id": 64, "label": 40, "note": 80, "version": 32,
    "author": 40, "license": 200, "description": 1000, "homepage": 300,
}

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")

#: 明确知道是"本机路径"的字段，打包时删掉 ✓
#: （web/js 里 grep 过 ck3_root / gameRoot / provinceMap，一个都没人用 ✓）
LOCAL_PATH_KEYS = ("ck3_root", "gameRoot")

ABS_PATH_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\|/[^/])")


def die(msg: str) -> "NoReturn":  # noqa: F821
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def looks_absolute(v: str) -> bool:
    """看着像本机绝对路径吗（只用来提醒，不用来删）"""
    return bool(ABS_PATH_RE.match(v)) and len(v) > 2


def sanitize_meta(meta: dict) -> tuple[dict, list]:
    """清掉 meta.json 里的本机路径。

    作者打包时最不该带出去的就是这个：`C:\\Steam\\steamapps\\common\\Crusader Kings III`
    里通常带着他的 Windows 用户名 ✗

    返回 (清过的 meta, 清掉的字段名列表)
    """
    out = dict(meta)
    dropped = []
    for k in list(out):
        if k in LOCAL_PATH_KEYS or k.endswith("_root"):
            dropped.append(k)
            del out[k]

    # 兜底：还有别的值像绝对路径的，**只提醒不删** ——
    # 万一某个字段其实有用，删了包就坏了，宁可让人自己看一眼 ✓
    for k, v in out.items():
        if isinstance(v, str) and k not in dropped and looks_absolute(v):
            print(f"  · 提醒：meta.{k} 看着像本机路径（{v[:60]}），请确认该不该带出去")
    return out, dropped


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def json_bytes(obj) -> bytes:
    """统一成 UTF-8 的紧凑 json（缩进 1，方便人肉看包，又不会太肥）"""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def read_meta(data_dir: str) -> dict:
    p = os.path.join(data_dir, "meta.json")
    if not os.path.exists(p):
        die(f"{data_dir} 里没有 meta.json —— 这是缓存目录吗？（先跑 python build_data.py）")
    try:
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        die(f"meta.json 解析不了：{e}")


def check_data_dir(data_dir: str, meta: dict) -> dict:
    """打包前先看一遍这套缓存是不是齐的、数字自不自洽"""
    if not os.path.isdir(data_dir):
        die(f"没有这个目录：{data_dir}")

    missing = [n for n in REQUIRED if not os.path.exists(os.path.join(data_dir, n))]
    if missing:
        die(f"{data_dir} 缺文件：{'、'.join(missing)}")

    for k in ("numProvinces", "numTitles", "mapWidth", "mapHeight"):
        v = meta.get(k)
        if not isinstance(v, int) or v <= 0:
            die(f"meta.{k} 不是正整数（{v!r}）—— 这份缓存没生成好")

    game = meta.get("game")
    if game not in GAMES:
        die(f"meta.game = {game!r} 不在 {GAMES} 里")

    tiers = meta.get("tiers")
    if not isinstance(tiers, list) or not tiers:
        die("meta.tiers 不是非空数组")

    # 长度公式（跟编辑器校验器同一套，改一边必须改另一边）
    raw = {}
    for name in REQUIRED:
        if not name.endswith(".bin"):
            continue                      # json 那两份不压，别拿去 zlib 解 ✗
        blob = open(os.path.join(data_dir, name), "rb").read()
        if len(blob) > MAX_FILE_BYTES:
            die(f"{name} 超过单文件上限（{len(blob)} 字节）")
        try:
            raw[name] = len(zlib.decompress(blob))
        except Exception as e:
            die(f"{name} 不是 zlib 压的？（{e}）—— 缓存目录应该是 build_*.py 产出的那份")

    W, H = meta["mapWidth"], meta["mapHeight"]
    P, T = meta["numProvinces"], len(tiers)
    want = {
        "provinces_id.bin": W * H * 2,
        "titlemap.bin": P * T * 2,
        "prov_pos.bin": P * 3 * 4,
    }
    for name, n in want.items():
        if raw[name] != n:
            die(f"{name} 解压后 {raw[name]} 字节，按公式应该是 {n} 字节（meta 和缓存对不上）")
    # 邻接表是 CSR：(P+1) 个 u32 偏移 + u16 邻居，没有固定总长，只看头够不够两条边
    head = (P + 1) * 4
    if raw["adjacency.bin"] < head or (raw["adjacency.bin"] - head) % 2:
        die(f"adjacency.bin 解压后 {raw['adjacency.bin']} 字节，对不上 CSR 布局")

    if sum(raw.values()) > MAX_TOTAL_RAW_BYTES:
        die("解压后总量超过 1 GB 上限")

    return raw


def collect(data_dir: str, preview: str | None) -> list:
    """要进包的条目：[(包内名字, 磁盘路径或 None, 原始字节)]，顺序固定（可复现）"""
    items = []
    for name in REQUIRED:
        items.append((name, os.path.join(data_dir, name)))

    if os.path.exists(os.path.join(data_dir, "tiles.json")):
        items.append(("tiles.json", os.path.join(data_dir, "tiles.json")))
        tdir = os.path.join(data_dir, "tiles")
        if not os.path.isdir(tdir):
            die("有 tiles.json 却没有 tiles/ 目录")
        names = sorted(os.listdir(tdir))
        if not names:
            die("tiles/ 是空的")
        for n in names:
            items.append((f"tiles/{n}", os.path.join(tdir, n)))

    if preview:
        if not os.path.exists(preview):
            die(f"找不到预览图：{preview}")
        ext = os.path.splitext(preview)[1].lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp"):
            die("预览图只收 jpg / png / webp")
        if os.path.getsize(preview) > 2 * 1024 * 1024:
            die("预览图超过 2 MB")
        items.append(("preview.jpg", preview))

    return items


def make_manifest(args, meta: dict, entries: dict) -> dict:
    stats = {k: meta[k] for k in ("numProvinces", "numTitles", "mapWidth", "mapHeight")}
    m = {
        "format": FORMAT,
        "formatVersion": FORMAT_VERSION,
        "dataSchema": DATA_SCHEMA,
        "id": args.id,
        "game": meta["game"],
        "label": args.label,
        "note": args.note if args.note is not None else f"{stats['mapWidth']} × {stats['mapHeight']}",
        "version": args.version,
        "author": args.author or "",
        "license": args.license or "",
        "homepage": args.homepage or "",
        "description": args.description or "",
        "stats": stats,
        # 每个文件的 sha256（编辑器有就核，没有就跳过 ✓）
        "files": {name: sha256(blob) for name, blob in entries.items()},
    }
    return m


def write_pack(out_path: str, entries: list, blobs: dict) -> None:
    """写 zip。

    **.bin 用 store，json 用 deflate** ✓ —— .bin 本来就是 zlib 压过的（78 9c 开头），
    再压一遍几乎不缩小，还要多花几秒 CPU ✗

    date_time 固定成 1980-01-01：同样的输入打出来的包**字节完全相同** ✓
    （不然每次打包 hash 都变，测试里没法比对，作者也没法核对"我传的和你下的是不是同一个"）
    """
    tmp = out_path + ".part"
    try:
        with zipfile.ZipFile(tmp, "w", allowZip64=False) as zf:
            for name, data in entries:
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_STORED if name.endswith(".bin") else zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                zf.writestr(info, data)
        os.replace(tmp, out_path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def self_check(out_path: str, manifest: dict) -> list:
    """打完自己解一遍：hash / 长度公式 / json 能不能解析，全都要对 ✓"""
    problems = []
    with zipfile.ZipFile(out_path) as zf:
        bad = zf.testzip()
        if bad:
            problems.append(f"zip 本身坏了：{bad}")

        names = zf.namelist()
        if len(names) != len(set(names)):
            problems.append("包里有重名条目")
        for n in names:
            if n.startswith("/") or ".." in n.split("/") or "\\" in n:
                problems.append(f"条目名不干净：{n}")

        if "manifest.json" not in names:
            problems.append("没有 manifest.json")
            return problems

        got = json.loads(zf.read("manifest.json").decode("utf-8"))
        if got != manifest:
            problems.append("读回来的 manifest 和写进去的不一样")

        for name, want in manifest["files"].items():
            if name not in names:
                problems.append(f"manifest 里写了 {name}，包里没有")
                continue
            if sha256(zf.read(name)) != want:
                problems.append(f"{name} 的 sha256 对不上")

        meta = json.loads(zf.read("meta.json").decode("utf-8"))
        json.loads(zf.read("titles.json").decode("utf-8"))
        for k in LOCAL_PATH_KEYS:
            if k in meta:
                problems.append(f"meta.json 里还有本机路径字段 {k}")
        if meta.get("game") != manifest["game"]:
            problems.append("meta.game 和 manifest.game 不一致")
        for k, v in manifest["stats"].items():
            if meta.get(k) != v:
                problems.append(f"meta.{k}={meta.get(k)} 和 manifest.stats.{k}={v} 不一致")

        W, H, P, T = (meta["mapWidth"], meta["mapHeight"],
                      meta["numProvinces"], len(meta["tiers"]))
        raw = {n: len(zlib.decompress(zf.read(n))) for n in REQUIRED if n.endswith(".bin")}
        if raw["provinces_id.bin"] != W * H * 2:
            problems.append("provinces_id.bin 长度不对")
        if raw["titlemap.bin"] != P * T * 2:
            problems.append("titlemap.bin 长度不对")
        if raw["prov_pos.bin"] != P * 3 * 4:
            problems.append("prov_pos.bin 长度不对")

        # 省份图里的 id 不许越界（大图分块扫，别整块摊进内存 —— EU5 原尺寸解压后 268 MB ✗）
        d = zlib.decompressobj()
        left = b""
        seen_max = -1
        with zf.open("provinces_id.bin") as fp:
            while True:
                chunk = fp.read(1 << 20)
                if not chunk:
                    break
                buf = left + d.decompress(chunk)
                if len(buf) % 2:           # 奇数长度：留一个字节跟下一块拼
                    left, buf = buf[-1:], buf[:-1]
                else:
                    left = b""
                if buf:
                    seen_max = max(seen_max, max(memoryview(buf).cast("H")))
        if seen_max >= P:
            problems.append(f"provinces_id.bin 里有省份号 {seen_max}，但这张图只有 {P} 个省份")

        # 分块那套（EU5 原尺寸）：几何 + 块尺寸都要自洽
        # （跟 web/js/pack.js 里校验器那几条是同一套规矩 ✓ 改一边必须改另一边）
        if "tiles.json" in names:
            tm = json.loads(zf.read("tiles.json").decode("utf-8"))
            files = tm.get("files") or []
            tw, th = tm.get("tileW"), tm.get("tileH")
            cols, rows = tm.get("cols"), tm.get("rows")
            # 先查"清单和包里的文件对不对得上"（要说出是**哪个文件** ✓），再查几何
            listed = {f"tiles/{f.get('name')}" for f in files}
            missing = sorted(n for n in listed if n not in names)
            extra = sorted(n for n in names if n.startswith("tiles/") and n not in listed)
            if missing:
                problems.append(f"tiles.json 里列了 {missing[0]}，包里没有")
            elif extra:
                problems.append(f"包里的 {extra[0]} 没写进 tiles.json")
            elif not all(isinstance(x, int) and x > 0 for x in (tw, th, cols, rows)):
                problems.append(f"tiles.json 的 tileW/tileH/cols/rows 得是正整数（{tw}/{th}/{cols}/{rows}）")
            elif cols * rows != len(files):
                problems.append(f"tiles.json 说有 {cols}×{rows} = {cols * rows} 块，只列了 {len(files)} 块")
            elif tw * cols != W or th * rows != H:
                bad = []
                if tw * cols != W:
                    bad.append(f"横向 {tw}×{cols} = {tw * cols}（应该是 {W}）")
                if th * rows != H:
                    bad.append(f"纵向 {th}×{rows} = {th * rows}（应该是 {H}）")
                problems.append("tiles.json 的块尺寸凑不出整张图：" + "、".join(bad))
            else:
                seen_rc = set()
                for f in files:
                    n = f"tiles/{f['name']}"
                    if f.get("w") != tw or f.get("h") != th:
                        problems.append(f"tiles.json 里 {n} 是 {f.get('w')}×{f.get('h')}，跟块尺寸 {tw}×{th} 不一致")
                        break
                    if not (0 <= f.get("r", -1) < rows and 0 <= f.get("c", -1) < cols):
                        problems.append(f"tiles.json 里 {n} 的位置 {f.get('r')},{f.get('c')} 超出范围")
                        break
                    rc = (f.get("r"), f.get("c"))
                    if rc in seen_rc:
                        problems.append(f"tiles.json 里有两块都写着 {rc[0]},{rc[1]}")
                        break
                    seen_rc.add(rc)
                    got_n = len(zlib.decompress(zf.read(n)))
                    if got_n != f["w"] * f["h"] * 2:
                        problems.append(f"{n} 解压后 {got_n} 字节，应该是 {f['w'] * f['h'] * 2}")
                        break
    return problems


def build_pack(args, quiet: bool = False) -> tuple:
    """打一个包（**主流程都在这儿** ✓ `main()` 和 `build_packs.py` 共用）

    @param args  要有 id / label / data_dir / note / version / author / license /
                 homepage / description / preview / out 这些字段
                 （`main()` 的 argparse 结果，或者 `argparse.Namespace` 都行 ✓）
    @param quiet True = 只出错才说话（批量打 7 个包时用，不然刷屏 ✓）
    @returns (输出路径, manifest)
    @raises SystemExit 打不出来（跟命令行那条路一样，直接带人话退出）
    """
    say = (lambda *a: None) if quiet else print

    if not ID_RE.match(args.id):
        die(f"--id 不合法：{args.id!r}（要小写字母数字和 . _ -，3~64 位，首字符是字母或数字）")
    for field, limit in LIMITS.items():
        v = getattr(args, field, None)
        if isinstance(v, str) and len(v) > limit:
            die(f"--{field} 太长（{len(v)} > {limit} 字），**不截断**，请自己改短")

    meta = read_meta(args.data_dir)
    check_data_dir(args.data_dir, meta)

    say(f"· 打包 {args.data_dir} → {args.id}")
    clean, dropped = sanitize_meta(meta)
    if dropped:
        say(f"  · 清掉本机路径字段：{'、'.join(dropped)}")

    entries = []
    blobs = {}
    for name, path in collect(args.data_dir, args.preview):
        blob = open(path, "rb").read()
        if name == "meta.json":
            # meta 要用清过的那份，**不是磁盘上原本那份** ✓
            blob = json_bytes(clean)
        entries.append((name, blob))
        blobs[name] = blob

    manifest = make_manifest(args, meta, blobs)
    entries.insert(0, ("manifest.json", json_bytes(manifest)))

    out_path = args.out or f"{args.id}.pdxmap"
    outdir = os.path.dirname(os.path.abspath(out_path))
    os.makedirs(outdir, exist_ok=True)
    write_pack(out_path, entries, blobs)

    size = os.path.getsize(out_path)
    if size > MAX_PACK_BYTES:
        os.remove(out_path)
        die(f"包有 {size / 1048576:.1f} MB，超过 300 MB 上限")

    problems = self_check(out_path, manifest)
    if problems:
        os.remove(out_path)
        for p in problems:
            print(f"✗ 自检不过：{p}", file=sys.stderr)
        raise SystemExit(1)

    stats = manifest["stats"]
    say(f"✓ {out_path}  {size / 1048576:.2f} MB")
    say(f"  {manifest['game']} · {stats['numTitles']} 个头衔 · {stats['numProvinces']} 个地块"
        f" · {stats['mapWidth']}×{stats['mapHeight']} · {len(entries)} 个条目")
    say(f"  sha256 {sha256(open(out_path, 'rb').read())[:16]}…")
    return out_path, manifest


def main() -> int:
    ap = argparse.ArgumentParser(
        description="把一份缓存目录打包成地图包 .pdxmap",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("data_dir", help="缓存目录，如 data / data_eu4 / data_eu5_full")
    ap.add_argument("--id", required=True, help="全局唯一标识（小写字母数字 . _ -）"
                                               "—— 作者这边的来源标识，编辑器里每导入一份算一张新图")
    ap.add_argument("--label", required=True, help="显示名（≤40 字），选图卡片上最大那行")
    ap.add_argument("--note", default=None, help="副标题（≤80 字），默认按尺寸生成")
    ap.add_argument("--version", default="1.0.0", help="作者自己的版本号（只展示，不比较）")
    ap.add_argument("--author", default="", help="作者名")
    ap.add_argument("--license", default="", help="授权说明，一句话")
    ap.add_argument("--homepage", default="", help="出处链接")
    ap.add_argument("--description", default="", help="多写几句（≤1000 字）")
    ap.add_argument("--preview", default=None, help="预览图（jpg/png/webp，≤2 MB）")
    ap.add_argument("--out", default=None, help="输出文件，默认 <id>.pdxmap")
    args = ap.parse_args()
    build_pack(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
