#!/usr/bin/env python3
"""產生逐幀定位用的測試影片（tests/fixtures/video/）。

    python tests/make_video_fixtures.py

每一幀畫著自己幀號的「條碼」（12 個黑白方塊＝幀號的二進位），左上角是白色方塊、右上角是黑色方塊。
所以不管用哪個瀏覽器引擎或 Python 解出一幀，都可以從像素讀回「這到底是第幾幀、方向對不對」。

這些影片完全是程式畫的，沒有任何實拍內容，檔案很小，是 .gitignore 裡唯一允許提交的影片。
需要 PATH 上有 ffmpeg 和 ffprobe（只有重新產生時才需要；跑測試不需要）。

同時寫出 expected.json：ffprobe 讀到的每一幀時間戳，當作三方（Mediabunny、PyAV、瀏覽器）比對的基準。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures" / "video"

W, H = 320, 180
BITS = 12
CELL_W, CELL_H = 24, 60
CELL_X0, CELL_Y0 = 16, 80
MARK = 40

#: 條碼的版面，測試程式（JS 和 Python）讀這份來解碼
LAYOUT = {
    "width": W, "height": H, "bits": BITS,
    "cell": {"x0": CELL_X0, "y0": CELL_Y0, "w": CELL_W, "h": CELL_H},
    "marker": {"size": MARK, "white": [0, 0], "black": [W - MARK, 0]},
}


def draw_frame(index: int) -> Image.Image:
    img = Image.new("RGB", (W, H), (128, 128, 128))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, MARK - 1, MARK - 1], fill=(255, 255, 255))
    d.rectangle([W - MARK, 0, W - 1, MARK - 1], fill=(0, 0, 0))
    for k in range(BITS):
        on = (index >> k) & 1
        x = CELL_X0 + k * CELL_W
        d.rectangle([x, CELL_Y0, x + CELL_W - 1, CELL_Y0 + CELL_H - 1], fill=(255, 255, 255) if on else (0, 0, 0))
    d.text((CELL_X0, CELL_Y0 + CELL_H + 8), f"frame {index}", fill=(255, 255, 0))
    return img


def run(cmd: list[str]) -> str:
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr.decode("utf-8", "replace")[-2000:])
        raise SystemExit(f"指令失敗：{' '.join(cmd[:6])} …")
    return r.stdout.decode("utf-8", "replace")


def probe(path: Path) -> dict:
    out = json.loads(run([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-of", "json",
        "-show_entries", "stream=codec_name,width,height,avg_frame_rate,nb_frames:stream_side_data=rotation:frame=pts_time",
        str(path),
    ]))
    st = out["streams"][0]
    times = sorted(float(f["pts_time"]) for f in out["frames"] if "pts_time" in f)
    rot = 0
    for sd in st.get("side_data_list", []):
        if "rotation" in sd:
            rot = int(round(float(sd["rotation"])))
    return {"codec": st["codec_name"], "codedWidth": st["width"], "codedHeight": st["height"], "ffprobeRotation": rot, "times": times}


def main() -> int:
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        print("[X] 需要 ffmpeg 和 ffprobe。Windows 可以用：winget install Gyan.FFmpeg")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    for old in list(OUT.glob("*.mp4")) + list(OUT.glob("*.mov")):
        old.unlink()
    n = 60
    expected: dict = {"layout": LAYOUT, "files": {}}
    with tempfile.TemporaryDirectory(prefix="arclog_fix_") as tmp:
        tmp = Path(tmp)
        for i in range(n):
            draw_frame(i).save(tmp / f"f{i:04d}.png")
        src = str(tmp / "f%04d.png")
        x264 = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]

        def add(name: str, note: str, display: tuple[int, int] = (W, H)):
            info = probe(OUT / name)
            info.update(note=note, frames=len(info["times"]), displayWidth=display[0], displayHeight=display[1],
                        bytes=(OUT / name).stat().st_size)
            expected["files"][name] = info
            print(f"  {name:22s} {info['frames']:3d} 幀 {info['bytes'] / 1024:6.1f} KB  {info['codec']}  第一幀 {info['times'][0]:.4f}s  旋轉 {info['ffprobeRotation']}  {note}")

        # 1. 固定 30fps、沒有 B 幀
        run(["ffmpeg", "-y", "-v", "error", "-framerate", "30", "-i", src, *x264, "-bf", "0", "-g", "15", str(OUT / "cfr30_h264.mp4")])
        add("cfr30_h264.mp4", "固定 30fps，沒有 B 幀")

        # 2. 有 B 幀（解碼順序和顯示順序不同，檔案裡有 edit list）
        run(["ffmpeg", "-y", "-v", "error", "-framerate", "30", "-i", src, *x264, "-bf", "3", "-g", "30", str(OUT / "bframes_h264.mp4")])
        add("bframes_h264.mp4", "有 B 幀，解碼順序和顯示順序不同")

        # 3. 可變幀率：把時間基準調細到 1/90000 秒，再讓每一幀的時間前後挪動（間隔約 0.01–0.057 秒）
        run(["ffmpeg", "-y", "-v", "error", "-framerate", "30", "-i", src,
             "-vf", "settb=1/90000,setpts='(N+0.35*sin(N*1.7))*3000'", "-fps_mode", "passthrough", "-enc_time_base", "1:90000",
             *x264, "-bf", "0", "-g", "15", "-video_track_timescale", "90000", str(OUT / "vfr_h264.mp4")])
        add("vfr_h264.mp4", "可變幀率（每幀間隔約 0.01–0.057 秒）")

        # 4. 60fps 的 .mov
        run(["ffmpeg", "-y", "-v", "error", "-framerate", "60", "-i", src, *x264, "-bf", "0", "-g", "30", str(OUT / "cfr60_h264.mov")])
        add("cfr60_h264.mov", "60fps，QuickTime 容器")

        # 5、6. 帶旋轉資訊：像素先反方向轉好，再寫入旋轉標記，播放時看到的應該是正的
        #    ffmpeg 的 -display_rotation 是「逆時針」角度；transpose=1 是順時針轉 90 度。
        run(["ffmpeg", "-y", "-v", "error", "-framerate", "30", "-i", src, "-vf", "transpose=1", *x264, "-bf", "0", "-g", "15", str(tmp / "t90.mp4")])
        run(["ffmpeg", "-y", "-v", "error", "-display_rotation:v:0", "90", "-i", str(tmp / "t90.mp4"), "-c", "copy", str(OUT / "rot90_h264.mov")])
        add("rot90_h264.mov", "像素是直的（180×320），帶 90 度旋轉標記；播放時應為 320×180")

        run(["ffmpeg", "-y", "-v", "error", "-framerate", "30", "-i", src, "-vf", "transpose=1,transpose=1", *x264, "-bf", "0", "-g", "15", str(tmp / "t180.mp4")])
        run(["ffmpeg", "-y", "-v", "error", "-display_rotation:v:0", "180", "-i", str(tmp / "t180.mp4"), "-c", "copy", str(OUT / "rot180_h264.mov")])
        add("rot180_h264.mov", "像素上下顛倒，帶 180 度旋轉標記（手機橫拍拿反時就是這樣）")

        # 7. 第一幀的時間不是 0
        run(["ffmpeg", "-y", "-v", "error", "-framerate", "30", "-i", src, "-vf", "setpts=PTS+0.5/TB", *x264, "-bf", "0", "-g", "15",
             "-avoid_negative_ts", "disabled", str(OUT / "offset_h264.mp4")])
        add("offset_h264.mp4", "第一幀的時間戳是 0.5 秒，不是 0")

        # 8. HEVC（iPhone「高效率」格式）；瀏覽器沒有硬體解碼時這個檔會被略過
        run(["ffmpeg", "-y", "-v", "error", "-framerate", "30", "-i", src, "-c:v", "libx265", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p",
             "-x265-params", "log-level=error:bframes=0:keyint=15", "-tag:v", "hvc1", str(OUT / "cfr30_hevc.mov")])
        add("cfr30_hevc.mov", "HEVC（hvc1），沒有 B 幀")

        # 確認帶旋轉的檔案用 ffmpeg 自動旋轉後真的是正的（左上白、右上黑）
        for name in ("rot90_h264.mov", "rot180_h264.mov"):
            png = tmp / f"{name}.png"
            run(["ffmpeg", "-y", "-v", "error", "-i", str(OUT / name), "-frames:v", "1", str(png)])
            im = Image.open(png).convert("L")
            assert im.size == (W, H), f"{name} 自動旋轉後大小是 {im.size}"
            tl = im.crop((8, 8, MARK - 8, MARK - 8)).resize((1, 1)).getpixel((0, 0))
            tr = im.crop((W - MARK + 8, 8, W - 8, MARK - 8)).resize((1, 1)).getpixel((0, 0))
            assert tl > 200 and tr < 60, f"{name} 自動旋轉後方向不對（左上 {tl}、右上 {tr}）"

    (OUT / "expected.json").write_text(json.dumps(expected, indent=1) + "\n", encoding="utf-8")
    total = sum(f["bytes"] for f in expected["files"].values())
    print(f"共 {len(expected['files'])} 個檔案、{total / 1024:.0f} KB，已寫入 {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
