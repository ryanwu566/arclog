"""YOLO 偵測模型的前後處理：縮放補邊、輸出解碼、NMS。對應 web/js/core/yolo.js。

支援兩種 Ultralytics ONNX 輸出：
  - 預設匯出（one-to-many）：[1, 4+類別數, N]，需要 NMS
  - nms=False 匯出（one-to-one）：[1, N, 6]，每列 x1, y1, x2, y2, 分數, 類別

這個模組只用到「可以用索引取值的一維資料」，不強制 numpy；
傳 numpy 陣列進來時會先用向量化挑出超過門檻的候選，速度才夠。
"""
from __future__ import annotations

import math


def _round_half_up(x: float) -> int:
    return math.floor(x + 0.5)


def letterbox(src_w: int, src_h: int, dst_w: int, dst_h: int) -> dict:
    """把 src 等比例縮進 dst、置中補邊的參數。"""
    scale = min(dst_w / src_w, dst_h / src_h)
    new_w = min(dst_w, max(1, _round_half_up(src_w * scale)))
    new_h = min(dst_h, max(1, _round_half_up(src_h * scale)))
    return {
        "scale": scale,
        "newW": new_w,
        "newH": new_h,
        "padX": (dst_w - new_w) // 2,
        "padY": (dst_h - new_h) // 2,
    }


def _iou(a: dict, b: dict) -> float:
    x1 = max(a["x1"], b["x1"])
    y1 = max(a["y1"], b["y1"])
    x2 = min(a["x2"], b["x2"])
    y2 = min(a["y2"], b["y2"])
    w = x2 - x1
    h = y2 - y1
    if not (w > 0 and h > 0):
        return 0.0
    inter = w * h
    return inter / ((a["x2"] - a["x1"]) * (a["y2"] - a["y1"]) + (b["x2"] - b["x1"]) * (b["y2"] - b["y1"]) - inter)


def _candidate_indices(data, start: int, count: int, step: int, conf: float):
    """回傳 data[start + i*step] >= conf 的 i（遞增）。有 numpy 就用向量化。"""
    try:
        import numpy as np

        if isinstance(data, np.ndarray):
            view = data.reshape(-1)[start : start + count * step : step]
            return [int(i) for i in np.nonzero(view >= conf)[0]]
    except ImportError:  # pragma: no cover
        pass
    return [i for i in range(count) if float(data[start + i * step]) >= conf]


def decode_detections(
    data,
    dims,
    class_index: int,
    conf: float = 0.15,
    iou: float = 0.5,
    max_det: int = 8,
    lb: dict | None = None,
) -> list[dict]:
    """解碼模型輸出，只留指定類別。回傳 [{'x','y','w','h','conf'}]，x y 是球心。

    data：攤平的輸出（list 或 numpy 陣列皆可）；dims：輸出形狀。
    有給 lb（letterbox 的結果）時，座標會換回原始畫面。
    """
    dims = [int(d) for d in dims]
    if len(dims) != 3:
        raise ValueError(f"看不懂的模型輸出形狀 {dims}")
    flat = data.reshape(-1) if hasattr(data, "reshape") else data

    cand = []
    if dims[2] == 6 and dims[1] != 6:
        n = dims[1]
        for i in _candidate_indices(flat, 4, n, 6, conf):
            o = i * 6
            if math.floor(float(flat[o + 5]) + 0.5) != class_index:
                continue
            cand.append({
                "x1": float(flat[o]), "y1": float(flat[o + 1]),
                "x2": float(flat[o + 2]), "y2": float(flat[o + 3]),
                "conf": float(flat[o + 4]), "i": i,
            })
    else:
        ch = dims[1]
        n = dims[2]
        if ch < 5 or 4 + class_index >= ch:
            raise ValueError(f"模型輸出只有 {ch - 4} 個類別，找不到類別 {class_index}")
        so = (4 + class_index) * n
        for i in _candidate_indices(flat, so, n, 1, conf):
            cx = float(flat[i])
            cy = float(flat[n + i])
            hw = float(flat[2 * n + i]) / 2
            hh = float(flat[3 * n + i]) / 2
            cand.append({"x1": cx - hw, "y1": cy - hh, "x2": cx + hw, "y2": cy + hh, "conf": float(flat[so + i]), "i": i})

    cand.sort(key=lambda c: (-c["conf"], c["i"]))
    keep: list[dict] = []
    for c in cand:
        ok = True
        for k in keep:
            if _iou(c, k) > iou:
                ok = False
                break
        if ok:
            keep.append(c)
            if len(keep) >= max_det:
                break

    out = []
    for k in keep:
        x = (k["x1"] + k["x2"]) / 2
        y = (k["y1"] + k["y2"]) / 2
        w = k["x2"] - k["x1"]
        h = k["y2"] - k["y1"]
        if lb is not None:
            x = (x - lb["padX"]) / lb["scale"]
            y = (y - lb["padY"]) / lb["scale"]
            w /= lb["scale"]
            h /= lb["scale"]
        out.append({"x": x, "y": y, "w": w, "h": h, "conf": k["conf"]})
    return out
