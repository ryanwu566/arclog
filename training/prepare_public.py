#!/usr/bin/env python3
"""把 Roboflow Universe 下載的公開資料集（YOLO 格式）整理成「只有籃球一個類別」的訓練資料。

    python training/prepare_public.py --src datasets/basketball-detection-v6-1 --out datasets/public_ball

公開資料集通常同時標了球、球員、籃框等好幾個類別。我們只要球：
  - 找出名稱是 basketball／ball 的類別，改成類別 0；其他類別的框全部丟掉。
  - 沒有球的影像留一部分當負樣本（預設最多是有球影像的一半）。
  - 來源沒有驗證組時，從訓練組切一部分出來。檔名看起來來自同一支影片的影像會放在同一組
    （公開資料集沒有「哪張圖來自哪支影片」的資訊，這只是依檔名猜的，不能保證）。
  - 可以用 --aspect 16:9 把被壓成正方形的影像還原成原本的比例（球才不會是橢圓的）。

可以給很多個 --src，會合併成一份。輸出的資料夾可以直接拿去訓練：

    python training/train.py --stage B --data datasets/public_ball/data.yaml

做完會輸出 preview_check.jpg（隨機抽樣把框畫在圖上），請打開看一下框是不是套在球上、球是不是圓的。

三類別模式（自動模式用）：加 --classes ball,rim,backboard，輸出固定 0 ball、1 rim、2 backboard。
  - 類別依名稱對應（arclog/detector.py 的 CLASS_ALIASES），不靠編號。
  - 先讀匯出檔裡的 README.roboflow.txt 核對授權：不是 CC BY 4.0、CC0、Public Domain 就停下來
    （確認過授權可以用 --allow-license 繼續）。
  - 某個來源沒有某個類別（例如 Arizona 的資料集看起來沒有籃板）時，記在 sources.json 的 missing，
    之後用 training/pseudo_label.py 補標；沒補標就直接訓練，模型會把沒標的籃板當成背景。

注意：公開資料集的驗證組只用來在訓練時挑選模型，不能當成我們自己場地的準確度。
各資料集的出處和授權請看 docs/DATA.md；重新散布或發表成果時要依 CC BY 4.0 標示出處。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
SPLIT_DIRS = {"train": ["train"], "val": ["valid", "val"], "test": ["test"]}


def group_key(filename: str) -> str:
    """從檔名猜「這張圖來自哪支影片」。

    Roboflow 的檔名長得像 `clip12_frame_0045_jpg.rf.3f2a….jpg`：
    去掉 .rf.<雜湊>、去掉 _jpg／_png、再去掉結尾的幀號，剩下的 `clip12` 當成同一組。
    """
    stem = Path(filename).name
    stem = re.sub(r"\.rf\.[0-9a-zA-Z]+(\.[a-zA-Z]+)?$", "", stem)
    stem = re.sub(r"\.[a-zA-Z]+$", "", stem) if re.search(r"\.(jpg|jpeg|png|bmp|webp)$", stem, re.I) else stem
    stem = re.sub(r"[_-](jpg|jpeg|png|bmp|webp)$", "", stem, flags=re.I)
    stem = re.sub(r"[_\-. ]*(frame|img|image)?[_\-. ]*\d+$", "", stem, flags=re.I)  # 只去掉最後一段數字
    return stem.lower() or "_"


def read_names(data_yaml: Path) -> dict[int, str]:
    import yaml  # ultralytics 會一起安裝

    data = yaml.safe_load(data_yaml.read_text(encoding="utf-8"))
    names = data.get("names")
    if isinstance(names, dict):
        return {int(k): str(v) for k, v in names.items()}
    if isinstance(names, list):
        return {i: str(v) for i, v in enumerate(names)}
    raise ValueError(f"{data_yaml} 裡沒有 names")


def convert_label(text: str, ball: int) -> list[tuple[float, float, float, float]]:
    """把一個標註檔裡屬於籃球的框挑出來。多邊形標註（分割）會轉成外接框。"""
    boxes = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        try:
            cls = int(float(parts[0]))
            vals = [float(v) for v in parts[1:]]
        except ValueError:
            continue
        if cls != ball:
            continue
        if len(vals) == 4:
            cx, cy, w, h = vals
        elif len(vals) >= 6 and len(vals) % 2 == 0:
            xs, ys = vals[0::2], vals[1::2]
            cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
            w, h = max(xs) - min(xs), max(ys) - min(ys)
        else:
            continue
        if w <= 0 or h <= 0:
            continue
        boxes.append((min(max(cx, 0.0), 1.0), min(max(cy, 0.0), 1.0), min(w, 1.0), min(h, 1.0)))
    return boxes


LICENSE_OK = ("cc by 4.0", "cc-by-4.0", "cc0", "public domain", "creative commons attribution 4.0")


def read_license(src: Path) -> str | None:
    """讀 Roboflow 匯出檔的 README.roboflow.txt 裡「License: …」那一行；沒有就回傳 None。"""
    for name in ("README.roboflow.txt", "README.dataset.txt"):
        f = src / name
        if not f.exists():
            continue
        for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"\s*licen[cs]e\s*[:：]\s*(.+)$", line, re.I)
            if m:
                return m.group(1).strip()
    return None


def license_ok(text: str | None) -> bool:
    """授權是不是在允許清單裡（CC BY 4.0、CC0、Public Domain）。"""
    return bool(text) and any(k in text.strip().lower() for k in LICENSE_OK)


def convert_label_multi(text: str, mapping: dict) -> list[tuple]:
    """三類別：mapping 是 {來源編號: 目標編號}。回傳 [(目標編號, cx, cy, w, h)]，依目標編號排序。"""
    out = []
    for src_cls, dst_cls in mapping.items():
        for b in convert_label(text, src_cls):
            out.append((dst_cls, *b))
    out.sort()
    return out


def place(src: Path, dst: Path, aspect: float | None) -> None:
    """把影像放到輸出資料夾：需要還原比例時重新存檔，否則用硬連結（不佔空間），不行再複製。"""
    if aspect:
        from PIL import Image

        with Image.open(src) as im:
            im = im.convert("RGB")
            w, h = im.size
            if abs(w / h - aspect) > 0.02:
                nh = int(round(w / aspect / 2)) * 2
                im = im.resize((w, nh), Image.BILINEAR)
            im.save(dst.with_suffix(".jpg"), quality=92)
        return
    try:
        os.link(src, dst)
    except OSError:
        shutil.copyfile(src, dst)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="公開資料集 → 只有籃球一個類別的訓練資料", formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", action="append", required=True, help="Roboflow 下載後的資料夾（裡面有 data.yaml、train/、valid/）；可以給很多次")
    ap.add_argument("--out", required=True, help="輸出資料夾")
    ap.add_argument("--ball-class", action="append", default=[], help="籃球類別的名稱或編號（預設自動找 basketball／ball）；有多個 --src 時依序對應")
    ap.add_argument("--aspect", action="append", default=[], help="把影像還原成這個長寬比，例如 16:9；不需要的來源填 keep；依序對應 --src")
    ap.add_argument("--val-fraction", type=float, default=0.15, help="來源沒有驗證組時，切多少比例出來（預設 0.15）")
    ap.add_argument("--max-neg-ratio", type=float, default=0.5, help="沒有球的影像最多是有球影像的幾倍（預設 0.5）")
    ap.add_argument("--limit", type=int, default=0, help="每個來源每一組最多取幾張（0＝全部；試流程時用）")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--clean", action="store_true", help="輸出資料夾已經有東西時先清掉")
    ap.add_argument("--classes", default="ball", help="要留的類別：ball（預設，只有籃球）或 ball,rim,backboard（自動模式的三類別）")
    ap.add_argument("--allow-license", action="store_true", help="README.roboflow.txt 的授權不在允許清單或找不到時仍然繼續（自己確認過授權才用）")
    args = ap.parse_args()

    from arclog.detector import resolve_class_index, resolve_classes

    targets = [c.strip() for c in args.classes.split(",") if c.strip()]
    multi = targets != ["ball"]
    if multi and (targets[0] != "ball" or any(t not in ("ball", "rim", "backboard") for t in targets)):
        print("[X] --classes 只能是 ball 或 ball,rim,backboard 的組合，而且第一個要是 ball")
        return 1

    out = Path(args.out)
    if out.exists() and any(out.iterdir()):
        if not args.clean:
            print(f"[X] {out} 裡面已經有東西。加 --clean 會先清掉，或換一個輸出資料夾。")
            return 1
        for sub in ("images", "labels"):
            shutil.rmtree(out / sub, ignore_errors=True)
    for s in ("train", "val", "test"):
        (out / "images" / s).mkdir(parents=True, exist_ok=True)
        (out / "labels" / s).mkdir(parents=True, exist_ok=True)

    manifest = {"format": "arclog-dataset", "version": 1, "classes": targets if multi else ["basketball"], "public": True, "sources": [], "videos": [], "images": []}
    sources_info = []
    counts = {s: [0, 0] for s in ("train", "val", "test")}

    for si, src_arg in enumerate(args.src):
        src = Path(src_arg)
        yaml_path = src / "data.yaml"
        if not yaml_path.exists():
            print(f"[X] {src} 裡找不到 data.yaml（請確認下載時選的是 YOLO 格式）")
            return 1
        names = read_names(yaml_path)
        mapping: dict = {}
        missing: list = []
        if multi:
            lic = read_license(src)
            if not license_ok(lic):
                if not args.allow_license:
                    print(f"[X] {src.name}：README.roboflow.txt 的授權是「{lic or '找不到'}」，不在允許清單（CC BY 4.0、CC0、Public Domain）。")
                    print("    請到資料集頁面確認授權；確認可以使用之後再加 --allow-license。")
                    return 1
                print(f"[!] {src.name}：授權「{lic or '找不到'}」沒有通過自動核對，依 --allow-license 繼續。")
            found_cls = resolve_classes(names, targets)
            if "ball" not in found_cls:
                print(f"[X] {src.name}：找不到籃球類別。類別有：{names}")
                return 1
            for ti, t in enumerate(targets):
                for k in found_cls.get(t, []):
                    mapping[k] = ti
            missing = [t for t in targets if t not in found_cls]
            desc = "、".join(f"{t}＝{[names[k] for k in found_cls.get(t, [])] or '沒有'}" for t in targets)
            print(f"{src.name}：類別 {names} → {desc}；授權 {lic}")
            sources_info.append({"name": src.name, "license": lic, "names": {str(k): v for k, v in names.items()},
                                 "mapping": {str(k): targets[v] for k, v in mapping.items()}, "missing": missing})
        want = args.ball_class[si] if si < len(args.ball_class) else None
        if want is None:
            ball = resolve_class_index(names)
        elif want.isdigit():
            ball = int(want)
        else:
            ball = next((k for k, v in names.items() if v.strip().lower() == want.strip().lower()), None)
        if multi:
            ball = min(k for k, v in mapping.items() if v == 0)
        if ball is None or ball not in names:
            print(f"[X] {src.name}：看不出哪個類別是籃球。類別有：{names}。請用 --ball-class 指定。")
            return 1
        aspect = None
        if si < len(args.aspect) and args.aspect[si].lower() != "keep":
            a, b = args.aspect[si].replace("/", ":").split(":")
            aspect = float(a) / float(b)
        tag = re.sub(r"[^0-9A-Za-z]+", "", src.name)[:10] or f"src{si}"
        if not multi:
            print(f"{src.name}：類別 {names} → 只留「{names[ball]}」（編號 {ball}）" + (f"，影像還原成 {args.aspect[si]}" if aspect else ""))

        # 讀進每一組的影像
        found: dict[str, list[tuple[Path, Path]]] = {}
        for split, dirs in SPLIT_DIRS.items():
            items = []
            for d in dirs:
                img_dir = src / d / "images"
                if not img_dir.is_dir():
                    continue
                for img in sorted(img_dir.iterdir()):
                    if img.suffix.lower() in IMAGE_EXT:
                        items.append((img, src / d / "labels" / (img.stem + ".txt")))
            found[split] = items
        if not found["train"]:
            print(f"[X] {src} 的 train/images 是空的")
            return 1
        made_val = False
        if not found["val"]:
            # 依檔名分組再切，盡量不要讓同一支影片的畫面同時出現在訓練和驗證
            groups: dict[str, list] = {}
            for item in found["train"]:
                groups.setdefault(group_key(item[0].name), []).append(item)
            total = len(found["train"])
            target = total * args.val_fraction
            by_name = len(groups) < 5 or len(groups) > 0.8 * total
            if by_name:
                # 檔名分不出影片：只能一張一張切（同一支影片的畫面可能同時出現在訓練和驗證）
                groups = {item[0].name: [item] for item in found["train"]}
            keys = sorted(groups, key=lambda k: hashlib.sha1(f"{args.seed}:{k}".encode("utf-8")).hexdigest())
            val_items: list = []
            for k in keys:
                if len(val_items) >= target:
                    break
                if len(val_items) + len(groups[k]) > max(2 * target, 1):
                    continue  # 這一組太大，留在訓練組
                val_items.extend(groups[k])
            chosen = {id(x) for x in val_items}
            found["val"] = val_items
            found["train"] = [x for x in found["train"] if id(x) not in chosen]
            made_val = True
            how = "檔名看不出影片分組，等於隨機切；驗證分數會偏樂觀" if by_name else f"依檔名分成 {len(groups)} 組"
            print(f"  來源沒有驗證組：切出 {len(val_items)} 張當驗證（{how}）")

        rng = random.Random(args.seed + si)
        info = {"name": src.name, "path": str(src), "names": names, "ballClass": names[ball], "aspect": args.aspect[si] if aspect else None,
                "madeVal": made_val, "splits": {}}
        for split, items in found.items():
            if args.limit and len(items) > args.limit:
                items = rng.sample(items, args.limit)
            pos, neg = [], []
            for img, lab in items:
                text = lab.read_text(encoding="utf-8", errors="replace") if lab.exists() else ""
                # 三類別：有任何一類的框就算有標註；負樣本只留什麼都沒有的
                boxes = (convert_label_multi(text, mapping) if multi else convert_label(text, ball)) if text else []
                (pos if boxes else neg).append((img, boxes))
            keep_neg = int(len(pos) * args.max_neg_ratio)
            if len(neg) > keep_neg:
                neg = rng.sample(neg, keep_neg)
            for img, boxes in pos + neg:
                stem = f"{tag}_{img.stem}"[:150]
                dst = out / "images" / split / (stem + (".jpg" if aspect else img.suffix.lower()))
                place(img, dst, aspect)
                if multi:
                    text = "".join(f"{c} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n" for c, cx, cy, w, h in boxes)
                else:
                    text = "".join(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n" for cx, cy, w, h in boxes)
                (out / "labels" / split / (stem + ".txt")).write_bytes(text.encode("utf-8"))
                entry = {"file": f"{split}/{dst.name}", "video": src.name, "split": split, "bundleFrame": 0, "videoFrame": 0,
                         "boxes": len(boxes), "src": ["public"] * len(boxes)}
                if multi:
                    entry["missing"] = missing
                manifest["images"].append(entry)
            counts[split][0] += len(pos)
            counts[split][1] += len(neg)
            info["splits"][split] = {"positives": len(pos), "negatives": len(neg)}
        manifest["sources"].append(info)

    if not counts["train"][0]:
        print("[X] 訓練組裡沒有任何有球的影像。")
        return 1
    yaml_lines = [
        "# 由 training/prepare_public.py 產生：公開資料集，只保留籃球一個類別。",
        f"path: {out.resolve().as_posix()}",
        "train: images/train",
        "val: images/val" if counts["val"][0] + counts["val"][1] else "val: images/train",
    ]
    if counts["test"][0] + counts["test"][1]:
        yaml_lines.append("test: images/test")
    if multi:
        yaml_lines[0] = "# 由 training/prepare_public.py 產生：公開資料集，三個類別（自動模式）。"
        yaml_lines += ["names:"] + [f"  {i}: {t}" for i, t in enumerate(targets)] + [""]
        (out / "sources.json").write_bytes(json.dumps({"classes": targets, "sources": sources_info}, ensure_ascii=False, indent=2).encode("utf-8"))
        need = sorted({m for x in sources_info for m in x["missing"]})
        if need:
            print(f"[!] 有來源缺少這些類別：{need}（見 sources.json）。訓練前請先用 training/pseudo_label.py 補標。")
    else:
        yaml_lines += ["names:", "  0: basketball", ""]
    (out / "data.yaml").write_text("\n".join(yaml_lines), encoding="utf-8")
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")

    print("")
    print("  組別    有球  沒有球")
    for s, label in (("train", "訓練"), ("val", "驗證"), ("test", "測試")):
        print(f"  {label}  {counts[s][0]:6d} {counts[s][1]:6d}")
    print(f"[OK] 已寫入 {out}")

    # 抽樣疊圖，讓人確認框有套在球上
    import subprocess

    subprocess.call([sys.executable, str(ROOT / "training" / "check_overlay.py"), "--dataset", str(out), "--out-name", "preview"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
