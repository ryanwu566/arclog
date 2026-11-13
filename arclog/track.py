"""自動偵測的後半段：把每一幀偵測到的球串成軌跡，找出一球一球的投籃。

對應 web/js/core/track.js，流程與參數完全相同（說明見該檔）。
"""
from __future__ import annotations

import math

from .constants import DRAG_K_RIM, round_angle
from .fit import eval_arc, fit_line, ransac_arc
from .geometry import to_hoop
from .shot import analyze_shot

TRACK_DEFAULTS = {
    "seed": 12345,
    "staticRadiusBall": 0.35,
    "staticMinSpan": 0.4,
    "staticMinCount": 5,
    "staticWindow": 0.6,
    "sizeMin": 0.35,
    "sizeMax": 3.0,
    "highV": 0.5,
    "clusterGap": 0.6,
    "windowBefore": 1.2,
    "windowAfter": 0.4,
    "thresh": 0.15,
    "timeTol": 1.0,
    "iters": 600,
    "maxArcsPerWindow": 4,
    "minInliers": 5,
    "binWidth": 0.5,
    "minBins": 5,
    "minDuration": 0.2,
    "minSpanU": 2.0,
    "minApex": 0.5,
    "maxApex": 6.0,
    "minSlope": 0.36397,  # tan 20°
    "maxSlope": 2.74748,  # tan 70°
    "sMin": -2.5,
    "sMax": 3.5,
    "minApproach": 2.0,
    "minDescending": 1,
    "preCrossCut": 0.3,
    "freeFlightMaxU": 0.9,
    "residSigmas": 3,
    "residFloor": 0.03,
    "gapFactor": 3.5,
    "gapMin": 0.2,
    "gapMaxTrim": 2,
    "maxRms": 0.12,
    "directionRatio": 4,
    "afterWindow": 0.8,
    "bounceWindow": 0.6,
    "bounceMinCount": 3,
    "bounceRangeU": 2.0,
    "bounceMaxV": 3.0,
    "dragK": DRAG_K_RIM,
}


def mark_static(dets: list[dict], ball_diameter_px: float, o: dict = TRACK_DEFAULTS) -> list[bool]:
    """標記靜止的偵測（0.4 秒以上都待在同一個位置）。dets 必須已依 t 排序。"""
    n = len(dets)
    flags = [False] * n
    r2 = (o["staticRadiusBall"] * ball_diameter_px) ** 2
    lo = 0
    for i in range(n):
        d = dets[i]
        while lo < n and dets[lo]["t"] < d["t"] - o["staticWindow"]:
            lo += 1
        count = 0
        t_min = d["t"]
        t_max = d["t"]
        j = lo
        while j < n and dets[j]["t"] <= d["t"] + o["staticWindow"]:
            e = dets[j]
            dx = e["x"] - d["x"]
            dy = e["y"] - d["y"]
            if dx * dx + dy * dy <= r2:
                count += 1
                if e["t"] < t_min:
                    t_min = e["t"]
                if e["t"] > t_max:
                    t_max = e["t"]
            j += 1
        if count >= o["staticMinCount"] and t_max - t_min >= o["staticMinSpan"]:
            flags[i] = True
    return flags


def find_shots(detections: list[dict], hoop: dict, **opts) -> dict:
    """由整支影片的偵測結果找出每一球。

    detections：[{'f','t','x','y','w','h','conf'}]，f 幀號、t 秒、x y 球心（像素）。
    回傳 {'shots': [...], 'stats': {...}}，欄位和 JS findShots 相同。
    """
    o = {**TRACK_DEFAULTS, **opts}
    indexed = [dict(d, i=i) for i, d in enumerate(detections)]
    indexed.sort(key=lambda d: (d["t"], d["i"]))

    ball_px = hoop["ballDiameterPx"]
    sized = []
    for d in indexed:
        s = max(d["w"], d["h"]) / ball_px
        if s >= o["sizeMin"] and s <= o["sizeMax"]:
            sized.append(d)
    static_flags = mark_static(sized, ball_px, o)
    pts: list[dict] = []
    static_count = 0
    for m, d in enumerate(sized):
        if static_flags[m]:
            static_count += 1
            continue
        u, v = to_hoop(hoop, d["x"], d["y"])
        pts.append({"u": u, "v": v, "t": d["t"], "f": d["f"], "x": d["x"], "y": d["y"], "conf": d["conf"], "used": False})

    windows: list[dict] = []
    cur = None
    for p in pts:
        if not p["v"] >= o["highV"]:
            continue
        if cur is not None and p["t"] - cur["t1"] <= o["clusterGap"]:
            cur["t1"] = p["t"]
        else:
            cur = {"t0": p["t"], "t1": p["t"]}
            windows.append(cur)

    shots: list[dict] = []
    for w, win in enumerate(windows):
        t0 = win["t0"] - o["windowBefore"]
        t1 = win["t1"] + o["windowAfter"]
        for rnd in range(o["maxArcsPerWindow"]):
            cand = [p for p in pts if not p["used"] and p["t"] >= t0 and p["t"] <= t1]
            arc = ransac_arc(
                cand,
                seed=o["seed"] + w * 31 + rnd,
                iters=o["iters"],
                thresh=o["thresh"],
                timeTol=o["timeTol"],
                minInliers=o["minInliers"],
                minApex=o["minApex"],
                maxApex=o["maxApex"],
                sMin=o["sMin"],
                sMax=o["sMax"],
                minSlope=o["minSlope"],
                maxSlope=o["maxSlope"],
                minApproach=o["minApproach"],
            )
            if arc is None:
                break
            inl = [cand[m] for m in arc["inliers"]]
            shot = _build_shot(inl, pts, o)
            for p in inl:
                p["used"] = True
            if shot is not None:
                shots.append(shot)

    shots.sort(key=lambda s: s["tCross"])
    merged: list[dict] = []
    for s in shots:
        last = merged[-1] if merged else None
        if last is not None and abs(s["tCross"] - last["tCross"]) < 0.3:
            if len(s["points"]) > len(last["points"]):
                merged[-1] = s
        else:
            merged.append(s)

    # 球都往同一個方向飛；反方向的少數幾球多半是彈回來的球
    forward = 0
    backward = 0
    for s in merged:
        if s["flip"]:
            backward += 1
        else:
            forward += 1
    if forward > 0 and backward > 0:
        if backward * o["directionRatio"] <= forward:
            merged = [s for s in merged if not s["flip"]]
        elif forward * o["directionRatio"] <= backward:
            merged = [s for s in merged if s["flip"]]

    return {
        "shots": merged,
        "stats": {
            "detections": len(detections),
            "usable": len(pts),
            "static": static_count,
            "windows": len(windows),
        },
    }


def _median(values: list[float]) -> float:
    srt = sorted(values)
    mid = len(srt) >> 1
    return srt[mid] if len(srt) % 2 else (srt[mid - 1] + srt[mid]) / 2


def _trim_ends(pts: list[dict], o: dict) -> list[dict]:
    """去掉頭尾落單的點（和其他點之間隔了很久的最前或最後一兩個點）。"""
    n = len(pts)
    if n < 4:
        return pts
    dts = [pts[i]["t"] - pts[i - 1]["t"] for i in range(1, n)]
    limit = max(o["gapFactor"] * _median(dts), o["gapMin"])
    start = 0
    end = n
    i = 1
    while i <= o["gapMaxTrim"] and i < n:
        if dts[i - 1] > limit:
            start = i
        if dts[n - 1 - i] > limit:
            end = n - i
        i += 1
    return pts if start == 0 and end == n else pts[start:end]


def _build_shot(inl: list[dict], pts: list[dict], o: dict) -> dict | None:
    # 只留過框前的自由飛行段，並去掉殘差特別大的點，重新擬合
    kept = inl
    pass_no = 0
    while True:
        kept = _trim_ends(kept, o)
        if len(kept) < o["minInliers"]:
            return None
        res = analyze_shot([{"u": p["u"], "v": p["v"], "t": p["t"]} for p in kept], drag_k=o["dragK"])
        if not res["ok"]:
            return None
        if pass_no >= 4:
            break
        flip = res["flip"]
        big_us = [(1 - p["u"] if flip else p["u"]) for p in kept]
        fitted = eval_arc(res["model"], big_us)
        abs_res = [abs(p["v"] - fitted[i]) for i, p in enumerate(kept)]
        resid_limit = max(o["residSigmas"] * 1.4826 * _median(abs_res), o["residFloor"])
        cut_u = min(res["crossS"] - o["preCrossCut"], o["freeFlightMaxU"])
        nxt = _trim_ends(
            [p for i, p in enumerate(kept) if big_us[i] <= cut_u and abs_res[i] <= resid_limit], o
        )
        if len(nxt) == len(kept):
            break
        kept = nxt
        pass_no += 1

    flip = res["flip"]
    n = len(kept)
    t_first = kept[0]["t"]
    t_last = kept[n - 1]["t"]
    if not t_last - t_first >= o["minDuration"]:
        return None
    # 水平跨距不看最兩端各一個點
    us = sorted(p["u"] for p in kept)
    if not us[n - 2] - us[1] >= o["minSpanU"]:
        return None
    bins = 1
    last_bin = math.floor(us[0] / o["binWidth"])
    for i in range(1, n):
        b = math.floor(us[i] / o["binWidth"])
        if b != last_bin:
            bins += 1
            last_bin = b
    if bins < o["minBins"]:
        return None
    slope = res["model"]["slope"]
    if not (slope >= o["minSlope"] and slope <= o["maxSlope"]):
        return None
    if not (res["apex"]["v"] >= o["minApex"] and res["apex"]["v"] <= o["maxApex"]):
        return None
    if not (res["crossS"] >= o["sMin"] and res["crossS"] <= o["sMax"]):
        return None
    if not res["rms"] <= o["maxRms"]:
        return None
    # 「朝籃框飛來」同樣不看最早的那一個點
    start_u = 1 - kept[1]["u"] if flip else kept[1]["u"]
    if not abs(start_u - 0.5) - abs(res["crossS"] - 0.5) >= o["minApproach"]:
        return None
    descending = 0
    for p in kept:
        big_u = 1 - p["u"] if flip else p["u"]
        if big_u > res["apex"]["u"]:
            descending += 1
    if descending < o["minDescending"]:
        return None

    line = fit_line([p["t"] for p in kept], [p["u"] for p in kept])
    if line is None or not abs(line["q"]) > 1e-9:
        return None
    uc_u = 1 - res["crossS"] if flip else res["crossS"]
    t_cross = (uc_u - line["p"]) / line["q"]

    net = 0
    above = 0
    for p in pts:
        if not (p["t"] > t_cross and p["t"] <= t_cross + o["afterWindow"]):
            continue
        big_u = 1 - p["u"] if flip else p["u"]
        if p["v"] <= -0.3 and p["v"] >= -1.6 and big_u >= 0.05 and big_u <= 0.95:
            net += 1
        elif (
            p["v"] >= 0.15
            and p["v"] <= o["bounceMaxV"]
            and p["t"] >= t_cross + 0.08
            and p["t"] <= t_cross + o["bounceWindow"]
            and abs(big_u - 0.5) <= o["bounceRangeU"]
        ):
            above += 1
    made = res["made"]
    made_by = "geometry"
    clear_short = res["crossS"] < -0.3
    if not clear_short and net >= 2:
        made = True
        made_by = "net"
    elif above >= o["bounceMinCount"] and net < 2:
        made = False
        made_by = "bounce"

    f_cross = inl[len(inl) - 1]["f"]
    best = float("inf")
    for p in inl:
        d = abs(p["t"] - t_cross)
        if d < best:
            best = d
            f_cross = p["f"]

    return {
        "angle": round_angle(res["angleRaw"]),
        "angleRaw": res["angleRaw"],
        "crossS": res["crossS"],
        "made": made,
        "madeGeometry": res["made"],
        "madeBy": made_by,
        "zone": res["zone"],
        "flip": flip,
        "model": res["model"],
        "parabola": res["parabola"],
        "apex": res["apex"],
        "rms": res["rms"],
        "tStart": t_first,
        "tEnd": t_last,
        "tCross": t_cross,
        "fStart": kept[0]["f"],
        "fEnd": kept[n - 1]["f"],
        "fCross": f_cross,
        "evidence": {"net": net, "above": above},
        "points": [{"f": p["f"], "t": p["t"], "x": p["x"], "y": p["y"], "conf": p["conf"]} for p in kept],
    }
