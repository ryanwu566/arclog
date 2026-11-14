// 自動流程的共用部分：把影格送進偵測器、收集偵測結果、跑整條分析、把結果放進這次練習。
// 上傳影片、示範、相機錄影（錄完補分析）都用這裡。

import { letterbox } from '../core/yolo.js';
import { analyzeAuto } from '../core/autoshots.js';
import { toImage } from '../core/geometry.js';
import { sampleArc } from '../core/shot.js';
import { planeToImage } from '../core/viewangle.js';
import { roundAngle } from '../core/constants.js';

/** 每秒至少看幾幀（偵測密度）。30fps 的影片每幀都看，60fps 的每 3 幀看一幀。 */
export function strideFor(fps, perSecond = 20) {
  return Math.max(1, Math.floor(fps / perSecond + 1e-6));
}

/**
 * 依序把影格縮放補邊後送進偵測器（最多兩幀同時在等結果，解碼和推論可以重疊）。
 * @param {object} o
 * @param {object} o.source FrameSource
 * @param {object} o.detector createDetector 或 createSimulatedDetector 的結果
 * @param {number} [o.from=0] @param {number} [o.to] @param {number} [o.stride=1]
 * @param {AbortSignal} [o.signal]
 * @param {(p:{done:number,total:number,rate:number,left:number}) => void} [o.onProgress]
 * @returns {Promise<{dets:object[], frames:number, cancelled:boolean, msPerFrame:number, seconds:number}>}
 */
export async function scanSource(o) {
  const { source, detector } = o;
  const { width: W, height: H } = detector.input;
  const lb = letterbox(source.width, source.height, W, H);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  const from = o.from || 0;
  const to = o.to != null ? o.to : source.frameCount - 1;
  const stride = o.stride || 1;
  const total = Math.ceil((to - from + 1) / stride);
  const dets = [];
  let done = 0;
  let inferMs = 0;
  let failure = null;
  let wake = null;
  const t0 = performance.now();
  const progress = () => {
    if (!o.onProgress) return;
    const el = (performance.now() - t0) / 1000;
    const rate = done / Math.max(el, 0.001);
    o.onProgress({ done, total, rate, left: rate > 0 ? (total - done) / rate : Infinity });
  };
  const res = await source.scan({
    from,
    to,
    stride,
    signal: o.signal,
    onFrame: async ({ index, time, draw }) => {
      if (failure) throw failure;
      ctx.fillStyle = 'rgb(114,114,114)';
      ctx.fillRect(0, 0, W, H);
      draw(ctx, lb.padX, lb.padY, lb.newW, lb.newH);
      const data = ctx.getImageData(0, 0, W, H);
      while (detector.pending >= 2 && !failure) {
        await new Promise((r) => {
          wake = r;
        });
      }
      if (failure) throw failure;
      detector
        .detect(data.data.buffer, lb)
        .then(({ dets: ds, ms }) => {
          for (const d of ds) dets.push({ f: index, t: time, cls: d.cls || 'ball', x: d.x, y: d.y, w: d.w, h: d.h, conf: d.conf });
          inferMs += ms;
        })
        .catch((err) => {
          failure = failure || err;
        })
        .finally(() => {
          done++;
          if (done % 3 === 0 || done === total) progress();
          if (wake) {
            const w = wake;
            wake = null;
            w();
          }
        });
    },
  });
  while (detector.pending > 0 && !failure) {
    await new Promise((r) => {
      wake = r;
      setTimeout(r, 50);
    });
  }
  if (failure) throw failure;
  return { dets, frames: done, cancelled: !!res.cancelled, msPerFrame: done ? inferMs / done : 0, seconds: (performance.now() - t0) / 1000 };
}

/** 這個偵測器找得到籃框嗎（沒有的話要請使用者點兩下）。 */
export function detectorHasRim(detector) {
  return !!(detector && detector.classes && detector.classes.rim != null);
}

/**
 * 跑分析，並為每一球算好「疊在原本畫面上」的軌跡線（報告的疊圖用；投籃平面模式要換回原本的畫面）。
 * @returns analyzeAuto 的結果，每一球多了 curve（[x, y] 像素）和 pts（偵測點的原本像素座標）
 */
export function analyze(dets, source, opts = {}) {
  const res = analyzeAuto(dets, { width: source.width, height: source.height, ...opts });
  if (!res.ok) return res;
  for (const s of res.shots) {
    s.pts = (s.points || []).map((p) => ({ f: p.f, t: p.t, x: p.px != null ? p.px : p.x, y: p.py != null ? p.py : p.y }));
    s.curve = null;
    if (!s.model || !s.points || !s.points.length) continue;
    const hoop = res.hoop;
    const us = s.points.map((p) => ((p.x - hoop.ox) * hoop.ux + (p.y - hoop.oy) * hoop.uy) / hoop.len);
    const cross = s.flip ? 1 - s.crossS : s.crossS;
    const arc = sampleArc(s, s.flip ? Math.max(...us) : Math.min(...us), cross, 40);
    const curve = [];
    for (const q of arc) {
      const [x, y] = toImage(hoop, q.u, q.v);
      const p = res.mode === 'plane' ? planeToImage(res.cam, x, y) : [x, y];
      if (p) curve.push([Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
    }
    s.curve = curve;
  }
  return res;
}

/** 把分析結果整理成這次練習的每一球（session.shots 的格式）。 */
export function shotsFromResult(res) {
  return res.shots.map((s, i) => ({
    id: i + 1,
    source: 'auto',
    points: (s.pts || []).map((p) => ({ frame: p.f, t: p.t, x: p.x, y: p.y })),
    made: !!s.made,
    madeSuggested: !!s.made,
    angle: s.angle != null ? roundAngle(s.angle) : null,
    angleRaw: s.angleRaw != null ? s.angleRaw : null,
    crossS: s.crossS != null ? s.crossS : null,
    zone: s.zone || null,
    analysis: null,
    auto: {
      mode: res.mode,
      madeBy: s.madeBy,
      uncertain: !!s.uncertain,
      fCross: s.fCross,
      tCross: s.tCross,
      curve: s.curve || null,
      angleMeasured: s.angleMeasured != null ? s.angleMeasured : null,
    },
  }));
}

/** 給報告用的鏡頭角度摘要（session.auto）。 */
export function autoSummary(res, extra = {}) {
  return {
    mode: res.mode,
    grade: res.view ? res.view.grade : 'unknown',
    devDeg: res.view ? res.view.devDeg : null,
    devRange: res.view ? res.view.devRange : null,
    viewSource: res.view ? res.view.source : null,
    rollDeg: res.rollDeg || 0,
    gRatio: res.gRatio != null ? res.gRatio : null,
    notes: res.notes || [],
    uncertain: res.shots.filter((s) => s.uncertain).length,
    ...extra,
  };
}
