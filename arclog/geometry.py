"""籃框座標系：像素座標 ↔ 以籃框為基準的座標。對應 web/js/core/geometry.js。"""
from __future__ import annotations

import math

from .constants import BALL_DIAMETER_M, RIM_DIAMETER_M


def make_hoop_frame(front: dict, back: dict, level: str = "rim") -> dict | None:
    """由籃框前緣、後緣建立座標系。

    u 軸：前緣 → 後緣，前緣 u=0、後緣 u=1；v 軸：垂直籃框平面往上；單位是籃框內徑。
    level='rim' 以兩點連線當水平；level='image' 以畫面水平當水平。
    """
    level = "image" if level == "image" else "rim"
    dx = back["x"] - front["x"]
    dy = back["y"] - front["y"]
    dist = math.sqrt(dx * dx + dy * dy)
    if not dist > 1e-6:
        return None
    sgn = -1.0 if dx < 0 else 1.0
    tilt_deg = math.atan2(-dy * sgn, abs(dx)) * 180 / math.pi

    if level == "image":
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
