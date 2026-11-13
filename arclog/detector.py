"""用 onnxruntime 跑籃球偵測模型。需要 `onnxruntime`、`numpy`、`pillow`。

和網站用的是同一個 ONNX 檔、同一套前後處理（arclog/yolo.py ↔ web/js/core/yolo.js），
所以 tools/analyze.py 和網站的自動偵測結果可以互相比對。
"""
from __future__ import annotations

import ast
import json
from pathlib import Path

import numpy as np

from .yolo import decode_detections, letterbox

#: 補邊用的灰色（Ultralytics 的慣例）
PAD_VALUE = 114

REPO_ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = REPO_ROOT / "models"


def resolve_class_index(names: dict) -> int | None:
    """從模型的類別名稱找出「籃球」是第幾類。

    自己訓練的單一類別模型是 0；COCO 預訓練模型是 32（sports ball）。
    """
    if not names:
        return None
    lower = {int(k): str(v).strip().lower() for k, v in names.items()}
    for want in ("basketball", "ball", "sports ball"):
        for k, v in lower.items():
            if v == want:
                return k
    for k, v in sorted(lower.items()):
        if "ball" in v:
            return k
    if len(lower) == 1:
        return next(iter(lower))
    return None


def load_manifest(models_dir: Path | str = MODELS_DIR) -> dict:
    """讀 models/manifest.json。"""
    return json.loads((Path(models_dir) / "manifest.json").read_text(encoding="utf-8"))


def find_model(model: str | None = None, models_dir: Path | str = MODELS_DIR) -> dict:
    """決定要用哪個模型。

    model 可以是 manifest 裡的 id、.onnx 檔的路徑，或 None（用 manifest 的預設）。
    回傳 {'path', 'classIndex'（可能是 None，由模型內的資訊決定）, 'conf', 'id'}。
    """
    models_dir = Path(models_dir)
    if model and Path(model).suffix.lower() == ".onnx" and Path(model).exists():
        return {"path": Path(model), "classIndex": None, "conf": None, "id": Path(model).stem}
    manifest = load_manifest(models_dir)
    want = model or manifest.get("default")
    for m in manifest.get("models", []):
        if m["id"] == want:
            return {"path": models_dir / m["file"], "classIndex": m.get("classIndex"), "conf": m.get("conf"), "id": m["id"]}
    raise FileNotFoundError(f"找不到模型「{want}」。可用的有：" + "、".join(m["id"] for m in manifest.get("models", [])))


class BallDetector:
    """載入 ONNX 模型，對一幀畫面找出籃球。"""

    def __init__(self, model_path, class_index: int | None = None, conf: float = 0.15, iou: float = 0.5,
                 max_det: int = 8, providers: list[str] | None = None, threads: int | None = None):
        import onnxruntime as ort

        so = ort.SessionOptions()
        if threads:
            so.intra_op_num_threads = int(threads)
        available = ort.get_available_providers()
        chosen = [p for p in (providers or ["CPUExecutionProvider"]) if p in available] or ["CPUExecutionProvider"]
        self.session = ort.InferenceSession(str(model_path), sess_options=so, providers=chosen)
        self.providers = self.session.get_providers()
        inp = self.session.get_inputs()[0]
        self.input_name = inp.name
        shape = inp.shape
        if len(shape) != 4 or not all(isinstance(d, int) for d in shape[2:]):
            raise ValueError(f"模型輸入形狀應為固定的 [1, 3, 高, 寬]，得到 {shape}")
        self.in_h, self.in_w = int(shape[2]), int(shape[3])

        meta = self.session.get_modelmeta().custom_metadata_map or {}
        self.names: dict = {}
        if "names" in meta:
            try:
                self.names = dict(ast.literal_eval(meta["names"]))
            except (ValueError, SyntaxError):
                self.names = {}
        self.meta = meta
        if class_index is None:
            class_index = resolve_class_index(self.names)
        if class_index is None:
            raise ValueError("看不出這個模型的哪一個類別是籃球，請用 class_index 指定")
        self.class_index = int(class_index)
        self.conf = float(conf)
        self.iou = float(iou)
        self.max_det = int(max_det)
        self._buf = np.full((1, 3, self.in_h, self.in_w), PAD_VALUE / 255.0, dtype=np.float32)

    def preprocess(self, rgb: np.ndarray) -> tuple[np.ndarray, dict]:
        """(高, 寬, 3) 的 RGB 畫面 → 模型輸入張量和 letterbox 參數。"""
        from PIL import Image

        h, w = rgb.shape[:2]
        lb = letterbox(w, h, self.in_w, self.in_h)
        if (lb["newW"], lb["newH"]) != (w, h):
            small = np.asarray(Image.fromarray(rgb).resize((lb["newW"], lb["newH"]), Image.BILINEAR))
        else:
            small = rgb
        buf = self._buf
        buf[:] = PAD_VALUE / 255.0
        y0, x0 = lb["padY"], lb["padX"]
        buf[0, :, y0 : y0 + lb["newH"], x0 : x0 + lb["newW"]] = small.transpose(2, 0, 1).astype(np.float32) / 255.0
        return buf, lb

    def detect(self, rgb: np.ndarray) -> list[dict]:
        """回傳 [{'x','y','w','h','conf'}]，座標是原始畫面的像素，x y 是球心。"""
        x, lb = self.preprocess(rgb)
        out = self.session.run(None, {self.input_name: x})[0]
        return decode_detections(out, out.shape, class_index=self.class_index, conf=self.conf, iou=self.iou,
                                 max_det=self.max_det, lb=lb)

    def detect_frame(self, frame) -> list[dict]:
        """直接吃 arclog.video.Frame：先在解碼端縮到模型需要的大小，比轉成全尺寸再縮快很多。"""
        lb = letterbox(frame.width, frame.height, self.in_w, self.in_h)
        small = frame.to_rgb(size=(lb["newW"], lb["newH"]))
        buf = self._buf
        buf[:] = PAD_VALUE / 255.0
        y0, x0 = lb["padY"], lb["padX"]
        buf[0, :, y0 : y0 + lb["newH"], x0 : x0 + lb["newW"]] = small.transpose(2, 0, 1).astype(np.float32) / 255.0
        out = self.session.run(None, {self.input_name: buf})[0]
        return decode_detections(out, out.shape, class_index=self.class_index, conf=self.conf, iou=self.iou,
                                 max_det=self.max_det, lb=lb)
