// 影格來源的共同介面與工具。
//
// 網站有三種來源，後面的校正、標記、偵測都只透過這個介面拿畫面：
//
//   codec-source.js  解封裝＋WebCodecs（主要做法：幀的身分由容器決定，沒有 seek 的模糊空間）
//   video-source.js  <video>＋requestVideoFrameCallback（退路）
//   synth-source.js  示範模式的合成畫面
//
// 介面（FrameSource）：
//   engine      'codec' | 'video' | 'synthetic'
//   name, size  檔名與大小
//   width, height     顯示方向的解析度（已套用旋轉）
//   frameCount, frameTimes（Float64Array，每一幀的時間戳，秒）, fps, duration
//   timeSource  'container'（讀自影片檔）| 'estimated'（估計的固定幀率）| 'synthetic'
//   codec, rotation, warnings（給使用者看的提醒）
//   getFrame(i) → Promise<{index, time, image}>
//        image 可以直接 drawImage；只保證到下一次 getFrame 之前有效，要留著請自己複製
//   scan({from, to, stride, signal, onFrame}) → Promise<{frames, cancelled}>
//        依序走過影格；onFrame({index, time, draw}) 可以是 async，
//        draw(ctx, dx, dy, dw, dh) 只在 onFrame 還沒結束前有效
//   dispose()

/** 開影片失敗時丟出的錯誤。code 給程式判斷，message 是給使用者看的中文。 */
export class SourceError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
    this.detail = detail || null;
  }
}

/** 由時間戳算出典型幀率與是否為可變幀率。 */
export function describeTiming(times) {
  const n = times.length;
  if (n < 2) return { fps: 30, vfr: false, minDt: 0, maxDt: 0 };
  const dts = new Float64Array(n - 1);
  for (let i = 1; i < n; i++) dts[i - 1] = times[i] - times[i - 1];
  const sorted = Float64Array.from(dts).sort();
  const median = sorted[sorted.length >> 1];
  let irregular = 0;
  for (let i = 0; i < dts.length; i++) {
    if (Math.abs(dts[i] - median) > 0.2 * median) irregular++;
  }
  return {
    fps: median > 0 ? 1 / median : 30,
    vfr: irregular > Math.max(1, 0.01 * dts.length),
    minDt: sorted[0],
    maxDt: sorted[sorted.length - 1],
  };
}

/** 在遞增的時間戳陣列裡找最接近 t 的索引。 */
export function nearestIndex(times, t) {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}

/** 把很多次連續的非同步呼叫排成一列，一次只跑一個。 */
export function serialQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const p = tail.then(fn, fn);
    tail = p.then(
      () => {},
      () => {},
    );
    return p;
  };
}

export function clampIndex(i, count) {
  const k = Math.round(Number(i) || 0);
  return k < 0 ? 0 : k >= count ? count - 1 : k;
}

/** 建立畫布：優先用 OffscreenCanvas，沒有就用一般的 canvas 元素。 */
export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
