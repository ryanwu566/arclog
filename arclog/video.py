"""用 PyAV 讀寫影片。需要 `av` 和 `numpy`（PyAV 內含 FFmpeg，不必另外安裝）。

讀影片時最重要的兩件事，都是為了和瀏覽器看到的畫面對齊：

1. 每一幀的時間戳取自影片本身（`frame.time`），不是用「第幾幀 ÷ 幀率」去推。
   iPhone 的影片常常是可變幀率，用推的會慢慢錯位。
2. 影片如果帶旋轉資訊（手機直拍、或橫拍時手機上下顛倒），這裡會轉成「播放時看到的方向」，
   座標才會和網站上標的一樣。
"""
from __future__ import annotations

from fractions import Fraction
from pathlib import Path
from typing import Iterator

import av
import numpy as np


def _display_turns(frame) -> int:
    """這一幀要顯示時需要逆時針轉幾個 90 度（給 numpy.rot90 用）。"""
    try:
        rot = float(frame.rotation or 0)
    except (AttributeError, TypeError, ValueError):
        rot = 0.0
    # PyAV 的 rotation 是顯示矩陣的旋轉角（逆時針為正），和 numpy.rot90 的方向相同
    return int(round(rot / 90.0)) % 4


class Frame:
    """解碼出來的一幀。只有呼叫 to_rgb() 時才真的轉成像素陣列，沒用到的幀幾乎不花時間。"""

    __slots__ = ("index", "time", "width", "height", "_frame", "_turns")

    def __init__(self, index: int, time: float, frame, turns: int):
        self.index = index
        self.time = time
        self._frame = frame
        self._turns = turns
        if turns % 2:
            self.width, self.height = frame.height, frame.width
        else:
            self.width, self.height = frame.width, frame.height

    def to_rgb(self, size: tuple[int, int] | None = None) -> np.ndarray:
        """回傳 (高, 寬, 3) 的 uint8 RGB 陣列，方向和播放時看到的一樣。

        size=(寬, 高) 可以順便縮放（寬高指的是顯示方向）。
        """
        kw = {"format": "rgb24"}
        if size is not None:
            w, h = size
            if self._turns % 2:
                w, h = h, w
            kw.update(width=int(w), height=int(h), interpolation="AREA")
        arr = self._frame.to_ndarray(**kw)
        if self._turns:
            arr = np.rot90(arr, self._turns)
        return np.ascontiguousarray(arr)


def iter_frames(path) -> Iterator[Frame]:
    """依顯示順序走過影片的每一幀。"""
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        index = 0
        for frame in container.decode(stream):
            if frame.pts is None:
                continue
            t = float(frame.pts * frame.time_base)
            yield Frame(index, t, frame, _display_turns(frame))
            index += 1


def probe(path) -> dict:
    """影片的基本資訊（解析度是顯示方向的）。"""
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        first = next(container.decode(stream))
        turns = _display_turns(first)
        w, h = (first.height, first.width) if turns % 2 else (first.width, first.height)
        rate = stream.average_rate or stream.guessed_rate
        duration = None
        if stream.duration is not None and stream.time_base is not None:
            duration = float(stream.duration * stream.time_base)
        elif container.duration is not None:
            duration = container.duration / 1e6
        return {
            "name": Path(path).name,
            "size": Path(path).stat().st_size,
            "width": w,
            "height": h,
            "rotation": (turns * 90) % 360,
            "fps": float(rate) if rate else None,
            "frames": int(stream.frames or 0),  # 檔頭寫的幀數，可能是 0 或不準
            "duration": duration,
            "codec": stream.codec_context.name,
            "firstTime": float(first.pts * first.time_base) if first.pts is not None else 0.0,
        }


def read_times(path) -> list[float]:
    """解碼整支影片，回傳每一幀的時間戳（秒）。"""
    return [f.time for f in iter_frames(path)]


class VideoWriter:
    """把 RGB 畫面寫成 H.264 的 MP4（瀏覽器、手機、QuickTime 都能播）。"""

    def __init__(self, path, width: int, height: int, fps: float, crf: int = 20, preset: str = "veryfast",
                 codec: str = "libx264", bframes: int | None = None, gop: int | None = None):
        self.path = str(path)
        # yuv420p 需要偶數的寬高
        self.width = int(width) - int(width) % 2
        self.height = int(height) - int(height) % 2
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._container = av.open(self.path, mode="w")
        rate = Fraction(fps).limit_denominator(1001 * 120)
        self._stream = self._container.add_stream(codec, rate=rate)
        self._stream.width = self.width
        self._stream.height = self.height
        self._stream.pix_fmt = "yuv420p"
        opts = {"crf": str(crf), "preset": preset}
        if bframes is not None:
            opts["bf"] = str(bframes)
        if gop is not None:
            opts["g"] = str(gop)
        self._stream.options = opts
        self._count = 0

    def write(self, rgb: np.ndarray) -> None:
        if rgb.shape[0] != self.height or rgb.shape[1] != self.width:
            rgb = np.ascontiguousarray(rgb[: self.height, : self.width])
        frame = av.VideoFrame.from_ndarray(rgb, format="rgb24")
        frame.pts = self._count
        self._count += 1
        for packet in self._stream.encode(frame):
            self._container.mux(packet)

    def close(self) -> None:
        if self._container is None:
            return
        for packet in self._stream.encode(None):
            self._container.mux(packet)
        self._container.close()
        self._container = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
