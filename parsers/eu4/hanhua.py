"""读 Paradox 汉化 mod 的"双字节"本地化文件。

EU4 官方只带英法德西四种语言。中文汉化 mod 的做法是**顶替 english 槽位**，
再把一堆 CJK 汉字塞进 ``localisation/*_l_english.yml``。但那些文件不是普通
UTF-8 中文 —— 直接打开会看到一堆控制字符，这就是所谓"双字节"。

## 这文件到底是怎么编的

两层，缺一不可：

1. **外层：整份文件是"原始字节流"按 cp1252 解码后再存成 UTF-8 的。**
   所以第一步得倒回去：``文件 → utf-8 解码 → 按 cp1252 编码``。
   注意是 **cp1252 不是 latin-1** —— 0x80–0x9F 这一段两者不一样，
   用 latin-1 反解会把 0x9A（š）、0x97（—）这些字节弄丢，后面怎么修都对不齐。

2. **内层：汉字是三字节一组** ``<标记> <低字节> <高字节>``，
   码位 = ``(高 << 8 | 低) + 偏移(标记)``。
   标记字节在 0x10–0x13，**低 2 位是标志位**：

   ====== ========== ===================================
   标记    偏移        例
   ====== ========== ===================================
   0x10   0          0x65AF → 斯
   0x11   −0x0E      0x4E1B → 不
   0x12   +0x900     0x56B7 → 德
   0x13   +0x8F2     0x560E → 开（开罗）
   ====== ========== ===================================

   ``0x13`` 的偏移正好是 ``0x900 − 0x0E``，所以可以写成
   ``(标记 & 2 ? 0x900 : 0) − (标记 & 1 ? 0x0E : 0)``。

   这几个偏移是把整份 prov_names 解出来、逐个对"解出来的像不像真地名"
   拟出来的：斯德哥尔摩 / 君士坦丁堡 / 柏林 / 洛阳 / 石勒苏益格 /
   科克斯霍尔姆 / 素可泰 / 孟加拉 全部对上，3728 条零乱码。

ASCII 直接原样过。整个解码过程是可逆的，但这里只做"读"。
"""

from __future__ import annotations

import re
from pathlib import Path

#: cp1252 里 0x80–0x9F 那一段（其余跟 latin-1 相同）
_CP1252_HIGH = {
    0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026,
    0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160,
    0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019,
    0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
    0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153,
    0x9E: 0x017E, 0x9F: 0x0178,
}
_BACK_TO_BYTE = {v: k for k, v in _CP1252_HIGH.items()}

#: 双字节部分的标记字节范围
_MARK_LO, _MARK_HI = 0x10, 0x1F

#: 标记字节低两位对应的两个修正量
_PAGE = 0x900      # bit1
_TRIM = 0x0E       # bit0

_LOC_LINE = re.compile(
    # 值里可以有 \" 转义 —— [^"]* 会在第一个引号处腰斩（ck3/parser.py 是对的写法）
    rb"(?m)^\s*([A-Za-z0-9_.'\-]+)\s*:\s*\d*\s*\"((?:[^\"\\]|\\.)*)\""
)

#: 汉字（含扩展 A）。判"这文件解出来是不是中文"就看它占多少。
_CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff]")

# ------------------------------------------------------------------ 认汉化

#: 快路：前这么多字节里标记字节够密，就不必整个文件解一遍
_PROBE_BYTES = 4096
_PROBE_MIN = 40

#: 慢路：整个文件里的标记字节数、解出来汉字占非 ASCII 字符的比例
#:
#: 🔴 **2026-10-28 为什么非要慢路** ✗✗（风云世纪两千年国名乱码）
#:   光看开头那 4 KB 会把**小文件**判错 —— FY 的 2145 个 yml 里有 77 个
#:   标记字节只有 3–39 个（`QF_lujiang_l_english.yml` 75 字节 6 个、
#:   `replace/liangyu_prov_names_l_english.yml` 147 字节 13 个），
#:   一个都过不了 `> 40` 这条线 → 被当成**普通 UTF-8 文件**读
#:   → `0x10 xx yy` 解成 `\x10` + cp1252 垃圾 ✓
#:   实测这 77 个全解成汉字（比例 0.82–1.00），而 3 个"英文里碰巧有
#:   0x10–0x1F 字节"的大文件（`mf_missions` 等）比例是 0 ✓
#:   → 用"解出来的汉字占非 ASCII 的比例"当判据，两边都分得开 ✓
#:
#: ⚠ 原版 EU4 的 578 个 yml **一个标记字节都没有**（实测）→ 全部走快路返回 False，
#:   一个都不进慢路，构建时间不受影响 ✓
_MIN_MARKS = 3          # 标记字节比这还少，不值得解（1–2 个是文本里的噪音）
_MIN_CJK_RATIO = 0.30   # 解出来非 ASCII 字符里汉字不足三成，就不是汉化


def marker_offset(mark: int) -> int:
    """标记字节 → 码位修正量。低两位是标志位。"""
    return (_PAGE if mark & 2 else 0) - (_TRIM if mark & 1 else 0)


def to_raw_bytes(text: str) -> bytes:
    """把文件里的字符串倒回"原始字节流"（utf-8 → cp1252）。"""
    out = bytearray()
    for ch in text:
        c = ord(ch)
        if c in _BACK_TO_BYTE:
            out.append(_BACK_TO_BYTE[c])
        elif c <= 0xFF:
            out.append(c)          # cp1252 未定义的那 5 个字节按字节原样走
        else:
            out.append(0x3F)       # 真的不在 cp1252 里，降级成 '?'
    return bytes(out)


def decode(raw: bytes) -> str:
    """原始字节流 → 正常文字。"""
    out: list[str] = []
    i, n = 0, len(raw)
    while i < n:
        c = raw[i]
        if _MARK_LO <= c <= _MARK_HI and i + 2 < n:
            cp = ((raw[i + 2] << 8) | raw[i + 1]) + marker_offset(c)
            out.append(chr(cp) if 0 < cp < 0x110000 else "\ufffd")
            i += 3
        else:
            out.append(chr(c))
            i += 1
    return "".join(out)


def cjk_ratio(path: Path) -> tuple[float, int]:
    """把文件里带标记字节的值都解一遍 → (汉字占非 ASCII 的比例, 标记字节总数)。

    只给 ``looks_hanhua`` 的慢路用；返回值也拿来打日志，说明"凭什么认成汉化"。
    """
    try:
        data = Path(path).read_bytes()
    except OSError:
        return 0.0, 0
    if data[:3] == b"\xef\xbb\xbf":
        data = data[3:]
    marks = sum(1 for b in data if _MARK_LO <= b <= _MARK_HI)
    if not marks:
        return 0.0, 0
    cjk = other = 0
    for m in _LOC_LINE.finditer(data):
        raw = m.group(2)
        if not any(_MARK_LO <= b <= _MARK_HI for b in raw):
            continue
        for ch in decode(to_raw_bytes(raw.decode("utf-8", "replace"))):
            o = ord(ch)
            if o < 0x80:
                continue
            if _CJK.match(ch):
                cjk += 1
            else:
                other += 1
    tot = cjk + other
    return ((cjk / tot) if tot else 0.0), marks


def looks_hanhua(path: Path) -> bool:
    """这个 yml 是不是"双字节汉化"。

    先看开头 4 KB（覆盖 95% 的文件，一个 read 就够）；
    过不了再整个文件解一遍数汉字比例 —— 小文件全靠这一条捞回来。

    ⚠ 这里**不能**简单放宽阈值了事：FY 里真有英文大文件在正文中间
      碰巧带着 0x10–0x1F（`Saladin\\x12\\x19\\x17s` 这种转义残留），
      按字节数放宽就会把它们当汉化解出一堆垃圾 ✗ 汉字比例才分得开 ✓
    """
    try:
        with open(path, "rb") as fp:
            head = fp.read(_PROBE_BYTES)
    except OSError:
        return False
    if sum(1 for b in head if _MARK_LO <= b <= _MARK_HI) > _PROBE_MIN:
        return True
    ratio, marks = cjk_ratio(path)
    if marks < _MIN_MARKS:
        return False
    return ratio >= _MIN_CJK_RATIO


def load_file(path: Path) -> dict[str, str]:
    """读一个汉化 yml → {key: 中文}。文件不在就返回空表。"""
    p = Path(path)
    if not p.is_file():
        return {}
    data = p.read_bytes()
    if data[:3] == b"\xef\xbb\xbf":
        data = data[3:]
    out: dict[str, str] = {}
    for m in _LOC_LINE.finditer(data):
        key = m.group(1).decode("latin-1")
        value = decode(to_raw_bytes(m.group(2).decode("utf-8", "replace")))
        value = " ".join(value.replace("\u00a0", " ").split())
        if value:
            out[key] = value
    return out


def load_dir(loc_dir: Path, keys=None) -> dict[str, str]:
    """把一个汉化 mod 的 localisation 目录整个读了，返回 {key: 中文}。

    后面的文件不覆盖前面的 —— 保留先读到的（跟游戏"先加载的赢"一致）。
    **``replace/`` 例外，它最后读而且覆盖**：那是覆盖机制，放的是"改过原版的那份"。
    （2026-10-13 烘 VN 时踩的：伏尔泰的噩梦把**自己的**地名整份放在
    ``localisation/replace/`` 下，外面那层反而是原版 EU4 的汉化 ——
    只读外面的话，VN 的核心区域名会退回原版那套，跟它的地图对不上。）
    子目录也一并递归，模组爱按主题分文件夹。
    """
    want = set(keys) if keys is not None else None
    out: dict[str, str] = {}
    d = Path(loc_dir)
    if not d.is_dir():
        return out
    plain: list[Path] = []
    override: list[Path] = []
    for fp in sorted(d.rglob("*.yml")):
        rel = fp.relative_to(d).parts[:-1]        # 去掉文件名，只看目录链
        (override if "replace" in rel else plain).append(fp)
    for fp in plain:
        for k, v in load_file(fp).items():
            if want is not None and k not in want:
                continue
            out.setdefault(k, v)
    for fp in override:
        for k, v in load_file(fp).items():
            if want is not None and k not in want:
                continue
            out[k] = v                            # 覆盖机制：replace/ 里的赢
    return out


# ------------------------------------------------------------------ 找汉化

def is_hanhua(path: Path) -> bool:
    """粗判一个 workshop 条目是不是"顶替 english 槽的中文汉化"。

    ⚠ 只看文件名带 ``_l_english`` 的那批，**不看**子目录 —— 这里问的是
      "这个 workshop 条目整体是不是汉化包"，有一个像样的中文文件就够了 ✓
    """
    loc = Path(path) / "localisation"
    if not loc.is_dir():
        return False
    return any(looks_hanhua(fp) for fp in loc.glob("*_l_english.yml"))


def find_hanhua(workshop_content: Path, appid: int = 236850) -> list[Path]:
    """在 workshop 目录下找出所有汉化 mod。"""
    root = Path(workshop_content) / str(appid)
    if not root.is_dir():
        return []
    return [p for p in sorted(root.iterdir()) if p.is_dir() and is_hanhua(p)]
