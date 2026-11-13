#!/usr/bin/env python3
"""把「影片＋標註包」轉成 Ultralytics YOLO 的訓練資料。

    python training/build_dataset.py --pairs D:\\arclog_data\\videos --out D:\\arclog_data\\dataset

--pairs 指向一個資料夾，裡面每支影片旁邊放著同名的標註包：
    練投_1108.mov
    練投_1108.arclog.json      ← 在網站上標記後按「匯出標註包」得到的檔案

做的事：
  1. 核對影片是不是標註時用的那個檔案（解析度、幀數）。
  2. 用「時間戳」把標註包裡的幀對到 Python 解出來的幀（不是單純用第幾幀去對）。
  3. 抽出有標註的畫面，寫成 YOLO 格式；類別只有一個：basketball。
     框的大小由籃框比例推算的球直徑決定。
  4. 加入沒有球的負樣本：只用標註包裡使用者確認「畫面上沒有球」的片段。
     （沒標註的幀不能當負樣本：畫面上常常有拿在手上或放在地上的球，當成「沒有球」會教壞模型。）
  5. 以「影片」為單位切成訓練、驗證、測試三組；同一支影片的畫面不會跨組。

輸出：
    <out>/images/{train,val,test}/*.jpg
    <out>/labels/{train,val,test}/*.txt
    <out>/data.yaml         給 Ultralytics 用
    <out>/manifest.json     每張圖的來源（影片、幀號、時間、手點或內插）、切分方式、對齊報告

做完請一定要跑疊圖檢查，用眼睛確認框有落在球上：

    python training/check_overlay.py --dataset <out>

注意：實拍影片和抽出來的畫面含有人像，不可以放進這個公開的 repo。請把 --pairs 和 --out 都放在 repo 以外，
或放在已經被 .gitignore 擋掉的 data/ 底下。
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".avi", ".webm"}


def find_pairs(folder: Path) -> list[tuple[Path, Path]]:
    """找出資料夾裡「影片＋同名 .arclog.json」的組合。"""
    pairs = []
    for bundle in sorted(folder.glob("*.arclog.json")):
        stem = bundle.name[: -len(".arclog.json")]
        video = next((p for p in sorted(folder.iterdir()) if p.is_file() and p.stem == stem and p.suffix.lower() in VIDEO_EXT), None)
        if video is None:
            print(f"  [!] 找不到 {bundle.name} 對應的影片（應該叫 {stem}.mp4 或 {stem}.mov），略過")
            continue
        pairs.append((video, bundle))
    return pairs


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="影片＋標註包 → YOLO 訓練資料", formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pairs", action="append", default=[], help="放影片和標註包的資料夾（可以給很多次）")
    ap.add_argument("--pair", nargs=2, action="append", default=[], metavar=("影片", "標註包"), help="直接指定一組影片和標註包（可以給很多次）")
    ap.add_argument("--out", required=True, help="輸出資料夾")
    ap.add_argument("--val", default="", help="指定放進驗證組的影片（檔名不含副檔名，用逗號分開）")
    ap.add_argument("--test", default="", help="指定放進測試組的影片")
    ap.add_argument("--seed", type=int, default=1, help="沒指定時，依影片名稱和這個數字決定怎麼切")
    ap.add_argument("--include-auto", action="store_true", help="也使用「自動偵測後經使用者接受」的球（預設只用手動標記的）")
    ap.add_argument("--box-scale", type=float, default=1.1, help="標註框相對球直徑的倍數（預設 1.1）")
    ap.add_argument("--neg-ratio", type=float, default=0.3, help="每支影片的負樣本數量上限＝正樣本數 × 這個比例（預設 0.3）")
    ap.add_argument("--max-side", type=int, default=1920, help="畫面長邊超過這個值就縮小（預設 1920）")
    ap.add_argument("--jpeg", type=int, default=92, help="JPEG 品質（預設 92）")
    ap.add_argument("--force", action="store_true", help="影片和標註包對不上時仍然繼續（不建議）")
    ap.add_argument("--clean", action="store_true", help="輸出資料夾已經有東西時先清掉")
    args = ap.parse_args()

    try:
        from PIL import Image

        from arclog.bundle import load_bundle
        from arclog.dataset import align_frames, check_fingerprint, pick_evenly, split_videos, yolo_box
        from arclog.video import iter_frames, probe, read_times
    except ImportError as err:
        print(f"[X] 缺少套件：{err.name}。請先執行：python -m pip install -r requirements.txt")
        return 1

    pairs: list[tuple[Path, Path]] = []
    for folder in args.pairs:
        folder = Path(folder)
        if not folder.is_dir():
            print(f"[X] 找不到資料夾：{folder}")
            return 1
        pairs.extend(find_pairs(folder))
    for video, bundle in args.pair:
        pairs.append((Path(video), Path(bundle)))
    if not pairs:
        print("[X] 沒有找到任何「影片＋標註包」。標註包要和影片同名，副檔名是 .arclog.json。")
        return 1
    names = [v.stem for v, _ in pairs]
    if len(set(names)) != len(names):
        print("[X] 有影片的檔名重複，請改成不一樣的名字。")
        return 1

    out = Path(args.out)
    if out.exists() and any(out.iterdir()):
        if not args.clean:
            print(f"[X] {out} 裡面已經有東西。加 --clean 會先清掉，或換一個輸出資料夾。")
            return 1
        for sub in ("images", "labels"):
            shutil.rmtree(out / sub, ignore_errors=True)
    try:
        split = split_videos(names, val=[n for n in args.val.split(",") if n], test=[n for n in args.test.split(",") if n], seed=args.seed)
    except ValueError as err:
        print(f"[X] {err}")
        return 1
    which = {n: s for s in ("train", "val", "test") for n in split[s]}
    for s in ("train", "val", "test"):
        (out / "images" / s).mkdir(parents=True, exist_ok=True)
        (out / "labels" / s).mkdir(parents=True, exist_ok=True)

    manifest = {
        "format": "arclog-dataset", "version": 1, "classes": ["basketball"],
        "split": {k: split[k] for k in ("train", "val", "test")}, "splitBy": "video",
        "boxScale": args.box_scale, "includeAuto": args.include_auto, "videos": [], "images": [],
    }
    total = {"train": [0, 0], "val": [0, 0], "test": [0, 0]}
    any_synthetic = False
    any_real = False
    failed = False

    for video, bundle_path in pairs:
        name = video.stem
        print(f"{name}（{which[name]}）")
        try:
            bundle = load_bundle(bundle_path)
        except ValueError as err:
            print(f"  [X] {err}")
            failed = True
            continue
        if bundle.get("synthetic"):
            any_synthetic = True
        else:
            any_real = True
        info = probe(video)
        times = read_times(video)
        errors, warnings = check_fingerprint(bundle, info, len(times))
        for w in warnings:
            print(f"  [!] {w}")
        if errors:
            for e in errors:
                print(f"  [X] {e}")
            if not args.force:
                print("      這支影片略過。請用標註時的同一個檔案；確定要硬做可以加 --force。")
                failed = True
                continue

        # 每一幀要畫哪些框
        labels: dict[int, list[dict]] = {}
        used_shots = 0
        for shot in bundle["shots"]:
            if shot.get("source") == "auto" and not args.include_auto:
                continue
            used_shots += 1
            for f in shot["frames"]:
                labels.setdefault(f["f"], []).append({"x": f["x"], "y": f["y"], "src": f["src"], "shot": shot.get("id")})
        neg_candidates = sorted({f for r in bundle.get("noBall", []) for f in range(r["from"], r["to"] + 1)} - set(labels))
        negatives = pick_evenly(neg_candidates, int(round(len(labels) * args.neg_ratio)))

        needed = sorted(set(labels) | set(negatives))
        al = align_frames(bundle["frameTimes"], times, needed)
        if len(al["dropped"]) > 0.05 * max(len(needed), 1) and not args.force:
            print(f"  [X] {len(needed)} 幀裡有 {len(al['dropped'])} 幀的時間戳對不上：這支影片和標註時瀏覽器看到的不是同一串畫面，略過。")
            print("      常見原因：標註時用的是手機轉檔後的版本，這裡拿的卻是原始檔。")
            failed = True
            continue
        if al["dropped"]:
            print(f"  [!] 有 {len(al['dropped'])} 幀的時間戳對不上，已略過（寧可少幾筆也不要標錯位置）")
        mode = "幀號直接對應" if al["mode"] == "identity" else "逐幀比對時間戳"
        print(f"  對齊方式：{mode}；時間軸相差 {al['offset'] * 1000:.1f} 毫秒；對齊後最大誤差 {al['maxError'] * 1000:.2f} 毫秒")

        by_video_frame: dict[int, int] = {v: k for k, v in al["map"].items()}
        diameter = float(bundle["ball"]["diameterPx"])
        bw, bh = int(bundle["video"]["width"]), int(bundle["video"]["height"])
        scale = min(1.0, args.max_side / max(info["width"], info["height"]))
        ow, oh = int(round(info["width"] * scale)), int(round(info["height"] * scale))
        pos = neg = 0
        split_name = which[name]
        for fr in iter_frames(video):
            bf = by_video_frame.get(fr.index)
            if bf is None:
                continue
            stem = f"{name}_{bf:06d}"
            lines = []
            srcs = []
            for lab in labels.get(bf, []):
                box = yolo_box(lab["x"], lab["y"], diameter, bw, bh, args.box_scale)
                if box is None:
                    continue
                lines.append("0 " + " ".join(f"{v:.6f}" for v in box))
                srcs.append(lab["src"])
            if bf in labels and not lines:
                continue  # 球完全在畫面外
            rgb = fr.to_rgb(size=(ow, oh)) if scale < 1.0 else fr.to_rgb()
            Image.fromarray(rgb).save(out / "images" / split_name / f"{stem}.jpg", quality=args.jpeg)
            (out / "labels" / split_name / f"{stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
            manifest["images"].append({
                "file": f"{split_name}/{stem}.jpg", "video": name, "split": split_name, "bundleFrame": bf, "videoFrame": fr.index,
                "time": round(fr.time, 6), "boxes": len(lines), "src": srcs,
            })
            if lines:
                pos += 1
            else:
                neg += 1
        total[split_name][0] += pos
        total[split_name][1] += neg
        manifest["videos"].append({
            "name": name, "video": video.name, "bundle": bundle_path.name, "split": split_name, "synthetic": bool(bundle.get("synthetic")),
            "width": info["width"], "height": info["height"], "frames": len(times), "shots": used_shots, "positives": pos, "negatives": neg,
            "ballDiameterPx": diameter, "hoop": bundle["hoop"], "align": {k: al[k] for k in ("mode", "offset", "maxError", "tolerance")},
            "dropped": len(al["dropped"]), "videoPath": str(video.resolve()), "bundlePath": str(bundle_path.resolve()),
        })
        print(f"  {used_shots} 球 → {pos} 張有球的畫面、{neg} 張沒有球的畫面" + ("" if neg else "（標註包裡沒有標「沒有球」的片段，所以沒有負樣本）"))

    if not manifest["images"]:
        print("[X] 沒有產生任何畫面。")
        return 1
    manifest["synthetic"] = any_synthetic and not any_real
    for w in split["warnings"]:
        print(f"[!] {w}")
    val_dir = "images/val" if total["val"][0] + total["val"][1] else "images/train"
    if val_dir == "images/train":
        print("[!] 驗證組是空的，data.yaml 的 val 先指向訓練組。這樣的驗證分數沒有參考價值。")
    yaml = [
        "# 由 training/build_dataset.py 產生。訓練、驗證、測試是以「影片」為單位切分的。",
        f"path: {out.resolve().as_posix()}",
        "train: images/train",
        f"val: {val_dir}",
    ]
    if total["test"][0] + total["test"][1]:
        yaml.append("test: images/test")
    yaml += ["names:", "  0: basketball", ""]
    (out / "data.yaml").write_text("\n".join(yaml), encoding="utf-8")
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    print("")
    print("  組別   影片數  有球  沒有球")
    for s, label in (("train", "訓練"), ("val", "驗證"), ("test", "測試")):
        print(f"  {label}   {len(split[s]):5d} {total[s][0]:5d} {total[s][1]:6d}   {', '.join(split[s])}")
    if manifest["synthetic"]:
        print("（全部是合成資料：只能用來確認流程，不代表真實準確度）")
    print(f"[OK] 已寫入 {out}")
    print(f"     下一步請用眼睛檢查標註框：python training/check_overlay.py --dataset \"{out}\"")
    return 1 if failed and not args.force else 0


if __name__ == "__main__":
    sys.exit(main())
