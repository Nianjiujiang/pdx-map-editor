# -*- coding: utf-8 -*-
"""名字汉化的公共实现（后处理并进 builder 用）

  · 归一化：去前缀（b_/c_/d_/k_/e_/h_/lake_/lakes_/sea_/river_…）+ 去空格下划线 + 小写
  · 变体：词序颠倒（Balkhash Lake → lake_balkhash）、去尾词（Lake/Sea/Desert/Mountains…）
  · 英文反查：英文显示名 → 键 → 中文
  · 前缀模糊：归一化后前 5 字符相同且**唯一**才认（Peipus/Peipsi 这类拼写差）
  · 一站式：localize_names(titles_json, loc_dirs, extra_zh) 就地改名并返回统计
"""

from __future__ import annotations

import json
import re
from pathlib import Path

HAS_ZH = re.compile(r"[\u4e00-\u9fff]")
KANA = re.compile(r"[\u3040-\u30ff]")
YML = re.compile(r'^\s*([A-Za-z0-9_.]+)\s*:\s*\d*\s*"([^"]*)"', re.M)
PRE = ("lakes_", "lake_", "seas_", "sea_", "rivers_", "river_",
       "b_", "c_", "d_", "k_", "e_", "h_")
TAIL = ("lake", "lakes", "sea", "seas", "desert", "mountains", "mountain",
        "wasteland", "wastes", "highlands", "field")


def norm(s: str) -> str:
    """只做大小写/分隔符归一 —— 绝不去前缀（去前缀会把黑海砍成黑）"""
    return re.sub(r"[^a-z0-9]", "", str(s).strip().lower())


def variants(name: str) -> set[str]:
    """一个名字可能的写法 —— 只做字数不变的变换（大小写、分隔符、词序）

    去前缀 / 去尾词一律不做：那会把黑海、白海砍成黑、白。
    """
    words = re.findall(r"[A-Za-z0-9]+", str(name))
    out: set[str] = set()
    if not words:
        return out
    joined = "_".join(words)
    out.add(joined.lower())
    out.add(joined.upper())
    out.add(joined.title())
    out.add(" ".join(words))
    out.add(" ".join(words).lower())
    out.add("_".join(words[::-1]).lower())
    return out


def load_loc(folders) -> tuple[dict, dict]:
    """读若干本地化目录 → (键→值, 值→键的第一条)；后读的不覆盖先读的"""
    zh: dict[str, str] = {}
    en: dict[str, str] = {}
    for folder in folders:
        folder = Path(folder)
        if not folder.is_dir():
            continue
        for f in folder.rglob("*.yml"):
            try:
                txt = f.read_text(encoding="utf-8-sig", errors="ignore")
            except OSError:
                continue
            for m in YML.finditer(txt):
                k, v = m.group(1), m.group(2)
                if v:
                    zh.setdefault(k, v)
    return zh, en


def build_index(zh: dict) -> tuple[dict, dict, dict]:
    """(归一化→中文, 前缀5字符→中文集合, 英文名小写→键)"""
    idx: dict[str, str] = {}
    for k, v in zh.items():
        if HAS_ZH.search(v) and not KANA.search(v):
            idx.setdefault(norm(k), v)
    pre5: dict[str, set] = {}
    for nk, v in idx.items():
        if len(nk) >= 5:
            pre5.setdefault(nk[:5], set()).add(v)
    uniq5 = {k: next(iter(v)) for k, v in pre5.items() if len(v) == 1}
    return idx, uniq5, {}


def resolve(name: str, zh: dict, idx: dict, uniq5: dict,
            en2key: dict | None = None, extra_zh: dict | None = None) -> str | None:
    """给一个名字找中文；找不到返回 None（不改动任何东西）"""
    if not isinstance(name, str) or not name or HAS_ZH.search(name):
        return None
    if extra_zh:
        v = extra_zh.get(name)
        if v and HAS_ZH.search(v):
            return v
    words = re.findall(r"[A-Za-z0-9]+", str(name))
    for c in variants(name):
        if c in zh and HAS_ZH.search(zh[c]) and not KANA.search(zh[c]):
            return zh[c]
        # 归一化索引**只用于多词名字**：单词名放宽会匹到值只有「黑」「白」的键 ✗
        if len(words) >= 2:
            n = norm(c)
            if n in idx:
                return idx[n]
    if en2key:
        k = en2key.get(str(name).strip().lower())
        if k and HAS_ZH.search(zh.get(k, "")):
            return zh[k]
    # 注意：**不要**再放宽到"前几个字符相同就认" —— 那会把「黑海」匹成值只有「黑」的键 ✗
    return None


def localize_names(titles_json: Path | str, loc_dirs, extra_zh: dict | None = None,
                   fields=("names", "provinceNames"), en_dirs=None) -> tuple[int, int]:
    """就地汉化 titles.json；返回 (换掉几个, 还剩几个非中文)

    :param en_dirs: 英文本地化目录（用来做"英文显示名 → 键"的反查）。
        不给就退回用 loc_dirs 的值反查 —— 那样基本查不到，等于不做 ✓
    """
    p = Path(titles_json)
    data = json.loads(p.read_text(encoding="utf-8"))
    zh, _ = load_loc(loc_dirs)
    idx, uniq5, _ = build_index(zh)
    # 英文显示名 → 键：**必须**用英文本地化，别拿中文表反查 ✓
    en_src, _ = load_loc(en_dirs if en_dirs else loc_dirs)
    en2key: dict[str, str] = {}
    for k, v in en_src.items():
        if v and not HAS_ZH.search(v):
            en2key.setdefault(v.strip().lower(), k)
    hit = 0
    for field in fields:
        arr = data.get(field)
        if not arr:
            continue
        for i, s in enumerate(arr):
            if not isinstance(s, str) or not s or "$" in s:
                continue
            v = resolve(s, zh, idx, uniq5, en2key, extra_zh)
            if v and v != s:
                arr[i] = v
                hit += 1
    left = sum(1 for f in fields for s in (data.get(f) or [])
               if isinstance(s, str) and s and not HAS_ZH.search(s))
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return hit, left
