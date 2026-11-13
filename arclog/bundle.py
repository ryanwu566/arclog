"""標註包的讀取與檢查。格式由網站的 web/js/core/bundle.js 產生（說明見該檔）。"""
from __future__ import annotations

import json
import math
from pathlib import Path

BUNDLE_FORMAT = "arclog-annotations"
BUNDLE_VERSION = 1


def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _int(x) -> bool:
    return isinstance(x, int) and not isinstance(x, bool)


def validate_bundle(b) -> list[str]:
    """檢查標註包格式。回傳錯誤訊息清單，空清單代表沒問題。訊息和 JS validateBundle 相同。"""
    errs: list[str] = []
    if not isinstance(b, dict):
        return ["不是 JSON 物件"]
    if b.get("format") != BUNDLE_FORMAT:
        errs.append(f"format 應為 {BUNDLE_FORMAT}")
    if b.get("version") != BUNDLE_VERSION:
        errs.append(f"不支援的 version：{b.get('version')}")
    v = b.get("video")
    if not isinstance(v, dict) or not _num(v.get("width")) or not _num(v.get("height")) or not v["width"] > 0 or not v["height"] > 0:
        errs.append("video.width / video.height 不正確")
    times = b.get("frameTimes")
    if not isinstance(times, list) or not times:
        errs.append("缺少 frameTimes")
    else:
        for i in range(1, len(times)):
            if not times[i] > times[i - 1]:
                errs.append(f"frameTimes 在第 {i} 幀沒有遞增")
                break
    h = b.get("hoop")
    ok_hoop = (
        isinstance(h, dict)
        and isinstance(h.get("front"), dict)
        and isinstance(h.get("back"), dict)
        and _num(h["front"].get("x"))
        and _num(h["front"].get("y"))
        and _num(h["back"].get("x"))
        and _num(h["back"].get("y"))
    )
    if not ok_hoop:
        errs.append("hoop.front / hoop.back 不正確")
    ball = b.get("ball")
    if not isinstance(ball, dict) or not _num(ball.get("diameterPx")) or not ball["diameterPx"] > 0:
        errs.append("ball.diameterPx 不正確")
    shots = b.get("shots")
    if not isinstance(shots, list):
        errs.append("缺少 shots")
    else:
        n = len(times) if isinstance(times, list) else 0
        for i, s in enumerate(shots):
            if not isinstance(s.get("made"), bool):
                errs.append(f"第 {i + 1} 球缺少 made")
            frames = s.get("frames")
            if not isinstance(frames, list) or not frames:
                errs.append(f"第 {i + 1} 球沒有 frames")
                continue
            prev = -1
            for f in frames:
                fi = f.get("f")
                if not _int(fi) or fi < 0 or fi >= n:
                    errs.append(f"第 {i + 1} 球有超出範圍的幀號 {fi}")
                    break
                if fi <= prev:
                    errs.append(f"第 {i + 1} 球的幀號沒有遞增")
                    break
                prev = fi
                if not _num(f.get("x")) or not _num(f.get("y")) or not _num(f.get("t")):
                    errs.append(f"第 {i + 1} 球第 {fi} 幀的座標不正確")
                    break
                if f.get("src") not in ("manual", "interp", "auto"):
                    errs.append(f"第 {i + 1} 球第 {fi} 幀的 src 不正確")
                    break
    no_ball = b.get("noBall")
    if no_ball is not None:
        if not isinstance(no_ball, list):
            errs.append("noBall 應為陣列")
        else:
            for r in no_ball:
                if not _int(r.get("from")) or not _int(r.get("to")) or r["from"] > r["to"] or r["from"] < 0:
                    errs.append("noBall 的範圍不正確")
                    break
    return errs


def load_bundle(path) -> dict:
    """讀取並檢查標註包；格式有問題時丟出 ValueError。"""
    data = json.loads(Path(path).read_text(encoding="utf-8-sig"))
    errs = validate_bundle(data)
    if errs:
        raise ValueError(f"{path} 不是正確的 ArcLog 標註包：" + "；".join(errs))
    return data
