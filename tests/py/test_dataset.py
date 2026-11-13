"""訓練資料相關的純函式：時間戳對齊、以影片為單位切分、標註框、評估指標。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "training"))

from arclog.dataset import align_frames, check_fingerprint, pick_evenly, split_videos, yolo_box  # noqa: E402
from arclog.evaluation import PENDING, combine, detection_metrics, match_shots, replace_section, shot_metrics, table  # noqa: E402


# ── 時間戳對齊 ──────────────────────────────────────────────────────────────

def test_align_identity_when_times_match():
    times = [i / 30 for i in range(100)]
    al = align_frames(times, [t + 1e-7 for t in times])
    assert al["mode"] == "identity"
    assert al["map"] == {i: i for i in range(100)}
    assert al["dropped"] == []
    assert al["maxError"] < 1e-6


def test_align_absorbs_constant_start_offset():
    # 有些影片第一幀的時間不是 0；瀏覽器和 Python 報的起點可能不同，但每一幀的間隔相同
    times = [i / 60 for i in range(50)]
    al = align_frames(times, [t + 0.0417 for t in times])
    assert al["mode"] == "identity"
    assert abs(al["offset"] - 0.0417) < 1e-9
    assert al["map"][49] == 49


def test_align_variable_frame_rate_by_timestamp():
    # 可變幀率：兩邊的時間戳一樣不規則，只是 Python 這邊多解出最後一幀
    import math

    bundle = [(i + 0.35 * math.sin(i * 1.7)) / 30 for i in range(60)]
    video = bundle + [61 / 30]
    al = align_frames(bundle, video)
    assert al["mode"] == "nearest"
    assert all(al["map"][i] == i for i in range(60))
    assert al["dropped"] == []


def test_align_one_frame_shift_is_resolved_by_timestamps():
    # 瀏覽器少看到第一幀：標註包的第 k 幀其實是影片的第 k+1 幀。
    # 用幀號直接對會整個錯一格；用時間戳對才對。
    video = [i / 30 for i in range(400)]
    bundle = video[1:]
    al = align_frames(bundle, video)
    assert al["mode"] == "nearest" and al["offset"] == 0.0
    assert al["map"] == {k: k + 1 for k in range(399)}
    # 反過來：Python 少解出最前面兩幀
    al = align_frames(video, video[2:])
    assert al["map"] == {k: k - 2 for k in range(2, 400)}
    assert al["dropped"] == [0, 1]
    # 幀數不同時也會提醒
    errors, warnings = check_fingerprint({"video": {"width": 1280, "height": 720}, "frameTimes": bundle}, {"width": 1280, "height": 720}, len(video))
    assert not errors and warnings


def test_align_refuses_when_count_and_timebase_both_differ():
    # 幀數不同、時間軸又差了半幀：分不出誰對誰，全部放棄而不是亂猜
    video = [i / 30 for i in range(40)]
    bundle = [t + 0.5 / 30 for t in video[:-1]]
    al = align_frames(bundle, video)
    assert al["map"] == {} and len(al["dropped"]) == 39


def test_estimated_time_source_is_rejected():
    bundle = {"video": {"width": 1280, "height": 720, "timeSource": "estimated"}, "frameTimes": [i / 30 for i in range(30)]}
    errors, _ = check_fingerprint(bundle, {"width": 1280, "height": 720}, 30)
    assert errors and "估計" in errors[0]


def test_align_drops_frames_that_do_not_match():
    bundle = [0.0, 0.1, 0.2, 0.3, 0.4]
    video = [0.0, 0.1, 0.2, 0.36, 0.4, 0.5]  # 第 4 幀的時間差太多
    al = align_frames(bundle, video)
    assert al["mode"] == "nearest"
    assert 3 in al["dropped"]
    assert al["map"][4] == 4
    assert 3 not in al["map"]


def test_align_only_needed_frames():
    times = [i / 30 for i in range(30)]
    al = align_frames(times, times, needed=[3, 7, 99])
    assert al["map"] == {3: 3, 7: 7}
    assert al["dropped"] == [99]


def test_fingerprint_rejects_different_file():
    bundle = {"video": {"width": 1920, "height": 1080, "size": 1000}, "frameTimes": [i / 30 for i in range(300)]}
    errors, _ = check_fingerprint(bundle, {"width": 1280, "height": 720, "size": 1000}, 300)
    assert errors and "解析度" in errors[0]
    errors, _ = check_fingerprint(bundle, {"width": 1920, "height": 1080, "size": 1000}, 150)
    assert errors and "幀數" in errors[0]
    errors, warnings = check_fingerprint(bundle, {"width": 1920, "height": 1080, "size": 1000}, 301)
    assert not errors and warnings
    errors, warnings = check_fingerprint(bundle, {"width": 1920, "height": 1080, "size": 1000}, 300)
    assert not errors and not warnings


# ── 以影片為單位切分 ────────────────────────────────────────────────────────

def test_split_keeps_each_video_in_one_group():
    names = [f"video_{i:02d}" for i in range(20)]
    s = split_videos(names, seed=3)
    groups = [set(s["train"]), set(s["val"]), set(s["test"])]
    assert groups[0] | groups[1] | groups[2] == set(names)
    assert not (groups[0] & groups[1]) and not (groups[0] & groups[2]) and not (groups[1] & groups[2])
    assert len(s["test"]) == 3 and len(s["val"]) == 3 and len(s["train"]) == 14
    assert split_videos(names, seed=3) == s  # 同樣的輸入每次結果相同
    assert split_videos(list(reversed(names)), seed=3) == s  # 和輸入順序無關


def test_split_small_sets_and_explicit_choice():
    s = split_videos(["a", "b", "c"])
    assert len(s["train"]) == 1 and len(s["val"]) == 1 and len(s["test"]) == 1
    s = split_videos(["a", "b"])
    assert len(s["train"]) == 1 and len(s["val"]) == 1 and s["test"] == [] and s["warnings"]
    s = split_videos(["a"])
    assert s["train"] == ["a"] and s["warnings"]
    s = split_videos(["a", "b", "c", "d"], val=["b"], test=["d"])
    assert s == {"train": ["a", "c"], "val": ["b"], "test": ["d"], "warnings": []}
    with pytest.raises(ValueError):
        split_videos(["a", "b"], val=["a"], test=["a"])
    with pytest.raises(ValueError):
        split_videos(["a", "b"], test=["zzz"])
    with pytest.raises(ValueError):
        split_videos(["a", "b"], val=["a"], test=["b"])  # 訓練組會是空的


# ── 標註框 ──────────────────────────────────────────────────────────────────

def test_yolo_box():
    cx, cy, w, h = yolo_box(640, 360, 36, 1280, 720, scale=1.0)
    assert (cx, cy) == (0.5, 0.5)
    assert abs(w - 36 / 1280) < 1e-12 and abs(h - 36 / 720) < 1e-12
    # 靠近邊緣：裁掉超出畫面的部分
    cx, cy, w, h = yolo_box(5, 360, 40, 1280, 720, scale=1.0)
    assert abs(cx * 1280 - 12.5) < 1e-9 and abs(w * 1280 - 25) < 1e-9
    # 球心在畫面外
    assert yolo_box(-3, 100, 40, 1280, 720) is None
    assert yolo_box(100, 721, 40, 1280, 720) is None


def test_pick_evenly():
    assert pick_evenly(list(range(100)), 4) == [12, 37, 62, 87]
    assert pick_evenly([1, 2, 3], 10) == [1, 2, 3]
    assert pick_evenly([], 3) == [] and pick_evenly([1, 2], 0) == []


# ── 評估指標 ────────────────────────────────────────────────────────────────

def _det(f, x, y, conf=0.5, fps=30):
    return {"f": f, "t": f / fps, "x": x, "y": y, "w": 30, "h": 30, "conf": conf}


def test_detection_metrics_counts():
    # 10 幀有標記：模型找到其中 8 幀；另外在兩幀「確定沒有球」的畫面上各誤報一次
    gt = {f: (100 + 20 * f, 300 - 5 * f) for f in range(10)}
    dets = [_det(f, 100 + 20 * f + 3, 300 - 5 * f - 2) for f in range(8)]
    dets += [_det(20, 500, 500), _det(22, 900, 100)]
    dets += [_det(30, 50, 50)]  # 第 30 幀不知道答案：不算
    m = detection_metrics(dets, gt, no_ball={20, 21, 22}, processed=set(range(40)), ball_px=36)
    assert (m["tp"], m["fn"], m["fp"]) == (8, 2, 2)
    assert m["recall"] == 0.8 and m["precision"] == 0.8
    assert m["gtFrames"] == 10 and m["noBallFrames"] == 3


def test_detection_metrics_respects_stride_and_radius():
    gt = {f: (100.0, 100.0) for f in range(10)}
    dets = [_det(f, 100.0 + (0 if f < 5 else 30), 100.0) for f in range(0, 10, 2)]
    m = detection_metrics(dets, gt, set(), processed=set(range(0, 10, 2)), ball_px=36, radius=0.5)
    # 只看偶數幀：5 幀；其中 f=0,2,4 在半個球直徑以內，f=6,8 偏了 30 像素（超過 18）
    assert m["gtFrames"] == 5 and m["tp"] == 3 and m["fp"] == 2


def test_detection_metrics_static_objects():
    # 一個一直停在同一個位置的假偵測：一般的 precision 會被拉低，扣掉靜止物之後不會
    gt = {f: (100 + 25 * f, 200.0) for f in range(30)}
    dets = [_det(f, 100 + 25 * f, 200.0) for f in range(30)] + [_det(f, 900.0, 600.0, 0.3) for f in range(30)]
    m = detection_metrics(dets, gt, set(), processed=set(range(30)), ball_px=36)
    assert m["recall"] == 1.0
    assert m["precision"] == 0.5
    assert m["precisionMoving"] == 1.0


def test_match_and_shot_metrics():
    manual = [
        {"id": 1, "t0": 1.0, "t1": 1.8, "angle": 45.0, "made": True},
        {"id": 2, "t0": 4.0, "t1": 4.9, "angle": 40.0, "made": False},
        {"id": 3, "t0": 7.0, "t1": 7.8, "angle": 50.0, "made": True},
    ]
    auto = [
        {"tCross": 1.85, "angle": 45.4, "made": True},
        {"tCross": 7.9, "angle": 49.0, "made": False},
        {"tCross": 12.0, "angle": 30.0, "made": False},  # 多抓的
    ]
    m = match_shots(manual, auto)
    assert m == {"pairs": [(0, 0), (2, 1)], "missed": [1], "extra": [2]}
    s = shot_metrics(manual, auto, truth={1: {"angle": 45.1, "made": True}, 3: {"angle": 50.2, "made": True}})
    assert (s["matched"], s["missed"], s["extra"], s["madeCorrect"]) == (2, 1, 1, 1)
    assert s["angleErrors"] == pytest.approx([0.4, 1.0])
    assert s["truthErrors"] == pytest.approx([0.3, 1.2])


def test_match_is_one_to_one():
    manual = [{"id": 1, "t0": 1.0, "t1": 1.8, "angle": 45.0, "made": True}]
    auto = [{"tCross": 1.7, "angle": 44.0, "made": True}, {"tCross": 1.9, "angle": 46.0, "made": True}]
    m = match_shots(manual, auto)
    assert len(m["pairs"]) == 1 and len(m["extra"]) == 1


def test_table_writes_pending_instead_of_numbers():
    video = {
        "detection": {"gtFrames": 100, "noBallFrames": 20, "tp": 90, "fn": 10, "fp": 10, "fpMoving": 0},
        "shots": {"manualShots": 10, "autoShots": 9, "matched": 9, "missed": 1, "extra": 0, "madeCorrect": 8, "angleErrors": [0.5] * 9},
    }
    total = combine([video, video])
    assert total["recall"] == 0.9 and total["precision"] == 0.9 and total["precisionMoving"] == 1.0
    assert total["angleMae"] == pytest.approx(0.5) and total["missed"] == 2 and total["videos"] == 2
    md = table([{"label": "階段 A", "result": total}, {"label": "階段 B", "result": None}, {"label": "階段 C", "result": None}])
    lines = md.splitlines()
    assert len(lines) == 5
    assert "90.0%" in lines[2] and "0.50" in lines[2] and "16/18（89%）" in lines[2] and "2 支／20 球" in lines[2]
    for line in lines[3:]:
        cells = [c.strip() for c in line.strip("|").split("|")]
        assert cells[1:] == [PENDING] * 8  # 沒有資料的列不能出現任何數字
    # 沒有任何一球的結果也算「沒有資料」
    empty = combine([])
    assert table([{"label": "x", "result": empty}]).splitlines()[2].count(PENDING) == 8


def test_replace_section():
    text = "# 標題\n\n<!-- EVAL:REAL:BEGIN -->\n舊的\n<!-- EVAL:REAL:END -->\n\n結尾\n"
    out = replace_section(text, "REAL", "新的表格")
    assert out == "# 標題\n\n<!-- EVAL:REAL:BEGIN -->\n新的表格\n<!-- EVAL:REAL:END -->\n\n結尾\n"
    assert replace_section(out, "REAL", "新的表格") == out
    with pytest.raises(ValueError):
        replace_section(text, "SYNTH", "x")


# ── 公開資料集的整理 ────────────────────────────────────────────────────────

def test_public_group_key_and_label_conversion():
    from prepare_public import convert_label, group_key

    assert group_key("clip12_frame_0045_jpg.rf.3f2a9c.jpg") == "clip12"
    assert group_key("clip12_frame_0046_jpg.rf.77aa01.jpg") == "clip12"
    assert group_key("clip13_frame_0001_jpg.rf.123abc.jpg") == "clip13"
    assert group_key("video_7_mp4-0045_jpg.rf.abc123.jpg") == "video_7_mp4"
    # 只留籃球（這裡是類別 1），其他類別丟掉；多邊形轉成外接框
    text = "0 0.5 0.5 0.2 0.2\n1 0.25 0.25 0.1 0.1\n1 0.1 0.1 0.3 0.1 0.3 0.4 0.1 0.4\n2 0.9 0.9 0.1 0.1\n"
    boxes = convert_label(text, 1)
    assert len(boxes) == 2
    assert boxes[0] == (0.25, 0.25, 0.1, 0.1)
    assert boxes[1] == pytest.approx((0.2, 0.25, 0.2, 0.3))
    assert convert_label("", 0) == [] and convert_label("garbage\n0 1 2\n", 0) == []
