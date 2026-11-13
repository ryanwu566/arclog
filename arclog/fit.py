"""軌跡擬合：最小平方拋物線、空氣阻力修正、RANSAC。對應 web/js/core/fit.js。

運算順序刻意和 JS 版寫成一樣（用迴圈逐項累加，不用 numpy），兩邊的結果才能對到小數後很多位。

座標是「飛行座標」：U 沿籃框平面、球往 +U 飛，U=0 近端框緣、U=1 遠端框緣；
v 垂直籃框平面往上，v=0 是籃框平面。長度單位是籃框內徑。
"""
from __future__ import annotations

import math

from .constants import DRAG_K_RIM
from .prng import mulberry32, rand_int

#: 阻力模型數值積分的最大步長（籃框內徑為單位）。
RK_STEP = 0.1


def solve3(m: list[list[float]]) -> list[float] | None:
    """解 3×3 線性方程組（部分選主元的高斯消去）。m 是 3×4 增廣矩陣，會被改寫。"""
    scale = 0.0
    for r in range(3):
        for c in range(3):
            v = abs(m[r][c])
            if v > scale:
                scale = v
    if not scale > 0:
        return None
    for i in range(3):
        p = i
        for r in range(i + 1, 3):
            if abs(m[r][i]) > abs(m[p][i]):
                p = r
        if not abs(m[p][i]) > 1e-12 * scale:
            return None
        if p != i:
            m[i], m[p] = m[p], m[i]
        for r in range(i + 1, 3):
            f = m[r][i] / m[i][i]
            for c in range(i, 4):
                m[r][c] -= f * m[i][c]
    x = [0.0, 0.0, 0.0]
    for i in (2, 1, 0):
        s = m[i][3]
        for c in range(i + 1, 3):
            s -= m[i][c] * x[c]
        x[i] = s / m[i][i]
    return x


def fit_parabola(us: list[float], vs: list[float]) -> dict | None:
    """最小平方法擬合 v = a·U² + b·U + c。"""
    n = len(us)
    if n < 3:
        return None
    mean = 0.0
    for i in range(n):
        mean += us[i]
    mean /= n
    half = 0.0
    for i in range(n):
        d = abs(us[i] - mean)
        if d > half:
            half = d
    if not half > 1e-9:
        return None
    s1 = s2 = s3 = s4 = t0 = t1 = t2 = 0.0
    for i in range(n):
        z = (us[i] - mean) / half
        z2 = z * z
        s1 += z
        s2 += z2
        s3 += z2 * z
        s4 += z2 * z2
        t0 += vs[i]
        t1 += vs[i] * z
        t2 += vs[i] * z2
    sol = solve3([
        [s4, s3, s2, t2],
        [s3, s2, s1, t1],
        [s2, s1, n, t0],
    ])
    if sol is None:
        return None
    a = sol[0] / (half * half)
    bz = sol[1] / half
    b = bz - 2 * a * mean
    c = a * mean * mean - bz * mean + sol[2]
    if not (math.isfinite(a) and math.isfinite(b) and math.isfinite(c)):
        return None
    return {"a": a, "b": b, "c": c}


def parabola_at(p: dict, u: float) -> float:
    return (p["a"] * u + p["b"]) * u + p["c"]


def descending_crossing(p: dict) -> dict | None:
    """拋物線下降時通過籃框平面（v=0）的點：{'uc', 'slope'}，slope = tan(入框角度)。"""
    if not p["a"] < 0:
        return None
    disc = p["b"] * p["b"] - 4 * p["a"] * p["c"]
    if not disc > 0:
        return None
    sq = math.sqrt(disc)
    q = -(p["b"] + sq) / 2 if p["b"] >= 0 else -(p["b"] - sq) / 2
    r1 = q / p["a"]
    r2 = p["c"] / q if q != 0 else r1
    uc = r1 if r1 > r2 else r2
    return {"uc": uc, "slope": sq}


def _rk_advance(st: list[float], x: float, target: float, kap2: float, k2: float) -> None:
    dist = target - x
    n = max(1, math.ceil(abs(dist) / RK_STEP))
    dx = dist / n
    y, yp, sg = st[0], st[1], st[2]
    for _ in range(n):
        a1p = -kap2 * math.exp(k2 * sg)
        a1s = math.sqrt(1 + yp * yp)
        yp2 = yp + 0.5 * dx * a1p
        sg2 = sg + 0.5 * dx * a1s
        a2p = -kap2 * math.exp(k2 * sg2)
        a2s = math.sqrt(1 + yp2 * yp2)
        yp3 = yp + 0.5 * dx * a2p
        sg3 = sg + 0.5 * dx * a2s
        a3p = -kap2 * math.exp(k2 * sg3)
        a3s = math.sqrt(1 + yp3 * yp3)
        yp4 = yp + dx * a3p
        sg4 = sg + dx * a3s
        a4p = -kap2 * math.exp(k2 * sg4)
        a4s = math.sqrt(1 + yp4 * yp4)
        y += (dx * (yp + 2 * yp2 + 2 * yp3 + yp4)) / 6
        yp += (dx * (a1p + 2 * a2p + 2 * a3p + a4p)) / 6
        sg += (dx * (a1s + 2 * a2s + 2 * a3s + a4s)) / 6
    st[0], st[1], st[2] = y, yp, sg


def eval_arc(model: dict, us: list[float]) -> list[float]:
    """軌跡模型 {'uc','slope','kappa','k'} 在一串 U 的 v 值。"""
    n = len(us)
    out = [0.0] * n
    uc, slope, kappa, k = model["uc"], model["slope"], model["kappa"], model["k"]
    if not k > 0:
        for i in range(n):
            d = us[i] - uc
            out[i] = (-kappa * d - slope) * d
        return out
    left = [i for i in range(n) if us[i] <= uc]
    right = [i for i in range(n) if not us[i] <= uc]
    left.sort(key=lambda i: (-us[i], i))
    right.sort(key=lambda i: (us[i], i))
    kap2 = 2 * kappa
    k2 = 2 * k
    st = [0.0, -slope, 0.0]
    x = uc
    for i in left:
        _rk_advance(st, x, us[i], kap2, k2)
        x = us[i]
        out[i] = st[0]
    st = [0.0, -slope, 0.0]
    x = uc
    for i in right:
        _rk_advance(st, x, us[i], kap2, k2)
        x = us[i]
        out[i] = st[0]
    return out


def _sum_sq(us: list[float], vs: list[float], model: dict) -> float:
    ys = eval_arc(model, us)
    s = 0.0
    for i in range(len(us)):
        r = vs[i] - ys[i]
        s += r * r
    return s


def fit_arc(us: list[float], vs: list[float], drag_k: float | None = None) -> dict:
    """擬合一球的軌跡：最小平方拋物線，再用高斯–牛頓法做空氣阻力修正。

    drag_k 以「1/籃框內徑」為單位；0 代表純拋物線；None 用預設值。
    回傳 {'ok': False, 'reason', 'parabola'} 或
         {'ok': True, 'uc', 'slope', 'kappa', 'k', 'parabola', 'rms', 'iterations'}。
    """
    k = DRAG_K_RIM if drag_k is None else drag_k
    n = len(us)
    parabola = fit_parabola(us, vs)
    if parabola is None:
        return {"ok": False, "reason": "degenerate", "parabola": None}
    if not parabola["a"] < 0:
        return {"ok": False, "reason": "not_arc", "parabola": parabola}
    cr = descending_crossing(parabola)
    if cr is None:
        return {"ok": False, "reason": "no_crossing", "parabola": parabola}

    p = [cr["uc"], cr["slope"], -parabola["a"]]
    model = {"uc": p[0], "slope": p[1], "kappa": p[2], "k": k if k > 0 else 0}
    sse = _sum_sq(us, vs, model)
    iterations = 0

    if k > 0:
        jac = [[0.0] * n, [0.0] * n, [0.0] * n]
        for it in range(12):
            base = eval_arc(model, us)
            steps = [1e-4, 1e-5, max(1e-7, abs(p[2]) * 1e-5)]
            for j in range(3):
                pp = p[:]
                pm = p[:]
                pp[j] += steps[j]
                pm[j] -= steps[j]
                yp = eval_arc({"uc": pp[0], "slope": pp[1], "kappa": pp[2], "k": k}, us)
                ym = eval_arc({"uc": pm[0], "slope": pm[1], "kappa": pm[2], "k": k}, us)
                for i in range(n):
                    jac[j][i] = -(yp[i] - ym[i]) / (2 * steps[j])
            mtx = [[0.0] * 4, [0.0] * 4, [0.0] * 4]
            for r in range(3):
                for c in range(3):
                    s = 0.0
                    for i in range(n):
                        s += jac[r][i] * jac[c][i]
                    mtx[r][c] = s
                g = 0.0
                for i in range(n):
                    g += jac[r][i] * (vs[i] - base[i])
                mtx[r][3] = -g
            d = solve3(mtx)
            if d is None:
                break
            lam = 1.0
            accepted = None
            accepted_sse = sse
            for _ in range(8):
                cand = [p[0] + lam * d[0], p[1] + lam * d[1], p[2] + lam * d[2]]
                if cand[1] > 0 and cand[2] > 0:
                    s = _sum_sq(us, vs, {"uc": cand[0], "slope": cand[1], "kappa": cand[2], "k": k})
                    if s <= sse:
                        accepted = cand
                        accepted_sse = s
                        break
                lam *= 0.5
            if accepted is None:
                break
            small = abs(accepted[0] - p[0]) < 1e-10 and abs(accepted[1] - p[1]) < 1e-10
            p = accepted
            sse = accepted_sse
            model = {"uc": p[0], "slope": p[1], "kappa": p[2], "k": k}
            iterations = it + 1
            if small:
                break

    return {
        "ok": True,
        "uc": model["uc"],
        "slope": model["slope"],
        "kappa": model["kappa"],
        "k": model["k"],
        "parabola": parabola,
        "rms": math.sqrt(sse / n),
        "iterations": iterations,
    }


def parabola_apex(p: dict) -> dict:
    u = -p["b"] / (2 * p["a"])
    return {"u": u, "v": p["c"] - (p["b"] * p["b"]) / (4 * p["a"])}


def fit_line(xs: list[float], ys: list[float]) -> dict | None:
    """直線最小平方 y = p + q·x。"""
    n = len(xs)
    if n < 2:
        return None
    mx = 0.0
    my = 0.0
    for i in range(n):
        mx += xs[i]
        my += ys[i]
    mx /= n
    my /= n
    sxx = 0.0
    sxy = 0.0
    for i in range(n):
        dx = xs[i] - mx
        sxx += dx * dx
        sxy += dx * (ys[i] - my)
    if not sxx > 1e-18:
        return None
    q = sxy / sxx
    return {"p": my - q * mx, "q": q}


RANSAC_DEFAULTS = {
    "seed": 1,
    "iters": 500,
    "thresh": 0.15,
    "timeTol": 1.0,
    "minInliers": 5,
    "minSampleSpan": 0.8,
    "minApex": 0.3,
    "maxApex": 1e9,
    "sMin": -2.5,
    "sMax": 3.5,
    "minSlope": 0,
    "maxSlope": 1e9,
    "minApproach": -1e9,
}


def ransac_arc(pts: list[dict], **opts) -> dict | None:
    """RANSAC：在偵測點裡找出最像一球投籃軌跡的那一組。

    pts：[{'u','v','t'}]，必須已依 t 排序。
    回傳 {'dir', 'inliers', 'parabola', 'line'} 或 None。條件說明見 fit.js。
    """
    o = {**RANSAC_DEFAULTS, **opts}
    n = len(pts)
    if n < max(3, o["minInliers"]):
        return None

    def evaluate(parabola, line, direction):
        idx = []
        sse = 0.0
        for m in range(n):
            pt = pts[m]
            slope = 2 * parabola["a"] * pt["u"] + parabola["b"]
            res = (pt["v"] - parabola_at(parabola, pt["u"])) / math.sqrt(1 + slope * slope)
            if abs(res) > o["thresh"]:
                continue
            if abs(pt["u"] - (line["p"] + line["q"] * pt["t"])) > o["timeTol"]:
                continue
            idx.append(m)
            sse += res * res
        return {"idx": idx, "sse": sse, "parabola": parabola, "line": line, "dir": direction}

    def check(parabola, direction, u_start):
        if parabola is None or not parabola["a"] < 0:
            return False
        cr = descending_crossing(parabola)
        if cr is None:
            return False
        if not (cr["slope"] >= o["minSlope"] and cr["slope"] <= o["maxSlope"]):
            return False
        apex = parabola_apex(parabola)
        if not (apex["v"] >= o["minApex"] and apex["v"] <= o["maxApex"]):
            return False
        uc_u = cr["uc"] if direction > 0 else -parabola["b"] / parabola["a"] - cr["uc"]
        s = uc_u if direction > 0 else 1 - uc_u
        if not (s >= o["sMin"] and s <= o["sMax"]):
            return False
        start = u_start if direction > 0 else 1 - u_start
        return abs(start - 0.5) - abs(s - 0.5) >= o["minApproach"]

    def try_sample(i, j, k, best):
        a, b, c = pts[i], pts[j], pts[k]
        if not (a["t"] < b["t"] and b["t"] < c["t"]):
            return best
        d1 = b["u"] - a["u"]
        d2 = c["u"] - b["u"]
        if not d1 * d2 > 0:
            return best
        if abs(c["u"] - a["u"]) < o["minSampleSpan"]:
            return best
        direction = 1 if d1 > 0 else -1
        parabola = fit_parabola([a["u"], b["u"], c["u"]], [a["v"], b["v"], c["v"]])
        if not check(parabola, direction, a["u"]):
            return best
        q = (c["u"] - a["u"]) / (c["t"] - a["t"])
        line = {"p": a["u"] - q * a["t"], "q": q}
        cand = evaluate(parabola, line, direction)
        if (
            best is None
            or len(cand["idx"]) > len(best["idx"])
            or (len(cand["idx"]) == len(best["idx"]) and cand["sse"] < best["sse"])
        ):
            return cand
        return best

    best = None
    total = (n * (n - 1) * (n - 2)) / 6
    if total <= o["iters"]:
        for i in range(n - 2):
            for j in range(i + 1, n - 1):
                for k in range(j + 1, n):
                    best = try_sample(i, j, k, best)
    else:
        rng = mulberry32(o["seed"])
        for _ in range(o["iters"]):
            i = rand_int(rng, n)
            j = rand_int(rng, n)
            k = rand_int(rng, n)
            if i == j or j == k or i == k:
                continue
            lo = min(i, j, k)
            hi = max(i, j, k)
            mid = i + j + k - lo - hi
            best = try_sample(lo, mid, hi, best)
    if best is None or len(best["idx"]) < o["minInliers"]:
        return None

    for _ in range(4):
        us = [pts[m]["u"] for m in best["idx"]]
        vs = [pts[m]["v"] for m in best["idx"]]
        ts = [pts[m]["t"] for m in best["idx"]]
        parabola = fit_parabola(us, vs)
        line = fit_line(ts, us)
        if line is None or not check(parabola, best["dir"], us[0]):
            break
        if not line["q"] * best["dir"] > 0:
            break
        cand = evaluate(parabola, line, best["dir"])
        if len(cand["idx"]) < o["minInliers"]:
            break
        same = cand["idx"] == best["idx"]
        best = cand
        if same:
            break

    return {"dir": best["dir"], "inliers": best["idx"], "parabola": best["parabola"], "line": best["line"]}
