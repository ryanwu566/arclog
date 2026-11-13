"""自動流程：影片 → 逐幀偵測 → 串成軌跡 → 每一球的入框角度與進球判定。

tools/analyze.py 和 training/evaluate.py 都用這裡的函式；
步驟和參數與網站的自動偵測（web/js/ui/auto.js）相同：同一個 ONNX 模型、同一套軌跡邏輯。
需要 numpy、pillow、av、onnxruntime。
"""
from __future__ import annotations

import math
import time
from pathlib import Path

from .constants import DRAG_K_RIM
from .geometry import make_hoop_frame, to_image
from .shot import sample_arc
from .track import find_shots
from .video import Frame, VideoWriter, iter_frames


def fps_of(times: list[float]) -> float:
    """由時間戳算典型幀率（幀間隔中位數的倒數），和網站的算法相同。"""
    if len(times) < 2:
        return 30.0
    dts = sorted(b - a for a, b in zip(times, times[1:]))
    median = dts[len(dts) >> 1]
    return 1.0 / median if median > 0 else 30.0


def stride_for(fps: float, density: str = "normal") -> int:
    """每幾幀偵測一次。標準：每秒看 20 到 30 幀；精細：每一幀都看，最多每秒 60 幀。"""
    if density == "fine":
        return max(1, round(fps / 60))
    return max(1, math.floor(fps / 20 + 1e-6))


def detect_video(path, detector, density: str = "normal", stride: int | None = None, start: float | None = None,
                 end: float | None = None, progress=None) -> dict:
    """對整支影片逐幀偵測籃球。

    回傳 {'detections': [{'f','t','x','y','w','h','conf'}], 'times': [每幀時間戳], 'width', 'height',
          'fps', 'stride', 'processed', 'seconds'}。
    progress(done_frames, total_frames_or_None, fps) 會定期被呼叫。
    """
    detections: list[dict] = []
    times: list[float] = []
    width = height = 0
    processed = 0
    t0 = time.time()
    last_report = t0
    step = stride
    warm: list[Frame] = []  # 還不知道幀率之前先收幾幀
    total = None
    try:
        import av

        with av.open(str(path)) as c:
            total = int(c.streams.video[0].frames or 0) or None
    except Exception:  # noqa: BLE001 - 幀數只是給進度用的，拿不到就算了
        total = None

    def handle(fr: Frame) -> None:
        nonlocal processed
        if start is not None and fr.time < start:
            return
        if end is not None and fr.time > end:
            return
        if fr.index % step:
            return
        for d in detector.detect_frame(fr):
            detections.append({"f": fr.index, "t": fr.time, "x": d["x"], "y": d["y"], "w": d["w"], "h": d["h"], "conf": d["conf"]})
        processed += 1

    for fr in iter_frames(path):
        times.append(fr.time)
        if not width:
            width, height = fr.width, fr.height
        if step is None:
            # 用前 30 幀的時間戳決定幀率和取樣間隔，再回頭處理這幾幀
            warm.append(fr)
            if len(warm) < 30:
                continue
            step = stride_for(fps_of(times), density)
            for w in warm:
                handle(w)
            warm = []
        else:
            handle(fr)
        now = time.time()
        if progress and now - last_report >= 2.0:
            last_report = now
            progress(len(times), total, len(times) / max(now - t0, 1e-6))
    if step is None:
        step = stride_for(fps_of(times), density)
        for w in warm:
            handle(w)
    return {
        "detections": detections,
        "times": times,
        "width": width,
        "height": height,
        "fps": fps_of(times),
        "stride": step,
        "processed": processed,
        "seconds": time.time() - t0,
    }


def run_auto(path, hoop_points: dict, detector, level: str = "persp", drag: bool = True, density: str = "normal",
             stride: int | None = None, start: float | None = None, end: float | None = None, progress=None,
             focal: float | None = None) -> dict:
    """完整的自動流程。hoop_points = {'front': {'x','y'}, 'back': {'x','y'}}（顯示方向的像素）。

    level：水平基準，'persp'（籃框連線並修正透視，實拍影片的預設）、'rim'、'image'；說明見 arclog/geometry.py。
    回傳 detect_video 的內容，加上 'hoop'（座標系）、'shots'（每一球）、'stats'（追蹤統計）。
    """
    if make_hoop_frame(hoop_points["front"], hoop_points["back"], "image" if level == "image" else "rim") is None:
        raise ValueError("籃框的兩個點太接近，無法校正")
    det = detect_video(path, detector, density=density, stride=stride, start=start, end=end, progress=progress)
    # 修正透視需要知道畫面大小，所以等讀到影片之後才建立座標系
    hoop = make_hoop_frame(hoop_points["front"], hoop_points["back"], level, width=det["width"], height=det["height"], focal=focal)
    res = find_shots(det["detections"], hoop, dragK=DRAG_K_RIM if drag else 0)
    det.update(hoop=hoop, hoopPoints=hoop_points, shots=res["shots"], stats=res["stats"])
    return det


def shots_for_csv(shots: list[dict]) -> list[dict]:
    return [{"angle": s["angle"], "made": s["made"]} for s in shots]


# ── 檢查影片：把軌跡疊在畫面上 ──────────────────────────────────────────────

def _curve_points(shot: dict, hoop: dict) -> list[tuple[float, float]]:
    us = [((p["x"] - hoop["ox"]) * hoop["ux"] + (p["y"] - hoop["oy"]) * hoop["uy"]) / hoop["len"] for p in shot["points"]]
    cross = 1 - shot["crossS"] if shot["flip"] else shot["crossS"]
    u_from = max(us) if shot["flip"] else min(us)
    return [to_image(hoop, q["u"], q["v"]) for q in sample_arc(shot, u_from, cross, 48)]


def write_overlay(path, out_path, result: dict, mode: str = "shots", max_width: int = 1280, progress=None) -> dict:
    """輸出疊了軌跡的檢查影片。

    mode='shots'：只保留每一球前後的片段（出手前 0.6 秒到過框後 1.2 秒），檢查起來最快。
    mode='full' ：整支影片。
    """
    from PIL import Image, ImageDraw, ImageFont

    hoop = result["hoop"]
    shots = result["shots"]
    times = result["times"]
    width, height = result["width"], result["height"]
    scale = min(1.0, max_width / width)
    ow = int(round(width * scale)) // 2 * 2
    oh = int(round(height * scale)) // 2 * 2
    k = ow / width
    try:
        font = ImageFont.truetype("arial.ttf", max(14, int(oh * 0.04)))
    except OSError:
        font = ImageFont.load_default()

    curves = [[(x * k, y * k) for x, y in _curve_points(s, hoop)] for s in shots]
    windows = [(s["tStart"] - 0.6, s["tCross"] + 1.2) for s in shots]
    front = (result["hoopPoints"]["front"]["x"] * k, result["hoopPoints"]["front"]["y"] * k)
    back = (result["hoopPoints"]["back"]["x"] * k, result["hoopPoints"]["back"]["y"] * k)
    by_frame: dict[int, list[dict]] = {}
    for d in result["detections"]:
        by_frame.setdefault(d["f"], []).append(d)
    lw = max(2, int(oh / 240))
    written = 0
    t0 = time.time()
    last = t0
    fps_out = min(result["fps"], 60.0)
    with VideoWriter(out_path, ow, oh, fps=fps_out, crf=24) as writer:
        for fr in iter_frames(path):
            active = [i for i, (a, b) in enumerate(windows) if a <= fr.time <= b]
            if mode == "shots" and not active:
                continue
            img = Image.fromarray(fr.to_rgb(size=(ow, oh)))
            draw = ImageDraw.Draw(img)
            draw.line([front, back], fill=(255, 255, 255), width=lw + 1)
            for d in by_frame.get(fr.index, []):
                r = max(d["w"], d["h"]) * k / 2
                draw.ellipse([d["x"] * k - r, d["y"] * k - r, d["x"] * k + r, d["y"] * k + r], outline=(255, 255, 255), width=1)
            for i in active:
                s = shots[i]
                color = (90, 162, 240) if s["made"] else (255, 138, 87)
                draw.line(curves[i], fill=(0, 0, 0), width=lw + 2)
                draw.line(curves[i], fill=color, width=lw)
                for p in s["points"]:
                    if p["t"] <= fr.time:
                        draw.ellipse([p["x"] * k - lw, p["y"] * k - lw, p["x"] * k + lw, p["y"] * k + lw], fill=(255, 216, 74))
                label = f"#{i + 1}  {s['angle']:.1f} deg  {'MADE' if s['made'] else 'MISS'}"
                draw.text((12, 10), label, fill=(0, 0, 0), font=font, stroke_width=3, stroke_fill=(0, 0, 0))
                draw.text((12, 10), label, fill=(255, 255, 255), font=font)
            import numpy as np

            writer.write(np.asarray(img))
            written += 1
            now = time.time()
            if progress and now - last >= 2.0:
                last = now
                progress(fr.index + 1, len(times), (fr.index + 1) / max(now - t0, 1e-6))
    return {"path": Path(out_path), "frames": written, "width": ow, "height": oh}
