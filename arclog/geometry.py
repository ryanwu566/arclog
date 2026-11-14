"""籃框座標系：像素座標 ↔ 以籃框為基準的座標。對應 web/js/core/geometry.js。"""
from __future__ import annotations

import math

from .constants import BALL_DIAMETER_M, FOCAL_RATIO, RIM_DIAMETER_M

#: level='vertical' 時，鉛直參考線換算出來的水平和籃框連線最多可以差幾度（超過就當成點錯了）。
MAX_VERTICAL_SKEW_DEG = 30


def _line_tilt_deg(dx: float, dy: float) -> float:
    """直線相對畫面水平的傾斜（度），右端比較高為正；和方向無關。"""
    sgn = -1.0 if dx < 0 else 1.0
    return math.atan2(-dy * sgn, abs(dx)) * 180 / math.pi


def make_hoop_frame(front: dict, back: dict, level: str = "rim", width: float | None = None, height: float | None = None,
                    focal: float | None = None, vertical: dict | None = None) -> dict | None:
    """由籃框前緣、後緣建立座標系。

    u 軸：前緣 → 後緣，前緣 u=0、後緣 u=1；v 軸：垂直籃框平面往上；單位是籃框內徑。
    level='persp'   ：以兩點連線當水平，但先扣掉籃框因為透視看起來是斜的那一部分（實拍影片的預設）。
                      需要 width、height（影片的像素大小），沒給就當成 'rim'。
    level='vertical'：以一條鉛直參考線（籃板側邊、籃架立柱、門框）為準，和它垂直的方向就是水平。
                      需要 vertical={'top': {x, y}, 'bottom': {x, y}}；沒給、兩點重合，
                      或換算出來的水平和籃框連線差超過 MAX_VERTICAL_SKEW_DEG 度時回傳 None。
    level='rim'     ：直接以兩點連線當水平。
    level='image'   ：以畫面水平當水平。
    說明見 web/js/core/geometry.js。
    """
    level = level if level in ("image", "persp", "vertical") else "rim"
    if level == "persp" and not (width is not None and height is not None and width > 0 and height > 0):
        level = "rim"
    dx = back["x"] - front["x"]
    dy = back["y"] - front["y"]
    dist = math.sqrt(dx * dx + dy * dy)
    if not dist > 1e-6:
        return None
    tilt_deg = _line_tilt_deg(dx, dy)

    persp_deg = 0.0
    vert_deg = None
    focal_used = None
    if level == "vertical":
        if not vertical or not vertical.get("top") or not vertical.get("bottom"):
            return None
        ex = vertical["top"]["x"] - vertical["bottom"]["x"]
        ey = vertical["top"]["y"] - vertical["bottom"]["y"]
        elen = math.sqrt(ex * ex + ey * ey)
        if not elen > 1e-6:
            return None
        ux = -ey / elen
        uy = ex / elen
        proj = ux * dx + uy * dy
        if proj < 0:
            ux = -ux
            uy = -uy
            proj = -proj
        if not proj >= dist * math.cos(MAX_VERTICAL_SKEW_DEG * math.pi / 180):
            return None
        vert_deg = _line_tilt_deg(ux, uy)
        cx = (front["x"] + back["x"]) / 2
        cy = (front["y"] + back["y"]) / 2
        xn = 0.0
        if width is not None and height is not None and width > 0 and height > 0:
            focal_used = focal if (focal is not None and focal > 0) else FOCAL_RATIO
            xn = (cx - width / 2) / (focal_used * max(width, height))
        length = proj / math.sqrt(1 + xn * xn)
        ox = cx - 0.5 * length * ux
        oy = cy - 0.5 * length * uy
    elif level == "persp":
        focal_used = focal if (focal is not None and focal > 0) else FOCAL_RATIO
        f = focal_used * max(width, height)
        cx = (front["x"] + back["x"]) / 2
        cy = (front["y"] + back["y"]) / 2
        xn = (cx - width / 2) / f
        yn = (height / 2 - cy) / f
        tan_tau = (xn * yn) / (1 + xn * xn)
        cos_tau = 1 / math.sqrt(1 + tan_tau * tan_tau)
        sin_tau = tan_tau * cos_tau
        persp_deg = math.atan(tan_tau) * 180 / math.pi
        ux = (dx * cos_tau - dy * sin_tau) / dist
        uy = (dx * sin_tau + dy * cos_tau) / dist
        length = (dist * cos_tau) / math.sqrt(1 + xn * xn)
        ox = cx - 0.5 * length * ux
        oy = cy - 0.5 * length * uy
    elif level == "image":
        if not abs(dx) > 1e-6:
            return None
        ox = front["x"]
        oy = (front["y"] + back["y"]) / 2
        ux = 1.0 if dx > 0 else -1.0
        uy = 0.0
        length = abs(dx)
    else:
        ox = front["x"]
        oy = front["y"]
        ux = dx / dist
        uy = dy / dist
        length = dist
    vx = uy
    vy = -ux
    if vy > 0 or (vy == 0 and vx > 0):
        vx = -vx
        vy = -vy
    return {
        "level": level,
        "ox": ox, "oy": oy, "ux": ux, "uy": uy, "vx": vx, "vy": vy,
        "len": length,
        "pxPerM": length / RIM_DIAMETER_M,
        "ballDiameterPx": (length / RIM_DIAMETER_M) * BALL_DIAMETER_M,
        "tiltDeg": tilt_deg,
        "perspDeg": persp_deg,
        "vertDeg": vert_deg,
        "focal": focal_used,
    }


def to_hoop(frame: dict, x: float, y: float) -> tuple[float, float]:
    """像素座標 → 籃框座標 (u, v)。"""
    px = x - frame["ox"]
    py = y - frame["oy"]
    return (
        (px * frame["ux"] + py * frame["uy"]) / frame["len"],
        (px * frame["vx"] + py * frame["vy"]) / frame["len"],
    )


def to_image(frame: dict, u: float, v: float) -> tuple[float, float]:
    """籃框座標 → 像素座標 (x, y)。"""
    a = u * frame["len"]
    b = v * frame["len"]
    return (
        frame["ox"] + a * frame["ux"] + b * frame["vx"],
        frame["oy"] + a * frame["uy"] + b * frame["vy"],
    )
