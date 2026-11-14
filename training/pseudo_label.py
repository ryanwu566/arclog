#!/usr/bin/env python3
"""補標：替「來源資料集沒有標某個類別」的影像，用模型補上那個類別的框（例如 Arizona 的資料集沒有籃板）。

    python training/pseudo_label.py --dataset datasets/public3 --weights runs/arclog/stage_b3_board/weights/best.pt --fill backboard

為什麼要補：資料集 A 有球和籃框、沒有籃板；資料集 B 有籃板。直接合在一起訓練，模型在 A 的影像裡看到沒有標的籃板，
會學到「籃板是背景」。所以先用有籃板的資料訓練一個模型，再用它替 A 的影像補上**高信心**的籃板框，最後合起來訓練。

- 只處理 manifest.json 裡 `missing` 含有這個類別的影像；其他影像一個框都不動。
- 補上的框另外記在 pseudo_labels.json（檔名、類別、框、信心），不和人工標註混在一起，事後可以檢查或撤銷（--undo）。
- 每張影像同一類最多補 max-per-image 個（籃板通常只有一兩個）。
- 做完會輸出 preview_pseudo.jpg（抽樣疊圖），請打開看補的框是不是真的套在籃板上。

補標的品質決定了最後模型的籃板偵測好不好；它不是人工標註，**不能當成準確度的根據**。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

CLASSES = ["ball", "rim", "backboard"]


def fill_missing(dataset: Path, predict, fill: list[str], conf: float = 0.5, max_per_image: int = 2) -> dict:
    """補標的主體（和模型無關，測試用假的 predict）。

    predict(影像路徑) → [(類別名稱, cx, cy, w, h, 信心)]，座標是 0 到 1 的相對值。
    回傳 {'images': 處理幾張, 'added': {類別: 補了幾個框}, 'records': [...]}。
    """
    dataset = Path(dataset)
    manifest = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    classes = manifest.get("classes") or CLASSES
    want = [c for c in fill if c in classes]
    records = []
    added = {c: 0 for c in want}
    n = 0
    for im in manifest["images"]:
        miss = [c for c in im.get("missing", []) if c in want]
        if not miss:
            continue
        img = dataset / "images" / im["file"]
        lab = dataset / "labels" / (str(Path(im["file"]).with_suffix(".txt")))
        if not img.exists():
            continue
        n += 1
        preds = [p for p in predict(img) if p[0] in miss and p[5] >= conf]
        preds.sort(key=lambda p: -p[5])
        lines = []
        per = {c: 0 for c in miss}
        for name, cx, cy, w, h, c in preds:
            if per[name] >= max_per_image:
                continue
            per[name] += 1
            ci = classes.index(name)
            lines.append(f"{ci} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n")
            records.append({"file": im["file"], "cls": name, "box": [cx, cy, w, h], "conf": round(float(c), 4)})
            added[name] += 1
        if lines:
            old = lab.read_text(encoding="utf-8") if lab.exists() else ""
            if old and not old.endswith("\n"):
                old += "\n"
            lab.write_bytes((old + "".join(lines)).encode("utf-8"))
            im["boxes"] = im.get("boxes", 0) + len(lines)
            im["src"] = im.get("src", []) + ["pseudo"] * len(lines)
        # 這張影像的這些類別已經處理過（補到框或確定沒有），不再算 missing
        im["missing"] = [c for c in im.get("missing", []) if c not in miss]
        im.setdefault("pseudoFilled", []).extend(miss)
    (dataset / "manifest.json").write_bytes(json.dumps(manifest, ensure_ascii=False).encode("utf-8"))
    prev = []
    pf = dataset / "pseudo_labels.json"
    if pf.exists():
        prev = json.loads(pf.read_text(encoding="utf-8")).get("records", [])
    pf.write_bytes(json.dumps({"conf": conf, "records": prev + records}, ensure_ascii=False, indent=1).encode("utf-8"))
    return {"images": n, "added": added, "records": records}


def undo(dataset: Path) -> int:
    """撤銷補標：把 pseudo_labels.json 記下的框從標註檔刪掉。回傳刪了幾個。"""
    dataset = Path(dataset)
    pf = dataset / "pseudo_labels.json"
    if not pf.exists():
        return 0
    recs = json.loads(pf.read_text(encoding="utf-8"))["records"]
    manifest = json.loads((dataset / "manifest.json").read_text(encoding="utf-8"))
    classes = manifest.get("classes") or CLASSES
    by_file: dict = {}
    for r in recs:
        by_file.setdefault(r["file"], []).append(f"{classes.index(r['cls'])} {r['box'][0]:.6f} {r['box'][1]:.6f} {r['box'][2]:.6f} {r['box'][3]:.6f}")
    removed = 0
    for f, lines in by_file.items():
        lab = dataset / "labels" / str(Path(f).with_suffix(".txt"))
        if not lab.exists():
            continue
        keep = []
        drop = list(lines)
        for line in lab.read_text(encoding="utf-8").splitlines():
            if line.strip() in drop:
                drop.remove(line.strip())
                removed += 1
            else:
                keep.append(line)
        lab.write_bytes(("\n".join(keep) + ("\n" if keep else "")).encode("utf-8"))
    for im in manifest["images"]:
        filled = im.pop("pseudoFilled", [])
        if filled:
            im["missing"] = sorted(set(im.get("missing", []) + filled), key=CLASSES.index)
            n = sum(1 for s in im.get("src", []) if s == "pseudo")
            im["src"] = [s for s in im.get("src", []) if s != "pseudo"]
            im["boxes"] = max(0, im.get("boxes", 0) - n)
    (dataset / "manifest.json").write_bytes(json.dumps(manifest, ensure_ascii=False).encode("utf-8"))
    pf.unlink()
    return removed


def ultralytics_predictor(weights: str, imgsz=(384, 640), device=None):
    """用 Ultralytics 的模型當 predict。模型的類別名稱用 CLASS_ALIASES 對應到 ball／rim／backboard。"""
    from ultralytics import YOLO

    from arclog.detector import resolve_classes

    model = YOLO(weights)
    found = resolve_classes(model.names)
    to_name = {k: name for name, ks in found.items() for k in ks}

    def predict(path: Path):
        res = model.predict(str(path), imgsz=list(imgsz), conf=0.05, verbose=False, device=device)[0]
        out = []
        for b in res.boxes:
            name = to_name.get(int(b.cls))
            if not name:
                continue
            cx, cy, w, h = (float(v) for v in b.xywhn[0])
            out.append((name, cx, cy, w, h, float(b.conf)))
        return out

    return predict


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dataset", required=True, help="prepare_public.py --classes ball,rim,backboard 的輸出資料夾")
    ap.add_argument("--weights", help="用來補標的模型（.pt）")
    ap.add_argument("--fill", default="backboard", help="要補的類別，逗號分隔（預設 backboard）")
    ap.add_argument("--conf", type=float, default=0.5, help="只補信心至少這麼高的框（預設 0.5；寧可少補，不要補錯）")
    ap.add_argument("--max-per-image", type=int, default=2)
    ap.add_argument("--undo", action="store_true", help="撤銷之前的補標")
    args = ap.parse_args()
    ds = Path(args.dataset)
    if args.undo:
        print(f"[OK] 撤銷補標：刪了 {undo(ds)} 個框")
        return 0
    if not args.weights:
        print("[X] 需要 --weights")
        return 1
    res = fill_missing(ds, ultralytics_predictor(args.weights), [c.strip() for c in args.fill.split(",")], args.conf, args.max_per_image)
    print(f"[OK] 看了 {res['images']} 張缺標的影像，補了 {res['added']} 個框（記在 pseudo_labels.json）")
    import subprocess

    subprocess.call([sys.executable, str(ROOT / "training" / "check_overlay.py"), "--dataset", str(ds), "--out-name", "preview_pseudo"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
