# -*- coding: utf-8 -*-
"""生成 v1.10 → v1.11.0 长图更新报告。

用法：py tools/make_changelog_image.py
产物：docs/更新报告-v1.11.0.png

排版约定：全部尺寸按逻辑像素计算，绘制时统一乘以 SCALE 超采样，
最后 LANCZOS 缩回。文字一律先量宽再换行，卡片高度由内容反推，
因此不会出现溢出、重叠或截断。
"""
from __future__ import annotations

import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

# ---------------------------------------------------------------- 基本参数

SCALE = 2
W = 1440
MARGIN = 80
CONTENT = W - MARGIN * 2  # 1280

BG = (18, 21, 27)          # #12151b
CARD = (25, 31, 40)        # #191f28
CARD_SOFT = (29, 36, 46)
BORDER = (42, 51, 64)      # #2a3340
LINE = (32, 38, 48)        # 分隔线
TEXT = (233, 238, 245)
BODY = (190, 202, 216)
TEXT2 = (169, 182, 197)
MUTED = (113, 128, 143)
FAINT = (90, 102, 118)
ACCENT = (74, 144, 217)    # #4a90d9
CYAN = (90, 210, 192)      # #5ad2c0

FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_REG = r"C:\Windows\Fonts\msyh.ttc"
FALLBACK_BOLD = [r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc"]
FALLBACK_REG = [r"C:\Windows\Fonts\simsun.ttc", r"C:\Windows\Fonts\simhei.ttf"]

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "docs", "更新报告-v1.11.0.png")

# ---------------------------------------------------------------- 字体


def pick_font(primary: str, fallbacks: list[str]) -> str:
    for path in [primary] + fallbacks:
        if os.path.exists(path):
            return path
    raise SystemExit("找不到可用的中文字体")


def cmap_chars(path: str) -> set[int] | None:
    try:
        from fontTools.ttLib import TTCollection, TTFont
    except ImportError:
        return None  # 没装 fontTools 时退回纯渲染检查

    if path.lower().endswith(".ttc"):
        font = TTCollection(path).fonts[0]
    else:
        font = TTFont(path)
    covered: set[int] = set()
    for table in font["cmap"].tables:
        covered.update(table.cmap.keys())
    return covered


class Doc:
    """逻辑坐标画布；enable() 之前只量不算画。"""

    def __init__(self, scale: int):
        self.scale = scale
        self.img: Image.Image | None = None
        self.d: ImageDraw.ImageDraw | None = None
        self._fonts: dict[tuple[int, bool], ImageFont.FreeTypeFont] = {}
        self.bold_path = pick_font(FONT_BOLD, FALLBACK_BOLD)
        self.reg_path = pick_font(FONT_REG, FALLBACK_REG)

    # -- 基础
    def font(self, size: float, bold: bool = False) -> ImageFont.FreeTypeFont:
        key = (int(round(size * self.scale)), bold)
        if key not in self._fonts:
            path = self.bold_path if bold else self.reg_path
            self._fonts[key] = ImageFont.truetype(path, key[0])
        return self._fonts[key]

    def w(self, text: str, font: ImageFont.FreeTypeFont) -> float:
        return font.getlength(text) / self.scale

    def enable(self, width: int, height: int) -> None:
        self.img = Image.new("RGB", (width * self.scale, height * self.scale), BG)
        self.d = ImageDraw.Draw(self.img)

    @property
    def on(self) -> bool:
        return self.d is not None

    # -- 绘制
    def rect(self, x, y, w, h, fill=None, outline=None, width=1, r=0):
        if not self.d:
            return
        s = self.scale
        box = [round(x * s), round(y * s), round((x + w) * s) - 1, round((y + h) * s) - 1]
        if r:
            self.d.rounded_rectangle(box, radius=round(r * s), fill=fill,
                                     outline=outline, width=max(1, round(width * s)))
        else:
            self.d.rectangle(box, fill=fill, outline=outline, width=max(1, round(width * s)))

    def line(self, x1, y1, x2, y2, fill=LINE, width=1):
        if not self.d:
            return
        s = self.scale
        self.d.line([round(x1 * s), round(y1 * s), round(x2 * s), round(y2 * s)],
                    fill=fill, width=max(1, round(width * s)))

    def text(self, x, baseline, s, font, fill):
        if not self.d:
            return
        self.d.text((round(x * self.scale), round(baseline * self.scale)), s,
                    font=font, fill=fill, anchor="ls")

    def dot(self, cx, cy, radius, fill):
        if not self.d:
            return
        s = self.scale
        self.d.ellipse([round((cx - radius) * s), round((cy - radius) * s),
                        round((cx + radius) * s), round((cy + radius) * s)], fill=fill)


def baseline_of(doc: Doc, top: float, line_h: float, font) -> float:
    asc, desc = font.getmetrics()
    asc /= doc.scale
    desc /= doc.scale
    return top + (line_h + asc - desc) / 2.0


# ---------------------------------------------------------------- 文本换行


WORD_EXTRA = set("._%:+-/") | {"×", "–", "—"}
CLOSE_PUNCT = "，。、；：！？）」』】》)]}>,.;:!?%，"
NUM_RE = re.compile(r"^[0-9][0-9.,×%–\-+/]*(?:ms|ns|px|s)?[，。、；：！？）」』】》]*$")


def _is_word_char(c: str) -> bool:
    return (c.isascii() and c.isalnum()) or c in WORD_EXTRA


def tokenize(text: str) -> list[str]:
    out: list[str] = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c == " ":
            j = i
            while j < n and text[j] == " ":
                j += 1
            out.append(text[i:j])
            i = j
            continue
        if _is_word_char(c):
            j = i
            while j < n and _is_word_char(text[j]):
                j += 1
            out.append(text[i:j])
            i = j
            continue
        out.append(c)
        i += 1

    merged: list[str] = []
    for tok in out:
        if len(tok) == 1 and tok in CLOSE_PUNCT and merged and not merged[-1].isspace():
            merged[-1] += tok
        else:
            merged.append(tok)
    return merged


def token_color(tok: str, base=BODY) -> tuple[int, int, int]:
    if NUM_RE.match(tok):
        return CYAN
    if tok == "→":
        return ACCENT
    return base


def _split_long(tok: str, doc: Doc, font, maxw: float) -> list[str]:
    """极端长串（URL 之类）按字符切，保证不越界。"""
    if doc.w(tok, font) <= maxw:
        return [tok]
    out, cur = [], ""
    for ch in tok:
        if cur and doc.w(cur + ch, font) > maxw:
            out.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def wrap(doc: Doc, text: str, font, maxw: float, color=BODY) -> list[list[tuple[str, tuple]]]:
    """返回行 -> [(文字, 颜色)]。数字用亮青，箭头用主色。"""
    toks = tokenize(text)
    lines: list[list[tuple[str, tuple]]] = []
    cur: list[tuple[str, tuple]] = []
    curw = 0.0

    for tok in toks:
        if tok == "\n":
            if cur:
                lines.append(cur)
            cur, curw = [], 0.0
            continue
        if tok.isspace():
            if cur:
                cur.append((tok, color))
                curw += doc.w(tok, font)
            continue
        for piece in _split_long(tok, doc, font, maxw):
            pw = doc.w(piece, font)
            if cur and curw + pw > maxw:
                lines.append(cur)
                cur, curw = [], 0.0
            cur.append((piece, token_color(piece, color)))
            curw += pw
    if cur:
        lines.append(cur)
    for ln in lines:
        lw = sum(doc.w(t, font) for t, _ in ln)
        assert lw <= maxw + 0.5, f"换行越界: {lw:.1f} > {maxw:.1f} :: {''.join(t for t, _ in ln)}"
    # 合并同色相邻片段
    merged_lines = []
    for ln in lines:
        merged: list[tuple[str, tuple]] = []
        for txt, col in ln:
            if merged and merged[-1][1] == col:
                merged[-1] = (merged[-1][0] + txt, col)
            else:
                merged.append((txt, col))
        merged_lines.append(merged)
    return merged_lines


def draw_line(doc: Doc, x: float, top: float, line_h: float, font, runs, align="left",
              right: float | None = None):
    if not runs:
        return
    width = sum(doc.w(t, font) for t, _ in runs)
    cx = x
    if align == "right" and right is not None:
        cx = right - width
    elif align == "center" and right is not None:
        cx = (x + right - width) / 2
    b = baseline_of(doc, top, line_h, font)
    for txt, col in runs:
        doc.text(cx, b, txt, font, col)
        cx += doc.w(txt, font)


def plain_runs(text: str, color) -> list[tuple[str, tuple]]:
    return [(text, color)]


# ---------------------------------------------------------------- 内容


HERO = [
    ("流畅度", [
        "涂色块重建 VIC3 16.96 → 9.31 ms，EU5 10.56 → 8.18 ms",
        "点击取块 VIC3 2.08 → 0.42 ms，不再为每个地块造临时对象",
        "地名取点整图 2.95 → 0.26 ms，去掉每帧分桶与全量排序",
        "字形缓存热命中 226 → 61 ns，布局记忆化命中率 100%",
        "每帧 GL 调用 97 → 5 条，缩放后地名消失的老 bug 一并修好",
    ]),
    ("地图包", [
        "下载页点卡片，编辑器自己把包取回列表，不再手动导入",
        "取不到时才退回浏览器下载，并提示拖进窗口自动导入",
        "拖拽整页压暗，松手直接导入，不是地图包当场说明",
        "国内链路 OSS → Worker → 加速代理 → 直连",
        "失败通道五分钟内不再重试，代理 6 s、直连 20 s 超时",
    ]),
    ("手机版", [
        "旗帜工具补上触摸入口，真机上终于点得动",
        "12px 内算点击，抬手同步执行，不再被 preventDefault 吃掉",
        "文件选择框离屏但仍在布局，iOS 也能弹出系统选图",
        "createImageBitmap 不可用时退回 img + createObjectURL",
    ]),
    ("地图修复", [
        "EU4 粗层海洋不再切成 668 片、每片印一个海省号",
        "大洲层片数 877 → 218，纯数字片名 793 → 0",
        "河流 / 湖泊 / 不可通行海域不再输出纯黑",
        "EU5 湖泊与陆地分开，湖泊改用水域真名",
    ]),
]

PERF = [
    ("涂色块重建", "VIC3", "16.96 ms", "9.31 ms"),
    ("涂色块重建", "EU5", "10.56 ms", "8.18 ms"),
    ("点击取块", "VIC3", "2.08 ms", "0.42 ms"),
    ("地名取点", "整图", "2.95 ms", "0.26 ms"),
    ("字形缓存", "热命中", "226 ns", "61 ns"),
    ("每帧 GL 调用", "EU4 / EU5", "97 条", "5 条"),
]
PERF_NOTE = ("细层重建 VIC3 7.00 → 1.47 ms、EU5 6.33 → 0.76 ms；"
             "点击取块 EU5 1.26 → 0.35 ms；近景地名取点 1.57 → 0.05 ms。\n"
             "数字取自 2026-11-03 开发日志实测；红线为 max(基线 × 1.25, 基线 + 1.5 ms)，"
             "57 项全部在红线内。")

V1102 = [
    ("整图导出合并",
     "整图与高清合并为一个入口，0.5× / 1× / 2× / 3× 快捷倍率，也可直接填宽高，"
     "倍率范围放宽到 0.1×–8×；导出范围支持整图或框选。"),
    ("实时地图图例",
     "图例直接长在地图上，可拖四角、改尺寸，1–8 列，同色自动合并，"
     "条目可改名、排序、隐藏。"),
    ("着色器分级降级",
     "完整链接失败时四级降级：多级边界 → 本层边界 → 本层头衔线 → 无边界精简版，"
     "移动 GPU 上尽量保留地区边界。"),
    ("手机设置界面",
     "图例面板、颜色卡、字体下拉与导出弹窗按手机宽度重排，设置页标签同步改为「图例」。"),
]

V1101 = [
    "「清除全部」可撤销，误触后 Ctrl + Z 就能找回",
    "保存地图自动预填「地图名 · 日期」并全选",
    "切换剧本、清除、橡皮之后国名立即刷新",
    "国名不必缩到 20% 才出现，小比例按字号逐步浮出",
    "手机版输入弹窗改居中卡片，缩放按钮回到右侧",
]
V1101_DESC = "体验修复"

V1100 = [
    "名称由「地图编辑器」改为「悖论制图」",
    "EU4 剧本 3 → 12 个，覆盖 1444–1792 年",
    "五级地理层级：大陆、次大陆、地区、省份、地点",
    "版图贴合排版，国名沿版图基线逐字排布",
    "地图仓库保存地图；支持导入 TTF / OTF 与 FNT / DDS 字体",
]
V1100_DESC = "名称与结构"

LEAD = ("这一版把缩放、拖图、涂色时的卡顿逐项拆掉，地图包点一下就能用，手机版旗帜真正能点了；\n"
        "同时修掉 EU4 海洋碎块、河流湖泊全黑、EU5 湖泊粘连三个老问题。")


# ---------------------------------------------------------------- 组件


PAD = 26
BULLET_LH = 27
BULLET_GAP = 9
TITLE_LH = 26


def hero_card_height(doc: Doc, w: float, items: list[str]) -> float:
    font = doc.font(15, False)
    maxw = w - PAD * 2 - 18
    lines = sum(len(wrap(doc, it, font, maxw)) for it in items)
    h = PAD + TITLE_LH + 13 + lines * BULLET_LH + (len(items) - 1) * BULLET_GAP + PAD
    return round(h)


def hero_card(doc: Doc, x, y, w, h, title, items, idx):
    doc.rect(x, y, w, h, fill=CARD, outline=BORDER, width=1, r=16)
    doc.rect(x + PAD, y + PAD + 4, 3, 18, fill=ACCENT, r=1.5)

    tf = doc.font(19, True)
    ty = y + PAD
    doc.text(x + PAD + 13, baseline_of(doc, ty, TITLE_LH, tf), title, tf, TEXT)
    nf = doc.font(12, True)
    doc.text(x + w - PAD, baseline_of(doc, ty, TITLE_LH, nf), idx, nf, FAINT)

    bf = doc.font(15, False)
    maxw = w - PAD * 2 - 18
    cy = ty + TITLE_LH + 13
    for item in items:
        lines = wrap(doc, item, bf, maxw)
        doc.dot(x + PAD + 5, cy + BULLET_LH / 2 - 1, 2.5, ACCENT)
        for ln in lines:
            draw_line(doc, x + PAD + 18, cy, BULLET_LH, bf, ln)
            cy += BULLET_LH
        cy += BULLET_GAP
    return h


def section_header(doc: Doc, y, idx, title, note) -> float:
    bar_h = 24
    doc.rect(MARGIN, y + 3, 3, bar_h, fill=ACCENT, r=1.5)
    nf = doc.font(13, True)
    doc.text(MARGIN + 16, baseline_of(doc, y + 2, 26, nf), idx, nf, ACCENT)
    tf = doc.font(25, True)
    doc.text(MARGIN + 44, baseline_of(doc, y + 2, 26, tf), title, tf, TEXT)
    if note:
        sf = doc.font(13.5, False)
        draw_line(doc, MARGIN, y + 2, 26, sf, plain_runs(note, MUTED), align="right",
                  right=MARGIN + CONTENT)
    return y + 30


def perf_table(doc: Doc, y, w):
    pad = 28
    header_h = 40
    row_h = 46
    note_font = doc.font(13.5, False)
    note_lines = wrap(doc, PERF_NOTE, note_font, w - pad * 2, color=MUTED)
    h = pad + header_h + row_h * len(PERF) + 16 + len(note_lines) * 22 + pad - 4

    x = MARGIN
    doc.rect(x, y, w, h, fill=CARD, outline=BORDER, width=1, r=16)

    col_metric = x + pad
    col_scene = x + pad + 300
    right_after = x + w - pad
    right_before = right_after - 150

    hf = doc.font(12.5, True)
    hb = baseline_of(doc, y + pad, header_h, hf)
    doc.text(col_metric, hb, "指标", hf, MUTED)
    doc.text(col_scene, hb, "地图 / 场景", hf, MUTED)
    doc.text(right_before - doc.w("改前", hf), hb, "改前", hf, MUTED)
    doc.text(right_after - doc.w("改后", hf), hb, "改后", hf, MUTED)

    doc.line(col_metric, y + pad + header_h - 8, right_after, y + pad + header_h - 8, LINE)

    mf = doc.font(16, True)
    sf = doc.font(14, False)
    bf = doc.font(16, False)
    af = doc.font(19, True)
    for i, (metric, scene, before, after) in enumerate(PERF):
        ry = y + pad + header_h + i * row_h
        rb = baseline_of(doc, ry, row_h, mf)
        doc.text(col_metric, rb, metric, mf, TEXT)
        doc.text(col_scene, rb, scene, sf, MUTED)
        doc.text(right_before - doc.w(before, bf), rb, before, bf, (139, 152, 168))
        doc.text(right_after - doc.w(after, af), rb, after, af, CYAN)
        if i < len(PERF) - 1:
            doc.line(col_metric, ry + row_h - 1, right_after, ry + row_h - 1, (29, 35, 44))

    # 表头“改前”那行上面误画的占位已右对齐，这里处理箭头列
    arrow_f = doc.font(15, False)
    for i in range(len(PERF)):
        ry = y + pad + header_h + i * row_h
        rb = baseline_of(doc, ry, row_h, arrow_f)
        ax = right_before + 38
        doc.text(ax, rb, "→", arrow_f, (96, 136, 180))

    ny = y + pad + header_h + len(PERF) * row_h + 16
    for ln in note_lines:
        draw_line(doc, col_metric, ny, 22, note_font, ln)
        ny += 22
    return h


def info_list_card(doc: Doc, x, y, w, title, desc, items, idx):
    """v1.10.1 / v1.10.0 的双列卡片。"""
    pad = 26
    font = doc.font(15, False)
    maxw = w - pad * 2 - 18
    all_lines = [wrap(doc, it, font, maxw) for it in items]
    body_h = sum(len(ls) * BULLET_LH for ls in all_lines) + (len(items) - 1) * BULLET_GAP
    h = pad + TITLE_LH + 13 + body_h + pad

    doc.rect(x, y, w, h, fill=CARD, outline=BORDER, width=1, r=16)
    doc.rect(x + pad, y + pad + 4, 3, 18, fill=ACCENT, r=1.5)
    tf = doc.font(19, True)
    ty = y + pad
    doc.text(x + pad + 13, baseline_of(doc, ty, TITLE_LH, tf), title, tf, TEXT)
    df = doc.font(12.5, False)
    draw_line(doc, x + pad, ty, TITLE_LH, df, plain_runs(desc, MUTED),
              align="right", right=x + w - pad)

    cy = ty + TITLE_LH + 13
    for lines in all_lines:
        doc.dot(x + pad + 5, cy + BULLET_LH / 2 - 1, 2.5, ACCENT)
        for ln in lines:
            draw_line(doc, x + pad + 18, cy, BULLET_LH, font, ln)
            cy += BULLET_LH
        cy += BULLET_GAP
    return h


def legend_card(doc: Doc, y, w):
    pad = 28
    label_w = 160
    desc_font = doc.font(14.5, False)
    desc_w = w - pad * 2 - label_w - 20
    rows = []
    for label, desc in V1102:
        rows.append((label, wrap(doc, desc, desc_font, desc_w, color=TEXT2)))
    rh = [max(28, len(ls) * 24) for _, ls in rows]
    gap = 18
    h = pad + sum(rh) + gap * (len(rows) - 1) + pad

    doc.rect(MARGIN, y, w, h, fill=CARD, outline=BORDER, width=1, r=16)
    lf = doc.font(15.5, True)
    cy = y + pad
    for i, (label, lines) in enumerate(rows):
        lb = baseline_of(doc, cy, 24, lf)
        doc.text(MARGIN + pad, lb, label, lf, TEXT)
        doc.dot(MARGIN + pad - 10, lb - 8, 2.5, ACCENT)
        for ln in lines:
            draw_line(doc, MARGIN + pad + label_w, cy, 24, desc_font, ln)
            cy += 24
        cy = y + pad + sum(rh[: i + 1]) + gap * (i + 1)
    return h


# ---------------------------------------------------------------- 页面


def layout(doc: Doc, draw: bool) -> float:
    y = MARGIN

    # ---- 标题区
    ef = doc.font(12.5, True)
    doc.text(MARGIN + 13, baseline_of(doc, y, 18, ef), "更新报告  /  CHANGELOG", ef, MUTED)
    doc.dot(MARGIN + 4, y + 10, 3, ACCENT)
    date_f = doc.font(14, False)
    draw_line(doc, MARGIN, y - 1, 18, date_f, plain_runs("2026-11-03", MUTED),
              align="right", right=MARGIN + CONTENT)

    h1 = doc.font(48, True)
    doc.text(MARGIN, baseline_of(doc, y + 26, 58, h1), "悖论制图", h1, TEXT)

    # 版本徽章
    pill_w, pill_h = 108, 34
    px_ = MARGIN + CONTENT - pill_w
    py_ = y + 28
    doc.rect(px_, py_, pill_w, pill_h, fill=(26, 38, 50), outline=(46, 72, 92), width=1, r=17)
    pf = doc.font(15, True)
    draw_line(doc, px_, py_ + 1, pill_h - 2, pf, plain_runs("v1.11.0", CYAN), align="center",
              right=px_ + pill_w)

    sub_f = doc.font(21, False)
    sub_runs = [("v1.10", (139, 152, 168)), ("  →  ", ACCENT), ("v1.11.0", CYAN),
                ("  更新报告", TEXT2)]
    draw_line(doc, MARGIN, y + 96, 30, sub_f, sub_runs)
    cov_f = doc.font(13, False)
    draw_line(doc, MARGIN, y + 97, 30, cov_f,
              plain_runs("覆盖 v1.10.0 · v1.10.1 · v1.10.2 · v1.11.0", MUTED),
              align="right", right=MARGIN + CONTENT)

    lead_f = doc.font(16.5, False)
    lead_lines = wrap(doc, LEAD, lead_f, 1000, color=TEXT2)
    ly = y + 140
    for ln in lead_lines:
        draw_line(doc, MARGIN, ly, 27, lead_f, ln)
        ly += 27
    y = ly + 46

    # ---- 01 本版重点
    y = section_header(doc, y, "01", "本版重点", "v1.11.0 · 4 个方向")
    y += 22
    gap = 22
    cw = (CONTENT - gap) // 2
    heights = [hero_card_height(doc, cw, items) for _, items in HERO]
    row1 = max(heights[0], heights[1])
    row2 = max(heights[2], heights[3])
    for i, (title, items) in enumerate(HERO):
        cx = MARGIN + (i % 2) * (cw + gap)
        if i < 2:
            cy = y
            h = row1
        else:
            cy = y + row1 + gap
            h = row2
        if draw:
            hero_card(doc, cx, cy, cw, h, title, items, f"{i + 1:02d}")
    y += row1 + gap + row2 + 50

    # ---- 02 性能数字
    y = section_header(doc, y, "02", "性能数字", "实测 · 单位 ms / ns")
    y += 22
    th = perf_table(doc, y, CONTENT) if draw else _perf_height(doc, CONTENT)
    y += th + 50

    # ---- 03 v1.10.2
    y = section_header(doc, y, "03", "v1.10.2", "2026-10-27 · 导出、图例与兼容")
    y += 22
    y += legend_card(doc, y, CONTENT) if draw else _legend_height(doc, CONTENT)
    y += 50

    # ---- 04 v1.10.1 / v1.10.0
    y = section_header(doc, y, "04", "v1.10.1 与 v1.10.0", "2026-10-27 / 2026-10-25")
    y += 22
    h1c = _info_height(doc, cw, V1101)
    h2c = _info_height(doc, cw, V1100)
    ch = max(h1c, h2c)
    if draw:
        info_list_card(doc, MARGIN, y, cw, "v1.10.1", V1101_DESC, V1101, "01")
        info_list_card(doc, MARGIN + cw + gap, y, cw, "v1.10.0", V1100_DESC, V1100, "02")
    y += ch + 56

    # ---- 页脚
    doc.line(MARGIN, y, MARGIN + CONTENT, y, LINE)
    fy = y + 28
    uf = doc.font(15, False)
    url_runs = [("github.com/", (139, 152, 168)), ("Nianjiujiang/pdx-map-editor", TEXT2)]
    draw_line(doc, MARGIN, fy, 22, uf, url_runs)
    tf = doc.font(14, False)
    draw_line(doc, MARGIN, fy, 22, tf,
              plain_runs("单文件 · 无需安装 · 支持 CK3 / EU4 / HOI4 / VIC3 / EU5", MUTED),
              align="right", right=MARGIN + CONTENT)
    return fy + 22 + MARGIN


def _perf_height(doc: Doc, w: float) -> float:
    pad = 28
    header_h = 40
    row_h = 46
    note_font = doc.font(13.5, False)
    note_lines = wrap(doc, PERF_NOTE, note_font, w - pad * 2, color=MUTED)
    return pad + header_h + row_h * len(PERF) + 16 + len(note_lines) * 22 + pad - 4


def _legend_height(doc: Doc, w: float) -> float:
    pad = 28
    label_w = 160
    desc_font = doc.font(14.5, False)
    desc_w = w - pad * 2 - label_w - 20
    rh = [max(28, len(wrap(doc, d, desc_font, desc_w, color=TEXT2)) * 24) for _, d in V1102]
    return pad + sum(rh) + 18 * (len(V1102) - 1) + pad


def _info_height(doc: Doc, w: float, items: list[str]) -> float:
    pad = 26
    font = doc.font(15, False)
    maxw = w - pad * 2 - 18
    lines = sum(len(wrap(doc, it, font, maxw)) for it in items)
    return pad + TITLE_LH + 13 + lines * BULLET_LH + (len(items) - 1) * BULLET_GAP + pad


def verify_text() -> None:
    chars: set[str] = set()
    for _, items in HERO:
        chars.update("".join(items))
    chars.update(LEAD)
    chars.update(PERF_NOTE)
    for row in PERF:
        chars.update("".join(row))
    for label, desc in V1102:
        chars.update(label + desc)
    chars.update("".join(V1101 + V1100))
    chars.update("悖论制图 更新 v1.10 → v1.11.0 更新报告 2026-11-03 本版重点 性能数字 "
                 "github.com/Nianjiujiang/pdx-map-editor 单文件 · 无需安装 · 支持 "
                 "「」—–×")
    chars.discard(" ")
    chars.discard(chr(10))

    for name, path in (("bold", pick_font(FONT_BOLD, FALLBACK_BOLD)),
                       ("regular", pick_font(FONT_REG, FALLBACK_REG))):
        covered = cmap_chars(path)
        if covered is None:
            print(f"字体检查 {name}: 未装 fontTools，跳过 cmap 覆盖检查")
            continue
        missing = sorted(c for c in chars if ord(c) not in covered)
        if missing:
            raise SystemExit(f"字体 {path} 缺字：{''.join(missing)}")
        print(f"字体检查 {name}: {os.path.basename(path)} 覆盖 {len(chars)} 个字，无缺字")

    # 真渲染一遍，确认不是豆腐块（与私用区缺字符比较形状）
    probe = Image.new("RGB", (600, 80), BG)
    pd = ImageDraw.Draw(probe)
    f = ImageFont.truetype(pick_font(FONT_BOLD, FALLBACK_BOLD), 40)
    tofu = bytes(f.getmask("\ue123"))
    for ch in "悖论制图更新":
        if bytes(f.getmask(ch)) == tofu:
            raise SystemExit(f"字形渲染异常（可能豆腐块）：{ch}")
    pd.text((4, 10), "悖论制图 更新", font=f, fill=(255, 255, 255))
    print("字形渲染检查通过：悖论制图 更新")


def main() -> None:
    verify_text()
    doc = Doc(SCALE)
    height = int(round(layout(doc, draw=False)))
    doc.enable(W, height)
    layout(doc, draw=True)
    assert doc.img is not None
    out = doc.img.resize((W, height), Image.LANCZOS)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out.save(OUT, "PNG", optimize=True)
    size = os.path.getsize(OUT)
    print(f"已生成 {OUT}")
    print(f"{W} × {height} px, {size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
