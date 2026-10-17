"""EU5 存档解析：从 1337 开局档里读出"每个地块归哪个国家"。

规格来自廿九摸出来的结论（不是猜的），要点全在这里 —— **别再自己瞎试**：

文件布局
    ``SAV02`` + version(2 hex) + kind(2 hex) + 8B 随机 + meta_len(8 hex) + 8B 填充 + ``\\n``
    = **32 字节头**（v1 是 24 字节）→ 之后 **meta（二进制，本例 404434 字节）**
    → 最后是 **ZIP（Deflate）**，含 ``gamestate``(172MB) 与 ``string_lookup``(658KB)。
    头部字节在前，Python 的 ``zipfile`` 会自动跳过前缀找 EOCD ✓。

``string_lookup``
    跳过前 5 字节，然后反复 ``<u16 LE 长度><UTF-8 字节>``（本例 37644 条）。
    里面是**运行时 intern 的字符串**（各种 manager 名），
    **绝不含 owner / provinces 这类字段名** —— 别再在里面找字段名 ✗。

``gamestate`` = lexeme 流
    每个元素以 u16 LE 的 id 开头：

    ================  ==========================================
    0x0001 / 0x0003   结构类 / ``{``
    0x0004            ``}``
    0x0014            标量 U32（4B）
    0x000c            I32（4B）
    0x000d            F32（4B）
    0x000e            BOOL（1B）
    0x000f / 0x0017   QUOTED / UNQUOTED（先 u16 长度再字节）
    0x0167            F64（8B）
    0x029c            U64（8B）
    0x0317            I64（8B）
    0x0243            RGB（后跟 ``{`` + 3~4 个 u32 + ``}``）
    0x0d3e..0x0d46    查表 token：payload 宽度依次 2/4/1/3/0(空串)/1/2/3/4，
                      值就是下标，用 ``string_lookup`` 还原成字符串
    0x0d47..0x0d55    变宽定点数：0x0d47 = 无 payload 的 0；
                      0x0d48..0x0d4e = 1~7 字节正数；0x0d4f..0x0d55 = 1~7 字节负数；
                      值 = 小端整数 ÷ 100000
    其余任何 id          **game token**（编译期字段名，无 payload，
                      值就是 id 本身，名字解不出但结构能照走）
    ================  ==========================================

    172MB **不要建成树** ✗ —— 用流式的 ``skip`` 扫一遍即可。

三张表（按"形状"认，靠 token 值定位）
    ① 国家 tag：顶层 token ``11468``(countries) → 子 key ``463`` → ``<u32, lookup>``
    ② 地块名：在 **meta 区**：token ``2526``(metadata) → ``12855`` → ``11712``
       → 一串长度前缀字符串，**下标 + 1 = 地块 id**
    ③ 地块归属：顶层 token ``11712``(locations) → 子 key ``11712``
       → key = 地块 id 的大 map，每个对象的字段 token ``10258`` 就是 owner（国家 id）
       （``11475`` / ``11476`` 同值，是 controller 一类）

校验锚点
    ``stockholm→3→SWE``、``london→289→ENG``、``paris→1141→FRA``、
    ``constantinople→203→BYZ``。这份存档正好是开局 1337.4.1，
    所以"当前 owner"就是 1337 归属；要别的年份读地块对象里的 ``ownership_history``。
"""

from __future__ import annotations

import csv
import struct
import sys
import zipfile
from pathlib import Path

#: 顶层 / 关键 token（编译期字段名，规格里给的）
T_COUNTRIES = 11468
T_COUNTRY_CHILD = 463
T_LOCATIONS = 11712
T_OWNER = 10258
T_META = 2526
T_META_A = 12855
T_META_B = 11712

#: lexeme id
L_STRUCT = 0x0001
L_OPEN = 0x0003
L_CLOSE = 0x0004
L_U32, L_I32, L_F32, L_BOOL = 0x0014, 0x000c, 0x000d, 0x000e
L_QUOTED, L_UNQUOTED = 0x000f, 0x0017
L_F64, L_U64, L_I64 = 0x0167, 0x029c, 0x0317
L_RGB = 0x0243
LOOKUP = {0x0D3E + i: w for i, w in enumerate((2, 4, 1, 3, 0, 1, 2, 3, 4))}
FIXED = {}
for _i in range(1, 8):                       # 0x0d48..0x0d4e 正数
    FIXED[0x0D47 + _i] = _i
for _i in range(1, 8):                       # 0x0d4f..0x0d55 负数
    FIXED[0x0D4E + _i] = -_i
FIXED[0x0D47] = 0


class Reader:
    """在 bytes 上顺序读的游标。"""

    def __init__(self, buf: bytes, pos: int = 0):
        self.b = buf
        self.p = pos

    def u16(self) -> int:
        v = self.b[self.p] | (self.b[self.p + 1] << 8)
        self.p += 2
        return v

    def u32(self) -> int:
        v = struct.unpack_from("<I", self.b, self.p)[0]
        self.p += 4
        return v

    def skip(self, n: int) -> None:
        self.p += n


def load_save(save: Path):
    """→ ``(meta_bytes, gamestate_bytes, string_lookup_bytes)``。

    头 32 字节（v1 是 24）里第 20~27 字节是 meta 长度；zip 段靠 ``zipfile`` 自己定位
    （它会自动跳过 zip 前面的前缀字节 ✓）。
    """
    raw = Path(save).read_bytes()
    if raw[:4] == b"SAV0":
        head = 32 if raw[4:5].isdigit() and raw[:5] >= b"SAV02" else 24
        meta_len = int(raw[12:20].decode("ascii", "replace"), 16)
        meta = raw[head:head + meta_len]
    else:
        head, meta_len, meta = 0, 0, b""
    with zipfile.ZipFile(save) as z:
        names = z.namelist()
        game = z.read("gamestate" if "gamestate" in names else names[0])
        look = z.read("string_lookup" if "string_lookup" in names else names[-1])
    return meta, game, look


def parse_lookup(data: bytes) -> list[str]:
    """``string_lookup`` → 字符串表（下标 = 查表 token 的值）。"""
    out: list[str] = []
    p = 5
    while p + 2 <= len(data):
        ln = data[p] | (data[p + 1] << 8)
        s = data[p + 2:p + 2 + ln]
        if ln == 0 or len(s) != ln:
            break
        out.append(s.decode("utf-8", "replace"))
        p += 2 + ln
    return out


def skip_value(r: Reader) -> int | None:
    """读一个元素，跳过它的 payload；返回**标量值**（能直读的才返回，否则 None）。"""
    ident = r.u16()
    if ident in (L_STRUCT, L_OPEN):
        while r.p + 2 <= len(r.b):
            save = r.p
            if r.b[r.p] | (r.b[r.p + 1] << 8) == L_CLOSE:
                r.p += 2
                return None
            skip_value(r)
            if r.p == save:
                break
        return None
    if ident == L_CLOSE:
        return None
    if ident == L_U32:
        v = r.u32(); return v
    if ident in (L_I32, L_F32):
        v = struct.unpack_from("<i", r.b, r.p)[0]; r.skip(4); return v
    if ident == L_BOOL:
        v = r.b[r.p]; r.skip(1); return v
    if ident in (L_QUOTED, L_UNQUOTED):
        ln = r.u16(); r.skip(ln); return None
    if ident == L_F64:
        r.skip(8); return None
    if ident in (L_U64, L_I64):
        r.skip(8); return None
    if ident == L_RGB:
        # { + 3~4 个 u32 + }
        open_id = r.u16()
        if open_id == L_OPEN:
            n = 0
            while n < 5 and r.p + 2 <= len(r.b):
                if r.b[r.p] | (r.b[r.p + 1] << 8) == L_CLOSE:
                    r.p += 2
                    break
                skip_value(r)
                n += 1
        return None
    if ident in LOOKUP:
        w = LOOKUP[ident]
        r.skip(w)
        return None
    if ident in FIXED:
        w = FIXED[ident]
        r.skip(abs(w))
        return None
    # 其余：game token，无 payload
    return ident


def walk(buf: bytes):
    """流式遍历：回调式太绕，这里返回一个能顺序 next 的遍历器（只在需要时用）。"""
    r = Reader(buf)
    while r.p + 2 <= len(buf):
        save = r.p
        yield r
        skip_value(r)
        if r.p == save:
            break


def read_container(buf: bytes, pos: int):
    """从 ``pos`` 读一个容器，返回 ``(元素列表, 结束位置)``；元素 = (id, payload读取器)。"""
    r = Reader(buf, pos)
    ident = r.u16()
    if ident not in (L_STRUCT, L_OPEN):
        return [], pos + 2
    items = []
    while r.p + 2 <= len(buf):
        if buf[r.p] | (buf[r.p + 1] << 8) == L_CLOSE:
            r.p += 2
            break
        start = r.p
        skip_value(r)
        items.append((start, r.p))
    return items, r.p


def scan_top_level(buf: bytes, want: int, limit: int = 40):
    """在顶层找 key = ``want`` 的元素，返回它的 payload 区间。"""
    r = Reader(buf)
    out = []
    while r.p + 2 <= len(buf) and len(out) < limit:
        key_at = r.p
        key = r.u16()
        start = r.p
        skip_value(r)
        if key == want:
            out.append((key_at, start, r.p))
    return out


def find_table(buf: bytes, key: int, depth: int = 0, lo: int = 0, hi: int | None = None,
               max_depth: int = 4):
    """在本层元素里找 key == ``key`` 的第一个，返回其 payload 起点。"""
    hi = len(buf) if hi is None else hi
    r = Reader(buf, lo)
    while r.p + 2 <= hi:
        cur = r.u16()          # 读到的 token；别覆盖形参 key（原来 `key = r.u16()`
        start = r.p            #  + `if key == key` 恒真，永远返回第一个元素）
        if cur == key and depth >= 0:
            return start
        skip_value(r)
        if r.p > hi:
            break
    return None


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    # 默认去本机「文档」里 EU5 的存档目录挑最新的那个 .eu5 ✓
    # （以前这里写死了作者机器上的绝对路径 —— 仓库里公开就是别人的用户名 ✗）
    if len(sys.argv) > 1:
        save = Path(sys.argv[1])
    else:
        d = (Path.home() / "Documents" / "Paradox Interactive"
             / "Europa Universalis V" / "save games")
        found = sorted(d.glob("*.eu5"), key=lambda p: p.stat().st_mtime,
                       reverse=True) if d.is_dir() else []
        if not found:
            print(f"没找到存档：{d}")
            print("用法：python parsers/eu5/save.py <存档.eu5>")
            raise SystemExit(2)
        save = found[0]
    print(f"存档：{save}")
    meta, game, look = load_save(save)
    table = parse_lookup(look)
    print(f"meta {len(meta)} 字节；gamestate {len(game)} 字节；"
          f"string_lookup 解出 {len(table)} 条")
    print("  前 5 条:", table[:5])
