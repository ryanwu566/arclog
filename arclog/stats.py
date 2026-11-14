"""練習統計。對應 web/js/core/stats.js 的數值部分。"""
from __future__ import annotations

import math


def mean(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = 0.0
    for x in xs:
        s += x
    return s / len(xs)


def sample_std(xs: list[float]) -> float | None:
    """樣本標準差（除以 n−1）。少於 2 筆回傳 None。"""
    n = len(xs)
    if n < 2:
        return None
    m = mean(xs)
    s = 0.0
    for x in xs:
        d = x - m
        s += d * d
    return math.sqrt(s / (n - 1))


def _block(shots: list[dict]) -> dict:
    attempts = len(shots)
    makes = 0
    angles = []
    for s in shots:
        if s["made"]:
            makes += 1
        a = s.get("angle")
        if isinstance(a, (int, float)) and not isinstance(a, bool) and math.isfinite(a):
            angles.append(a)
    return {
        "attempts": attempts,
        "makes": makes,
        "pct": (makes / attempts) * 100 if attempts else None,
        "angleMean": mean(angles),
        "angleStd": sample_std(angles),
    }


def summarize(shots: list[dict]) -> dict:
    """整理一次練習的統計。前半 = 前 floor(n/2) 球，後半 = 其餘。

    shots：[{'angle': float, 'made': bool}]，依出手順序。
    """
    n = len(shots)
    n_first = n // 2
    out = _block(shots)
    out["first"] = _block(shots[:n_first])
    out["second"] = _block(shots[n_first:])
    return out
