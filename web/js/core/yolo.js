// YOLO 偵測模型的前後處理：縮放補邊（letterbox）、輸出解碼、NMS。
// 純函式，不碰 DOM。Python 對應檔：arclog/yolo.py（網站和 tools/analyze.py 用同一套邏輯）。
//
// 支援兩種 Ultralytics ONNX 輸出：
//   - 預設匯出（one-to-many head）：[1, 4+類別數, N]，每欄是 cx, cy, w, h, 各類別分數，需要 NMS
//   - nms=False 匯出（one-to-one head）：[1, N, 6]，每列是 x1, y1, x2, y2, 分數, 類別

/** 四捨五入到整數（.5 一律進位，和 Python 那邊寫法一致）。 */
function roundHalfUp(x) {
  return Math.floor(x + 0.5);
}

/**
 * 算出把 srcW×srcH 的畫面等比例縮進 dstW×dstH、置中補邊的參數。
 * @returns {{scale:number, newW:number, newH:number, padX:number, padY:number}}
 */
export function letterbox(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const newW = Math.min(dstW, Math.max(1, roundHalfUp(srcW * scale)));
  const newH = Math.min(dstH, Math.max(1, roundHalfUp(srcH * scale)));
  return {
    scale,
    newW,
    newH,
    padX: Math.floor((dstW - newW) / 2),
    padY: Math.floor((dstH - newH) / 2),
  };
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const w = x2 - x1;
  const h = y2 - y1;
  if (!(w > 0 && h > 0)) return 0;
  const inter = w * h;
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter);
}

/**
 * 解碼模型輸出，只留指定類別（籃球）。
 *
 * @param {ArrayLike<number>} data 模型輸出 output0 的資料
 * @param {number[]} dims 輸出的形狀
 * @param {object} opts
 * @param {number} opts.classIndex 籃球的類別編號（COCO 預訓練是 32 sports ball；自己訓練的單類別模型是 0）
 * @param {number} [opts.conf=0.15] 信心門檻
 * @param {number} [opts.iou=0.5]  NMS 的 IoU 門檻
 * @param {number} [opts.maxDet=8] 每幀最多留幾顆
 * @param {object} [opts.lb] letterbox() 的結果；有給的話座標會換回原始畫面
 * @returns {{x:number, y:number, w:number, h:number, conf:number}[]} x, y 是球心
 */
export function decodeDetections(data, dims, opts) {
  const conf = opts.conf != null ? opts.conf : 0.15;
  const iouThres = opts.iou != null ? opts.iou : 0.5;
  const maxDet = opts.maxDet != null ? opts.maxDet : 8;
  const cls = opts.classIndex;
  if (dims.length !== 3) throw new Error(`看不懂的模型輸出形狀 [${dims.join(', ')}]`);

  const cand = [];
  if (dims[2] === 6 && dims[1] !== 6) {
    // one-to-one：每列 x1, y1, x2, y2, score, class
    const n = dims[1];
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const score = data[o + 4];
      if (!(score >= conf)) continue;
      if (Math.floor(data[o + 5] + 0.5) !== cls) continue;
      cand.push({ x1: data[o], y1: data[o + 1], x2: data[o + 2], y2: data[o + 3], conf: score, i });
    }
  } else {
    // one-to-many：第 c 個通道在 data[c*N + i]
    const ch = dims[1];
    const n = dims[2];
    if (ch < 5 || 4 + cls >= ch) throw new Error(`模型輸出只有 ${ch - 4} 個類別，找不到類別 ${cls}`);
    const so = (4 + cls) * n;
    for (let i = 0; i < n; i++) {
      const score = data[so + i];
      if (!(score >= conf)) continue;
      const cx = data[i];
      const cy = data[n + i];
      const hw = data[2 * n + i] / 2;
      const hh = data[3 * n + i] / 2;
      cand.push({ x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh, conf: score, i });
    }
  }

  cand.sort((a, b) => b.conf - a.conf || a.i - b.i);
  const keep = [];
  for (const c of cand) {
    let ok = true;
    for (const k of keep) {
      if (iou(c, k) > iouThres) {
        ok = false;
        break;
      }
    }
    if (ok) {
      keep.push(c);
      if (keep.length >= maxDet) break;
    }
  }

  const lb = opts.lb;
  return keep.map((k) => {
    let x = (k.x1 + k.x2) / 2;
    let y = (k.y1 + k.y2) / 2;
    let w = k.x2 - k.x1;
    let h = k.y2 - k.y1;
    if (lb) {
      x = (x - lb.padX) / lb.scale;
      y = (y - lb.padY) / lb.scale;
      w /= lb.scale;
      h /= lb.scale;
    }
    return { x, y, w, h, conf: k.conf };
  });
}

/**
 * 把 RGBA 像素（已經縮放補邊成模型輸入大小）轉成模型要的 float32 CHW、0–1。
 * @param {Uint8ClampedArray|Uint8Array} rgba 長度 w*h*4
 * @param {Float32Array} [out] 可重複使用的緩衝區，長度 3*w*h
 */
export function rgbaToChw(rgba, w, h, out) {
  const n = w * h;
  const dst = out && out.length === 3 * n ? out : new Float32Array(3 * n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    dst[i] = rgba[p] / 255;
    dst[n + i] = rgba[p + 1] / 255;
    dst[2 * n + i] = rgba[p + 2] / 255;
  }
  return dst;
}
