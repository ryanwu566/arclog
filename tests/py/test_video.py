"""影片讀寫的測試：每一幀的時間戳、順序、方向都要對。

測試影片（tests/fixtures/video/）每一幀畫著自己幀號的條碼，所以可以從像素直接讀回
「解出來的到底是第幾幀」。同一批影片也拿去測瀏覽器的兩個影格引擎（tests/e2e）。
"""
from __future__ import annotations

import json

import pytest

from conftest import ROOT

np = pytest.importorskip("numpy")
pytest.importorskip("av")

from arclog.video import VideoWriter, iter_frames, probe, read_times  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "video"
EXPECTED = json.loads((FIX / "expected.json").read_text(encoding="utf-8"))
LAYOUT = EXPECTED["layout"]
FILES = sorted(EXPECTED["files"])


def decode_barcode(rgb) -> tuple[int, bool]:
    """由畫面讀回幀號，並檢查方向（左上角白、右上角黑）。"""
    gray = rgb.astype(np.float32).mean(axis=2)
    c = LAYOUT["cell"]
    value = 0
    for k in range(LAYOUT["bits"]):
        x = c["x0"] + k * c["w"] + c["w"] // 2
        y = c["y0"] + c["h"] // 2
        if gray[y - 4 : y + 4, x - 4 : x + 4].mean() > 128:
            value |= 1 << k
    m = LAYOUT["marker"]
    s = m["size"]
    white = gray[m["white"][1] + 8 : m["white"][1] + s - 8, m["white"][0] + 8 : m["white"][0] + s - 8].mean()
    black = gray[m["black"][1] + 8 : m["black"][1] + s - 8, m["black"][0] + 8 : m["black"][0] + s - 8].mean()
    return value, bool(white > 200 and black < 60)


@pytest.mark.parametrize("name", FILES)
def test_every_frame_is_the_right_frame(name):
    info = EXPECTED["files"][name]
    frames = list(iter_frames(FIX / name))
    assert len(frames) == info["frames"], "幀數"
    for i, fr in enumerate(frames):
        assert fr.index == i
        assert (fr.width, fr.height) == (info["displayWidth"], info["displayHeight"]), "顯示方向的解析度"
        assert abs(fr.time - info["times"][i]) < 1e-6, f"第 {i} 幀的時間戳 {fr.time} != ffprobe 的 {info['times'][i]}"
        value, upright = decode_barcode(fr.to_rgb())
        assert upright, f"第 {i} 幀的方向不對（旋轉沒有套用好）"
        assert value == i, f"第 {i} 幀解出來的條碼是 {value}"


@pytest.mark.parametrize("name", FILES)
def test_probe_and_times(name):
    info = EXPECTED["files"][name]
    p = probe(FIX / name)
    assert (p["width"], p["height"]) == (info["displayWidth"], info["displayHeight"])
    assert p["codec"] == info["codec"]
    assert abs(p["firstTime"] - info["times"][0]) < 1e-6
    times = read_times(FIX / name)
    assert len(times) == info["frames"]
    assert all(b > a for a, b in zip(times, times[1:])), "時間戳要嚴格遞增"


def test_resized_frames_keep_orientation():
    """邊解碼邊縮小（偵測時用的路徑）在帶旋轉的影片上方向也要對。"""
    for name in ("rot90_h264.mov", "rot180_h264.mov", "cfr30_h264.mp4"):
        fr = next(iter(iter_frames(FIX / name)))
        small = fr.to_rgb(size=(160, 90))
        assert small.shape == (90, 160, 3)
        gray = small.astype(np.float32).mean(axis=2)
        assert gray[4:16, 4:16].mean() > 200 and gray[4:16, 144:156].mean() < 60, name


def test_variable_frame_rate_is_really_variable():
    times = EXPECTED["files"]["vfr_h264.mp4"]["times"]
    gaps = sorted({round(b - a, 4) for a, b in zip(times, times[1:])})
    assert len(gaps) >= 4 and gaps[-1] > 2.5 * gaps[0], gaps


def test_writer_roundtrip(tmp_path):
    """寫出去再讀回來：幀數、時間戳、內容都不變。"""
    path = tmp_path / "out.mp4"
    w, h = LAYOUT["width"], LAYOUT["height"]
    src = list(iter_frames(FIX / "cfr30_h264.mp4"))[:20]
    with VideoWriter(path, w, h, fps=30) as wr:
        for fr in src:
            wr.write(fr.to_rgb())
    back = list(iter_frames(path))
    assert len(back) == 20
    for i, fr in enumerate(back):
        assert abs(fr.time - back[0].time - i / 30) < 1e-6
        assert decode_barcode(fr.to_rgb()) == (i, True)
    assert probe(path)["codec"] == "h264"
