"""一球的分析：入框角度、過框位置、進球建議。對應 web/js/core/shot.js。"""
from __future__ import annotations

import math

from .constants import (
    BALL_RADIUS_RIM,
    DRAG_K_RIM,
    MAKE_FAR_FACTOR,
    MAKE_NEAR_FACTOR,
    round_angle,
)
from .fit import eval_arc, fit_arc, parabola_apex


def judge_make(s: float, angle_deg: float) -> dict:
    """依過框位置 s（0 前緣、1 後緣）和入框角度建議進球與否。說明見 shot.js。"""
    theta = (angle_deg * math.pi) / 180
    near_clear = s * math.sin(theta)
    far_gap = 1 - s
    r = BALL_RADIUS_RIM
    if near_clear >= r and far_gap >= r:
        zone = "clean"
    elif near_clear >= MAKE_NEAR_FACTOR * r and far_gap >= MAKE_FAR_FACTOR * r:
        zone = "rim"
    elif far_gap < MAKE_FAR_FACTOR * r and near_clear >= MAKE_NEAR_FACTOR * r:
        zone = "long"
    elif near_clear < MAKE_NEAR_FACTOR * r and far_gap >= MAKE_FAR_FACTOR * r:
        zone = "short"
    else:
        zone = "short" if s < 0.5 else "long"
    return {"made": zone in ("clean", "rim"), "zone": zone, "nearClear": near_clear, "farGap": far_gap}


def analyze_shot(points: list[dict], drag_k: float | None = None) -> dict:
    """分析一球。points：[{'u','v','t'}]（籃框座標加時間），至少 3 點。

    回傳 {'ok': False, 'reason'} 或和 JS analyzeShot 相同欄位的 dict。
    """
    n = len(points)
    if n < 3:
        return {"ok": False, "reason": "too_few_points"}
    order = sorted(range(n), key=lambda i: (points[i]["t"], i))
    first = points[order[0]]
    last = points[order[n - 1]]
    du = last["u"] - first["u"]
    if not abs(du) > 1e-9:
        return {"ok": False, "reason": "no_motion"}
    flip = du < 0

    us = [0.0] * n
    vs = [0.0] * n
    for m in range(n):
        p = points[order[m]]
        us[m] = 1 - p["u"] if flip else p["u"]
        vs[m] = p["v"]
    monotonic = True
    for m in range(1, n):
        if not us[m] > us[m - 1]:
            monotonic = False

    k = DRAG_K_RIM if drag_k is None else drag_k
    fit = fit_arc(us, vs, drag_k=k)
    if not fit["ok"]:
        return {"ok": False, "reason": fit["reason"]}

    angle_raw = (math.atan(fit["slope"]) * 180) / math.pi
    judge = judge_make(fit["uc"], angle_raw)
    return {
        "ok": True,
        "angleDeg": round_angle(angle_raw),
        "angleRaw": angle_raw,
        "crossS": fit["uc"],
        "made": judge["made"],
        "zone": judge["zone"],
        "flip": flip,
        "model": {"uc": fit["uc"], "slope": fit["slope"], "kappa": fit["kappa"], "k": fit["k"]},
        "parabola": fit["parabola"],
        "apex": parabola_apex(fit["parabola"]),
        "rms": fit["rms"],
        "monotonic": monotonic,
    }


def sample_arc(shot: dict, u_from: float, u_to: float, count: int = 48) -> list[dict]:
    """取樣擬合出來的軌跡（校正座標），給疊圖用。"""
    us = [u_from + ((u_to - u_from) * i) / (count - 1) for i in range(count)]
    big_u = [1 - u if shot["flip"] else u for u in us]
    vs = eval_arc(shot["model"], big_u)
    return [{"u": us[i], "v": vs[i]} for i in range(count)]
