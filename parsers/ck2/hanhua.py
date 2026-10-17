# -*- coding: utf-8 -*-
"""读 CK2 汉化 mod 的「双字节」本地化文件。

CK2 官方只带英 / 法 / 德 / 西四种语言，**没有中文列** ✗（见 `parsers/ck2/parser.py`
的 `prov_loc_key` 那段 ✓）。汉化组的做法是**整套替换** ``localisation/*.csv``，
把中文按一种自造编码塞进 ENGLISH 那一栏 ✓。

## 这套编码跟 EU4 那套不是一个东西 ✗✗（别照搬 `parsers/eu4/hanhua.py`）

两家的"双字节"都长成 ``<标记> <低字节> <高字节>`` ✓，但**标记位与偏移完全不同** ✗：

======  ==========================================  ==============================
         EU4（`parsers/eu4/hanhua.py` ✓）             CK2（本文件 ✓）
======  ==========================================  ==============================
标记     ``0x10 ~ 0x1F``（低两位 = 页码 / 减数）    ``0x10 ~ 0x13``（低两位 = **冲突位**）
码位     ``(高<<8 | 低) + 偏移(标记)``              ``(高<<8 | 低)``，**不加偏移** ✓
修正     标记自带偏移                              **低字节冲突 → +14**、
                                                   **高字节冲突 → −9**（挪完再拼 ✓）
依据     汉化 mod 里解出来的地名拟出来的              ParaTranz 转换器的公开方案 ✓
======  ==========================================  ==============================

CK2 这套的**权威出处**是本机那份转换器
``C:\\Users\\lyc20\\.openclaw\\workspace\\tools\\ck2cjk\\ck2cjk.py``
（复刻 ParaTranz 在线转换器的 CK2 方案 ✓）。下面是它的核心，一字不差地照搬过来 ✓：

    [前缀, 低字节, 高字节]              # ⚠ 低字节在前、高字节在后 ✓
    前缀 = 0x10 | (低字节冲突 ? 1 : 0) | (高字节冲突 ? 2 : 0)
    低字节冲突 → 低字节 += 14
    高字节冲突 → 高字节 -= 9
    冲突表（落在这些值里就要挪 —— 它们会跟文件语法 / 控制符打架 ✓）：
        0, 10, 13, 32, 34, 36, 64, 91, 92, 123, 125, 126,
        128, 163, 164, 167, 189, 59, 93, 95, 61, 33

    ⚠ **冲突表里有 ``;`` (59) / 换行 (10, 13) / 空格 (32) / 引号 (34)** ✗ ——
      这正是为什么"整份文件先解码、再按 ``;`` 切行"是**安全**的 ✓：
      三字节单元里面**永远不可能**出现分隔符 ✓（编码时已经把它们挪开了 ✓）
      所以不用像 EU4 那样先 `utf-8 → cp1252` 倒一层 ✗（EU4 是文件被存成
      UTF-8 才需要那一步 ✓ CK2 这份是**原始字节流** ✓ 直接解就行 ✓）

ASCII（< 0x100）原样 1 字节 ✓，汉字 3 字节 ✓，整个文件仍是合法单字节流 ✓
（CK2 引擎按单字节读文本，既不认 UTF-8 也不认 GBK ✓ 汉化组只能这么绕 ✓）

实测：``ck2_chinese`` 那份 mod 的 ``localisation/HolyFury.csv`` 头 24 字节是
``### ParaTranz ###`` 全 ASCII ✓，解出来的 ``PROV`` / ``c_`` / ``b_`` 行都是通顺中文 ✓。
"""

from __future__ import annotations

import re
from pathlib import Path

#: 编码位置冲突的那几个值（照搬转换器的 CONFLICT ✓）
CONFLICT = frozenset((
    0, 10, 13, 32, 34, 36, 64, 91, 92, 123, 125, 126,
    128, 163, 164, 167, 189, 59, 93, 95, 61, 33,
))

#: 三字节单元的标记字节范围（低两位是冲突位 ✓）
PREFIX_MIN, PREFIX_MAX = 0x10, 0x13

#: 冲突修正量（旧版 CK2 用 15 ✓ 现行是 14 ✓ 本机 mod 实测走 14 ✓）
LO_OFF, HI_OFF = 14, 9


def decode_unit(prefix: int, lo: int, hi: int, old: bool = False) -> int:
    """三字节 → 码位（照搬 `ck2cjk.decode_unit` ✓）。"""
    off = 15 if old else LO_OFF
    if prefix == 0x11:
        lo -= off
    elif prefix == 0x12:
        hi += 9
    elif prefix == 0x13:
        lo -= off
        hi += 9
    return ((hi & 0xFF) << 8) | (lo & 0xFF)


def decode(raw: bytes, old: bool | None = None) -> str:
    """原始字节流 → 正常文字（ASCII 原样，三字节还原成汉字 ✓）。

    :param old: **低字节的修正量取哪一版** ✓
        ``False`` = 14（``ck2cjk.py`` 里写的现行值 ✓）
        ``True``  = 15（转换器里那个"旧版 CK2"分支 ✓）
        ``None``（默认）= **自动判** ✓ —— 见 ``pick_old`` ✓

    ⚠⚠ **本机这份 ck2_chinese 是旧版 15** ✗✗（这一条不定标，解出来会**整体差一** ✓）
      实测定标：``e_hre`` 那行是 ``11 32 57 10 57 7f …`` ✓

      * 按 **14** 解 → ``lo = 0x32 - 14 = 0x24`` → ``U+5724`` = **圤** ✗
      * 按 **15** 解 → ``lo = 0x32 - 15 = 0x23`` → ``U+5723`` = **圣** ✓✓
        （"神圣罗马帝国" 才对 ✓ 按 14 解出来是"神圤罗马帝国" ✓ 一眼假 ✓）

      ⚠ 而且那一位 **0x23 在现行冲突表里根本没有** ✗（转换器的 CONFLICT 里没有 35 ✓）
        —— 旧版是**另一张表 + 另一个偏移** ✓ 所以这不是"表抄错了"，是**版本不同** ✓
        （0x10 无冲突那一路、0x12 高字节那一路两版**完全一样** ✓ 实测对拍过 ✓
         只有 0x11 / 0x13 这两路受影响 ✓）
    """
    if old is None:
        old = pick_old(raw)
    out: list[str] = []
    i, n = 0, len(raw)
    while i < n:
        b = raw[i]
        if PREFIX_MIN <= b <= PREFIX_MAX and i + 2 < n:
            out.append(chr(decode_unit(b, raw[i + 1], raw[i + 2], old)))
            i += 3
        else:
            out.append(chr(b))          # 按 latin-1 映射：ASCII 就是它自己 ✓
            i += 1
    return "".join(out)


#: 常见汉字（按频率排的前 200 来个 ✓）—— 只用来给"两种偏移哪個对"投票 ✓
#: ⚠ 这不是"中文检测器" ✗ —— 两种解法解出来的都是**合法汉字** ✓
#:   区别只在"是不是人话" ✓ 所以拿一张常见字表投票就够 ✓（差一的字基本都落在生僻字上 ✓）
_COMMON_HAN = set(
    "的一是不了在人有我他这个上们来到时大地为子中你说生国年着就那和要"
    "她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当"
    "没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手"
    "又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被"
    "高已亲其进此话常与活正感国王帝圣城西西里罗马巴黎伦敦中华帝国公爵"
    "伯爵领地省区海河湖岛山"
)


def pick_old(raw: bytes, probe: int = 200_000) -> bool:
    """自动判这份文件该用哪个偏移（``True`` = 旧版 15 ✓）。

    做法：两种都解一遍（只看前 ``probe`` 字节 ✓ 大文件也不慢 ✓），
    数各自命中了多少**常见汉字** ✓ 谁多听谁的 ✓；打平（例如整份没有
    0x11/0x13 单元 ✓ 那两版结果**一模一样** ✓）就按**现行 14** ✓。
    """
    head = raw[:probe]
    if not any(b in (0x11, 0x13) for b in head):
        return False                       # 两版等价 ✓ 按现行值 ✓
    score_new = score_old = 0
    for old in (False, True):
        hits = 0
        i, n = 0, len(head)
        while i < n:
            b = head[i]
            if PREFIX_MIN <= b <= PREFIX_MAX and i + 2 < n:
                c = chr(decode_unit(b, head[i + 1], head[i + 2], old))
                if c in _COMMON_HAN:
                    hits += 1
                i += 3
            else:
                i += 1
        if old:
            score_old = hits
        else:
            score_new = hits
    return score_old > score_new


def looks_hanhua(path: Path, probe: int = 4096) -> bool:
    """粗判一个 ``.csv`` 是不是"这套双字节"的汉化（而不是原版 ASCII ✓）。

    判据：头几 KB 里落进 ``0x10~0x13`` 的字节**够多** ✓
    ⚠ 原版 CSV 里也会偶尔出现这几个字节 ✗（那是 cp1252 的重音字母 ✓ 例如
      ``Lüneburg`` 的 ``ü`` 是 0xFC ✓ 不在这段 ✓；但控制字符可能零星有 ✓）——
      所以门槛取"多"，不取"有" ✓（跟 EU4 那边 `is_hanhua` 同一个思路 ✓）
    """
    try:
        head = Path(path).read_bytes()[:probe]
    except OSError:
        return False
    return sum(1 for b in head if PREFIX_MIN <= b <= PREFIX_MAX) > 40


def read_text(path: Path) -> str:
    """读一个汉化文件 → 去掉 UTF-8 BOM 之后解码好的文本（偏移自动判 ✓）。"""
    p = Path(path)
    data = p.read_bytes()
    if data[:3] == b"\xef\xbb\xbf":
        data = data[3:]
    return decode(data)


#: 行首的键（CK2 的 CSV：``KEY;ENGLISH;…;x`` ✓ 键永远是 ASCII ✓）
_KEY = re.compile(r"^([A-Za-z0-9_.'\-]+)")

#: 排版码（``§Y…§!`` ✓）与 ``$VAR$``（汉化里偶尔留着 ✓）
_FMT = re.compile(r"§.")


def _clean(v: str) -> str:
    v = _FMT.sub("", v)
    for a, b in (("\\n", " "), ("\\t", " "), ("\u00a0", " ")):
        v = v.replace(a, b)
    return " ".join(v.split())


def load_file(path: Path, col: int = 1) -> dict[str, str]:
    """读一个汉化 ``.csv`` → ``{key: 中文}``。

    :param col: 取第几栏（CK2 的 CSV 是 ``键;英;法;德;;西;…;x`` ✓
        汉化**整套替换 ENGLISH 那一栏** ✓ 所以默认取 **1** ✓）。
        ⚠ 汉化组也可能只填了别的栏 ✗ —— 取不到中文时**往后再找一栏有汉字的** ✓
          （宁可多找一个，也别把一整份文件白白丢掉 ✓）
    """
    p = Path(path)
    if not p.is_file():
        return {}
    text = read_text(p)
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue                       # 表头 ``#CODE;ENGLISH;…`` 与注释 ✓
        parts = line.split(";")
        if len(parts) < 2:
            continue
        m = _KEY.match(parts[0].strip())
        if m is None:
            continue
        key = m.group(1)
        val = _clean(parts[col]) if col < len(parts) else ""
        if not _has_han(val) and col == 1:
            # ENGLISH 栏里没有汉字 → 往后找第一栏有汉字的（见上面那条 ⚠ ✓）
            for c in range(2, len(parts)):
                cand = _clean(parts[c])
                if _has_han(cand):
                    val = cand
                    break
        if val:
            out.setdefault(key, val)
    return out


#: 汉字（含 CJK 扩展 A 与常用标点 ✓）—— 用来判"这一栏是不是真中文" ✓
_HAN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]")


def _has_han(s: str) -> bool:
    return bool(s) and _HAN.search(s) is not None


def load_dir(loc_dir: Path, keys=None, col: int = 1) -> dict[str, str]:
    """把一个汉化 mod 的 ``localisation/`` 整个读了 → ``{key: 中文}``。

    后面读到的**不覆盖**前面读到的 ✓（``setdefault`` ✓ 跟 CK3/EU4 那边一个口径 ✓
    "先加载的赢" ✓）。子目录也递归（汉化组爱按 DLC 分文件夹 ✓）。

    :param keys: 只要这些键（``None`` = 全要 ✓）。**传进来能省一半时间** ✓ ——
        汉化那 91 个文件加起来二十多 MB ✓ 全解析一遍要好几秒 ✓
    """
    want = set(keys) if keys is not None else None
    out: dict[str, str] = {}
    d = Path(loc_dir)
    if not d.is_dir():
        return out
    for fp in sorted(d.rglob("*.csv")):
        for k, v in load_file(fp, col=col).items():
            if want is not None and k not in want:
                continue
            out.setdefault(k, v)
    return out


def find_hanhua(base: Path) -> list[Path]:
    """在"文档 / Paradox Interactive / Crusader Kings II / mod"下找汉化 mod。

    判据：``<mod>/localisation/*.csv`` 里有"这套双字节"的文件 ✓
    返回的是**每个 mod 的 localisation 目录**（调用方直接喂 ``load_dir`` ✓）。
    """
    base = Path(base)
    if not base.is_dir():
        return []
    out: list[Path] = []
    for mod in sorted(base.iterdir()):
        if not mod.is_dir():
            continue
        loc = mod / "localisation"
        if not loc.is_dir():
            continue
        if any(looks_hanhua(f) for f in sorted(loc.glob("*.csv"))[:4]):
            out.append(loc)
    return out
