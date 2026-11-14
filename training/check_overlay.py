#!/usr/bin/env python3
"""疊圖檢查：隨機抽一些訓練畫面，把標註框畫上去拼成一張大圖，讓人用眼睛確認框有沒有落在球上。

    python training/check_overlay.py --dataset D:\\arclog_data\\dataset

輸出（放在資料集資料夾裡）：
    overlay_check.jpg       抽樣的畫面，每格是「以標註框為中心放大」的局部，框應該剛好套住球
    overlay_negatives.jpg   抽樣的負樣本（整張畫面縮小）：裡面不應該看得到籃球

每一格左上角的字：影片名稱、幀號、M＝手點／I＝內插／A＝自動偵測。格子裡全黑的部分是畫面以外。
如果框系統性地落在球的前面或後面（差一兩幀），代表瀏覽器和 Python 的幀沒有對齊，
請不要拿這份資料去訓練，先回報問題。

合成資料另外有「真值」可以比對，加 --truth 會直接算出標註和真實球心差幾個像素。
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

TILE = 224


def multi_sheet(root: Path, manifest: dict, positives: list, rng, args) -> int:
    """三類別資料集的拼圖：整張畫面縮小，綠＝球、橘＝籃框、藍＝籃板；補標的框畫虛線。"""
    from PIL import Image, ImageDraw

    colors = [(0, 255, 0), (255, 140, 0), (0, 200, 255)]
    sample = rng.sample(positives, min(args.count, len(positives)))
    cols, tw = 4, 384
    with Image.open(root / "images" / sample[0]["file"]) as first:
        th = int(tw * first.size[1] / first.size[0])
    sheet = Image.new("RGB", (cols * tw, ((len(sample) + cols - 1) // cols) * th), (30, 30, 30))
    for i, im in enumerate(sample):
        img = Image.open(root / "images" / im["file"]).convert("RGB")
        w, h = img.size
        lines = (root / "labels" / im["file"]).with_suffix(".txt").read_text(encoding="utf-8").split("\n")
        img = img.resize((tw, th), Image.BILINEAR)
        k = tw / w
        d = ImageDraw.Draw(img)
        src = im.get("src", [])
        j = 0
        for line in lines:
            parts = line.split()
            if len(parts) != 5:
                continue
            c = int(float(parts[0]))
            cx, cy, bw, bh = (float(v) for v in parts[1:])
            x0, y0, x1, y1 = (cx - bw / 2) * w * k, (cy - bh / 2) * h * k, (cx + bw / 2) * w * k, (cy + bh / 2) * h * k
            col = colors[c % len(colors)]
            if j < len(src) and src[j] == "pseudo":
                for t in range(int(x0), int(x1), 6):
                    d.line([(t, y0), (min(t + 3, x1), y0)], fill=col, width=2)
                    d.line([(t, y1), (min(t + 3, x1), y1)], fill=col, width=2)
                for t in range(int(y0), int(y1), 6):
                    d.line([(x0, t), (x0, min(t + 3, y1))], fill=col, width=2)
                    d.line([(x1, t), (x1, min(t + 3, y1))], fill=col, width=2)
            else:
                d.rectangle([x0, y0, x1, y1], outline=col, width=2)
            j += 1
        d.rectangle([0, 0, tw, 15], fill=(0, 0, 0))
        d.text((3, 2), f"{im['video'][:20]} missing:{','.join(im.get('missing', [])) or '-'}", fill=(255, 255, 255))
        sheet.paste(img, ((i % cols) * tw, (i // cols) * th))
    out_pos = root / f"{args.out_name}_check.jpg"
    sheet.save(out_pos, quality=90)
    print(f"[OK] {out_pos}（{len(sample)} 張；綠＝球、橘＝籃框、藍＝籃板；虛線是補標的框）")
    print("     請確認：框有套在對的東西上、球是圓的；籃框的框是只框鐵圈還是連球網一起框（決定網站 manifest 的 rimBox 設定）。")
    return 0


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="隨機抽樣，把標註框疊在畫面上拼成一張圖")
    ap.add_argument("--dataset", required=True, help="build_dataset.py 的輸出資料夾")
    ap.add_argument("--count", type=int, default=48, help="抽幾張有球的畫面（預設 48）")
    ap.add_argument("--negatives", type=int, default=12, help="抽幾張負樣本（預設 12）")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--out-name", default="overlay", help="輸出檔名的開頭（預設 overlay → overlay_check.jpg、overlay_negatives.jpg）")
    ap.add_argument("--zoom", type=float, default=5.0, help="每格顯示的範圍是標註框的幾倍（預設 5）")
    ap.add_argument("--truth", default=None, help="合成資料的真值資料夾（放 *.truth.json 的地方）；有給就計算標註和真值的差距")
    ap.add_argument("--max-error", type=float, default=None, help="和真值比較時，平均誤差超過這個像素數就回報失敗（給自動測試用）")
    args = ap.parse_args()

    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("[X] 缺少套件 pillow。請先執行：python -m pip install -r requirements.txt")
        return 1

    root = Path(args.dataset)
    manifest_path = root / "manifest.json"
    if not manifest_path.exists():
        print(f"[X] {root} 不是 build_dataset.py 的輸出（找不到 manifest.json）")
        return 1
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    rng = random.Random(args.seed)
    positives = [im for im in manifest["images"] if im["boxes"]]
    negatives = [im for im in manifest["images"] if not im["boxes"]]
    if not positives:
        print("[X] 資料集裡沒有任何有球的畫面")
        return 1

    def read_boxes(im: dict, w: int, h: int) -> list[tuple[float, float, float, float]]:
        txt = (root / "labels" / im["file"]).with_suffix(".txt").read_text(encoding="utf-8").split("\n")
        out = []
        for line in txt:
            parts = line.split()
            if len(parts) == 5:
                cx, cy, bw, bh = (float(v) for v in parts[1:])
                out.append((cx * w, cy * h, bw * w, bh * h))
        return out

    # 三類別資料集（球、籃框、籃板）：整張畫面縮小，每一類不同顏色，補標的框（pseudo）畫虛線
    classes = manifest.get("classes") or ["basketball"]
    if len(classes) > 1:
        return multi_sheet(root, manifest, positives, rng, args)

    # ── 有球的畫面：以框為中心放大 ──
    sample = rng.sample(positives, min(args.count, len(positives)))
    sample.sort(key=lambda im: (im["video"], im["bundleFrame"]))
    cols = 8
    rows = (len(sample) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * TILE, rows * TILE), (30, 30, 30))
    for i, im in enumerate(sample):
        img = Image.open(root / "images" / im["file"]).convert("RGB")
        w, h = img.size
        boxes = read_boxes(im, w, h)
        cx, cy, bw, bh = boxes[0]
        half = max(bw, bh) * args.zoom / 2
        crop = img.crop((int(cx - half), int(cy - half), int(cx + half), int(cy + half))).resize((TILE, TILE), Image.BILINEAR)
        k = TILE / (2 * half)
        d = ImageDraw.Draw(crop)
        for bx, by, bbw, bbh in boxes:
            x0 = (bx - bbw / 2 - (cx - half)) * k
            y0 = (by - bbh / 2 - (cy - half)) * k
            d.rectangle([x0, y0, x0 + bbw * k, y0 + bbh * k], outline=(0, 255, 0), width=2)
            d.line([(bx - (cx - half)) * k - 4, (by - (cy - half)) * k, (bx - (cx - half)) * k + 4, (by - (cy - half)) * k], fill=(0, 255, 0))
            d.line([(bx - (cx - half)) * k, (by - (cy - half)) * k - 4, (bx - (cx - half)) * k, (by - (cy - half)) * k + 4], fill=(0, 255, 0))
        tag = "".join({"manual": "M", "interp": "I", "auto": "A", "public": "P"}.get(s, "?") for s in im["src"])
        text = f"{im['video'][:14]} {tag}" if manifest.get("public") else f"{im['video'][:14]} f{im['bundleFrame']} {tag}"
        d.rectangle([0, 0, TILE, 15], fill=(0, 0, 0))
        d.text((3, 2), text, fill=(255, 255, 255))
        sheet.paste(crop, ((i % cols) * TILE, (i // cols) * TILE))
    out_pos = root / f"{args.out_name}_check.jpg"
    sheet.save(out_pos, quality=90)
    print(f"[OK] {out_pos}（{len(sample)} 張；綠框應該剛好套住球，十字是球心）")

    # ── 負樣本：整張畫面縮小 ──
    if negatives:
        sample_n = rng.sample(negatives, min(args.negatives, len(negatives)))
        cols_n = 4
        tw = 384
        first = Image.open(root / "images" / sample_n[0]["file"])
        th = int(tw * first.size[1] / first.size[0])
        rows_n = (len(sample_n) + cols_n - 1) // cols_n
        sheet_n = Image.new("RGB", (cols_n * tw, rows_n * th), (30, 30, 30))
        for i, im in enumerate(sample_n):
            img = Image.open(root / "images" / im["file"]).convert("RGB").resize((tw, th), Image.BILINEAR)
            d = ImageDraw.Draw(img)
            d.rectangle([0, 0, tw, 15], fill=(0, 0, 0))
            d.text((3, 2), f"{im['video'][:20]} f{im['bundleFrame']} (no ball)", fill=(255, 255, 255))
            sheet_n.paste(img, ((i % cols_n) * tw, (i // cols_n) * th))
        out_neg = root / f"{args.out_name}_negatives.jpg"
        sheet_n.save(out_neg, quality=88)
        print(f"[OK] {out_neg}（{len(sample_n)} 張；這些畫面裡不應該看得到籃球）")
        if manifest.get("synthetic"):
            print("     合成畫面裡牆上和地上的純色圓形是刻意放的干擾物（沒有球的紋路），不是球。")
    else:
        print("[!] 資料集裡沒有負樣本。" + ("" if manifest.get("public") else "建議在網站上標幾段「畫面上沒有球」的片段再匯出標註包。"))

    # ── 合成資料：和真值比較 ──
    if args.truth:
        truth_dir = Path(args.truth)
        errs = []
        by_video: dict[str, dict] = {}
        videos = {v["name"]: v for v in manifest["videos"]}
        for im in positives:
            name = im["video"]
            if name not in by_video:
                p = truth_dir / f"{name}.truth.json"
                by_video[name] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
            truth = by_video[name]
            if truth is None:
                continue
            ball = truth["balls"][im["videoFrame"]]
            if ball is None:
                errs.append((1e9, im))
                continue
            v = videos[name]
            txt = (root / "labels" / im["file"]).with_suffix(".txt").read_text(encoding="utf-8").split()
            cx, cy = float(txt[1]) * v["width"], float(txt[2]) * v["height"]
            errs.append((((cx - ball["x"]) ** 2 + (cy - ball["y"]) ** 2) ** 0.5, im))
        # 負樣本：真值裡這一幀應該真的沒有球
        bad_neg = []
        for im in negatives:
            name = im["video"]
            if name not in by_video:
                p = truth_dir / f"{name}.truth.json"
                by_video[name] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
            truth = by_video[name]
            if truth is not None and truth["balls"][im["videoFrame"]] is not None:
                bad_neg.append(im)
        if negatives:
            if bad_neg:
                print(f"[X] 有 {len(bad_neg)} 張負樣本其實有球（例如 {bad_neg[0]['video']} 第 {bad_neg[0]['bundleFrame']} 幀）")
                if args.max_error is not None:
                    return 1
            else:
                print(f"和真值比較（{len(negatives)} 張負樣本）：每一張都確實沒有球")
        if errs:
            vals = sorted(e for e, _ in errs)
            mean = sum(vals) / len(vals)
            worst = max(errs, key=lambda t: t[0])
            print(f"和真值比較（{len(vals)} 張）：標註的球心平均差 {mean:.2f} 像素、中位數 {vals[len(vals) // 2]:.2f}、最大 {vals[-1]:.2f}"
                  f"（{worst[1]['video']} 第 {worst[1]['bundleFrame']} 幀）")
            if args.max_error is not None and mean > args.max_error:
                print(f"[X] 平均誤差超過 {args.max_error} 像素：標註和畫面可能沒有對齊")
                return 1
        else:
            print("[!] 找不到對應的真值檔，沒有比較")
    return 0


if __name__ == "__main__":
    sys.exit(main())
