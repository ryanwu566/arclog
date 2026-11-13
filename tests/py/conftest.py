"""pytest 共用設定：讓測試找得到 repo 根目錄的 arclog 套件，並提供讀向量與比對的工具。"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def vectors(name: str):
    """讀 tests/vectors/ 裡 JS 和 Python 共用的測試向量。"""
    return json.loads((ROOT / "tests" / "vectors" / name).read_text(encoding="utf-8"))


def assert_close(actual, expected, tol: float = 1e-6, path: str = "value") -> None:
    """遞迴比較：數字容許 tol 的誤差，其餘必須完全相同。只檢查 expected 裡有的欄位。"""
    if isinstance(expected, bool) or expected is None or isinstance(expected, str):
        assert actual == expected and type(actual) is type(expected), f"{path}: {actual!r} != {expected!r}"
        return
    if isinstance(expected, (int, float)):
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool), f"{path}: 應為數字，得到 {actual!r}"
        if isinstance(expected, float) and math.isnan(expected):
            assert math.isnan(actual), f"{path}: 應為 NaN"
            return
        assert abs(actual - expected) <= tol, f"{path}: {actual!r} 和 {expected!r} 相差 {abs(actual - expected)}（容許 {tol}）"
        return
    if isinstance(expected, list):
        assert isinstance(actual, (list, tuple)), f"{path}: 應為清單"
        assert len(actual) == len(expected), f"{path}: 長度 {len(actual)} != {len(expected)}"
        for i, e in enumerate(expected):
            assert_close(actual[i], e, tol, f"{path}[{i}]")
        return
    assert isinstance(actual, dict), f"{path}: 應為 dict，得到 {type(actual).__name__}"
    for k, e in expected.items():
        assert k in actual, f"{path}.{k} 不存在"
        assert_close(actual[k], e, tol, f"{path}.{k}")
