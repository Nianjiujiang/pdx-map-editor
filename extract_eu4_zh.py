"""把 EU4 汉化 mod 里的中文名抠出来，存成一份 JSON。

    python extract_eu4_zh.py                     # 自动找汉化 mod
    python extract_eu4_zh.py --mod "C:\\...\\2976470733"
    python extract_eu4_zh.py --list              # 只列装了哪些汉化

编码细节（"双字节"到底怎么回事）看 ``eu4/hanhua.py`` 顶上那段说明。
这个脚本只负责：找出 mod → 读那几个跟地名有关的文件 → 对照游戏本体报告覆盖率
→ 写出 ``eu4_names_zh.json``。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from parsers.eu4 import hanhua

#: 默认的 EU4 workshop 目录
DEFAULT_WORKSHOP = Path(r"C:\Steam\steamapps\workshop\content")

#: 地图上可能出现的 key 到底有哪些，**不靠猜** —— 直接从游戏数据推：
#: ``area.txt`` / ``region.txt`` / ``superregion.txt`` / ``continent.txt`` 里的分组名，
#: 加上 ``definition.csv`` 的每个省份 ``PROV<id>``。这就是编辑器可能去查的全部 key。
#:
#: 一开始我是按 key 的"形状"筛的（``*_area`` / ``*_region`` / ``*_superregion``），
#: 结果漏了 17 个 —— EU4 里有 ``basque_country``、``northern_kyushu``、
#: ``eastern_mongolia`` 这种**不带后缀的**区域名。所以改成从数据里取，
#: 抽完再拿 ``titles.json`` 逐个节点验一遍。
def map_keys(game: Path | None) -> set[str] | None:
    """游戏里跟地图有关的全部本地化 key。找不到游戏就返回 None（那就全留）。"""
    if not game:
        return None
    mp = game / "map"
    if not (mp / "definition.csv").is_file():
        return None
    from parsers.eu4 import parser as E
    from parsers.eu4.history import parse_country_tags
    keys: set[str] = set()
    for fn in ("area.txt", "region.txt", "superregion.txt", "continent.txt"):
        if (mp / fn).is_file():
            keys |= set(E.parse_groups(mp / fn))
    for pid in E.parse_definition(mp / "definition.csv"):
        keys.add(f"PROV{pid}")
    # 1444 / 1618 / 1800 三个年份视图是按国家上色的，国家名也得要
    keys |= set(parse_country_tags(game))
    return keys


def find_game() -> Path | None:
    for c in (Path(r"C:\Steam\steamapps\common\Europa Universalis IV"),
              Path(r"D:\Steam\steamapps\common\Europa Universalis IV")):
        if (c / "map" / "provinces.bmp").is_file():
            return c
    return None


def game_names(path: Path) -> dict[str, str]:
    """读游戏本体的英文 yml（用来报告覆盖率、以及当兜底）。"""
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        m = re.match(r'^\s*([A-Za-z0-9_.\'\-]+)\s*:\s*\d*\s*"((?:[^"\\]|\\.)*)"', line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


def mod_info(mod: Path, files: dict[str, int]) -> dict:
    """汉化 mod 的身份信息。写进 json 的 ``_meta``，免得以后分不清名字是哪来的。"""
    # **只留 workshop 目录之后那一段**（形如 ``236850/2976470733``）：
    # 绝对路径里带着本机盘符和用户名，而这份 json 是会跟着快照包发出去的 ✗
    # 认来源靠 workshop_id + descriptor 里那几项就够了 ✓（没人读 path ✓）
    tail = "/".join(mod.parts[-2:]) if len(mod.parts) >= 2 else mod.name
    info = {"path": tail, "workshop_id": mod.name, "files": files}
    desc = mod / "descriptor.mod"
    if desc.is_file():
        t = desc.read_text(encoding="utf-8", errors="replace")
        for key in ("name", "version", "supported_version", "remote_file_id"):
            m = re.search(rf'^\s*{key}\s*=\s*"?([^"\r\n]*)"?', t, re.M)
            if m and m.group(1).strip():
                info[key] = m.group(1).strip()
    return info


def describe(info: dict) -> str:
    """一行话说清这份中文名是谁给的。"""
    name = info.get("name") or "?"
    wid = info.get("workshop_id") or info.get("remote_file_id") or "?"
    return f"{name}（workshop {wid}）"


def main() -> int:
    ap = argparse.ArgumentParser(description="提取 EU4 汉化的中文地名")
    ap.add_argument("--mod", help="汉化 mod 目录（含 localisation/），不给就自动找")
    ap.add_argument("--workshop", default=str(DEFAULT_WORKSHOP),
                    help="workshop content 目录")
    ap.add_argument("--game", help="EU4 安装目录（用来算覆盖率）")
    ap.add_argument("--out", default=str(ROOT / "eu4_names_zh.json"))
    ap.add_argument("--all", action="store_true",
                    help="存汉化里的全部条目（12 MB），默认只存地图用得上的")
    ap.add_argument("--list", action="store_true", help="只列出检测到的汉化 mod")
    args = ap.parse_args()

    workshop = Path(args.workshop)
    if args.list:
        for p in hanhua.find_hanhua(workshop):
            print(p)
        return 0

    # ---- 选 mod
    if args.mod:
        mod = Path(args.mod).resolve()
        if mod.name == "localisation":
            mod = mod.parent
        if not (mod / "localisation").is_dir():
            print(f"!! {mod} 里没有 localisation/")
            return 1
    else:
        cands = hanhua.find_hanhua(workshop)
        if not cands:
            print("!! 没找到汉化 mod，用 --mod 手动指一个")
            return 1
        if len(cands) == 1:
            mod = cands[0]
        else:
            # 谁盖的省份名多，就选谁
            game = Path(args.game).resolve() if args.game else find_game()
            prov_keys = set(game_names(game / "localisation" / "prov_names_l_english.yml")) \
                if game else set()
            best, best_n = cands[0], -1
            for c in cands:
                d = hanhua.load_file(c / "localisation" / "prov_names_l_english.yml")
                n = len(set(d) & prov_keys) if prov_keys else len(d)
                if n > best_n:
                    best, best_n = c, n
            mod = best
            print(f"装了 {len(cands)} 个汉化 mod，挑了盖得最全的这个：{mod.name}")

    print(f"汉化 mod: {mod}")

    game = Path(args.game).resolve() if args.game else find_game()
    keys = map_keys(game)
    if keys:
        print(f"游戏数据里跟地图有关的 key：{len(keys)} 个")
    else:
        print("没找到游戏安装，不做筛选，全留")

    # ---- 读：整个 localisation 目录都要读，一个文件都别挑
    #
    # 早先这里写死了一张 4 个文件的名单，结果树里 322 个地区/区域被误判成
    # "汉化也没翻" —— 那些名字其实散在别的文件里。这个 mod 一共 146 个文件、
    # 12 万多条，只挑 4 个等于蒙着眼睛下结论。
    loc_dir = mod / "localisation"
    files = sorted(loc_dir.glob("*.yml"))
    if not files:
        print(f"!! {loc_dir} 里没有 yml")
        return 1
    print(f"localisation 里 {len(files)} 个文件，全部读一遍")

    zh: dict[str, str] = {}
    got: dict[str, int] = {}
    for fp in files:
        d = hanhua.load_file(fp)
        got[fp.name] = len(d)
        for k, v in d.items():
            zh.setdefault(k, v)

    print(f"   合计 {len(zh)} 条")
    top = sorted(got.items(), key=lambda t: -t[1])[:6]
    print("   条数最多的几个文件：" + "、".join(f"{n} {c}" for n, c in top))

    if args.all:
        print("   按要求全留")
    elif keys:
        kept = {k: v for k, v in zh.items() if k in keys}
        print(f"   只留地图用得上的 key：{len(kept)} 条"
              f"（丢掉 {len(zh) - len(kept)} 条任务/事件/UI 文本；--all 可以全留）")
        zh = kept

    # 乱码自检（跳过 _meta，它不是名字）
    bad = [k for k, v in zh.items()
           if isinstance(v, str) and ("\ufffd" in v or any("\ue000" <= c <= "\uf8ff" for c in v))]
    if bad:
        print(f"   ！{len(bad)} 条解出乱码，样例：{bad[:5]}")
    else:
        print("   解出乱码: 0 条")

    # 把来源钉在文件里，后面谁看都知道名字是哪来的
    info = mod_info(mod, got)
    zh["_meta"] = {
        **info,
        "entries": len(zh),
        "full_dump": bool(args.all),
        "extracted": __import__("time").strftime("%Y-%m-%d %H:%M:%S"),
    }
    print(f"   来源：{describe(info)}")

    # ---- 覆盖率
    prov_zh = {k: v for k, v in zh.items() if k.startswith("PROV") and k[4:].isdigit()}
    total = None
    if game:
        en = game_names(game / "localisation" / "prov_names_l_english.yml")
        have = sum(1 for k in en if k in prov_zh)
        print(f"\n游戏本体有名字的省份 {len(en)} 个，汉化覆盖 {have} 个"
              f"（差 {len(en) - have} 个）")
        defs = game / "map" / "definition.csv"
        if defs.is_file():
            raw = defs.read_text(encoding="latin-1", errors="replace")
            total = sum(1 for line in raw.splitlines()[1:] if line.strip())
            print(f"definition.csv 一共 {total} 个省份，汉化写到 "
                  f"{len(prov_zh)} 个（{100.0 * len(prov_zh) / total:.0f}%）")
            print("  剩下的游戏里本来就没名字，多半是随机新世界预留的省份")
    if total is None:
        print(f"\n汉化提供省份名 {len(prov_zh)} 个")

    hier = {k: v for k, v in zh.items()
            if k.endswith(("_area", "_region", "_superregion"))}
    cont = {k: v for k, v in zh.items()
            if k in ("europe", "asia", "africa", "north_america", "south_america", "oceania")}
    print(f"\n地区/区域/大区 {len(hier)} 条，大洲 {len(cont)} 条")

    # ---- 拿已经生成好的树对一遍：地图上每个节点都拿到中文了吗
    # 这一步是这套"只留地图 key"的规则能不能站住的硬证据 —— 漏一个就报出来。
    tree = ROOT / "data_eu4" / "titles.json"
    if tree.is_file():
        T = json.loads(tree.read_text(encoding="utf-8"))
        real = [i for i in range(len(T["keys"])) if T["tiers"][i] < 5]
        miss = []
        for i in real:
            k = T["keys"][i]
            ek = f"PROV{k[2:]}" if k.startswith("p_") else k
            if ek not in zh:
                miss.append((k, T["namesEn"][i] if T.get("namesEn") else ""))
        if miss:
            print(f"\n！和 data_eu4/titles.json 对不上：{len(miss)} 个节点没有中文")
            for k, e in miss[:12]:
                print(f"     {k:<28} 英文={e!r}")
        else:
            print(f"\n和 data_eu4/titles.json 对过：{len(real)} 个真节点全部有中文 ✔")

    out = Path(args.out)
    out.write_text(json.dumps(zh, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n写出 {len(zh)} 条 → {out}"
          f"（{out.stat().st_size / 1024:.0f} KB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
