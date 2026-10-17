# -*- coding: utf-8 -*-
"""国名位置 = **首都所在那一片连通域**的重心（后处理，不用重新生成）

硬要求（用户定的）：**每个模式的首都都必须落到"最低单位"**
  EU4      文件里就是省份号             → 直接是省
  HOI4     capital = <州号>            → 该州胜利点最高的省；没有 vp 就用面积最大的省
  V3       capital = STATE_XXX         → 该州面积最大的省
  EU5      capital（setup/countries）   → 本来就是地块（最细那层）

三条锚定规则（用户定的）：
  ① 首都还在自家地盘上   → 含首都那一片连通域的重心
  ② 首都被涂掉了         → 挨着首都的那一片（**不是**最大片）
  ③ 首都就是那片最后一块地、且它没了 → 落到**最大连通域**

用法：
  python patch_capitals.py --data data_eu4            # 只报告（默认）
  python patch_capitals.py --data data_eu4 --write    # 真的写盘
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import zlib
from pathlib import Path

import numpy as np

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:      # pythonw / 部分捕获环境没有 reconfigure，别让 import 就崩
    pass
ROOT = Path(__file__).resolve().parent


def say(*a):
    print("   ", *a)


# ------------------------------------------------------------------ 读原文件

def _read(p: Path) -> str:
    # utf-8-sig：HOI4 的国家文件带 BOM；之前用 utf-8 读，得到「364 个里只有 30 个有首都」
    # 这种假结论，白折腾一轮。
    return p.read_text(encoding="utf-8-sig", errors="ignore")


def _tag_of(path: Path) -> str:
    return re.split(r"[ \-_]", path.stem)[0].strip().upper()


def eu4_capitals(game: Path) -> dict[str, int]:
    """tag → 省份号（history/countries/<TAG>*.txt 的 capital = N）"""
    out: dict[str, int] = {}
    d = game / "history" / "countries"
    for f in (sorted(d.glob("*.txt")) if d.is_dir() else []):
        tag = _tag_of(f)
        if len(tag) != 3 or not tag.isalpha():
            continue
        m = re.search(r"^\s*capital\s*=\s*(\d+)", _read(f), re.M)
        if m:
            out.setdefault(tag, int(m.group(1)))
    return out


def hoi4_capitals(game: Path) -> dict[str, int]:
    """tag → **州号**（history/countries/*.txt 的 capital = <state>）"""
    out: dict[str, int] = {}
    d = game / "history" / "countries"
    for f in (sorted(d.glob("*.txt")) if d.is_dir() else []):
        tag = _tag_of(f)
        if len(tag) != 3 or not tag.isalpha():
            continue
        m = re.search(r"^\s*capital\s*=\s*(\d+)", _read(f), re.M)
        if m:
            out.setdefault(tag, int(m.group(1)))
    return out


def vic3_capitals(game: Path) -> dict[str, str]:
    """tag → **州名**（game/common/country_definitions/*.txt 的 capital = STATE_XXX）

    写法是 `GBR = { color = ... capital = STATE_HOME_COUNTIES }`（可能跨行、可能一行好几国），
    所以按**大括号配对**切块，而不是靠行首正则。
    """
    out: dict[str, str] = {}
    d = game / "game" / "common" / "country_definitions"
    if not d.is_dir():
        return out
    for f in sorted(d.rglob("*.txt")):
        body = _read(f)
        for m in re.finditer(r"^\s*([A-Z]{3})\s*=\s*\{", body, re.M):
            tag = m.group(1)
            depth, i = 1, m.end()
            while i < len(body) and depth:
                c = body[i]
                if c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                i += 1
            block = body[m.end():i]
            c = re.search(r"capital\s*=\s*(STATE_[A-Z0-9_]+)", block)
            if c:
                out.setdefault(tag, c.group(1))
    return out


def eu5_capitals(game: Path) -> dict[str, str]:
    """tag → 首都（setup/countries/*.txt，值是地块号或名字）"""
    out: dict[str, str] = {}
    d = game / "game" / "in_game" / "setup" / "countries"
    for f in (sorted(d.glob("*.txt")) if d.is_dir() else []):
        tag = _tag_of(f)
        m = re.search(r"^\s*capital\s*=\s*([A-Za-z0-9_]+)", _read(f), re.M)
        if m:
            out.setdefault(tag, m.group(1))
    return out


# ------------------------------------------------------------------ 数据读取

class Data:
    def __init__(self, d: Path):
        self.d = d
        self.M = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        self.T = json.loads((d / "titles.json").read_text(encoding="utf-8"))
        self.n = int(self.M["numProvinces"])
        self.rows = len(self.M["tiers"])
        self.W = int(self.M["mapWidth"])
        self.H = int(self.M["mapHeight"])
        self.TM = np.frombuffer(zlib.decompress((d / "titlemap.bin").read_bytes()),
                                dtype="<u2").reshape(self.rows, self.n)
        raw = (d / "adjacency.bin").read_bytes()
        try:
            raw = zlib.decompress(raw)
        except Exception:
            pass
        self.off = np.frombuffer(raw, dtype="<u4", count=self.n + 1)
        self.nb = np.frombuffer(raw, dtype="<u2", offset=(self.n + 1) * 4)
        ids = np.frombuffer(zlib.decompress((d / "provinces_id.bin").read_bytes()),
                            dtype="<u2").reshape(self.H, self.W)
        flat = ids.reshape(-1).astype(np.int64)
        xs = np.tile(np.arange(self.W, dtype=np.float64), self.H)
        ys = np.repeat(np.arange(self.H, dtype=np.float64), self.W)
        self.cnt = np.bincount(flat, minlength=self.n + 1).astype(np.float64)
        with np.errstate(invalid="ignore", divide="ignore"):
            self.cx = np.bincount(flat, weights=xs, minlength=self.n + 1) / np.maximum(self.cnt, 1)
            self.cy = np.bincount(flat, weights=ys, minlength=self.n + 1) / np.maximum(self.cnt, 1)
        self.keys = self.T["keys"]
        self.index_of = {k: i for i, k in enumerate(self.keys)}
        self.row_of_tier = {t: i for i, t in enumerate(self.M["tiers"])}
        self.era = [i for i, t in enumerate(self.M["tiers"]) if re.fullmatch(r"\d{3,4}", str(t))]

    def around(self, pid: int):
        return self.nb[self.off[pid]:self.off[pid + 1]]

    def provinces_of_state(self, row: int) -> dict[int, list[int]]:
        out: dict[int, list[int]] = {}
        for p in range(1, self.n):
            if self.cnt[p] <= 0:
                continue
            out.setdefault(int(self.TM[row][p]), []).append(p)
        return out

    def key_candidates(self, raw: str) -> list[str]:
        return [raw, f"STATE_{raw}", raw.replace("STATE_", ""), f"state_{raw.lower()}"]


# ------------------------------------------------------------------ 连通分片

def components(provs: list[int], data: Data, max_gap: float = 240.0) -> dict[int, list[int]]:
    """按邻接分片；加一道距离闸 —— 邻接表里隔着海的省份也算相邻，
    会把热那亚和它在黑海的殖民地并成一片，重心就掉进海里了。"""
    parent = {p: p for p in provs}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for p in provs:
        for q in data.around(p):
            q = int(q)
            if q == p or q not in parent:
                continue
            dx = float(data.cx[p]) - float(data.cx[q])
            dy = float(data.cy[p]) - float(data.cy[q])
            if dx * dx + dy * dy > max_gap * max_gap:
                continue
            ra, rb = find(p), find(q)
            if ra != rb:
                parent[rb] = ra
    out: dict[int, list[int]] = {}
    for p in provs:
        out.setdefault(find(p), []).append(p)
    return out


def centroid(pl: list[int], data: Data):
    arr = np.array(pl, dtype=np.int64)
    w = float(data.cnt[arr].sum())
    if w <= 0:
        return None
    return (float((data.cx[arr] * data.cnt[arr]).sum() / w),
            float((data.cy[arr] * data.cnt[arr]).sum() / w))


# ------------------------------------------------------------------ 主流程

def main() -> int:
    ap = argparse.ArgumentParser(description="国名位置按首都所在连通域（首都一律落到最低单位）")
    ap.add_argument("--data", required=True)
    ap.add_argument("--game", help="游戏安装根目录（默认按数据目录名猜）")
    ap.add_argument("--write", action="store_true", help="真的写盘（默认只报告）")
    ap.add_argument("--largest", action="store_true",
                    help="不按首都，直接取**最大连通域**（EU5 用这个：它没有首都来源）")
    args = ap.parse_args()

    data = Data(Path(args.data))
    name = Path(args.data).name
    say(f"{name}: {data.W}×{data.H} · {data.n} 省 · 年份层 "
        f"{[data.M['tiers'][i] for i in data.era]}")

    guess = {
        "data_eu4": [r"C:\Steam\steamapps\common\Europa Universalis IV"],
        "data_eu4_hd": [r"C:\Steam\steamapps\common\Europa Universalis IV"],
        "data_hoi4": [r"C:\Steam\steamapps\common\Hearts of Iron IV"],
        "data_vic3": [r"C:\Steam\steamapps\common\Victoria 3"],
        "data_eu5": [r"C:\Game NIANJIU\EU5", r"D:\Game NIANJIU\EU5",
                     r"C:\Steam\steamapps\common\Europa Universalis V"],
    }.get(name, [])
    game = Path(args.game) if args.game else next((Path(p) for p in guess if Path(p).is_dir()), None)
    if game is None or not game.is_dir():
        say("！找不到游戏根目录，用 --game 指一下")
        return 1

    # ---- 首都 → 最低单位（省份号）----
    tag_to_prov: dict[str, int] = {}
    detail = ""
    st_row = data.row_of_tier.get("st")
    if name.startswith("data_eu4"):
        caps = eu4_capitals(game)
        tag_to_prov = {t: p for t, p in caps.items() if 0 < p <= data.n and data.cnt[p] > 0}
        detail = "EU4 省份号直接可用"
    elif name == "data_hoi4":
        caps = hoi4_capitals(game)
        by_state = data.provinces_of_state(st_row) if st_row is not None else {}
        st_title_of_state = {
            int(k.split("_", 1)[1]): i for i, k in enumerate(data.keys)
            if k.startswith("STATE_") and k.split("_", 1)[1].isdigit()
        }
        vp: dict[int, int] = {}
        try:
            from parsers.hoi4 import parser as HP  # type: ignore
            for sid, st in HP.parse_states(game / "history" / "states").items():
                pairs = getattr(st, "vp", None)
                if pairs:
                    best = max(((int(v), int(k)) for k, v in dict(pairs).items()), default=None)
                    if best:
                        vp[sid] = best[1]
        except Exception as e:
            say(f"  （HOI4 胜利点没读到，改用最大省：{type(e).__name__}）")
        for t, sid in caps.items():
            # 文件里给的是**州号**（capital = 64），数据里这一层的 key 是 `STATE_64`
            # —— 之前直接拿州号当 title id 用，全落空，只有巧合命中的那些才"看起来能用"。
            tid = st_title_of_state.get(sid)
            pl = by_state.get(tid) or [] if tid is not None else []
            if not pl:
                continue
            cand = vp.get(sid)
            tag_to_prov[t] = cand if (cand in pl) else max(pl, key=lambda p: data.cnt[p])
        detail = "HOI4 州号 → STATE_<id> → 胜利点省 / 最大省"
    elif name == "data_vic3":
        caps = vic3_capitals(game)
        by_state = data.provinces_of_state(st_row) if st_row is not None else {}
        for t, skey in caps.items():
            tid = data.index_of.get(skey)
            pl = by_state.get(tid) or [] if tid is not None else []
            if pl:
                tag_to_prov[t] = max(pl, key=lambda p: data.cnt[p])
        detail = "V3 州名 → 该州最大省"
    elif name == "data_eu5":
        caps = eu5_capitals(game)
        loc_row = data.row_of_tier.get("loc", max(data.row_of_tier.values()))
        for t, v in caps.items():
            if v.isdigit() and 0 < int(v) <= data.n and data.cnt[int(v)] > 0:
                tag_to_prov[t] = int(v)
                continue
            tid = next((data.index_of.get(k) for k in data.key_candidates(v)
                        if data.index_of.get(k) is not None), None)
            if tid is None:
                continue
            pl = [p for p in range(1, data.n)
                  if data.cnt[p] > 0 and int(data.TM[loc_row][p]) == tid]
            if pl:
                tag_to_prov[t] = max(pl, key=lambda p: data.cnt[p])
        detail = "EU5 地块直接可用"
    say(f"首都落到最低单位：{len(tag_to_prov)} 个国家（{detail}）")

    # ---- 逐年逐国重算位置 ----
    lx = list(data.T["lx"])
    ly = list(data.T["ly"])
    moved = anchored = fallback = nocap = 0
    samples = []
    for row in data.era:
        row_t = data.TM[row]
        by_title: dict[int, list[int]] = {}
        for p in range(1, data.n):
            tt = int(row_t[p])
            if tt == 0 or tt >= data.M["numRealTitles"] or data.cnt[p] <= 0:
                continue
            by_title.setdefault(tt, []).append(p)
        for tid, provs in by_title.items():
            key = data.keys[tid]
            tag = key.split("_", 1)[1] if "_" in key else key
            cap = tag_to_prov.get(tag)
            i = data.index_of.get(key)
            if i is None or not provs:
                nocap += 1
                continue
            if cap is None and not args.largest:
                nocap += 1
                continue
            groups = components(provs, data)
            pset = set(provs)
            target = None
            if cap is not None and cap in pset:                 # ① 首都还在自家地盘
                target = next((pl for pl in groups.values() if cap in pl), None)
            elif cap is not None:
                # ② 首都那一带剩下的那一片
                #    只认**紧邻**是不够的：占领首都时周围一圈往往一起没了，那样就只能
                #    退到"最大片"（法国 → 非洲）。改成从首都**一圈圈向外**找本国的地。
                seen = {cap}
                frontier = [cap]
                for _ring in range(12):
                    nxt = []
                    hit = None
                    for q in frontier:
                        for r in data.around(q):
                            r = int(r)
                            if r <= 0 or r in seen:
                                continue
                            seen.add(r)
                            nxt.append(r)
                            if r in pset:
                                for pl in groups.values():
                                    if r in pl:
                                        hit = pl
                                        break
                            if hit:
                                break
                        if hit:
                            break
                    if hit is not None:
                        target = hit
                        anchored += 1
                        break
                    frontier = nxt
                    if not frontier:
                        break
            if target is None:                                 # ③ 最大连通域（EU5 一律走这条）
                if groups:
                    target = max(groups.values(), key=lambda pl: data.cnt[pl].sum())
                    fallback += 1
                else:
                    continue
            c = centroid(target, data)
            if c is None:
                continue
            if abs(lx[i] - c[0]) > 1 or abs(ly[i] - c[1]) > 1:
                moved += 1
                if len(samples) < 6:
                    samples.append((key, (round(lx[i]), round(ly[i])),
                                    (round(c[0]), round(c[1])), len(target)))
            lx[i], ly[i] = c[0], c[1]

    say(f"位置：挪 {moved} 个（首都那片 {anchored} · 退到最大片 {fallback} · 没首都 {nocap}）")
    for k, a, b, sz in samples:
        say(f"  {k:22s} {a} → {b}   （那一片 {sz} 块地）")

    if args.write:
        data.T["lx"] = [None if v is None else round(float(v), 1) for v in lx]
        data.T["ly"] = [None if v is None else round(float(v), 1) for v in ly]
        (data.d / "titles.json").write_text(
            json.dumps(data.T, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        data.M["capitals"] = dict(tag_to_prov)          # 一律是最低单位（省份号）
        data.M["capitalsUnit"] = "province"
        (data.d / "meta.json").write_text(
            json.dumps(data.M, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        say("写回 titles.json / meta.json")
    else:
        say("（只报告；要写盘加 --write）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
