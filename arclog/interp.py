"""標註內插。對應 web/js/core/interp.js。

相鄰兩個手點之間假設水平速度固定（飛行座標 U 對時間線性內插），
高度取擬合軌跡的值再加上兩端手點殘差的線性內插。
"""
from __future__ import annotations

from .fit import eval_arc
from .geometry import to_hoop, to_image


def interpolate_shot(manual: list[dict], frame_times, hoop: dict, shot: dict) -> list[dict]:
    """manual：[{'frame','t','x','y'}]（像素座標）。

    回傳第一個手點到最後一個手點之間每一幀的
    [{'frame','t','x','y','src': 'manual'|'interp'}]。
    """
    pts = sorted(manual, key=lambda p: p["frame"])
    uniq: list[dict] = []
    for p in pts:
        if uniq and uniq[-1]["frame"] == p["frame"]:
            uniq[-1] = p
        else:
            uniq.append(p)
    if len(uniq) < 2:
        return [{"frame": p["frame"], "t": p["t"], "x": p["x"], "y": p["y"], "src": "manual"} for p in uniq]

    flip = shot["flip"]
    big_u = []
    big_v = []
    for p in uniq:
        u, v = to_hoop(hoop, p["x"], p["y"])
        big_u.append(1 - u if flip else u)
        big_v.append(v)
    fitted = eval_arc(shot["model"], big_u)
    resid = [big_v[k] - fitted[k] for k in range(len(uniq))]

    out: list = []
    mid_u: list[float] = []
    mid_meta: list[dict] = []
    for k in range(len(uniq)):
        p = uniq[k]
        out.append({"frame": p["frame"], "t": p["t"], "x": p["x"], "y": p["y"], "src": "manual"})
        if k == len(uniq) - 1:
            break
        q = uniq[k + 1]
        span = q["t"] - p["t"]
        for f in range(p["frame"] + 1, q["frame"]):
            t = frame_times[f]
            w = (t - p["t"]) / span if span > 0 else 0
            mid_u.append(big_u[k] + w * (big_u[k + 1] - big_u[k]))
            mid_meta.append({"at": len(out), "frame": f, "t": t, "e": resid[k] + w * (resid[k + 1] - resid[k])})
            out.append(None)
    mid_v = eval_arc(shot["model"], mid_u)
    for m, meta in enumerate(mid_meta):
        u = 1 - mid_u[m] if flip else mid_u[m]
        x, y = to_image(hoop, u, mid_v[m] + meta["e"])
        out[meta["at"]] = {"frame": meta["frame"], "t": meta["t"], "x": x, "y": y, "src": "interp"}
    return out
