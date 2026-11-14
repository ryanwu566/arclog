"""評估用的純函式：偵測指標、自動流程和人工標記的比對、結果表格。

實際讀影片、跑模型的部分在 training/evaluate.py；這裡的函式只吃資料，方便單獨測試。
"""
from __future__ import annotations

from .track import TRACK_DEFAULTS, mark_static

PENDING = "待實測"


def detection_metrics(detections: list[dict], gt: dict[int, tuple[float, float]], no_ball: set[int], processed: set[int],
                      ball_px: float, radius: float = 0.5) -> dict:
    """「飛行中的球」的偵測指標。

    gt        ：{影片幀號: (球心 x, 球心 y)}，人工標記（含內插）的飛行中的球
    no_ball   ：確定畫面上沒有球的幀號
    processed ：模型實際看過的幀號（每幾幀看一次時，沒看的幀不算）
    radius    ：偵測到的中心離標記的球心多近算「找到」（單位：球的直徑）

    recall    ＝有標記的幀裡，模型找到球的比例。
    precision ＝在「知道答案的幀」（有標記的幀＋確定沒有球的幀）裡，模型框出來的東西有多少真的是那顆球。
                沒標記也沒說沒有球的幀（例如球拿在手上的時候）不知道答案，所以不算。
    precisionMoving：同上，但先扣掉「一直停在同一個地方」的偵測（放在地上的球、牆上的圓形標誌；
                追蹤邏輯本來就會把它們濾掉）。
    """
    limit2 = (radius * ball_px) ** 2
    ordered = sorted(detections, key=lambda d: (d["t"], d["f"]))
    static = mark_static(ordered, ball_px, TRACK_DEFAULTS)
    by_frame: dict[int, list[tuple[dict, bool]]] = {}
    for d, is_static in zip(ordered, static):
        by_frame.setdefault(d["f"], []).append((d, is_static))

    gt_frames = [f for f in gt if f in processed]
    known = set(gt_frames) | (no_ball & processed)
    tp = fp = fp_moving = 0
    for f in known:
        items = by_frame.get(f, [])
        target = gt.get(f)
        hit = False
        for d, is_static in items:
            ok = target is not None and not hit and (d["x"] - target[0]) ** 2 + (d["y"] - target[1]) ** 2 <= limit2
            if ok:
                hit = True
            else:
                fp += 1
                if not is_static:
                    fp_moving += 1
        if hit:
            tp += 1
    fn = len(gt_frames) - tp
    return {
        "gtFrames": len(gt_frames), "noBallFrames": len(no_ball & processed), "tp": tp, "fn": fn, "fp": fp, "fpMoving": fp_moving,
        "recall": tp / len(gt_frames) if gt_frames else None,
        "precision": tp / (tp + fp) if tp + fp else None,
        "precisionMoving": tp / (tp + fp_moving) if tp + fp_moving else None,
    }


def match_shots(manual: list[dict], auto: list[dict], before: float = 0.3, after: float = 0.6) -> dict:
    """把自動找到的球和人工標記的球一對一配起來。

    manual：[{'id', 't0', 't1', 'angle', 'made'}]，t0／t1 是這一球第一個和最後一個標記的時間
    auto  ：[{'tCross', 'angle', 'made'}]
    自動那一球「過框的時間」落在人工標記的時間範圍內（前後各放寬一點）就算同一球；
    一球只能配一次，離得最近的優先。
    回傳 {'pairs': [(manual 索引, auto 索引)], 'missed': [manual 索引], 'extra': [auto 索引]}
    """
    cands = []
    for i, m in enumerate(manual):
        for j, a in enumerate(auto):
            if m["t0"] - before <= a["tCross"] <= m["t1"] + after:
                cands.append((abs(a["tCross"] - m["t1"]), i, j))
    cands.sort()
    used_m: set[int] = set()
    used_a: set[int] = set()
    pairs = []
    for _, i, j in cands:
        if i in used_m or j in used_a:
            continue
        used_m.add(i)
        used_a.add(j)
        pairs.append((i, j))
    pairs.sort()
    return {
        "pairs": pairs,
        "missed": [i for i in range(len(manual)) if i not in used_m],
        "extra": [j for j in range(len(auto)) if j not in used_a],
    }


def shot_metrics(manual: list[dict], auto: list[dict], truth: dict[int, dict] | None = None) -> dict:
    """最終指標：角度差、進球判定、漏掉和多抓的球數。

    truth：{人工那一球的 id: {'angle', 'made'}}，只有合成資料才有。
    """
    m = match_shots(manual, auto)
    errs = [abs(auto[j]["angle"] - manual[i]["angle"]) for i, j in m["pairs"]]
    made_ok = sum(1 for i, j in m["pairs"] if bool(auto[j]["made"]) == bool(manual[i]["made"]))
    out = {
        "manualShots": len(manual), "autoShots": len(auto), "matched": len(m["pairs"]),
        "missed": len(m["missed"]), "extra": len(m["extra"]),
        "angleErrors": errs, "madeCorrect": made_ok,
    }
    if truth is not None:
        terrs = []
        for i, j in m["pairs"]:
            t = truth.get(manual[i]["id"])
            if t is not None:
                terrs.append(abs(auto[j]["angle"] - t["angle"]))
        out["truthErrors"] = terrs
    return out


def combine(per_video: list[dict]) -> dict:
    """把好幾支影片的結果加總成一個模型的成績。"""
    tot = {"videos": len(per_video), "gtFrames": 0, "noBallFrames": 0, "tp": 0, "fn": 0, "fp": 0, "fpMoving": 0,
           "manualShots": 0, "autoShots": 0, "matched": 0, "missed": 0, "extra": 0, "madeCorrect": 0, "angleErrors": [], "truthErrors": []}
    has_truth = False
    for r in per_video:
        for k in ("gtFrames", "noBallFrames", "tp", "fn", "fp", "fpMoving"):
            tot[k] += r["detection"][k]
        for k in ("manualShots", "autoShots", "matched", "missed", "extra", "madeCorrect"):
            tot[k] += r["shots"][k]
        tot["angleErrors"] += r["shots"]["angleErrors"]
        if "truthErrors" in r["shots"]:
            has_truth = True
            tot["truthErrors"] += r["shots"]["truthErrors"]
    tot["recall"] = tot["tp"] / tot["gtFrames"] if tot["gtFrames"] else None
    tot["precision"] = tot["tp"] / (tot["tp"] + tot["fp"]) if tot["tp"] + tot["fp"] else None
    tot["precisionMoving"] = tot["tp"] / (tot["tp"] + tot["fpMoving"]) if tot["tp"] + tot["fpMoving"] else None
    tot["angleMae"] = sum(tot["angleErrors"]) / len(tot["angleErrors"]) if tot["angleErrors"] else None
    tot["angleMax"] = max(tot["angleErrors"]) if tot["angleErrors"] else None
    tot["madeAccuracy"] = tot["madeCorrect"] / tot["matched"] if tot["matched"] else None
    if has_truth:
        tot["truthMae"] = sum(tot["truthErrors"]) / len(tot["truthErrors"]) if tot["truthErrors"] else None
    else:
        del tot["truthErrors"]
    return tot


def _pct(v: float | None) -> str:
    return PENDING if v is None else f"{v * 100:.1f}%"


def _deg(v: float | None) -> str:
    return PENDING if v is None else f"{v:.2f}"


def table(rows: list[dict], with_truth: bool = False) -> str:
    """把各模型的成績排成一張 Markdown 表。rows：[{'label': 模型名稱, 'result': combine() 的結果或 None}]。

    result 是 None（還沒有模型、或還沒有測試影片）的那一列，每一格都寫「待實測」，不填任何數字。
    """
    head = ["模型", "測試影片／球數", "飛行球 recall", "飛行球 precision", "precision（扣掉靜止物）", "入框角度 MAE（度）", "進球判定正確率", "漏掉的球", "多抓的球"]
    if with_truth:
        head.insert(6, "對真值的 MAE（度）")
    lines = ["| " + " | ".join(head) + " |", "|" + "|".join(["---"] * len(head)) + "|"]
    for row in rows:
        r = row.get("result")
        if not r or not r.get("manualShots"):
            cells = [row["label"]] + [PENDING] * (len(head) - 1)
        else:
            made = PENDING if r["madeAccuracy"] is None else f"{r['madeCorrect']}/{r['matched']}（{r['madeAccuracy'] * 100:.0f}%）"
            cells = [
                row["label"], f"{r['videos']} 支／{r['manualShots']} 球", _pct(r["recall"]), _pct(r["precision"]), _pct(r["precisionMoving"]),
                _deg(r["angleMae"]), made, str(r["missed"]), str(r["extra"]),
            ]
            if with_truth:
                cells.insert(6, _deg(r.get("truthMae")))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def replace_section(text: str, name: str, body: str) -> str:
    """把文件裡 <!-- EVAL:NAME:BEGIN --> 和 <!-- EVAL:NAME:END --> 之間的內容換掉。"""
    begin, end = f"<!-- EVAL:{name}:BEGIN -->", f"<!-- EVAL:{name}:END -->"
    a, b = text.find(begin), text.find(end)
    if a < 0 or b < 0 or b < a:
        raise ValueError(f"文件裡找不到 {begin} … {end}")
    return text[: a + len(begin)] + "\n" + body.strip("\n") + "\n" + text[b:]
