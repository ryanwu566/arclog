"""ArcLog 的 Python 共用程式庫。

和網站的 web/js/core/ 一一對應：同一套幾何、擬合、進球判定、軌跡邏輯，
由 tests/vectors/ 的共用測試向量保證兩邊算出一樣的結果。

    constants  常數
    prng       可重現的亂數（和 JS 相同的 mulberry32）
    geometry   籃框座標系
    fit        拋物線擬合、空氣阻力修正、RANSAC
    shot       入框角度與進球建議
    track      偵測點 → 一球一球的投籃
    stats      練習統計
    interp     標註內插
    csvio      CSV 匯出匯入
    bundle     標註包的讀取與檢查
    yolo       偵測模型的前後處理
    detector   用 onnxruntime 跑 ONNX 模型（需要 onnxruntime、numpy）
    video      用 PyAV 讀寫影片（需要 av、numpy）
"""

__version__ = "0.1.0"
