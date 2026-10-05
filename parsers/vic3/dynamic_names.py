"""V3 的动态国名（附庸/共主邦联时换个名字）。

数据全在游戏里，两处对起来就是答案：

* ``common/history/diplomacy/00_subject_relationships.txt`` —— 1836 年开局的关系表，
  形如 ``c:RUS ?= { create_diplomatic_pact = { country = c:FIN  type = personal_union } }``；
* ``common/dynamic_country_names/00_dynamic_country_names.txt`` —— 每个 tag 一串候选名，
  形如 ``dynamic_country_name = { name = dyn_c_grand_duchy_of_finland
  trigger = { c:RUS ?= { has_diplomatic_pact = { who = c:FIN type = personal_union } } } }``。

只处理**能判定**的条件（`has_diplomatic_pact` / `use_overlord_prefix`）；
`has_variable` 这类运行时的东西判不了就**保留本名** —— 宁可不动，也不瞎编。
"""

from __future__ import annotations

from pathlib import Path

from parsers.ck3.parser import parse_script


def _find(entries, want: str):
    """递归找某个键（游戏里 ``?=`` 会被解析成键 ``'?'``，字段常常埋在第三层）。"""
    out = []
    for k, v in entries or []:
        if k == want:
            out.append(v)
        if isinstance(v, list):
            out.extend(_find(v, want))
    return out


def _flat(entries):
    """把 parse_script 的条目拉平成一串 (key, value)，方便找字段。"""
    out = []
    for k, v in entries or []:
        if isinstance(v, list):
            out.extend(_flat(v))
        else:
            out.append((k, v))
    return out


def _unwrap(entries, want: str | None = None):
    """取出 ``want`` 那一块的内容；``want=None`` 时直接返回顶层。"""
    if want is None:
        return entries
    for k, v in entries:
        if k == want and isinstance(v, list):
            return v
    return []


def load_pacts(path: Path) -> dict[tuple[str, str], str]:
    """``{(宗主, 附庸): 关系类型}``（标签都不带 ``c:`` 前缀）。

    注意：游戏写的是 ``c:RUS ?= { … }``，而 ``ck3.parser`` 不认 ``?=`` ——
    它会把 ``c:RUS`` 读成一个**裸词**、把 ``?=`` 拆成键 ``'?'``。
    所以这里按"裸词 + 紧跟的 ``'?'`` 块"来配对。
    """
    pacts: dict[tuple[str, str], str] = {}
    # 传目录就把 common/history/diplomacy/ 下**所有**文件读进来
    # （关系不止一个文件：只读 00_subject_relationships.txt 会漏掉波兰这种）
    src = Path(path)
    files = sorted(src.glob("*.txt")) if src.is_dir() else [src]

    for fp in files:
        raw = fp.read_text(encoding="utf-8-sig", errors="replace")
        body = _unwrap(parse_script(raw), "DIPLOMACY")
        _read_body(body, pacts)
    return pacts


def _read_body(body, pacts: dict) -> None:
    pending: str | None = None
    for key, value in body:
        if key is None and isinstance(value, str):
            pending = value.split(":")[-1]          # c:RUS → RUS
            continue
        if key != "?" or not isinstance(value, list) or pending is None:
            continue
        over = pending
        pending = None
        for k2, v2 in value:
            if k2 != "create_diplomatic_pact" or not isinstance(v2, list):
                continue
            sub = typ = None
            for k3, v3 in v2:
                if k3 == "country" and isinstance(v3, str):
                    sub = v3.split(":")[-1]
                elif k3 == "type" and isinstance(v3, str):
                    typ = v3
            if sub:
                pacts[(over, sub)] = typ or "?"


def load_dynamic_names(path: Path) -> dict[str, list[dict]]:
    """``{tag: [候选名, …]}``；每个候选名是 ``{name, priority, pacts, overlord_prefix}``。

    ``pacts`` 里放的是**能判的**条件：``(宗主, 关系类型)`` 二元组，
    或者 ``(None, 关系类型)`` 表示"跟任何国家有这种关系都算"。
    """
    out: dict[str, list[dict]] = {}
    raw = Path(path).read_text(encoding="utf-8-sig", errors="replace")
    for tag, value in parse_script(raw):
        if tag in (None, "DEFAULT") or not isinstance(value, list):
            continue
        for k2, v2 in value:
            if k2 != "dynamic_country_name" or not isinstance(v2, list):
                continue
            name = prio = None
            prefix = False
            pacts: list[tuple[str | None, str]] = []
            # 递归找：`?=` 会被解析成键 '?'，所以这些字段可能埋在任意深度
            names = _find(v2, "name")
            if names:
                name = names[0]
            for pv in _find(v2, "priority"):
                if isinstance(pv, int):
                    prio = pv
                elif isinstance(pv, str) and pv.lstrip("-").isdigit():
                    prio = int(pv)
                break
            if _find(v2, "use_overlord_prefix"):
                prefix = True
            for hp in _find(v2, "has_diplomatic_pact"):
                who = typ = None
                for k4, v4 in _flat(hp if isinstance(hp, list) else []):
                    if k4 == "who" and isinstance(v4, str):
                        who = v4.split(":")[-1]
                    elif k4 == "type" and isinstance(v4, str):
                        typ = v4
                if typ:
                    pacts.append((who, typ))
            # 注意：**不能**用 _flat —— 它会把 trigger 里的字段一起递归拍平，
            # 于是 `has_diplomatic_pact` 那一层就看不见了。这里只展开一层到 trigger。
            items = list(v2)
            items = None
            if name:
                out.setdefault(tag, []).append({
                    "name": name,
                    "priority": prio or 0,
                    "pacts": pacts,
                    "overlord_prefix": prefix,
                })
    return out


def resolve(tag: str, pacts: dict[tuple[str, str], str], dyn: dict[str, list[dict]]):
    """挑这个名字键；挑不到返回 ``None``（调用方就保留本名）。

    规则：候选名里**条件全部满足**（且至少写了一条能判的条件）的那些，
    按 priority 高的优先。
    """
    best = None
    for cand in dyn.get(tag, []):
        if not cand["pacts"]:
            continue                    # 没有任何可判条件 → 不动
        # 方向要注意：游戏里的写法是 `c:RUS ?= { has_diplomatic_pact = { who = c:FIN
        # type = personal_union } }` —— `who` 指的是**附庸那一方**（FIN），
        # 而我们的关系表是 `(宗主, 附庸)`。所以两种方向都试：
        #   ① 本 tag 是附庸：存在某个 O 使得 pacts[(O, tag)] == 类型
        #   ② 本 tag 是宗主：pacts[(tag, who)] == 类型
        def hit(who, typ):
            if any(v == typ and s == tag for (_o, s), v in pacts.items()):
                return True
            return who is not None and pacts.get((tag, who)) == typ

        ok = all(hit(who, typ) for who, typ in cand["pacts"])
        if ok and (best is None or cand["priority"] > best["priority"]):
            best = cand
    return best["name"] if best else None


if __name__ == "__main__":       # python -m vic3.dynamic_names
    import sys
    sys.stdout.reconfigure(encoding="utf-8")
    G = Path(r"C:\Steam\steamapps\common\Victoria 3\game")
    pacts = load_pacts(G / "common" / "history" / "diplomacy")
    dyn = load_dynamic_names(G / "common" / "dynamic_country_names" / "00_dynamic_country_names.txt")
    print(f"1836 关系 {len(pacts)} 条；带动态国名的 tag {len(dyn)} 个")
    dist: dict[str, int] = {}
    for v in pacts.values():
        dist[v] = dist.get(v, 0) + 1
    print("  关系类型分布:", dict(sorted(dist.items(), key=lambda x: -x[1])))
    print("\n自证（该换名的换、不该换的留）:")
    for tag in ("FIN", "POL", "SER", "EGY", "CAN", "SWE", "CHI", "TIB"):
        key = resolve(tag, pacts, dyn)
        rel = [f"{o}->{s}:{v}" for (o, s), v in pacts.items() if s == tag]
        print(f"   {tag}: {key or '（保留本名）':<34} 关系={rel or '无'}")
