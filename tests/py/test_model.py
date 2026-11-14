"""模型相關的測試：models/ 與 web/models/ 一致、階段 A 模型載得起來、
自己寫的解碼和 Ultralytics 官方的結果一致。

需要 onnxruntime；和 Ultralytics 對照的部分另外需要 ultralytics（沒裝會自動略過）。
用的圖是 tests/fixtures/img/ 的合成畫面（程式畫的，沒有實拍內容）。
"""
from __future__ import annotations

import importlib.util
import json
import math
import sys

import pytest

from conftest import ROOT

np = pytest.importorskip("numpy")
pytest.importorskip("onnxruntime")
Image = pytest.importorskip("PIL.Image")

from arclog.detector import BallDetector, find_model, load_manifest, resolve_class_index  # noqa: E402
from arclog.yolo import decode_detections, letterbox  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "img"
META = json.loads((FIX / "synth_frames.json").read_text(encoding="utf-8"))


def load_rgb(name: str):
    return np.asarray(Image.open(FIX / name).convert("RGB"))


def load_sync_module():
    spec = importlib.util.spec_from_file_location("sync_models", ROOT / "tools" / "sync_models.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_models_and_web_models_are_in_sync():
    assert load_sync_module().check() == []


def test_manifest_describes_stage_a():
    manifest = load_manifest()
    ids = [m["id"] for m in manifest["models"]]
    assert manifest["default"] in ids
    a = next(m for m in manifest["models"] if m["stage"] == "A")
    assert a["classIndex"] == 32 and a["className"] == "sports ball"
    assert a["input"] == {"width": 640, "height": 384}
    assert a["output"][0] == 1 and a["output"][1] == 84, "階段 A 用預設的 one-to-many 輸出，需要外部 NMS"
    assert a["license"] == "AGPL-3.0"
    assert (ROOT / "models" / a["file"]).stat().st_size == a["bytes"]


def test_resolve_class_index():
    assert resolve_class_index({0: "person", 32: "sports ball", 49: "orange"}) == 32
    assert resolve_class_index({0: "ball", 1: "hoop", 2: "player"}) == 0
    assert resolve_class_index({0: "hoop", 1: "basketball", 2: "made basket"}) == 1
    assert resolve_class_index({0: "Basketball"}) == 0
    assert resolve_class_index({0: "thing"}) == 0
    assert resolve_class_index({0: "hoop", 1: "player"}) is None
    assert resolve_class_index({}) is None


@pytest.fixture(scope="module")
def detector():
    info = find_model()
    return BallDetector(info["path"], class_index=info["classIndex"], conf=0.05)


def test_stage_a_finds_the_ball_in_synthetic_frames(detector):
    """COCO 預訓練模型看得到示範畫面裡飛行中的球（示範模式的自動偵測靠這個）。"""
    assert (detector.in_w, detector.in_h) == (640, 384)
    assert detector.class_index == 32
    ball_px = META["ballDiameterPx"]
    for name in ("synth_apex.png", "synth_late.png"):
        truth = META["frames"][name]["ball"]
        dets = detector.detect(load_rgb(name))
        near = [d for d in dets if math.hypot(d["x"] - truth["x"], d["y"] - truth["y"]) <= 0.35 * ball_px]
        assert near, f"{name}：沒有在球的位置偵測到球，偵測結果 {dets}"
        best = max(near, key=lambda d: d["conf"])
        assert best["conf"] >= 0.10, f"{name}：信心只有 {best['conf']:.2f}"
        assert 0.6 * ball_px <= best["w"] <= 1.6 * ball_px and 0.6 * ball_px <= best["h"] <= 1.6 * ball_px
    # 沒有球的畫面不可以有高信心的偵測
    empty = detector.detect(load_rgb("synth_empty.png"))
    assert all(d["conf"] < 0.25 for d in empty), empty


def test_decoder_matches_ultralytics_nms(detector):
    """同一個輸出張量，自己寫的解碼＋NMS 和 Ultralytics 的 non_max_suppression 結果一致。"""
    torch = pytest.importorskip("torch")
    try:
        from ultralytics.utils.nms import non_max_suppression
    except ImportError:  # 舊版放在 ops
        ops = pytest.importorskip("ultralytics.utils.ops")
        non_max_suppression = ops.non_max_suppression

    for name in ("synth_apex.png", "synth_late.png"):
        x, lb = detector.preprocess(load_rgb(name))
        out = detector.session.run(None, {detector.input_name: x})[0]
        for conf in (0.05, 0.15):
            mine = decode_detections(out, out.shape, class_index=32, conf=conf, iou=0.5, max_det=300)
            ref = non_max_suppression(torch.from_numpy(out.copy()), conf_thres=conf, iou_thres=0.5, classes=[32],
                                      multi_label=True, max_det=300, nc=80)[0].numpy()
            assert len(mine) == len(ref), f"{name} conf {conf}：我 {len(mine)} 個、Ultralytics {len(ref)} 個"
            ref_sorted = sorted(ref.tolist(), key=lambda r: -r[4])
            for d, r in zip(mine, ref_sorted):
                assert abs(d["conf"] - r[4]) < 1e-5
                assert abs(d["x"] - (r[0] + r[2]) / 2) < 1e-2 and abs(d["y"] - (r[1] + r[3]) / 2) < 1e-2
                assert abs(d["w"] - (r[2] - r[0])) < 1e-2 and abs(d["h"] - (r[3] - r[1])) < 1e-2
            assert len(mine) >= 1


def test_full_pipeline_close_to_ultralytics_predict(detector):
    """整條前後處理（縮放方式和 Ultralytics 略有不同）得到的球，位置和官方推論差不到 2 像素。"""
    ultralytics = pytest.importorskip("ultralytics")
    info = find_model()
    model = ultralytics.YOLO(str(info["path"]), task="detect")
    for name in ("synth_apex.png", "synth_late.png"):
        rgb = load_rgb(name)
        truth = META["frames"][name]["ball"]
        res = model.predict(Image.fromarray(rgb), imgsz=(384, 640), conf=0.05, classes=[32], verbose=False)[0]
        ref = [(float(b[0] + b[2]) / 2, float(b[1] + b[3]) / 2, float(c)) for b, c in zip(res.boxes.xyxy.tolist(), res.boxes.conf.tolist())]
        ref_near = [r for r in ref if math.hypot(r[0] - truth["x"], r[1] - truth["y"]) <= 0.35 * META["ballDiameterPx"]]
        mine = [d for d in detector.detect(rgb) if math.hypot(d["x"] - truth["x"], d["y"] - truth["y"]) <= 0.35 * META["ballDiameterPx"]]
        assert ref_near and mine, f"{name}: ultralytics {ref}, mine {mine}"
        r = max(ref_near, key=lambda t: t[2])
        d = max(mine, key=lambda t: t["conf"])
        assert math.hypot(d["x"] - r[0], d["y"] - r[1]) < 2.0, f"{name}: 位置差 {math.hypot(d['x'] - r[0], d['y'] - r[1]):.2f} 像素"
        assert abs(d["conf"] - r[2]) < 0.15, f"{name}: 信心 {d['conf']:.2f} vs {r[2]:.2f}"


def test_letterbox_matches_detector_preprocess(detector):
    rgb = load_rgb("synth_apex.png")
    x, lb = detector.preprocess(rgb)
    assert x.shape == (1, 3, 384, 640) and x.dtype == np.float32
    assert lb == letterbox(rgb.shape[1], rgb.shape[0], 640, 384)
    # 補邊的地方是灰色 114/255
    assert abs(float(x[0, 0, 0, 0]) - 114 / 255) < 1e-6 and abs(float(x[0, 2, -1, -1]) - 114 / 255) < 1e-6
    assert 0.0 <= float(x.min()) and float(x.max()) <= 1.0
