// 軌跡擬合：最小平方拋物線、空氣阻力修正、RANSAC 穩健擬合。
// 純函式，不碰 DOM。Python 對應檔：arclog/fit.py（兩邊運算順序刻意寫成一樣）。
//
// 座標一律是「飛行座標」：U 沿籃框平面、球往 +U 飛，U=0 是近端框緣、U=1 是遠端框緣；
// v 垂直籃框平面往上，v=0 是籃框平面。長度單位是籃框內徑。

import { DRAG_K_RIM } from './constants.js';
import { mulberry32, randInt } from './prng.js';

/** 阻力模型數值積分的最大步長（籃框內徑為單位，0.1 ≈ 4.5 公分）。 */
const RK_STEP = 0.1;

/**
 * 解 3×3 線性方程組（部分選主元的高斯消去）。
 * @param {number[][]} m 3×4 增廣矩陣（會被改寫）
 * @returns {number[]|null} 解，或矩陣接近奇異時回傳 null
 */
export function solve3(m) {
  let scale = 0;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const v = Math.abs(m[r][c]);
      if (v > scale) scale = v;
    }
  }
  if (!(scale > 0)) return null;
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) {
      if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
    }
    if (!(Math.abs(m[p][i]) > 1e-12 * scale)) return null;
    if (p !== i) {
      const tmp = m[i];
      m[i] = m[p];
      m[p] = tmp;
    }
    for (let r = i + 1; r < 3; r++) {
      const f = m[r][i] / m[i][i];
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = m[i][3];
    for (let c = i + 1; c < 3; c++) s -= m[i][c] * x[c];
    x[i] = s / m[i][i];
  }
  return x;
}

/**
 * 最小平方法擬合拋物線 v = a·U² + b·U + c。
 * 先把 U 平移縮放到 [-1, 1] 再解，數值比較穩。
 * @returns {{a:number,b:number,c:number}|null}
 */
export function fitParabola(us, vs) {
  const n = us.length;
  if (n < 3) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += us[i];
  mean /= n;
  let half = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(us[i] - mean);
    if (d > half) half = d;
  }
  if (!(half > 1e-9)) return null;
  let s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const z = (us[i] - mean) / half;
    const z2 = z * z;
    s1 += z;
    s2 += z2;
    s3 += z2 * z;
    s4 += z2 * z2;
    t0 += vs[i];
    t1 += vs[i] * z;
    t2 += vs[i] * z2;
  }
  const sol = solve3([
    [s4, s3, s2, t2],
    [s3, s2, s1, t1],
    [s2, s1, n, t0],
  ]);
  if (!sol) return null;
  const a = sol[0] / (half * half);
  const bz = sol[1] / half;
  const b = bz - 2 * a * mean;
  const c = a * mean * mean - bz * mean + sol[2];
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return null;
  return { a, b, c };
}

/** 拋物線在 U 的值。 */
export function parabolaAt(p, u) {
  return (p.a * u + p.b) * u + p.c;
}

/**
 * 拋物線「下降時」通過籃框平面（v=0）的那一點。
 * 球往 +U 飛、開口向下，所以取較大的根。
 * @returns {{uc:number, slope:number}|null} slope = tan(入框角度) > 0
 */
export function descendingCrossing(p) {
  if (!(p.a < 0)) return null;
  const disc = p.b * p.b - 4 * p.a * p.c;
  if (!(disc > 0)) return null;
  const sq = Math.sqrt(disc);
  // 用不會互相抵銷的方式求兩個根
  const q = p.b >= 0 ? -(p.b + sq) / 2 : -(p.b - sq) / 2;
  const r1 = q / p.a;
  const r2 = q !== 0 ? p.c / q : r1;
  const uc = r1 > r2 ? r1 : r2;
  return { uc, slope: sq };
}

// ── 阻力模型 ────────────────────────────────────────────────────────────────
// 以 U 為自變數：y'' = −2κ·exp(2k·σ)，σ' = √(1+y'²)，在過框點 y=0、y'=−slope、σ=0。
// 推導：阻力只讓水平速度沿路徑衰減，vx(σ) = vx₀·exp(−k·σ)，而 y'' = −g/vx²。

function rkAdvance(st, x, target, kap2, k2) {
  const dist = target - x;
  const n = Math.max(1, Math.ceil(Math.abs(dist) / RK_STEP));
  const dx = dist / n;
  let y = st[0];
  let yp = st[1];
  let sg = st[2];
  for (let s = 0; s < n; s++) {
    const a1p = -kap2 * Math.exp(k2 * sg);
    const a1s = Math.sqrt(1 + yp * yp);
    const yp2 = yp + 0.5 * dx * a1p;
    const sg2 = sg + 0.5 * dx * a1s;
    const a2p = -kap2 * Math.exp(k2 * sg2);
    const a2s = Math.sqrt(1 + yp2 * yp2);
    const yp3 = yp + 0.5 * dx * a2p;
    const sg3 = sg + 0.5 * dx * a2s;
    const a3p = -kap2 * Math.exp(k2 * sg3);
    const a3s = Math.sqrt(1 + yp3 * yp3);
    const yp4 = yp + dx * a3p;
    const sg4 = sg + dx * a3s;
    const a4p = -kap2 * Math.exp(k2 * sg4);
    const a4s = Math.sqrt(1 + yp4 * yp4);
    y += (dx * (yp + 2 * yp2 + 2 * yp3 + yp4)) / 6;
    yp += (dx * (a1p + 2 * a2p + 2 * a3p + a4p)) / 6;
    sg += (dx * (a1s + 2 * a2s + 2 * a3s + a4s)) / 6;
  }
  st[0] = y;
  st[1] = yp;
  st[2] = sg;
}

/**
 * 算出軌跡模型在一串 U 的 v 值。
 * @param {{uc:number, slope:number, kappa:number, k:number}} model
 * @param {number[]} us
 * @returns {number[]}
 */
export function evalArc(model, us) {
  const n = us.length;
  const out = new Array(n);
  const { uc, slope, kappa, k } = model;
  if (!(k > 0)) {
    for (let i = 0; i < n; i++) {
      const d = us[i] - uc;
      out[i] = (-kappa * d - slope) * d;
    }
    return out;
  }
  const left = [];
  const right = [];
  for (let i = 0; i < n; i++) {
    if (us[i] <= uc) left.push(i);
    else right.push(i);
  }
  left.sort((i, j) => us[j] - us[i] || i - j); // 由過框點往回走
  right.sort((i, j) => us[i] - us[j] || i - j); // 由過框點往前走
  const kap2 = 2 * kappa;
  const k2 = 2 * k;
  let st = [0, -slope, 0];
  let x = uc;
  for (let m = 0; m < left.length; m++) {
    const i = left[m];
    rkAdvance(st, x, us[i], kap2, k2);
    x = us[i];
    out[i] = st[0];
  }
  st = [0, -slope, 0];
  x = uc;
  for (let m = 0; m < right.length; m++) {
    const i = right[m];
    rkAdvance(st, x, us[i], kap2, k2);
    x = us[i];
    out[i] = st[0];
  }
  return out;
}

function sumSq(us, vs, model) {
  const ys = evalArc(model, us);
  let s = 0;
  for (let i = 0; i < us.length; i++) {
    const r = vs[i] - ys[i];
    s += r * r;
  }
  return s;
}

/**
 * 擬合一球的軌跡：先最小平方拋物線，再用高斯–牛頓法做空氣阻力修正。
 *
 * @param {number[]} us 飛行座標 U
 * @param {number[]} vs 高度 v
 * @param {{dragK?: number}} [opts] dragK 以「1/籃框內徑」為單位；0 代表純拋物線
 * @returns {null | {ok:false, reason:string, parabola:object|null}
 *                 | {ok:true, uc:number, slope:number, kappa:number, k:number,
 *                    parabola:{a:number,b:number,c:number}, rms:number, iterations:number}}
 */
export function fitArc(us, vs, opts = {}) {
  const k = opts.dragK != null ? opts.dragK : DRAG_K_RIM;
  const n = us.length;
  const parabola = fitParabola(us, vs);
  if (!parabola) return { ok: false, reason: 'degenerate', parabola: null };
  if (!(parabola.a < 0)) return { ok: false, reason: 'not_arc', parabola };
  const cr = descendingCrossing(parabola);
  if (!cr) return { ok: false, reason: 'no_crossing', parabola };

  let p = [cr.uc, cr.slope, -parabola.a];
  let model = { uc: p[0], slope: p[1], kappa: p[2], k: k > 0 ? k : 0 };
  let sse = sumSq(us, vs, model);
  let iterations = 0;

  if (k > 0) {
    const J = [new Array(n), new Array(n), new Array(n)];
    for (let it = 0; it < 12; it++) {
      const base = evalArc(model, us);
      const steps = [1e-4, 1e-5, Math.max(1e-7, Math.abs(p[2]) * 1e-5)];
      for (let j = 0; j < 3; j++) {
        const pp = p.slice();
        const pm = p.slice();
        pp[j] += steps[j];
        pm[j] -= steps[j];
        const yp = evalArc({ uc: pp[0], slope: pp[1], kappa: pp[2], k }, us);
        const ym = evalArc({ uc: pm[0], slope: pm[1], kappa: pm[2], k }, us);
        // 殘差 r = v − y，所以 ∂r/∂p = −∂y/∂p
        for (let i = 0; i < n; i++) J[j][i] = -(yp[i] - ym[i]) / (2 * steps[j]);
      }
      const mtx = [
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let i = 0; i < n; i++) s += J[r][i] * J[c][i];
          mtx[r][c] = s;
        }
        let g = 0;
        for (let i = 0; i < n; i++) g += J[r][i] * (vs[i] - base[i]);
        mtx[r][3] = -g;
      }
      const d = solve3(mtx);
      if (!d) break;
      // 步長減半直到誤差不再變大
      let lam = 1;
      let accepted = null;
      let acceptedSse = sse;
      for (let tries = 0; tries < 8; tries++) {
        const cand = [p[0] + lam * d[0], p[1] + lam * d[1], p[2] + lam * d[2]];
        if (cand[1] > 0 && cand[2] > 0) {
          const s = sumSq(us, vs, { uc: cand[0], slope: cand[1], kappa: cand[2], k });
          if (s <= sse) {
            accepted = cand;
            acceptedSse = s;
            break;
          }
        }
        lam *= 0.5;
      }
      if (!accepted) break;
      const small =
        Math.abs(accepted[0] - p[0]) < 1e-10 && Math.abs(accepted[1] - p[1]) < 1e-10;
      p = accepted;
      sse = acceptedSse;
      model = { uc: p[0], slope: p[1], kappa: p[2], k };
      iterations = it + 1;
      if (small) break;
    }
  }

  return {
    ok: true,
    uc: model.uc,
    slope: model.slope,
    kappa: model.kappa,
    k: model.k,
    parabola,
    rms: Math.sqrt(sse / n),
    iterations,
  };
}

/** 拋物線最高點 {u, v}（阻力修正對最高點位置影響很小，驗證用拋物線即可）。 */
export function parabolaApex(p) {
  const u = -p.b / (2 * p.a);
  return { u, v: p.c - (p.b * p.b) / (4 * p.a) };
}

/** 直線最小平方 y = p + q·x。 */
export function fitLine(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (!(sxx > 1e-18)) return null;
  const q = sxy / sxx;
  return { p: my - q * mx, q };
}

/**
 * RANSAC：在一堆偵測點裡找出最像「一球投籃軌跡」的那一組。
 *
 * 輸入點用校正座標 (u, v) 加時間 t，必須已依時間排序。
 * 假設檢驗：任取 3 點定出拋物線，要求
 *   1. 開口向下，而且會往下通過籃框平面
 *   2. 最高點比籃框高 minApex、但不超過 maxApex
 *   3. 過框點離籃框不超過 [sMin, sMax]
 *   4. 入框斜率（tan 入框角度）在 [minSlope, maxSlope] 之間：太陡的是彈起來或往下掉的球
 *   5. 是「朝籃框飛來」：起點到籃框的水平距離，要比過框點到籃框的距離多 minApproach 以上。
 *      沒進之後從框上彈走的球會被這一條擋掉。
 * 內點條件：離拋物線的垂直距離 ≤ thresh，而且出現的時間和水平位置對得上（水平等速）。
 *
 * @param {{u:number,v:number,t:number}[]} pts 已依 t 排序
 * @param {object} [opts]
 * @returns {null | {dir:number, inliers:number[], parabola:object, line:{p:number,q:number}}}
 */
export function ransacArc(pts, opts = {}) {
  const o = {
    seed: 1,
    iters: 500,
    thresh: 0.15,
    timeTol: 1.0,
    minInliers: 5,
    minSampleSpan: 0.8,
    minApex: 0.3,
    maxApex: 1e9,
    sMin: -2.5,
    sMax: 3.5,
    minSlope: 0,
    maxSlope: 1e9,
    minApproach: -1e9,
    ...opts,
  };
  const n = pts.length;
  if (n < Math.max(3, o.minInliers)) return null;

  const evaluate = (parabola, line, dir) => {
    const idx = [];
    let sse = 0;
    for (let m = 0; m < n; m++) {
      const pt = pts[m];
      const slope = 2 * parabola.a * pt.u + parabola.b;
      const res = (pt.v - parabolaAt(parabola, pt.u)) / Math.sqrt(1 + slope * slope);
      if (Math.abs(res) > o.thresh) continue;
      if (Math.abs(pt.u - (line.p + line.q * pt.t)) > o.timeTol) continue;
      idx.push(m);
      sse += res * res;
    }
    return { idx, sse, parabola, line, dir };
  };

  const check = (parabola, dir, uStart) => {
    if (!parabola || !(parabola.a < 0)) return false;
    const cr = descendingCrossing(parabola);
    if (!cr) return false;
    if (!(cr.slope >= o.minSlope && cr.slope <= o.maxSlope)) return false;
    const apex = parabolaApex(parabola);
    if (!(apex.v >= o.minApex && apex.v <= o.maxApex)) return false;
    // dir<0 時下降那一側是較小的根
    const ucU = dir > 0 ? cr.uc : -parabola.b / parabola.a - cr.uc;
    const s = dir > 0 ? ucU : 1 - ucU;
    if (!(s >= o.sMin && s <= o.sMax)) return false;
    const start = dir > 0 ? uStart : 1 - uStart;
    return Math.abs(start - 0.5) - Math.abs(s - 0.5) >= o.minApproach;
  };

  const trySample = (i, j, k, best) => {
    const a = pts[i];
    const b = pts[j];
    const c = pts[k];
    if (!(a.t < b.t && b.t < c.t)) return best;
    const d1 = b.u - a.u;
    const d2 = c.u - b.u;
    if (!(d1 * d2 > 0)) return best;
    if (Math.abs(c.u - a.u) < o.minSampleSpan) return best;
    const dir = d1 > 0 ? 1 : -1;
    const parabola = fitParabola([a.u, b.u, c.u], [a.v, b.v, c.v]);
    if (!check(parabola, dir, a.u)) return best;
    const q = (c.u - a.u) / (c.t - a.t);
    const line = { p: a.u - q * a.t, q };
    const cand = evaluate(parabola, line, dir);
    if (
      !best ||
      cand.idx.length > best.idx.length ||
      (cand.idx.length === best.idx.length && cand.sse < best.sse)
    ) {
      return cand;
    }
    return best;
  };

  let best = null;
  const total = (n * (n - 1) * (n - 2)) / 6;
  if (total <= o.iters) {
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        for (let k = j + 1; k < n; k++) best = trySample(i, j, k, best);
      }
    }
  } else {
    const rng = mulberry32(o.seed);
    for (let it = 0; it < o.iters; it++) {
      const i = randInt(rng, n);
      const j = randInt(rng, n);
      const k = randInt(rng, n);
      if (i === j || j === k || i === k) continue;
      // 依索引排序（點已依時間排序）
      const lo = Math.min(i, j, k);
      const hi = Math.max(i, j, k);
      const mid = i + j + k - lo - hi;
      best = trySample(lo, mid, hi, best);
    }
  }
  if (!best || best.idx.length < o.minInliers) return null;

  // 用內點重新擬合，直到內點集合不再改變（最多 4 輪）
  for (let round = 0; round < 4; round++) {
    const us = best.idx.map((m) => pts[m].u);
    const vs = best.idx.map((m) => pts[m].v);
    const ts = best.idx.map((m) => pts[m].t);
    const parabola = fitParabola(us, vs);
    const line = fitLine(ts, us);
    if (!line || !check(parabola, best.dir, us[0])) break;
    if (!(line.q * best.dir > 0)) break;
    const cand = evaluate(parabola, line, best.dir);
    if (cand.idx.length < o.minInliers) break;
    const same =
      cand.idx.length === best.idx.length && cand.idx.every((v, m) => v === best.idx[m]);
    best = cand;
    if (same) break;
  }

  return { dir: best.dir, inliers: best.idx, parabola: best.parabola, line: best.line };
}
