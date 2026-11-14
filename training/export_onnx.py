#!/usr/bin/env python3
"""把 Ultralytics 的權重匯出成網站和 tools/analyze.py 用的 ONNX，並登記到 models/manifest.json。

階段 A（COCO 預訓練，直接用 sports ball 類別）：

    python training/export_onnx.py --weights yolo26n.pt --id arclog-ball-a-coco --stage A --set-default

階段 B／C（自己訓練出來的 best.pt）：

    python training/export_onnx.py --weights runs/arclog/stage_b/weights/best.pt --id arclog-ball-b-public --stage B

匯出設定（已對照 Ultralytics 官方文件，版本 8.4.211）：
  - format="onnx"、simplify=True（預設）、opset 用預設值、dynamic=False
  - imgsz=(384, 640)：高 384、寬 640 的長方形輸入，配合橫向 16:9 的影片
  - nms 不指定：用預設的 one-to-many 輸出 [1, 4+類別數, N]，NMS 由 arclog/yolo.py 和 web/js/core/yolo.js 自己做
    （YOLO26 的 nms=False 會多出 TopK 等運算，在瀏覽器的 WebGPU 上比較容易退回 CPU）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

MODELS = ROOT / "models"
STAGE_LABELS = {
    "A": "階段 A：COCO 預訓練（sports ball 類別）",
    "B": "階段 B：公開資料集訓練",
    "C": "階段 C：自有資料微調",
    "synthetic": "合成資料（只用來驗證流程，不代表真實準確度）",
}
SYNTHETIC_NOTE = "用合成畫面訓練的模型，只用來驗證流程，不代表真實準確度。"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="匯出 ONNX 並登記到 models/manifest.json")
    ap.add_argument("--weights", required=True, help="yolo26n.pt（官方預訓練）或訓練出來的 best.pt")
    ap.add_argument("--id", required=True, help="模型代號，也是檔名，例如 arclog-ball-b-public")
    ap.add_argument("--stage", required=True, choices=sorted(STAGE_LABELS), help="A、B、C 或 synthetic")
    ap.add_argument("--label", help="網站選單顯示的名稱（預設依 stage 決定）")
    ap.add_argument("--imgsz", type=int, nargs=2, default=[384, 640], metavar=("高", "寬"))
    ap.add_argument("--conf", type=float, default=None, help="建議的信心門檻（預設：階段 A 用 0.05，其餘 0.15；假偵測由軌跡邏輯濾掉，所以門檻可以設低）")
    ap.add_argument("--note", default=None, help="寫進 manifest 的補充說明（網站選模型時會顯示；--stage synthetic 沒給時自動寫上「不代表真實準確度」的提醒）")
    ap.add_argument("--data", default="", help="訓練資料來源的簡短描述（寫進 manifest）")
    ap.add_argument("--set-default", action="store_true", help="設成網站預設使用的模型")
    ap.add_argument("--out-dir", default=str(MODELS), help="輸出目錄（預設 models/）")
    ap.add_argument("--no-sync", action="store_true", help="不要同步到 web/models/")
    args = ap.parse_args()

    import ultralytics
    from ultralytics import YOLO

    from arclog.detector import BallDetector

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    weights = Path(args.weights)

    # 在暫存目錄匯出，免得在權重旁邊留下檔案
    with tempfile.TemporaryDirectory(prefix="arclog_export_") as tmp:
        work = Path(tmp) / weights.name
        if weights.exists():
            shutil.copyfile(weights, work)
            model = YOLO(str(work))
        else:
            # 官方權重名稱（例如 yolo26n.pt）：讓 Ultralytics 自己下載到暫存目錄
            model = YOLO(str(work))
        exported = Path(model.export(format="onnx", imgsz=tuple(args.imgsz)))
        dst = out_dir / f"{args.id}.onnx"
        shutil.copyfile(exported, dst)

    # 重新用 onnxruntime 載入一次：確認檔案能用，順便讀出輸入大小和類別
    try:
        det = BallDetector(dst)
    except ValueError as err:
        print(f"[X] {err}")
        return 1
    class_index = det.class_index
    out_shape = [int(d) if isinstance(d, int) else str(d) for d in det.session.get_outputs()[0].shape]
    conf = args.conf if args.conf is not None else (0.05 if args.stage == "A" else 0.15)
    note = args.note
    if note is None:
        # 合成資料訓練的模型一定要讓使用者看得到這句（網站選這個模型時會顯示 manifest 的 note）
        note = SYNTHETIC_NOTE if args.stage == "synthetic" else ""

    entry = {
        "id": args.id,
        "file": dst.name,
        "label": args.label or STAGE_LABELS[args.stage],
        "stage": args.stage,
        "base": det.meta.get("description", "").split(" model")[0].replace("Ultralytics ", "") or weights.stem,
        "input": {"width": det.in_w, "height": det.in_h},
        "output": out_shape,
        "classIndex": class_index,
        "className": det.names.get(class_index),
        "numClasses": len(det.names),
        "conf": conf,
        "ultralytics": ultralytics.__version__,
        "exported": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "bytes": dst.stat().st_size,
        "sha256": sha256(dst),
        "data": args.data,
        "note": note,
        "license": "AGPL-3.0",
    }

    manifest_path = out_dir / "manifest.json"
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    else:
        manifest = {"version": 1, "default": args.id, "models": []}
    manifest["models"] = [m for m in manifest["models"] if m["id"] != args.id] + [entry]
    order = {"A": 0, "B": 1, "C": 2, "synthetic": 3}
    manifest["models"].sort(key=lambda m: (order.get(m["stage"], 9), m["id"]))
    if args.set_default or manifest.get("default") not in [m["id"] for m in manifest["models"]]:
        manifest["default"] = args.id
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"[OK] {dst.relative_to(ROOT) if dst.is_relative_to(ROOT) else dst}")
    print(f"     輸入 {det.in_w}×{det.in_h}、輸出 {out_shape}、籃球類別 {class_index}（{entry['className']}）、{entry['bytes'] / 1e6:.1f} MB")

    if not args.no_sync and out_dir.resolve() == MODELS.resolve():
        import subprocess

        return subprocess.call([sys.executable, str(ROOT / "tools" / "sync_models.py")])
    return 0


if __name__ == "__main__":
    sys.exit(main())
