// 一球的分析：入框角度、過框位置、進球建議。
// 純函式，不碰 DOM。Python 對應檔：arclog/shot.py

import {
  BALL_RADIUS_RIM,
  DRAG_K_RIM,
  MAKE_NEAR_FACTOR,
  MAKE_FAR_FACTOR,
  roundAngle,
} from './constants.js';
import { fitArc, evalArc, parabolaApex } from './fit.js';

/**
 * 依「過框位置」和「入框角度」建議進球與否。
 *
 * s：球心通過籃框平面時的位置，0 = 近端框緣（前緣）、1 = 遠端框緣（後緣）。
 *
 * 幾何上：
 *   - 球心路徑到前緣的垂直距離 = s·sinθ。小於球半徑就會碰到前緣。
 *   - 球心過平面時離後緣的距離 = 1−s。小於球半徑時，球在平面以上就先撞到後緣。
 *
 * 分區：
 *   clean：兩邊都有一個球半徑以上的空間 → 建議進球
 *   rim  ：會擦到框但多半還是會進 → 建議進球，介面會提醒使用者確認
 *   short / long：偏短 / 偏長 → 建議沒進
 *
 * 側拍看不到左右偏差，所以這只是建議，使用者可以一鍵改正。
 */
export function judgeMake(s, angleDeg) {
  const theta = (angleDeg * Math.PI) / 180;
  const nearClear = s * Math.sin(theta);
  const farGap = 1 - s;
  const R = BALL_RADIUS_RIM;
  let zone;
  if (nearClear >= R && farGap >= R) {
    zone = 'clean';
  } else if (nearClear >= MAKE_NEAR_FACTOR * R && farGap >= MAKE_FAR_FACTOR * R) {
    zone = 'rim';
  } else if (farGap < MAKE_FAR_FACTOR * R && nearClear >= MAKE_NEAR_FACTOR * R) {
    zone = 'long';
  } else if (nearClear < MAKE_NEAR_FACTOR * R && farGap >= MAKE_FAR_FACTOR * R) {
    zone = 'short';
  } else {
    zone = s < 0.5 ? 'short' : 'long';
  }
  return { made: zone === 'clean' || zone === 'rim', zone, nearClear, farGap };
}

/**
 * 分析一球。
 *
 * @param {{u:number, v:number, t:number}[]} points 球心（籃框座標）加時間；至少 3 點
 * @param {{dragK?: number}} [opts]
 * @returns {{ok:false, reason:string} | {
 *   ok:true,
 *   angleDeg:number,   // 入框角度（記到小數一位）
 *   angleRaw:number,   // 未捨入
 *   crossS:number,     // 過框位置：0 前緣、1 後緣
 *   made:boolean, zone:string,
 *   flip:boolean,      // true 代表球是由「後緣」往「前緣」飛（校正時前後點反了）
 *   model:{uc:number, slope:number, kappa:number, k:number},
 *   parabola:{a:number,b:number,c:number},
 *   apex:{u:number, v:number},  // 最高點（飛行座標）
 *   rms:number,        // 擬合殘差（籃框內徑為單位）
 *   monotonic:boolean  // 各點的水平位置是否隨時間一路往前
 * }}
 */
export function analyzeShot(points, opts = {}) {
  const n = points.length;
  if (n < 3) return { ok: false, reason: 'too_few_points' };
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  order.sort((i, j) => points[i].t - points[j].t || i - j);
  const first = points[order[0]];
  const last = points[order[n - 1]];
  const du = last.u - first.u;
  if (!(Math.abs(du) > 1e-9)) return { ok: false, reason: 'no_motion' };
  const flip = du < 0;

  const us = new Array(n);
  const vs = new Array(n);
  for (let m = 0; m < n; m++) {
    const p = points[order[m]];
    us[m] = flip ? 1 - p.u : p.u;
    vs[m] = p.v;
  }
  let monotonic = true;
  for (let m = 1; m < n; m++) {
    if (!(us[m] > us[m - 1])) monotonic = false;
  }

  const dragK = opts.dragK != null ? opts.dragK : DRAG_K_RIM;
  const fit = fitArc(us, vs, { dragK });
  if (!fit || !fit.ok) return { ok: false, reason: fit ? fit.reason : 'degenerate' };

  const angleRaw = (Math.atan(fit.slope) * 180) / Math.PI;
  const angleDeg = roundAngle(angleRaw);
  const judge = judgeMake(fit.uc, angleRaw);
  return {
    ok: true,
    angleDeg,
    angleRaw,
    crossS: fit.uc,
    made: judge.made,
    zone: judge.zone,
    flip,
    model: { uc: fit.uc, slope: fit.slope, kappa: fit.kappa, k: fit.k },
    parabola: fit.parabola,
    apex: parabolaApex(fit.parabola),
    rms: fit.rms,
    monotonic,
  };
}

/**
 * 取樣擬合出來的軌跡，給疊圖用。
 * @param {{model:object, flip:boolean}} shot analyzeShot 的結果
 * @param {number} uFrom 校正座標 u 的起點
 * @param {number} uTo   校正座標 u 的終點
 * @param {number} [count=48]
 * @returns {{u:number, v:number}[]} 校正座標（不是飛行座標）
 */
export function sampleArc(shot, uFrom, uTo, count = 48) {
  const us = new Array(count);
  const Us = new Array(count);
  for (let i = 0; i < count; i++) {
    const u = uFrom + ((uTo - uFrom) * i) / (count - 1);
    us[i] = u;
    Us[i] = shot.flip ? 1 - u : u;
  }
  const vs = evalArc(shot.model, Us);
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = { u: us[i], v: vs[i] };
  return out;
}
