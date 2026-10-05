"""按编辑器同一份数据渲几张预览图，方便不开浏览器先看效果。

    python preview.py                 # 默认看 data/
    python preview.py --data data_eu4 --out preview_eu4

出图在 ``preview*/`` 下。这里做的是 CPU 版的同一套查表：
省份 id → (省份, 层级) → 头衔 → 颜色，跟前端 GPU 那边完全一致。
层级名字从 meta 里读，所以 CK3 和 EU4 共用这一个脚本。
"""

from __future__ import annotations

import argparse
import json
import sys
import zlib
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent

NO_TITLE = 65535
WATER = np.array([24, 34, 46], dtype=np.uint8)
BORDER = np.array([8, 10, 14], dtype=np.uint8)


def load(data: Path):
    meta = json.loads((data / "meta.json").read_text(encoding="utf-8"))
    titles = json.loads((data / "titles.json").read_text(encoding="utf-8"))
    h, w = meta["mapHeight"], meta["mapWidth"]
    nprov = meta["numProvinces"]
    n_tier = len(meta["tiers"])

    ids = np.frombuffer(zlib.decompress((data / "provinces_id.bin").read_bytes()),
                        dtype=np.uint16).reshape(h, w)
    tm = np.frombuffer(zlib.decompress((data / "titlemap.bin").read_bytes()),
                       dtype=np.uint16).reshape(n_tier, nprov)
    colors = np.array(titles["colors"], dtype=np.uint8)
    return meta, titles, ids, tm, colors


def render_tier(ids, tm_row, colors, scale: int) -> Image.Image:
    """分块渲染，免得一次展开几十张 42M 像素的中间数组。"""
    h, w = ids.shape
    out = np.empty((h, w, 3), dtype=np.uint8)
    chunk = 512
    for y0 in range(0, h, chunk):
        y1 = min(y0 + chunk, h)
        block = ids[y0:y1]
        tid = tm_row[block]                       # (bh, w) 头衔序号
        water = tid == NO_TITLE
        safe = np.where(water, 0, tid)

        rgb = colors[safe]                        # (bh, w, 3)
        rgb[water] = WATER

        # 头衔边界，块内做（块与块之间那条缝本来就在图上）
        edge = np.zeros(block.shape, dtype=bool)
        edge[:, :-1] |= tid[:, :-1] != tid[:, 1:]
        edge[:-1, :] |= tid[:-1, :] != tid[1:, :]
        edge &= ~water
        rgb[edge] = BORDER

        out[y0:y1] = rgb
    im = Image.fromarray(out, "RGB")
    if scale > 1:
        im = im.resize((w // scale, h // scale), Image.LANCZOS)
    return im


def label(im: Image.Image, text: str) -> Image.Image:
    from PIL import ImageDraw
    d = ImageDraw.Draw(im)
    pad = 12
    try:
        from PIL import ImageFont
        font = ImageFont.truetype("C:/Windows/Fonts/msyhbd.ttc", 34)
    except Exception:
        font = None
    box = d.textbbox((pad, pad), text, font=font)
    d.rectangle([box[0] - 10, box[1] - 6, box[2] + 10, box[3] + 6], fill=(12, 16, 21))
    d.text((pad, pad), text, fill=(232, 200, 96), font=font)
    return im


def main() -> int:
    ap = argparse.ArgumentParser(description="按缓存数据渲预览图")
    ap.add_argument("--data", default="data", help="缓存目录，默认 data/")
    ap.add_argument("--out", default="preview", help="出图目录，默认 preview/")
    ap.add_argument("--scale", type=int, default=4, help="缩小倍数，默认 4")
    args = ap.parse_args()

    data = (ROOT / args.data) if not Path(args.data).is_absolute() else Path(args.data)
    out = (ROOT / args.out) if not Path(args.out).is_absolute() else Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    meta, titles, ids, tm, colors = load(data)
    scale = max(1, args.scale)
    names = meta.get("tierNames") or list(meta["tiers"])
    keys = meta.get("tierKeys") or list(meta["tiers"])
    print(f"{data.name}：{ids.shape[1]}×{ids.shape[0]}，{meta['numTitles']} 个"
          f"（真 {meta.get('numRealTitles', '?')}），缩放 1/{scale}")

    for tier in range(len(meta["tiers"])):
        im = render_tier(ids, tm[tier], colors, scale)
        label(im, f"{keys[tier]} {names[tier]}")
        p = out / f"{tier + 1:02d}_{str(keys[tier]).rstrip('_')}_{names[tier]}.jpg"
        im.save(p, quality=88, subsampling=1)
        print(f"  {p.name}")

    # 顺带报一下各层级的覆盖率，确认没有大片漏着色
    for tier, key in enumerate(keys):
        row = tm[tier]
        covered = np.count_nonzero(row[ids] != NO_TITLE)
        print(f"  {key.rstrip('_')}: 已着色像素 {covered / ids.size:.1%}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
