"""Python 核心模組的測試：讀和 JS 同一份測試向量（tests/vectors/），確認兩邊算出一樣的結果。

    python -m pytest tests/py

向量裡的 expected 是 JS 版算出來的數字，所以這裡每一個 assert_close 都是在檢查
「Python 和 JS 一致」；truth 是合成物理的真實答案，用來檢查誤差門檻。
"""
from __future__ import annotations

import math

import pytest

from arclog import constants as C
from arclog.bundle import BUNDLE_FORMAT, load_bundle, validate_bundle
from arclog.csvio import parse_csv, read_csv, shots_to_csv, write_csv
from arclog.fit import descending_crossing, eval_arc, fit_arc, fit_line, fit_parabola, ransac_arc
from arclog.geometry import make_hoop_frame, to_hoop, to_image
from arclog.interp import interpolate_shot
from arclog.prng import mulberry32, rand_int, rand_normal
from arclog.shot import analyze_shot, judge_make, sample_arc
from arclog.stats import summarize
from arclog.track import find_shots, mark_static
from arclog.yolo import decode_detections, letterbox
from conftest import assert_close, vectors

TOL = 1e-6  # JS 和 Python 的數值差容許值


def hoop_pts(hoop, points):
    out = []
    for p in points:
        u, v = to_hoop(hoop, p["x"], p["y"])
        out.append({"u": u, "v": v, "t": p["t"]})
    return out


def test_constants_match_js():
    v = vectors("constants.json")
    for k, want in v.items():
        if k == "roundAngle":
            continue
        assert getattr(C, k) == want, k
    for x, want in v["roundAngle"]:
        assert C.round_angle(x) == want, x


def test_prng_matches_js():
    for s in vectors("prng.json")["sequences"]:
        a = mulberry32(s["seed"])
        assert [a() for _ in range(8)] == s["floats"]
        b = mulberry32(s["seed"])
        assert [rand_int(b, 37) for _ in range(8)] == s["ints"]
        c = mulberry32(s["seed"])
        assert_close([rand_normal(c) for _ in range(4)], s["normals"], 1e-12)


def test_geometry():
    for c in vectors("geometry.json")["cases"]:
        frame = make_hoop_frame(c["front"], c["back"], c["level"], width=c.get("width"), height=c.get("height"), focal=c.get("focal"))
        if c["frame"] is None:
            assert frame is None
            continue
        assert_close(frame, c["frame"], 1e-12, "frame")
        for p in c["pts"]:
            u, v = to_hoop(frame, p["x"], p["y"])
            assert_close([u, v], [p["u"], p["v"]], 1e-12)
            x, y = to_image(frame, u, v)
            assert abs(x - p["x"]) < 1e-9 and abs(y - p["y"]) < 1e-9


def test_judge_make():
    v = vectors("make.json")
    for g in v["grid"]:
        j = judge_make(g["s"], g["angle"])
        assert j["zone"] == g["zone"], (g["s"], g["angle"])
        assert j["made"] == g["made"]
        assert_close([j["nearClear"], j["farGap"]], [g["nearClear"], g["farGap"]], 1e-12)
    for h in v["hand"]:
        j = judge_make(h["s"], h["angle"])
        assert (j["zone"], j["made"]) == (h["zone"], h["made"]), h["why"]


def test_entry_angle_within_one_degree_and_matches_js():
    v = vectors("angle.json")
    worst = 0.0
    for c in v["cases"]:
        hoop = make_hoop_frame(c["front"], c["back"], c["level"])
        res = analyze_shot(hoop_pts(hoop, c["points"]), drag_k=c["dragK"])
        assert res["ok"], c["name"]
        err = abs(res["angleRaw"] - c["truth"]["angleDeg"])
        worst = max(worst, err)
        assert err < c["tolDeg"] <= 1.0, f"{c['name']}: 誤差 {err:.3f} 度"
        assert res["made"] == (c["truth"]["zone"] in ("clean", "rim")), c["name"]
        assert_close(res, c["expected"], TOL, c["name"])
    assert len(v["cases"]) >= 60
    assert worst < 1.0


def test_entry_angle_failures():
    for c in vectors("angle_fail.json")["cases"]:
        res = analyze_shot(c["points"])
        assert res["ok"] is False
        assert res["reason"] == c["expected"]["reason"], c["name"]


def test_fit_functions():
    for s in vectors("fit.json")["sets"]:
        assert_close(fit_parabola(s["us"], s["vs"]), s["parabola"], TOL)
        assert_close(descending_crossing(s["parabola"]), s["crossing"], TOL)
        arc0 = fit_arc(s["us"], s["vs"], drag_k=0)
        arck = fit_arc(s["us"], s["vs"], drag_k=C.DRAG_K_RIM)
        assert_close(arc0, s["arc0"], TOL, "arc0")
        assert_close(arck, s["arcK"], TOL, "arcK")
        assert_close(eval_arc({"uc": arc0["uc"], "slope": arc0["slope"], "kappa": arc0["kappa"], "k": 0}, s["probe"]), s["eval0"], TOL)
        assert_close(eval_arc({"uc": arck["uc"], "slope": arck["slope"], "kappa": arck["kappa"], "k": arck["k"]}, s["probe"]), s["evalK"], TOL)
        assert_close(fit_line(s["us"], s["vs"]), s["line"], TOL)
        assert arck["slope"] > arc0["slope"]
    assert fit_parabola([1, 2], [1, 2]) is None
    assert fit_parabola([1, 1, 1], [1, 2, 3]) is None


def test_ransac_with_outliers():
    v = vectors("ransac.json")
    for c in v["cases"]:
        hoop = make_hoop_frame(c["front"], c["back"])
        pts = hoop_pts(hoop, c["points"])
        arc = ransac_arc(pts, seed=c["seed"], iters=c["iters"])
        assert arc is not None, c["name"]
        assert arc["inliers"] == c["expected"]["inliers"], c["name"]
        assert arc["dir"] == c["expected"]["dir"]
        assert_close(arc["parabola"], c["expected"]["parabola"], TOL)
        assert_close(arc["line"], c["expected"]["line"], TOL)
        res = analyze_shot([pts[m] for m in arc["inliers"]])
        assert abs(res["angleRaw"] - c["truth"]["angleDeg"]) < 1.0, c["name"]
        assert_close(res["angleRaw"], c["expected"]["angleRaw"], TOL)
    n = v["noiseOnly"]
    assert_close(ransac_arc(n["points"], seed=n["seed"]), n["expected"], TOL, "noiseOnly")


def test_find_shots_scenarios():
    v = vectors("track.json")
    for sc in v["scenarios"]:
        hoop = make_hoop_frame(sc["front"], sc["back"])
        res = find_shots(sc["detections"], hoop, **sc["opts"])
        assert len(res["shots"]) == len(sc["truth"]), sc["name"]
        assert res["stats"] == sc["expected"]["stats"], sc["name"]
        for i, s in enumerate(res["shots"]):
            t = sc["truth"][i]
            assert abs(s["angleRaw"] - t["angleDeg"]) < 1.0, f"{sc['name']} #{i + 1}"
            assert s["made"] == t["made"], f"{sc['name']} #{i + 1}"
            assert abs(s["tCross"] - t["tCross"]) < 0.12
            got = dict(s, nPoints=len(s["points"]), firstPoint=s["points"][0], lastPoint=s["points"][-1])
            assert_close(got, sc["expected"]["shots"][i], TOL, f"{sc['name']} #{i + 1}")
    sc = v["staticCase"]
    assert mark_static(sc["dets"], sc["ballDiameterPx"]) == sc["expected"]
    hoop = make_hoop_frame({"x": 900, "y": 240}, {"x": 972, "y": 240})
    assert find_shots([], hoop)["shots"] == []


def test_stats():
    for c in vectors("stats.json")["cases"]:
        assert_close(summarize(c["shots"]), c["expected"], 1e-12)
    st = summarize([{"angle": a, "made": i % 2 == 0} for i, a in enumerate([44, 46, 45, 47, 43, 45])])
    assert (st["attempts"], st["makes"], st["pct"]) == (6, 3, 50)
    assert abs(st["angleMean"] - 45) < 1e-12
    assert abs(st["angleStd"] - math.sqrt(2)) < 1e-12
    assert (st["first"]["attempts"], st["second"]["attempts"]) == (3, 3)
    odd = summarize([{"angle": 45, "made": True}] * 11)
    assert (odd["first"]["attempts"], odd["second"]["attempts"]) == (5, 6)
    empty = summarize([])
    assert empty["attempts"] == 0 and empty["pct"] is None and empty["angleMean"] is None


def test_interpolation():
    for c in vectors("interp.json")["cases"]:
        hoop = make_hoop_frame(c["front"], c["back"])
        shot = analyze_shot(hoop_pts(hoop, c["manual"]))
        frames = interpolate_shot(c["manual"], c["frameTimes"], hoop, shot)
        assert_close(frames, c["expected"]["frames"], 1e-6, c["name"])
        assert len(frames) == c["manual"][-1]["frame"] - c["manual"][0]["frame"] + 1
        manual_frames = {m["frame"] for m in c["manual"]}
        for i, f in enumerate(frames):
            assert f["src"] == ("manual" if f["frame"] in manual_frames else "interp")
            if f["src"] == "interp":
                d = math.hypot(f["x"] - c["truth"][i]["x"], f["y"] - c["truth"][i]["y"])
                assert d < c["tolPx"], f"{c['name']} 第 {f['frame']} 幀離真值 {d:.2f} 像素"


def test_csv(tmp_path):
    v = vectors("csv.json")
    assert shots_to_csv(v["shots"]) == v["text"]
    assert parse_csv(shots_to_csv(v["shots"]))["shots"] == v["shots"]
    for c in v["cases"]:
        assert parse_csv(c["text"]) == c["expected"], c["name"]
    # 寫檔再讀回來（含 BOM），統計不變
    shots = [{"angle": a, "made": i % 3 != 0} for i, a in enumerate([44.3, 47.0, 38.9, 52.1, 45.6, 41.2])]
    path = tmp_path / "shots.csv"
    write_csv(path, shots)
    raw = path.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf"), "要有 BOM，Excel 才不會亂碼"
    assert b"\r\n" in raw and b"\r\r\n" not in raw
    assert read_csv(path)["shots"] == shots
    assert summarize(read_csv(path)["shots"]) == summarize(shots)


def test_yolo_pre_and_post_processing():
    np = pytest.importorskip("numpy")
    v = vectors("yolo.json")
    for l in v["letterbox"]:
        assert_close(letterbox(l["sw"], l["sh"], l["dw"], l["dh"]), l["expected"], 1e-12)
    for group in ("many", "one"):
        data = np.array(v[group]["data"], dtype=np.float32)
        for c in v[group]["cases"]:
            o = c["opts"]
            kw = dict(class_index=o["classIndex"], conf=o["conf"], iou=o["iou"], max_det=o["maxDet"], lb=o["lb"])
            # numpy 陣列和一般 list 兩種輸入都要得到一樣的結果
            assert_close(decode_detections(data, v[group]["dims"], **kw), c["expected"], 1e-9, group)
            assert_close(decode_detections([float(x) for x in data], v[group]["dims"], **kw), c["expected"], 1e-9, group)
    assert letterbox(1920, 1080, 640, 384) == {"scale": 1 / 3, "newW": 640, "newH": 360, "padX": 0, "padY": 12}
    with pytest.raises(ValueError):
        decode_detections([320, 192, 24, 24, 0.9], [1, 5, 1], class_index=3)
    with pytest.raises(ValueError):
        decode_detections([320, 192, 24, 24, 0.9], [5, 1], class_index=0)


def test_bundle_validation(tmp_path):
    import json

    v = vectors("bundle.json")
    assert validate_bundle(v["good"]) == []
    assert v["good"]["format"] == BUNDLE_FORMAT
    for b in v["bads"]:
        assert validate_bundle(b["bundle"]) == b["expected"], b["name"]
    good = tmp_path / "ok.arclog.json"
    good.write_text(json.dumps(v["good"], ensure_ascii=False), encoding="utf-8")
    assert load_bundle(good)["video"]["frameCount"] == len(v["good"]["frameTimes"])
    bad = tmp_path / "bad.arclog.json"
    bad.write_text(json.dumps(v["bads"][0]["bundle"], ensure_ascii=False), encoding="utf-8")
    with pytest.raises(ValueError):
        load_bundle(bad)


def test_sample_arc_passes_near_points():
    c = next(x for x in vectors("angle.json")["cases"] if x["name"].startswith("鏡射"))
    hoop = make_hoop_frame(c["front"], c["back"])
    pts = hoop_pts(hoop, c["points"])
    res = analyze_shot(pts, drag_k=c["dragK"])
    us = [p["u"] for p in pts]
    curve = sample_arc(res, min(us), max(us), 200)
    for p in pts:
        near = min(curve, key=lambda q: abs(q["u"] - p["u"]))
        assert abs(near["v"] - p["v"]) < 0.05
