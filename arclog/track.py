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
    "subWindow": 3.0,
    "subStep": 1.0,
    "edgeMargin": 0.12,
    "thresh": 0.15,
    "timeTol": 1.0,
    "iters": 600,
    "maxArcsPerWindow": 6,
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
    "backtrackTol": 0.1,
    "chainTol": 0.3,
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
        pts.append({"u": u, "v": v, "t": d["t"], "f": d["f"], "x": d["x"], "y": d["y"], "conf": d["conf"], "used": False, "skip": -1})

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

    # 每個搜尋範圍用固定長度的小視窗滑過去找軌跡
    shots: list[dict] = []
    rejected: dict[str, int] = {}
    candidates = 0
    calls = 0
    stamp = 0
    n_pts = len(pts)
    for win in windows:
        t0 = win["t0"] - o["windowBefore"]
        t1 = win["t1"] + o["windowAfter"]
        lo = 0
        a = t0
        while True:
            b = min(t1, a + o["subWindow"])
            stamp += 1
            while lo < n_pts and pts[lo]["t"] < a:
                lo += 1
            for _ in range(o["maxArcsPerWindow"]):
                cand = []
                m = lo
                while m < n_pts and pts[m]["t"] <= b:
                    if not pts[m]["used"] and pts[m]["skip"] != stamp:
                        cand.append(pts[m])
                    m += 1
                arc = ransac_arc(
                    cand,
                    seed=o["seed"] + calls,
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
                calls += 1
                if arc is None:
                    break
                inl = [cand[k] for k in arc["inliers"]]
                # 球還在飛就碰到小視窗的尾端：留給下一個小視窗
                if b < t1 and inl[len(inl) - 1]["t"] > b - o["edgeMargin"]:
                    for p in inl:
                        p["skip"] = stamp
                    continue
                built = _build_shot(inl, pts, o)
                candidates += 1
                for p in inl:
                    p["used"] = True
                if "shot" in built:
                    shots.append(built["shot"])
                else:
                    rejected[built["reason"]] = rejected.get(built["reason"], 0) + 1
            if b >= t1:
                break
            a += o["subStep"]

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
        dropped = forward + backward - len(merged)
        if dropped:
            rejected["wrong_direction"] = dropped

    return {
        "shots": merged,
        "stats": {
            "detections": len(detections),
            "usable": len(pts),
            "static": static_count,
            "windows": len(windows),
            "candidates": candidates,
            "rejected": rejected,
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


def _chain_filter(pts: list[dict], o: dict) -> list[dict]:
    """時間核對：由軌跡中段的三個點開始，往更早、再往更晚一個一個核對水平位置是否符合等速。"""
    n = len(pts)
    if n < 5:
        return pts
    mid = n >> 1
    acc = [mid - 1, mid, mid + 1]

    def fit():
        return fit_line([pts[i]["t"] for i in acc], [pts[i]["u"] for i in acc])

    line = fit()
    if line is None:
        return pts
    order = list(range(mid - 2, -1, -1)) + list(range(mid + 2, n))
    for i in order:
        if abs(pts[i]["u"] - (line["p"] + line["q"] * pts[i]["t"])) > o["chainTol"]:
            continue
        acc.append(i)
        nxt = fit()
        if nxt is not None:
            line = nxt
    if len(acc) == n:
        return pts
    acc.sort()
    return [pts[i] for i in acc]


def _build_shot(inl: list[dict], pts: list[dict], o: dict) -> dict:
    """回傳 {'shot': {...}} 或 {'reason': '被排除的原因'}。"""
    # 只留過框前的自由飛行段，並去掉殘差特別大的點，重新擬合
    kept = inl
    pass_no = 0
    while True:
        kept = _trim_ends(kept, o)
        if len(kept) < o["minInliers"]:
            return {"reason": "few_points"}
        res = analyze_shot([{"u": p["u"], "v": p["v"], "t": p["t"]} for p in kept], drag_k=o["dragK"])
        if not res["ok"]:
            return {"reason": "fit_failed"}
        if pass_no >= 4:
            break
        flip = res["flip"]
        big_us = [(1 - p["u"] if flip else p["u"]) for p in kept]
        fitted = eval_arc(res["model"], big_us)
        abs_res = [abs(p["v"] - fitted[i]) for i, p in enumerate(kept)]
        resid_limit = max(o["residSigmas"] * 1.4826 * _median(abs_res), o["residFloor"])
        cut_u = min(res["crossS"] - o["preCrossCut"], o["freeFlightMaxU"])
        # 依時間順序走：第一次進到框附近之後的點全部不要；殘差太大或水平位置倒退的點也不要
        keep = []
        run_max = float("-inf")
        reached = False
        for i, p in enumerate(kept):
            if big_us[i] > cut_u:
                reached = True
            if reached:
                continue
            if abs_res[i] > resid_limit:
                continue
            if big_us[i] < run_max - o["backtrackTol"]:
                continue
            if big_us[i] > run_max:
                run_max = big_us[i]
            keep.append(p)
        nxt = _trim_ends(_chain_filter(keep, o), o)
        if len(nxt) == len(kept):
            break
        kept = nxt
        pass_no += 1

    flip = res["flip"]
    n = len(kept)
    t_first = kept[0]["t"]
    t_last = kept[n - 1]["t"]
    if not t_last - t_first >= o["minDuration"]:
        return {"reason": "short_duration"}
    # 水平跨距不看最兩端各一個點
    us = sorted(p["u"] for p in kept)
    if not us[n - 2] - us[1] >= o["minSpanU"]:
        return {"reason": "short_span"}
    bins = 1
    last_bin = math.floor(us[0] / o["binWidth"])
    for i in range(1, n):
        b = math.floor(us[i] / o["binWidth"])
        if b != last_bin:
            bins += 1
            last_bin = b
    if bins < o["minBins"]:
        return {"reason": "few_bins"}
    slope = res["model"]["slope"]
    if not (slope >= o["minSlope"] and slope <= o["maxSlope"]):
        return {"reason": "angle_range"}
    if not (res["apex"]["v"] >= o["minApex"] and res["apex"]["v"] <= o["maxApex"]):
        return {"reason": "apex_range"}
    if not (res["crossS"] >= o["sMin"] and res["crossS"] <= o["sMax"]):
        return {"reason": "cross_range"}
    if not res["rms"] <= o["maxRms"]:
        return {"reason": "rms"}
    # 「朝籃框飛來」同樣不看最早的那一個點
    start_u = 1 - kept[1]["u"] if flip else kept[1]["u"]
    if not abs(start_u - 0.5) - abs(res["crossS"] - 0.5) >= o["minApproach"]:
        return {"reason": "not_approaching"}
    descending = 0
    for p in kept:
        big_u = 1 - p["u"] if flip else p["u"]
        if big_u > res["apex"]["u"]:
            descending += 1
    if descending < o["minDescending"]:
        return {"reason": "no_descent"}

    line = fit_line([p["t"] for p in kept], [p["u"] for p in kept])
    if line is None or not abs(line["q"]) > 1e-9:
        return {"reason": "time_fit"}
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

    shot = {
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
    return {"shot": shot}
