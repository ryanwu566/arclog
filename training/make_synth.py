#!/usr/bin/env python3
"""產生合成練投影片、標註包和真值，用來在沒有實拍影片時把整條流程跑通。

    python training/make_synth.py --out data/synth --videos 6

每支影片會輸出三個檔案：
    <名稱>.mp4            合成影片（H.264）
    <名稱>.arclog.json    標註包（和網站匯出的格式相同）
    <名稱>.truth.json     每一幀球的真實位置、每一球的真實角度（只有合成資料才有）

畫面是用網站示範模式的同一份程式畫出來的（web/js/demo/scene.js，透過 Node 執行），
所以需要先安裝 Node 和開發用套件：

    npm install

每支影片的取景、顏色、幀率、投籃角度都不一樣，並加上幾個干擾物。
這些資料只能證明「流程沒壞」，用它訓練出來的模型不代表在真實影片上的準確度。
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# 讓每支影片長得不一樣的幾組配色（牆、護墊、地板、籃框、球）
PALETTES = [
    {},
    {"wallTop": "#e9e4d8", "wallBottom": "#d8d0bd", "wainscot": "#7f9a84", "floor": "#b98a55", "floorDark": "#8f6a3e"},
    {"wallTop": "#cfd8e6", "wallBottom": "#aebbd0", "wainscot": "#5d6f8f", "floor": "#d1ab78", "floorDark": "#a88252", "pole": "#2f3740"},
    {"wallTop": "#f1f1ee", "wallBottom": "#deded8", "wainscot": "#b9433c", "floor": "#c49a62", "floorDark": "#9c7746", "figure": "#1f2a44"},
    {"wallTop": "#d9d2c5", "wallBottom": "#bdb4a3", "wainscot": "#8a8f98", "floor": "#a97b4a", "floorDark": "#7f5a33", "ballMid": "#c9652a", "ballLight": "#e9a05f"},
    {"wallTop": "#bcc7c9", "wallBottom": "#9aa9ad", "wainscot": "#4f6b6f", "floor": "#c8a36c", "floorDark": "#9a7a4a", "ballMid": "#e07f3a", "ballDark": "#7a3a16"},
]


def video_spec(index: int, seed: int, shots: int, small: bool) -> dict:
    """第 index 支影片的設定。同一個 seed 每次產生的都一樣。"""
    rng = random.Random(seed * 1000 + index)
    fps = [30, 60, 30, 30, 60, 30][index % 6]
    size = [(1280, 720, 150), (1280, 720, 140), (1920, 1080, 225), (1280, 720, 160), (1280, 720, 150), (1600, 900, 190)][index % 6]
    if small:
        size = (960, 540, 112)
        fps = 30
    width, height, px_per_m = size
    look = dict(PALETTES[index % len(PALETTES)])
    look["shutter"] = rng.choice([1 / 240, 1 / 120, 1 / 90, 1 / 60])
    # 干擾物：地上一顆球、牆上一個橘色圓形標誌（都不是「飛行中的球」）
    look["distractors"] = [
        {"x": round(-5.6 + rng.random() * 1.0, 2), "y": round(-3.05 + 0.12, 2), "r": 0.12, "color": rng.choice(["#d9702b", "#c9652a", "#8a4a1f"])},
        {"x": round(-2.5 + rng.random() * 1.5, 2), "y": round(-1.2 + rng.random() * 0.8, 2), "r": round(0.1 + rng.random() * 0.08, 2), "color": rng.choice(["#e0a030", "#d24a2a", "#f2f2f2"])},
    ]
    return {
        "name": f"synth_{index + 1:02d}",
        "plan": {
            "seed": seed * 7919 + index * 104729 + 1,
            "shots": shots,
            "fps": fps,
            "width": width,
            "height": height,
            "pxPerM": px_per_m,
            "mirror": index % 2 == 1,
            "rollDeg": round((rng.random() - 0.5) * 3.0, 2),
        },
        "look": look,
        "clicks": {"count": rng.choice([5, 6, 6]), "noisePx": 1.5, "seed": seed + index},
    }


def render_video(spec: dict, out_dir: Path, node: str, crf: int) -> dict:
    """呼叫 Node 畫出每一幀，邊收邊編碼成 MP4。"""
    import numpy as np

    from arclog.video import VideoWriter

    name = spec["name"]
    with tempfile.TemporaryDirectory(prefix="arclog_synth_") as tmp:
        tmp = Path(tmp)
        spec = dict(spec)
        spec["out"] = {
            "bundle": str(out_dir / f"{name}.arclog.json"),
            "truth": str(out_dir / f"{name}.truth.json"),
            "meta": str(tmp / "meta.json"),
        }
        spec_path = tmp / "spec.json"
        spec_path.write_text(json.dumps(spec), encoding="utf-8")
        proc = subprocess.Popen([node, str(ROOT / "training" / "render_synth.mjs"), "--spec", str(spec_path), "--raw"],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(ROOT))
        width, height, fps = spec["plan"]["width"], spec["plan"]["height"], spec["plan"]["fps"]
        frame_bytes = width * height * 4
        count = 0
        video_path = out_dir / f"{name}.mp4"
        with VideoWriter(video_path, width, height, fps=fps, crf=crf) as writer:
            while True:
                buf = proc.stdout.read(frame_bytes)
                if len(buf) < frame_bytes:
                    break
                rgba = np.frombuffer(buf, np.uint8).reshape(height, width, 4)
                writer.write(np.ascontiguousarray(rgba[:, :, :3]))
                count += 1
        err = proc.stderr.read().decode("utf-8", "replace")
        if proc.wait() != 0 or count == 0:
            raise RuntimeError(f"畫面產生失敗（{name}）：{err.strip()[-600:]}")
        meta = json.loads((tmp / "meta.json").read_text(encoding="utf-8"))
    if meta["frameCount"] != count:
        raise RuntimeError(f"{name}：應該有 {meta['frameCount']} 幀，實際收到 {count} 幀")
    return {"name": name, "video": video_path, "frames": count, "fps": fps, "width": width, "height": height}


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(description="產生合成練投影片、標註包和真值")
    ap.add_argument("--out", default=str(ROOT / "data" / "synth"), help="輸出資料夾（預設 data/synth，不會進版控）")
    ap.add_argument("--videos", type=int, default=6, help="產生幾支影片（預設 6：訓練、驗證、測試各分得到）")
    ap.add_argument("--shots", type=int, default=10, help="每支影片幾球（預設 10）")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--small", action="store_true", help="用 960×540 的小畫面（跑得快，測試流程用）")
    ap.add_argument("--crf", type=int, default=20, help="H.264 的壓縮品質，越小越清楚（預設 20）")
    ap.add_argument("--node", default=shutil.which("node") or "node", help="node 執行檔的位置")
    args = ap.parse_args()

    if not shutil.which(args.node) and not Path(args.node).exists():
        print("[X] 找不到 node。請先安裝 Node.js（https://nodejs.org），再在 repo 根目錄執行 npm install。")
        return 1
    if not (ROOT / "node_modules" / "@napi-rs" / "canvas").exists():
        print("[X] 還沒有安裝開發用套件。請先在 repo 根目錄執行：npm install")
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    done = []
    for i in range(args.videos):
        spec = video_spec(i, args.seed, args.shots, args.small)
        info = render_video(spec, out_dir, args.node, args.crf)
        done.append(info)
        print(f"  {info['name']}.mp4  {info['width']}x{info['height']} {info['fps']}fps  {info['frames']} 幀", flush=True)
    index = {
        "synthetic": True,
        "note": "合成資料，只用來驗證流程，不代表真實準確度。",
        "videos": [{"name": d["name"], "video": d["video"].name, "bundle": f"{d['name']}.arclog.json", "truth": f"{d['name']}.truth.json"} for d in done],
    }
    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[OK] 已產生 {len(done)} 支合成影片到 {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
