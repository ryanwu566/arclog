"""把「影片＋標註包」變成訓練資料時用到的純函式：時間戳對齊、以影片為單位切分、標註框。

這些函式不讀影片也不寫檔（實際的讀寫在 training/build_dataset.py），所以可以單獨測試。
"""
from __future__ import annotations

import bisect
import hashlib
import math


def median_gap(times: list[float]) -> float:
    if len(times) < 2:
        return 1 / 30
    gaps = sorted(b - a for a, b in zip(times, times[1:]))
    return gaps[len(gaps) >> 1]


def align_frames(bundle_times: list[float], video_times: list[float], needed: list[int] | None = None) -> dict:
    """把標註包裡的幀號（瀏覽器看到的幀）對到 Python 解出來的幀號。

    兩邊各有一串「每一幀的時間戳」。做法：
      1. 先扣掉兩邊第一幀的時間差（有些播放器的時間軸起點不同）。
      2. 幀數相同、而且每一幀的時間都對得上（差不到半幀）→ 幀號直接相同，這是最常見的情況。
      3. 否則逐幀找時間最接近的那一幀；差超過半幀的就放棄（寧可少一筆也不要標錯位置）。

    needed：只需要對齊哪些幀號（預設全部）。
    回傳 {'map': {標註包幀號: 影片幀號}, 'mode': 'identity'|'nearest', 'offset': 秒,
          'maxError': 對齊後最大的時間差, 'dropped': [對不上的幀號], 'tolerance': 秒}
    """
    if not bundle_times or not video_times:
        return {"map": {}, "mode": "nearest", "offset": 0.0, "maxError": 0.0, "dropped": list(needed or []), "tolerance": 0.0}
    want = list(range(len(bundle_times))) if needed is None else sorted(set(needed))
    offset = video_times[0] - bundle_times[0]
    tol = 0.5 * min(median_gap(bundle_times), median_gap(video_times))

    if len(bundle_times) == len(video_times):
        worst = 0.0
        for a, b in zip(bundle_times, video_times):
            err = abs(b - a - offset)
            if err > worst:
                worst = err
        if worst < tol:
            return {"map": {f: f for f in want if 0 <= f < len(video_times)}, "mode": "identity", "offset": offset,
                    "maxError": worst, "dropped": [f for f in want if not 0 <= f < len(video_times)], "tolerance": tol}

    mapping: dict[int, int] = {}
    dropped: list[int] = []
    worst = 0.0
    for f in want:
        if not 0 <= f < len(bundle_times):
            dropped.append(f)
            continue
        target = bundle_times[f] + offset
        j = bisect.bisect_left(video_times, target)
        best = None
        for cand in (j - 1, j):
            if 0 <= cand < len(video_times):
                err = abs(video_times[cand] - target)
                if best is None or err < best[0]:
                    best = (err, cand)
        if best is None or best[0] >= tol:
            dropped.append(f)
            continue
        mapping[f] = best[1]
        if best[0] > worst:
            worst = best[0]
    return {"map": mapping, "mode": "nearest", "offset": offset, "maxError": worst, "dropped": dropped, "tolerance": tol}


def check_fingerprint(bundle: dict, probe: dict, frame_count: int) -> tuple[list[str], list[str]]:
    """核對影片是不是標註時用的那一個檔案。回傳（錯誤, 警告）。

    最常見的出錯情況：在 iPhone 的 Safari 上標註（系統給網頁的是轉檔後的版本），
    卻拿原始檔來抽畫面。解析度或幀數不同時，標註的座標和幀號都對不上。
    """
    errors: list[str] = []
    warnings: list[str] = []
    v = bundle["video"]
    if (int(v["width"]), int(v["height"])) != (int(probe["width"]), int(probe["height"])):
        errors.append(f"解析度不同：標註時是 {v['width']}×{v['height']}，這支影片是 {probe['width']}×{probe['height']}。這不是標註時用的那個檔案。")
    n = len(bundle["frameTimes"])
    if n != frame_count:
        diff = abs(n - frame_count) / max(n, 1)
        msg = f"幀數不同：標註時是 {n} 幀，這支影片是 {frame_count} 幀。"
        if diff > 0.02:
            errors.append(msg + "差太多了，很可能不是同一個檔案（例如一個是手機轉檔後的版本）。")
        else:
            warnings.append(msg + "會改用時間戳逐幀對齊。")
    if v.get("size") and probe.get("size") and int(v["size"]) != int(probe["size"]):
        warnings.append(f"檔案大小不同（標註時 {v['size']} 位元組，現在 {probe['size']} 位元組）。如果解析度和幀數都相同，通常沒有問題。")
    return errors, warnings


def split_videos(names: list[str], val: list[str] | None = None, test: list[str] | None = None,
                 ratios: tuple[float, float, float] = (0.7, 0.15, 0.15), seed: int = 1) -> dict:
    """以「影片」為單位切成訓練、驗證、測試三組：同一支影片的畫面一定在同一組。

    val、test 可以直接指定影片名稱；沒指定的部分依影片名稱的雜湊決定（同一批影片、同一個 seed 結果固定）。
    回傳 {'train': [...], 'val': [...], 'test': [...], 'warnings': [...]}
    """
    names = sorted(set(names))
    warnings: list[str] = []
    val = [n for n in (val or [])]
    test = [n for n in (test or [])]
    for n in val + test:
        if n not in names:
            raise ValueError(f"指定的影片「{n}」不在資料裡")
    if set(val) & set(test):
        raise ValueError("同一支影片不能同時在驗證組和測試組")
    rest = [n for n in names if n not in val and n not in test]
    rest.sort(key=lambda n: hashlib.sha1(f"{seed}:{n}".encode("utf-8")).hexdigest())
    total = len(names)
    if not val and not test:
        if total >= 3:
            n_test = max(1, round(total * ratios[2]))
            n_val = max(1, round(total * ratios[1]))
            while n_test + n_val >= total:
                if n_test > 1:
                    n_test -= 1
                elif n_val > 1:
                    n_val -= 1
                else:
                    break
            test = rest[:n_test]
            val = rest[n_test:n_test + n_val]
            rest = rest[n_test + n_val:]
        elif total == 2:
            val = rest[:1]
            rest = rest[1:]
            warnings.append("只有 2 支影片：一支訓練、一支驗證，沒有獨立的測試組。評估結果不能當成最終準確度。")
        else:
            warnings.append("只有 1 支影片：全部拿去訓練，驗證也只能用同一支。這樣量不出模型在新影片上的表現。")
    train = rest
    if not train:
        raise ValueError("沒有影片可以放進訓練組")
    overlap = (set(train) & set(val)) | (set(train) & set(test)) | (set(val) & set(test))
    if overlap:
        raise ValueError(f"切分出錯，影片重複出現在不同組：{sorted(overlap)}")
    return {"train": sorted(train), "val": sorted(val), "test": sorted(test), "warnings": warnings}


def yolo_box(x: float, y: float, diameter: float, width: int, height: int, scale: float = 1.1) -> tuple[float, float, float, float] | None:
    """球心和直徑 → YOLO 格式的標註框（中心 x、中心 y、寬、高，都除以畫面大小）。

    框比球稍微大一點（預設 1.1 倍），把邊緣的模糊包進去；超出畫面的部分裁掉。
    球心在畫面外、或裁完剩不到四分之一顆球時回傳 None。
    """
    if not (0 <= x <= width and 0 <= y <= height):
        return None
    half = diameter * scale / 2
    x1, y1 = max(0.0, x - half), max(0.0, y - half)
    x2, y2 = min(float(width), x + half), min(float(height), y + half)
    w, h = x2 - x1, y2 - y1
    if w < half * 0.5 or h < half * 0.5:
        return None
    return ((x1 + x2) / 2 / width, (y1 + y2) / 2 / height, w / width, h / height)


def pick_evenly(candidates: list[int], count: int) -> list[int]:
    """從候選幀裡平均挑 count 個。"""
    if count <= 0 or not candidates:
        return []
    if count >= len(candidates):
        return list(candidates)
    step = len(candidates) / count
    return [candidates[min(len(candidates) - 1, math.floor(step * (i + 0.5)))] for i in range(count)]
