// 標註內插：使用者每球只點 4–6 個球心，其餘幀的球心沿擬合軌跡補上。
// 純函式，不碰 DOM。Python 對應檔：arclog/interp.py
//
// 作法：
//   1. 相鄰兩個手點之間，假設水平速度固定 → 飛行座標 U 對時間做線性內插。
//   2. 高度 v 取擬合軌跡在該 U 的值，再加上兩端手點殘差的線性內插，
//      讓補出來的點在手點所在的幀剛好等於手點（不會跳一下）。

import { toHoop, toImage } from './geometry.js';
import { evalArc } from './fit.js';

/**
 * @param {{frame:number, t:number, x:number, y:number}[]} manual 手點（像素座標）
 * @param {ArrayLike<number>} frameTimes 每一幀的時間戳（秒），索引就是幀號
 * @param {object} hoop makeHoopFrame 的結果
 * @param {{model:object, flip:boolean}} shot analyzeShot 的結果
 * @returns {{frame:number, t:number, x:number, y:number, src:'manual'|'interp'}[]}
 *          由第一個手點到最後一個手點之間的每一幀
 */
export function interpolateShot(manual, frameTimes, hoop, shot) {
  const pts = manual.slice().sort((a, b) => a.frame - b.frame);
  // 同一幀重複點的話留最後一個
  const uniq = [];
  for (const p of pts) {
    if (uniq.length && uniq[uniq.length - 1].frame === p.frame) uniq[uniq.length - 1] = p;
    else uniq.push(p);
  }
  if (uniq.length < 2) {
    return uniq.map((p) => ({ frame: p.frame, t: p.t, x: p.x, y: p.y, src: 'manual' }));
  }

  const U = new Array(uniq.length);
  const V = new Array(uniq.length);
  for (let k = 0; k < uniq.length; k++) {
    const [u, v] = toHoop(hoop, uniq[k].x, uniq[k].y);
    U[k] = shot.flip ? 1 - u : u;
    V[k] = v;
  }
  const fitted = evalArc(shot.model, U);
  const resid = V.map((v, k) => v - fitted[k]);

  const out = [];
  const midU = [];
  const midMeta = [];
  for (let k = 0; k < uniq.length; k++) {
    const p = uniq[k];
    out.push({ frame: p.frame, t: p.t, x: p.x, y: p.y, src: 'manual' });
    if (k === uniq.length - 1) break;
    const q = uniq[k + 1];
    const span = q.t - p.t;
    for (let f = p.frame + 1; f < q.frame; f++) {
      const t = frameTimes[f];
      const w = span > 0 ? (t - p.t) / span : 0;
      midU.push(U[k] + w * (U[k + 1] - U[k]));
      midMeta.push({ at: out.length, frame: f, t, e: resid[k] + w * (resid[k + 1] - resid[k]) });
      out.push(null);
    }
  }
  const midV = evalArc(shot.model, midU);
  for (let m = 0; m < midMeta.length; m++) {
    const meta = midMeta[m];
    const u = shot.flip ? 1 - midU[m] : midU[m];
    const [x, y] = toImage(hoop, u, midV[m] + meta.e);
    out[meta.at] = { frame: meta.frame, t: meta.t, x, y, src: 'interp' };
  }
  return out;
}
