#!/usr/bin/env python3
"""在筆電上分析練投影片：輸出和網站相同格式的 CSV，以及一支疊了軌跡的檢查影片。

給十分鐘以上的長影片用。用的是和網站同一個 ONNX 模型、同一套軌跡邏輯。

用法（PowerShell，一行）：

    python tools/analyze.py "D:\\影片\\練投.mov" --hoop 1403.5,412.0,1538.2,410.6

--hoop 是籃框「前緣 x,y」和「後緣 x,y」在影片上的像素座標（前緣＝靠近投籃者的那一端）。
最簡單的取得方式：在網站上載入同一支影片、完成校正，報告頁最下面會給你整行指令。
也可以先用 --grid 輸出一張有座標格線的畫面，自己讀座標。

水平基準預設是「籃框連線並修正透視」（--level persp）。在網站上改用「垂直參考線」校正時，
指令會多出 --level vertical --vertical x1,y1,x2,y2（籃板側邊等鉛直的邊上兩點的座標）。

輸出（預設放在影片旁邊）：
    <影片名>.arclog.csv      球序, 入框角度, 是否進球（可以用網站首頁的「匯入 CSV」看報告）
    <影片名>.arclog.mp4      檢查影片：每一球的片段，疊上軌跡、角度、進球判定
    <影片名>.arclog-auto.json 每一球的詳細資料（偵測點、擬合參數）

進球判定只是依軌跡的建議，請看檢查影片確認；要改的話直接改 CSV 的第三欄（是／否）。

安裝需要的套件：

    python -m pip install -r requirements.txt
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

#: 垂直參考線和籃框（扣掉透視後）推算的手機歪斜差超過幾度就提醒（和網站 web/js/ui/session.js 的 VERTICAL_AGREE_DEG 相同）。
VERTICAL_AGREE_DEG = 2


def fmt_time(sec: float) -> str:
    sec = max(0, int(sec))
    return f"{sec // 60} 分 {sec % 60} 秒" if sec >= 60 else f"{sec} 秒"


def write_grid(video: Path, out: Path) -> None:
    """輸出第一幀加上座標格線的圖，方便讀出籃框的像素座標。"""
    from PIL import Image, ImageDraw

    from arclog.video import iter_frames

    fr = next(iter(iter_frames(video)))
    img = Image.fromarray(fr.to_rgb())
    draw = ImageDraw.Draw(img)
    step = 100 if fr.width <= 2000 else 200
    for x in range(0, fr.width, step):
        draw.line([(x, 0), (x, fr.height)], fill=(255, 255, 0) if x % (step * 5) == 0 else (255, 255, 255), width=1)
        draw.text((x + 3, 3), str(x), fill=(255, 255, 0), stroke_width=2, stroke_fill=(0, 0, 0))
    for y in range(0, fr.height, step):
        draw.line([(0, y), (fr.width, y)], fill=(255, 255, 0) if y % (step * 5) == 0 else (255, 255, 255), width=1)
        draw.text((3, y + 3), str(y), fill=(255, 255, 0), stroke_width=2, stroke_fill=(0, 0, 0))
    img.save(out)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="分析練投影片，輸出 CSV 和檢查影片", formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="--hoop 的四個數字是：前緣x,前緣y,後緣x,後緣y（影片顯示方向的像素）")
    ap.add_argument("video", help="影片檔（MP4 或 MOV）")
    ap.add_argument("--hoop", help="籃框前緣和後緣的像素座標：x1,y1,x2,y2")
    ap.add_argument("--grid", action="store_true", help="只輸出一張有座標格線的畫面（用來找籃框座標），不做分析")
    ap.add_argument("--model", default=None, help="模型代號（models/manifest.json 裡的 id）或 .onnx 檔的路徑；預設用 manifest 的預設模型")
    ap.add_argument("--conf", type=float, default=None, help="偵測的信心門檻（預設用模型建議值）")
    ap.add_argument("--density", choices=["normal", "fine"], default="normal", help="normal：每秒看 20–30 幀；fine：每一幀都看（最多每秒 60 幀）")
    ap.add_argument("--level", choices=["persp", "vertical", "rim", "image"], default="persp",
                    help="水平基準：persp＝籃框連線並修正透視（預設，實拍影片用）；vertical＝垂直參考線（要加 --vertical）；"
                         "rim＝籃框連線不修正（合成畫面用）；image＝畫面水平")
    ap.add_argument("--vertical", help="垂直參考線（籃板側邊、籃架立柱等鉛直的邊）上兩點的像素座標：x1,y1,x2,y2。只有 --level vertical 用到")
    ap.add_argument("--focal", type=float, default=None,
                    help="鏡頭焦距是畫面長邊的幾倍（--level persp 用來修正透視；--level vertical 只用來扣籃框比例；預設 0.8，也就是手機的 1 倍鏡頭）")
    ap.add_argument("--no-drag", action="store_true", help="關閉空氣阻力修正（純拋物線）")
    ap.add_argument("--start", type=float, default=None, help="從第幾秒開始")
    ap.add_argument("--end", type=float, default=None, help="到第幾秒結束")
    ap.add_argument("--overlay", choices=["shots", "full", "none"], default="shots", help="檢查影片：shots＝只留每一球的片段（預設）；full＝整支；none＝不輸出")
    ap.add_argument("--out", default=None, help="輸出資料夾（預設：影片所在的資料夾）")
    ap.add_argument("--threads", type=int, default=None, help="推論用幾個 CPU 執行緒（預設由 onnxruntime 決定）")
    args = ap.parse_args()

    video = Path(args.video)
    if not video.exists():
        print(f"[X] 找不到影片：{video}")
        return 1
    out_dir = Path(args.out) if args.out else video.parent
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = video.stem

    try:
        import av  # noqa: F401
        import numpy  # noqa: F401
        import onnxruntime  # noqa: F401
        import PIL  # noqa: F401
    except ImportError as err:
        print(f"[X] 缺少套件：{err.name}。請先執行：python -m pip install -r requirements.txt")
        return 1

    if args.grid:
        out = out_dir / f"{stem}.grid.png"
        write_grid(video, out)
        print(f"[OK] 已輸出 {out}")
        print("     打開這張圖，讀出籃框前緣和後緣的座標，再用 --hoop x1,y1,x2,y2 執行。")
        return 0

    if not args.hoop:
        print("[X] 需要 --hoop x1,y1,x2,y2（籃框前緣和後緣的像素座標）。")
        print("    取得方式：在網站上載入同一支影片並完成校正，報告頁最下面會給整行指令；")
        print("    或是加 --grid 輸出一張有座標格線的畫面自己讀。")
        return 1
    try:
        x1, y1, x2, y2 = (float(v) for v in args.hoop.replace(" ", "").split(","))
    except ValueError:
        print("[X] --hoop 的格式應該是四個用逗號分開的數字，例如 --hoop 1403.5,412,1538.2,410.6")
        return 1
    hoop_points = {"front": {"x": x1, "y": y1}, "back": {"x": x2, "y": y2}}
    vertical = None
    if args.level == "vertical":
        if not args.vertical:
            print("[X] --level vertical 需要 --vertical x1,y1,x2,y2（垂直參考線上兩點的像素座標）。")
            print("    在網站上選「垂直參考線」完成校正後，報告頁最下面的指令會包含這一段。")
            return 1
        try:
            vx1, vy1, vx2, vy2 = (float(v) for v in args.vertical.replace(" ", "").split(","))
        except ValueError:
            print("[X] --vertical 的格式應該是四個用逗號分開的數字，例如 --vertical 1561.3,300.2,1558.9,520.6")
            return 1
        vertical = {"top": {"x": vx1, "y": vy1}, "bottom": {"x": vx2, "y": vy2}}
    elif args.vertical:
        print("  注意：只有 --level vertical 會用到 --vertical，這次忽略。")

    from arclog.csvio import write_csv
    from arclog.detector import BallDetector, find_model
    from arclog.geometry import make_hoop_frame
    from arclog.pipeline import run_auto, shots_for_csv, write_overlay
    from arclog.stats import summarize

    try:
        info = find_model(args.model)
    except (FileNotFoundError, OSError) as err:
        print(f"[X] {err}")
        return 1
    conf = args.conf if args.conf is not None else (info["conf"] if info["conf"] is not None else 0.15)
    detector = BallDetector(info["path"], class_index=info["classIndex"], conf=conf, threads=args.threads)
    print(f"模型：{info['id']}（輸入 {detector.in_w}×{detector.in_h}，籃球類別 {detector.class_index}，信心門檻 {conf}）")
    print(f"影片：{video.name}")

    def progress(done, total, fps):
        if total:
            left = (total - done) / max(fps, 1e-6)
            print(f"  偵測中 {done}/{total} 幀（{done / total:.0%}），每秒 {fps:.0f} 幀，大約還要 {fmt_time(left)}", flush=True)
        else:
            print(f"  偵測中 {done} 幀，每秒 {fps:.0f} 幀", flush=True)

    t0 = time.time()
    try:
        result = run_auto(video, hoop_points, detector, level=args.level, drag=not args.no_drag, density=args.density,
                          start=args.start, end=args.end, progress=progress, focal=args.focal, vertical=vertical)
    except ValueError as err:
        print(f"[X] {err}")
        return 1
    shots = result["shots"]
    hoop = result["hoop"]
    print(f"影片 {result['width']}×{result['height']}、每秒 {result['fps']:.2f} 幀、共 {len(result['times'])} 幀；每 {result['stride']} 幀偵測一次，用了 {fmt_time(result['seconds'])}")
    tilt = f"連線傾斜 {abs(hoop['tiltDeg']):.1f} 度"
    if hoop["level"] == "persp":
        tilt += f"（其中透視約 {abs(hoop['perspDeg']):.1f} 度，扣掉後剩 {abs(hoop['tiltDeg'] - hoop['perspDeg']):.1f} 度）"
    elif hoop["level"] == "vertical":
        tilt += f"；依垂直參考線，手機歪了 {abs(hoop['vertDeg']):.1f} 度（已扣掉）"
    print(f"籃框寬 {hoop['len']:.0f} 像素（每公尺 {hoop['pxPerM']:.0f} 像素），{tilt}")
    if hoop["level"] == "persp" and abs(hoop["tiltDeg"] - hoop["perspDeg"]) > 3:
        print("  注意：扣掉透視後還歪超過 3 度，可能是手機沒放平、鏡頭往上仰，或籃框座標不準；角度可能差到 1 度左右。")
    if hoop["level"] == "vertical":
        rim = make_hoop_frame(hoop_points["front"], hoop_points["back"], "persp", width=result["width"], height=result["height"], focal=args.focal)
        diff = abs((rim["tiltDeg"] - rim["perspDeg"]) - hoop["vertDeg"])
        if diff > VERTICAL_AGREE_DEG:
            print(f"  注意：垂直參考線和籃框（扣掉透視後）推算的水平差了 {diff:.1f} 度，可能有一邊的座標不準，"
                  "或參考線不是真的鉛直。不是用 1 倍鏡頭拍的影片也會差 1 到 2 度，這時以垂直參考線為準。")
    if hoop["len"] < 30:
        print("  注意：籃框在畫面上很小，角度會比較不準。")
    st = result["stats"]
    print(f"偵測到 {st['detections']} 個球的位置（其中 {st['static']} 個靜止不動），找到 {len(shots)} 球")
    if st.get("rejected"):
        print("  被排除的候選軌跡：" + "、".join(f"{k}×{v}" for k, v in sorted(st["rejected"].items())))

    csv_path = out_dir / f"{stem}.arclog.csv"
    write_csv(csv_path, shots_for_csv(shots))
    detail = {
        "video": video.name, "model": info["id"], "conf": conf, "level": hoop["level"], "focal": hoop["focal"], "drag": not args.no_drag,
        "width": result["width"], "height": result["height"], "fps": result["fps"], "frames": len(result["times"]),
        "stride": result["stride"], "hoop": hoop_points, "vertical": vertical, "stats": st,
        "shots": [{k: s[k] for k in ("angle", "angleRaw", "crossS", "made", "madeGeometry", "madeBy", "zone", "flip", "tStart", "tEnd", "tCross",
                                     "fStart", "fEnd", "fCross", "evidence", "rms", "points")} for s in shots],
    }
    json_path = out_dir / f"{stem}.arclog-auto.json"
    json_path.write_text(json.dumps(detail, ensure_ascii=False), encoding="utf-8")

    if shots:
        s = summarize(shots_for_csv(shots))
        sd = f"{s['angleStd']:.1f}" if s["angleStd"] is not None else "—"
        print(f"出手 {s['attempts']} 球、進 {s['makes']} 球（{s['pct']:.0f}%）；入框角度平均 {s['angleMean']:.1f} 度、標準差 {sd} 度")
        for i, sh in enumerate(shots):
            print(f"  #{i + 1:<3d} {sh['angle']:5.1f}°  {'進球' if sh['made'] else '沒進'}  （{sh['tCross']:.1f} 秒，{len(sh['points'])} 個偵測點）")
    else:
        print("沒有找到投籃。可能的原因：模型偵測不到球（球太小或太模糊）、--hoop 的座標不對、或影片方向和校正時不同。")
    print(f"[OK] {csv_path}")
    print(f"[OK] {json_path}")

    if args.overlay != "none" and (shots or args.overlay == "full"):
        mp4_path = out_dir / f"{stem}.arclog.mp4"

        def progress2(done, total, fps):
            print(f"  輸出檢查影片 {done}/{total} 幀（{done / max(total, 1):.0%}）", flush=True)

        ov = write_overlay(video, mp4_path, result, mode=args.overlay, progress=progress2)
        print(f"[OK] {mp4_path}（{ov['frames']} 幀，{ov['width']}×{ov['height']}）")
    print(f"全部完成，共 {fmt_time(time.time() - t0)}。進球判定只是建議，請看檢查影片確認。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
