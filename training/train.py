#!/usr/bin/env python3
"""訓練籃球偵測模型（Ultralytics YOLO，單一類別）。

階段 B：用公開資料集，從官方的 COCO 預訓練權重開始

    python training/train.py --stage B --data datasets/public_ball/data.yaml

階段 C：用自己的影片（build_dataset.py 的輸出），從階段 B 的結果接著訓練

    python training/train.py --stage C --data D:\\arclog_data\\dataset\\data.yaml --weights runs/arclog/stage_b/weights/best.pt

只想確認流程會動（合成資料、跑兩三輪就好）：

    python training/train.py --stage synthetic --data data/dataset_synth/data.yaml --epochs 3

訓練完會告訴你下一步的匯出指令。結果放在 runs/arclog/<名稱>/（這個資料夾不會進版控）。

參數名稱已對照 Ultralytics 8.4.211 的設定（ultralytics/cfg/default.yaml）：
  model、data、epochs、patience、batch、imgsz、device、workers、project、name、exist_ok、
  seed、fraction、freeze、fliplr、degrees、close_mosaic、plots。
沒有 NVIDIA 顯示卡的電腦只能用 CPU 訓練，非常慢，只適合試流程；正式訓練請用 training/arclog_train.ipynb（Google Colab）。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: 各階段的預設值。epochs＝最多訓練幾輪；patience＝驗證分數連續幾輪沒進步就提早停。
STAGE_DEFAULTS = {
    "B": {"epochs": 80, "patience": 20, "name": "stage_b"},
    "C": {"epochs": 50, "patience": 15, "name": "stage_c"},
    "synthetic": {"epochs": 3, "patience": 0, "name": "synthetic"},
}
BASE_WEIGHTS = "yolo26n.pt"  # 最新一代的 Nano 尺寸（理由見 docs/PLAN.md）


def pick_device(want: str | None) -> tuple[str, str]:
    """決定用什麼裝置訓練。回傳（給 Ultralytics 的 device, 給人看的說明）。"""
    import torch

    if want and want != "auto":
        return want, f"依指定使用 {want}"
    if torch.cuda.is_available():
        return "0", f"NVIDIA GPU：{torch.cuda.get_device_name(0)}"
    return "cpu", "沒有可用的 NVIDIA GPU，改用 CPU（很慢，只適合試流程）"


def find_base_weights(name: str) -> str:
    """官方權重：repo 裡已經下載過就直接用，否則交給 Ultralytics 下載。"""
    for cand in (Path(name), ROOT / "data" / "weights" / name, ROOT / name):
        if cand.exists():
            return str(cand)
    return name


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="訓練籃球偵測模型", formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", required=True, choices=sorted(STAGE_DEFAULTS), help="B＝公開資料；C＝自己的影片；synthetic＝合成資料（只試流程）")
    ap.add_argument("--data", required=True, help="資料集的 data.yaml")
    ap.add_argument("--weights", default=None, help=f"從哪個權重開始（預設 {BASE_WEIGHTS}；階段 C 建議給階段 B 的 best.pt）")
    ap.add_argument("--epochs", type=int, default=None, help="最多訓練幾輪")
    ap.add_argument("--patience", type=int, default=None, help="驗證分數連續幾輪沒進步就提早停（0＝不提早停）")
    ap.add_argument("--batch", type=int, default=16, help="一次看幾張圖（記憶體不夠就調小）")
    ap.add_argument("--imgsz", type=int, default=640, help="訓練用的影像大小（長邊）")
    ap.add_argument("--device", default="auto", help="auto、cpu、0（第一張 GPU）")
    ap.add_argument("--workers", type=int, default=None, help="讀資料用幾個背景程序（預設：GPU 8、CPU 2）")
    ap.add_argument("--fraction", type=float, default=1.0, help="只用訓練資料的一部分（試流程用，例如 0.2）")
    ap.add_argument("--freeze", type=int, default=None, help="凍結前幾層不訓練（自己的資料很少時可以試 10）")
    ap.add_argument("--name", default=None, help="結果資料夾的名稱（預設依階段）")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    data = Path(args.data)
    if not data.exists():
        print(f"[X] 找不到 {data}")
        return 1
    try:
        import torch  # noqa: F401
        from ultralytics import YOLO
        import ultralytics
    except ImportError as err:
        print(f"[X] 缺少套件：{err.name}。請先執行：python -m pip install -r training/requirements.txt")
        return 1

    d = STAGE_DEFAULTS[args.stage]
    epochs = args.epochs if args.epochs is not None else d["epochs"]
    patience = args.patience if args.patience is not None else d["patience"]
    name = args.name or d["name"]
    device, device_note = pick_device(args.device)
    workers = args.workers if args.workers is not None else (8 if device != "cpu" else 2)
    weights = args.weights or find_base_weights(BASE_WEIGHTS)
    if args.weights and not Path(args.weights).exists():
        print(f"[X] 找不到權重檔 {args.weights}")
        return 1
    if args.stage == "C" and not args.weights:
        print("[!] 階段 C 沒有指定 --weights，會從官方預訓練權重開始，而不是接著階段 B 訓練。")

    manifest_path = data.parent / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    if manifest.get("synthetic") and args.stage != "synthetic":
        print("[X] 這份資料全部是合成的，只能用 --stage synthetic（合成資料訓練出來的模型不能當成階段 B 或 C）。")
        return 1

    print(f"Ultralytics {ultralytics.__version__}；裝置：{device_note}")
    print(f"資料：{data}；起始權重：{weights}；最多 {epochs} 輪；影像大小 {args.imgsz}；batch {args.batch}")

    project = ROOT / "runs" / "arclog"
    t0 = time.time()
    model = YOLO(weights)
    results = model.train(
        data=str(data.resolve()),
        epochs=epochs,
        patience=patience if patience > 0 else epochs + 1,
        batch=args.batch,
        imgsz=args.imgsz,
        device=device,
        workers=workers,
        project=str(project),
        name=name,
        exist_ok=True,
        seed=args.seed,
        fraction=args.fraction,
        freeze=args.freeze,
        fliplr=0.5,     # 左右翻轉：籃框在左邊或右邊都可能
        degrees=3.0,    # 小幅旋轉：腳架不一定完全水平
        close_mosaic=min(10, max(1, epochs // 5)),  # 最後幾輪關掉拼貼增強，讓模型看接近實際的畫面
        plots=True,
    )
    run_dir = Path(getattr(results, "save_dir", project / name))
    best = run_dir / "weights" / "best.pt"
    if not best.exists():
        best = run_dir / "weights" / "last.pt"
    metrics = {}
    for key, label in (("metrics/precision(B)", "precision"), ("metrics/recall(B)", "recall"), ("metrics/mAP50(B)", "mAP50"), ("metrics/mAP50-95(B)", "mAP50_95")):
        value = getattr(results, "results_dict", {}).get(key)
        if value is not None:
            metrics[label] = round(float(value), 4)
    summary = {
        "stage": args.stage, "name": name, "data": str(data), "weights": str(weights), "epochs": epochs, "imgsz": args.imgsz, "batch": args.batch,
        "device": device, "ultralytics": ultralytics.__version__, "minutes": round((time.time() - t0) / 60, 1), "valMetrics": metrics,
        "synthetic": bool(manifest.get("synthetic")), "dataSplit": manifest.get("split"), "dataSources": [s.get("name") for s in manifest.get("sources", [])],
        "best": str(best),
    }
    (run_dir / "arclog_train.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    print("")
    print(f"[OK] 訓練完成，用了 {summary['minutes']} 分鐘。最好的權重：{best}")
    if metrics:
        print("     驗證組（訓練時用來挑模型的那一組）的分數：" + "、".join(f"{k} {v}" for k, v in metrics.items()))
        print("     這不是最終準確度：要看 training/evaluate.py 在測試影片上的結果。")
    model_id = {"B": "arclog-ball-b-public", "C": "arclog-ball-c-own", "synthetic": "arclog-ball-synth"}[args.stage]
    extra = " --out-dir data/models_synth" if args.stage == "synthetic" else ""
    print("下一步，匯出成網站用的 ONNX：")
    print(f"     python training/export_onnx.py --weights \"{best}\" --id {model_id} --stage {args.stage}{extra}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
