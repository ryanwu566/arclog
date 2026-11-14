#!/usr/bin/env python3
"""評估：在同一批測試影片上，比較各個模型跑「自動流程」的表現。

    python training/evaluate.py --dataset D:\\arclog_data\\dataset --write-doc

--dataset 是 build_dataset.py 的輸出資料夾。預設只用「測試組」的影片（--split test）：
這些影片的畫面沒有被拿去訓練，所以成績才有參考價值。切分是以影片為單位，同一支影片不會跨組。
每支測試影片都要有完整的標註包（整支影片的每一球都標過），不然沒標到的球會被算成「多抓」。

量兩類指標：
  偵測指標：飛行中的球的 recall（有標記的幀裡找到球的比例）和 precision（框出來的有多少真的是那顆球）
  最終指標：自動流程算出的入框角度和人工標記相差幾度（平均絕對誤差 MAE）、進球判定正確率、
            漏掉幾球、多抓幾球

預設比較 models/manifest.json 裡登記的所有模型（階段 A、B、C）；也可以用 --models 指定代號或 .onnx 檔。
加 --write-doc 會把結果表寫進 docs/EVAL.md；還沒有的模型或資料，表格裡會寫「待實測」，不會填數字。

實拍影片的檔名可能含有人名，所以寫進文件的只有支數和球數，不會寫檔名。

合成資料（只用來確認流程）要另外指定：

    python training/evaluate.py --dataset data/dataset_synth --truth data/synth --section synthetic --models arclog-ball-a-coco,data/models_synth/arclog-ball-synth.onnx --write-doc
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

STAGE_ROWS = [("A", "階段 A：COCO 預訓練"), ("B", "階段 B：公開資料訓練"), ("C", "階段 C：自有資料微調")]


def file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_pairs(args) -> list[dict]:
    """決定要評估哪些影片。回傳 [{'name', 'video', 'bundle'}]。"""
    items = []
    if args.dataset:
        manifest = json.loads((Path(args.dataset) / "manifest.json").read_text(encoding="utf-8"))
        for v in manifest["videos"]:
            if args.split != "all" and v["split"] != args.split:
                continue
            items.append({"name": v["name"], "video": Path(v["videoPath"]), "bundle": Path(v["bundlePath"])})
    for folder in args.pairs:
        folder = Path(folder)
        for bundle in sorted(folder.glob("*.arclog.json")):
            stem = bundle.name[: -len(".arclog.json")]
            video = next((p for p in sorted(folder.iterdir()) if p.is_file() and p.stem == stem and p.suffix.lower() in {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"}), None)
            if video is not None:
                items.append({"name": stem, "video": video, "bundle": bundle})
    return items


def evaluate_video(item: dict, info: dict, detector, args, cache_dir: Path, truth_dir: Path | None) -> dict:
    from arclog.bundle import load_bundle
    from arclog.constants import DRAG_K_RIM
    from arclog.dataset import align_frames
    from arclog.evaluation import detection_metrics, shot_metrics
    from arclog.geometry import make_hoop_frame
    from arclog.pipeline import detect_video
    from arclog.track import find_shots

    bundle = load_bundle(item["bundle"])
    stat = item["video"].stat()
    key = hashlib.sha1(f"{item['video'].resolve()}|{stat.st_size}|{int(stat.st_mtime)}|{info['sha']}|{info['conf']}|{args.density}".encode("utf-8")).hexdigest()[:16]
    cache = cache_dir / f"{item['name']}__{info['id']}__{key}.json"
    if cache.exists() and not args.no_cache:
        det = json.loads(cache.read_text(encoding="utf-8"))
    else:
        last = [time.time()]

        def progress(done, total, fps):
            if time.time() - last[0] >= 15:
                last[0] = time.time()
                print(f"      {done}/{total or '?'} 幀，每秒 {fps:.0f} 幀", flush=True)

        det = detect_video(item["video"], detector, density=args.density, progress=progress)
        cache.write_text(json.dumps(det, default=float), encoding="utf-8")

    # 標註包的幀號 → 這裡解出來的幀號（用時間戳對齊）
    al = align_frames(bundle["frameTimes"], det["times"])
    fmap = al["map"]
    gt: dict[int, tuple[float, float]] = {}
    manual = []
    for shot in bundle["shots"]:
        if shot.get("source") == "auto" and not args.include_auto:
            continue
        frames = [f for f in shot["frames"] if f["f"] in fmap]
        for f in frames:
            gt[fmap[f["f"]]] = (f["x"], f["y"])
        if frames:
            manual.append({"id": shot.get("id"), "t0": frames[0]["t"] + al["offset"], "t1": frames[-1]["t"] + al["offset"],
                           "angle": float(shot["angleDeg"]), "made": bool(shot["made"])})
    no_ball = {fmap[f] for r in bundle.get("noBall", []) for f in range(r["from"], r["to"] + 1) if f in fmap} - set(gt)
    processed = set(range(0, len(det["times"]), det["stride"]))
    ball_px = float(bundle["ball"]["diameterPx"])
    det_m = detection_metrics(det["detections"], gt, no_ball, processed, ball_px, radius=args.match_radius)

    hoop = make_hoop_frame(bundle["hoop"]["front"], bundle["hoop"]["back"], bundle["hoop"].get("level", "rim"),
                           width=bundle["video"]["width"], height=bundle["video"]["height"], focal=bundle["hoop"].get("focal"),
                           vertical=bundle["hoop"].get("vertical"))
    res = find_shots(det["detections"], hoop, dragK=DRAG_K_RIM)
    auto = [{"tCross": s["tCross"], "angle": s["angleRaw"], "made": s["made"]} for s in res["shots"]]
    truth = None
    if truth_dir is not None:
        tp = truth_dir / f"{item['name']}.truth.json"
        if tp.exists():
            t = json.loads(tp.read_text(encoding="utf-8"))
            truth = {s["shot"]: {"angle": s["angleDeg"], "made": s["made"]} for s in t["shots"]}
    shot_m = shot_metrics(manual, auto, truth)
    return {"name": item["name"], "synthetic": bool(bundle.get("synthetic")), "frames": len(det["times"]), "stride": det["stride"],
            "detections": len(det["detections"]), "align": al["mode"], "dropped": len(al["dropped"]), "detection": det_m, "shots": shot_m,
            "tracker": res["stats"]}


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="在同一批測試影片上比較各個模型", formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default=None, help="build_dataset.py 的輸出資料夾（用裡面記的影片和切分）")
    ap.add_argument("--split", default="test", choices=["train", "val", "test", "all"], help="用哪一組影片（預設 test）")
    ap.add_argument("--pairs", action="append", default=[], help="或直接給放「影片＋標註包」的資料夾，裡面全部當測試影片")
    ap.add_argument("--models", default=None, help="要比較的模型：代號或 .onnx 路徑，用逗號分開（預設：manifest 裡全部）")
    ap.add_argument("--truth", default=None, help="合成資料的真值資料夾（*.truth.json）")
    ap.add_argument("--section", choices=["real", "synthetic"], default="real", help="結果寫進 docs/EVAL.md 的哪一段（預設 real）")
    ap.add_argument("--write-doc", nargs="?", const=str(ROOT / "docs" / "EVAL.md"), default=None, help="把結果表寫進文件（預設 docs/EVAL.md）")
    ap.add_argument("--out", default=None, help="詳細結果和偵測快取放哪裡（預設：資料集資料夾裡的 eval/）")
    ap.add_argument("--density", choices=["normal", "fine"], default="normal")
    ap.add_argument("--match-radius", type=float, default=0.5, help="偵測中心離標記多近算找到，單位是球的直徑（預設 0.5）")
    ap.add_argument("--include-auto", action="store_true", help="標註包裡「自動偵測後接受」的球也當成標準答案")
    ap.add_argument("--no-cache", action="store_true", help="不要用之前存下來的偵測結果")
    args = ap.parse_args()

    from arclog.detector import BallDetector, find_model, load_manifest
    from arclog.evaluation import combine, replace_section, table

    items = load_pairs(args)
    synthetic_flags = []
    for it in items:
        try:
            synthetic_flags.append(bool(json.loads(it["bundle"].read_text(encoding="utf-8-sig")).get("synthetic")))
        except (OSError, ValueError):
            synthetic_flags.append(False)
    if items and args.section == "real" and any(synthetic_flags):
        print("[X] 測試影片裡有合成資料，不能寫進「實拍」的結果。請加 --section synthetic。")
        return 1
    if items and args.section == "synthetic" and not all(synthetic_flags):
        print("[X] --section synthetic 只能用合成影片。")
        return 1
    for it in items:
        if not it["video"].exists() or not it["bundle"].exists():
            print(f"[X] 找不到 {it['video']} 或它的標註包（資料集建好之後影片被移動了嗎？）")
            return 1

    # 要比較哪些模型
    if args.models:
        wanted = [m.strip() for m in args.models.split(",") if m.strip()]
    else:
        wanted = [m["id"] for m in load_manifest().get("models", []) if m.get("stage") in ("A", "B", "C")]
    infos = []
    for w in wanted:
        try:
            info = find_model(w)
        except (FileNotFoundError, OSError) as err:
            print(f"[X] {err}")
            return 1
        info["conf"] = info["conf"] if info["conf"] is not None else 0.15
        info["sha"] = file_sha(info["path"])[:16]
        infos.append(info)

    out_dir = Path(args.out) if args.out else (Path(args.dataset) / "eval" if args.dataset else ROOT / "data" / "eval")
    results: dict[str, dict] = {}
    if items:
        cache_dir = out_dir / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        truth_dir = Path(args.truth) if args.truth else None
        print(f"測試影片 {len(items)} 支；模型 {len(infos)} 個")
        for info in infos:
            print(f"模型 {info['id']}（信心門檻 {info['conf']}）")
            detector = BallDetector(info["path"], class_index=info["classIndex"], conf=info["conf"])
            per_video = []
            for it in items:
                r = evaluate_video(it, info, detector, args, cache_dir, truth_dir)
                per_video.append(r)
                d, s = r["detection"], r["shots"]
                rec = f"{d['recall'] * 100:.0f}%" if d["recall"] is not None else "—"
                print(f"   {r['name']}：recall {rec}；人工 {s['manualShots']} 球、自動 {s['autoShots']} 球、配對 {s['matched']}、漏 {s['missed']}、多 {s['extra']}")
            results[info["id"]] = {"info": {k: (str(v) if isinstance(v, Path) else v) for k, v in info.items()}, "total": combine(per_video), "videos": per_video}
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"eval_{args.section}.json").write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    elif args.dataset:
        print(f"資料集的「{args.split}」組裡沒有影片（影片少於 3 支時不會有獨立的測試組）：表格全部寫「待實測」。")
    else:
        print("沒有指定測試影片：表格全部寫「待實測」。")

    # 排成表格
    if args.section == "real":
        rows = []
        for stage, label in STAGE_ROWS:
            hit = next((r for r in results.values() if r["info"].get("stage") == stage), None)
            name = f"{label}（`{hit['info']['id']}`）" if hit else label
            rows.append({"label": name, "result": hit["total"] if hit else None})
        for r in results.values():  # 不在 A／B／C 裡的模型（例如直接給 .onnx 檔）也列出來
            if r["info"].get("stage") not in ("A", "B", "C"):
                rows.append({"label": f"`{r['info']['id']}`", "result": r["total"]})
        md = table(rows)
    else:
        rows = [{"label": f"{r['info'].get('label') or r['info']['id']}（`{r['info']['id']}`）", "result": r["total"]} for r in results.values()]
        md = table(rows, with_truth=True)
    n_shots = next((r["total"]["manualShots"] for r in results.values()), 0)
    if items:
        note = f"測試影片 {len(items)} 支、共 {n_shots} 球；{date.today().isoformat()} 用 `training/evaluate.py` 產生。"
    else:
        note = "還沒有實拍的測試影片，所以整張表都是「待實測」。"
    print("")
    print(md)
    print(note)
    if results:
        print(f"詳細結果：{out_dir / f'eval_{args.section}.json'}")

    if args.write_doc:
        doc = Path(args.write_doc)
        if not doc.exists():
            print(f"[X] 找不到 {doc}")
            return 1
        name = "REAL" if args.section == "real" else "SYNTH"
        try:
            text = replace_section(doc.read_text(encoding="utf-8"), name, md + "\n\n" + note)
        except ValueError as err:
            print(f"[X] {err}")
            return 1
        doc.write_text(text, encoding="utf-8", newline="\n")
        print(f"[OK] 已更新 {doc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
