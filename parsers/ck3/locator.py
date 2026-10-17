"""定位《十字军之王 III》的安装目录。

优先读 Steam 的 libraryfolders.vdf，再退回常见路径。
"""

from __future__ import annotations

import os
import re
from pathlib import Path

CK3_APPID = "1158310"
GAME_DIR_NAME = "Crusader Kings III"

# Steam 可能装在哪些地方
STEAM_ROOTS = [
    r"C:\Program Files (x86)\Steam",
    r"C:\Program Files\Steam",
    r"C:\Steam",
    r"D:\Steam",
    r"E:\Steam",
    r"F:\Steam",
    r"D:\SteamLibrary",
    r"E:\SteamLibrary",
    r"F:\SteamLibrary",
    r"C:\Games\Steam",
]

# 非 Steam（如 Game Pass / 绿色版）常见的落点
OTHER_ROOTS = [
    r"C:\Program Files (x86)\Steam\steamapps\common",
    r"C:\Program Files\Steam\steamapps\common",
    r"D:\Games",
    r"E:\Games",
]


def _library_dirs_from_vdf(vdf: Path) -> list[Path]:
    """从 libraryfolders.vdf 里抠出所有库目录。"""
    try:
        text = vdf.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    dirs = []
    for m in re.finditer(r'"path"\s+"([^"]+)"', text):
        raw = m.group(1).replace("\\\\", "\\")
        dirs.append(Path(raw))
    # 有时候 root 自己也算一个库
    dirs.append(vdf.parent.parent)
    return dirs


def find_steam_libraries() -> list[Path]:
    out: list[Path] = []
    seen = set()
    for root in STEAM_ROOTS + OTHER_ROOTS:
        p = Path(root)
        for vdf in (p / "steamapps" / "libraryfolders.vdf", p / "libraryfolders.vdf"):
            if vdf.is_file():
                for d in _library_dirs_from_vdf(vdf):
                    key = str(d).lower()
                    if key not in seen:
                        seen.add(key)
                        out.append(d)
        key = str(p).lower()
        if key not in seen and p.is_dir():
            seen.add(key)
            out.append(p)
    return out


def looks_like_ck3(path: Path) -> bool:
    """判断一个目录是不是 CK3 的安装根（含 game/ 与 binaries/）。"""
    return (path / "game" / "map_data" / "provinces.png").is_file() and (
        path / "game" / "common" / "landed_titles"
    ).is_dir()


def candidates(extra: list[str] | None = None) -> list[Path]:
    """按可能性从高到低列出候选安装目录。"""
    out: list[Path] = []
    seen = set()

    def push(p: Path | str):
        p = Path(p)
        key = str(p).lower()
        if key not in seen:
            seen.add(key)
            out.append(p)

    for e in extra or []:
        push(e)
    if os.environ.get("CK3_DIR"):
        push(os.environ["CK3_DIR"])

    for lib in find_steam_libraries():
        push(lib / "steamapps" / "common" / GAME_DIR_NAME)
        push(lib / "common" / GAME_DIR_NAME)
    for root in OTHER_ROOTS:
        push(Path(root) / GAME_DIR_NAME)
    # 直接就是游戏根的情况
    push(Path.cwd())

    return out


def find_ck3(extra: list[str] | None = None, verbose: bool = True) -> Path:
    """返回 CK3 安装根目录。找不到就抛异常，并把找过的地方列出来。"""
    tried = []
    for c in candidates(extra):
        tried.append(str(c))
        if looks_like_ck3(c):
            if verbose:
                print(f"[定位] 找到 CK3：{c}")
            return c
    raise FileNotFoundError(
        "没找到《十字军之王 III》的安装目录。\n"
        "可以用 --ck3 \"D:\\Steam\\steamapps\\common\\Crusader Kings III\" 手动指定，\n"
        "或设置环境变量 CK3_DIR。已尝试过：\n  " + "\n  ".join(tried[:20])
    )


if __name__ == "__main__":
    root = find_ck3()
    print("game/    :", root / "game")
    print("provinces:", (root / "game" / "map_data" / "provinces.png").stat().st_size, "bytes")
