// 自動偵測的後半段：把每一幀偵測到的球串成軌跡，找出「一球投籃」。
// 純函式，不碰 DOM。Python 對應檔：arclog/track.py（tools/analyze.py 用同一套邏輯）。
//
// 流程：
//   1. 去掉靜止的偵測（放在地上的球、被誤認成球的固定物體）。
//   2. 找出「比籃框高」的偵測，依時間分群；每一群前後各留一段時間當作搜尋範圍，
//      範圍太長時切成固定長度的小視窗滑過去。
//   3. 視窗內用 RANSAC 找符合拋物線的一組點；條件是最高點高於籃框、下降時靠近籃框、
//      入框角度在合理範圍、而且是朝籃框飛來。這一步會濾掉運球、傳球、彈框後的球和場上其他球。
//   4. 只留「過框前的自由飛行段」重新擬合（含空氣阻力修正），算入框角度。
//      球碰到框或球網之後就不再照拋物線走，所以那些點不能拿來算角度。
//   5. 看過框之後的偵測（球有沒有出現在球網的位置、有沒有彈起來）修正進球判定。

import { DRAG_K_RIM, roundAngle } from './constants.js';
import { toHoop } from './geometry.js';
import { ransacArc, fitLine, evalArc } from './fit.js';
import { analyzeShot } from './shot.js';

export const TRACK_DEFAULTS = {
  seed: 12345,
  // 靜止偵測：0.4 秒以上都待在同一個位置（半徑 0.35 顆球）
  staticRadiusBall: 0.35,
  staticMinSpan: 0.4,
  staticMinCount: 5,
  staticWindow: 0.6,
  // 球框大小和校正推算的球直徑差太多就不要
  sizeMin: 0.35,
  sizeMax: 3.0,
  // 「比籃框高」的門檻（籃框內徑為單位）與分群間隔（秒）
  highV: 0.5,
  clusterGap: 0.6,
  windowBefore: 1.2,
  windowAfter: 0.4,
  // 一段很長的視窗（假偵測多的時候會連成一片）切成固定長度的小視窗滑過去找，
  // 不然裡面有好幾球時 RANSAC 很難剛好抽到同一球的三個點
  subWindow: 3.0,
  subStep: 1.0,
  edgeMargin: 0.12,
  // RANSAC
  thresh: 0.15,
  timeTol: 1.0,
  iters: 600,
  maxArcsPerWindow: 6,
  // 軌跡成立條件
  minInliers: 5,
  // 點要沿著軌跡分散：把水平位置每半個框分成一格，至少要佔 5 格。
  // （投籃前球拿在手上不動，會在同一個位置累積很多偵測，不能算成軌跡的證據）
  binWidth: 0.5,
  minBins: 5,
  minDuration: 0.2,
  minSpanU: 2.0,
  minApex: 0.5, // 最高點至少比籃框高半個框（約 22 公分）
  maxApex: 6.0, // 也不會高到 2.7 公尺以上
  minSlope: 0.36397, // tan 20°
  maxSlope: 2.74748, // tan 70°
  sMin: -2.5,
  sMax: 3.5,
  minApproach: 2.0, // 起點要比過框點離籃框遠 2 個框以上（朝籃框飛來）
  minDescending: 1,
  preCrossCut: 0.3, // 過框點之前約一個球半徑以內的點不拿來擬合
  freeFlightMaxU: 0.9, // 再往後球已經碰得到後緣或籃板
  backtrackTol: 0.1, // 水平位置倒退超過這麼多的點，是碰框後彈回來的球
  // 出手前球還在手上（或投籃前運球）、以及碰框後彈起來的球，位置常常剛好落在軌跡的延長線上，
  // 但時間對不上：飛行中的球水平等速。由軌跡中段的點往前、往後一個一個核對。
  chainTol: 0.3,
  residSigmas: 3, // 殘差超過 3 倍穩健標準差的點視為混進來的別顆球
  residFloor: 0.03,
  // 頭尾一兩個點如果和其他點隔了一大段時間，多半是碰巧落在延長線上的別顆球
  gapFactor: 3.5,
  gapMin: 0.2,
  gapMaxTrim: 2,
  maxRms: 0.12,
  directionRatio: 4, // 某個飛行方向的球數不到另一個方向的 1/4 時，視為彈框的球而丟掉
  // 過框之後觀察多久（秒）
  afterWindow: 0.8,
  bounceWindow: 0.6,
  bounceMinCount: 3,
  bounceRangeU: 2.0,
  bounceMaxV: 3.0,
  dragK: DRAG_K_RIM,
};

/**
 * 標記靜止的偵測。
 * @param {{t:number,x:number,y:number}[]} dets 已依 t 排序
 * @returns {boolean[]} true = 靜止
 */
export function markStatic(dets, ballDiameterPx, o = TRACK_DEFAULTS) {
  const n = dets.length;
  const flags = new Array(n).fill(false);
  const r2 = (o.staticRadiusBall * ballDiameterPx) ** 2;
  let lo = 0;
  for (let i = 0; i < n; i++) {
    const d = dets[i];
    while (lo < n && dets[lo].t < d.t - o.staticWindow) lo++;
    let count = 0;
    let tMin = d.t;
    let tMax = d.t;
    for (let j = lo; j < n && dets[j].t <= d.t + o.staticWindow; j++) {
      const e = dets[j];
      const dx = e.x - d.x;
      const dy = e.y - d.y;
      if (dx * dx + dy * dy <= r2) {
        count++;
        if (e.t < tMin) tMin = e.t;
        if (e.t > tMax) tMax = e.t;
      }
    }
    if (count >= o.staticMinCount && tMax - tMin >= o.staticMinSpan) flags[i] = true;
  }
  return flags;
}

/**
 * 由整支影片的偵測結果找出每一球。
 *
 * @param {{f:number, t:number, x:number, y:number, w:number, h:number, conf:number}[]} detections
 *        f 幀號、t 時間（秒）、x y 球心（像素）
 * @param {object} hoop makeHoopFrame 的結果
 * @param {object} [opts] 覆寫 TRACK_DEFAULTS
 * @returns {{shots:object[], stats:{detections:number, usable:number, static:number, windows:number,
 *            candidates:number, rejected:Object<string, number>}}}
 *          stats.rejected 記錄被排除的候選軌跡各是卡在哪一個條件，調參數或除錯時用
 */
export function findShots(detections, hoop, opts = {}) {
  const o = { ...TRACK_DEFAULTS, ...opts };
  const all = detections
    .map((d, i) => ({ ...d, i }))
    .sort((a, b) => a.t - b.t || a.i - b.i);

  // 1. 大小與靜止過濾
  const sized = all.filter((d) => {
    const s = Math.max(d.w, d.h) / hoop.ballDiameterPx;
    return s >= o.sizeMin && s <= o.sizeMax;
  });
  const staticFlags = markStatic(sized, hoop.ballDiameterPx, o);
  const pts = [];
  let staticCount = 0;
  for (let m = 0; m < sized.length; m++) {
    if (staticFlags[m]) {
      staticCount++;
      continue;
    }
    const d = sized[m];
    const [u, v] = toHoop(hoop, d.x, d.y);
    pts.push({ u, v, t: d.t, f: d.f, x: d.x, y: d.y, conf: d.conf, used: false, skip: -1 });
  }

  // 2. 比籃框高的偵測依時間分群
  const windows = [];
  let cur = null;
  for (const p of pts) {
    if (!(p.v >= o.highV)) continue;
    if (cur && p.t - cur.t1 <= o.clusterGap) cur.t1 = p.t;
    else {
      cur = { t0: p.t, t1: p.t };
      windows.push(cur);
    }
  }

  // 3. 每個搜尋範圍用小視窗滑過去找軌跡
  const shots = [];
  const rejected = {};
  let candidates = 0;
  let calls = 0;
  let stamp = 0;
  let lo = 0;
  for (let w = 0; w < windows.length; w++) {
    const t0 = windows[w].t0 - o.windowBefore;
    const t1 = windows[w].t1 + o.windowAfter;
    for (let a = t0; ; a += o.subStep) {
      const b = Math.min(t1, a + o.subWindow);
      stamp++;
      while (lo < pts.length && pts[lo].t < a) lo++;
      for (let round = 0; round < o.maxArcsPerWindow; round++) {
        const cand = [];
        for (let m = lo; m < pts.length && pts[m].t <= b; m++) {
          if (!pts[m].used && pts[m].skip !== stamp) cand.push(pts[m]);
        }
        const arc = ransacArc(cand, {
          seed: o.seed + calls,
          iters: o.iters,
          thresh: o.thresh,
          timeTol: o.timeTol,
          minInliers: o.minInliers,
          minApex: o.minApex,
          maxApex: o.maxApex,
          sMin: o.sMin,
          sMax: o.sMax,
          minSlope: o.minSlope,
          maxSlope: o.maxSlope,
          minApproach: o.minApproach,
        });
        calls++;
        if (!arc) break;
        const inl = arc.inliers.map((m) => cand[m]);
        // 球還在飛就碰到小視窗的尾端：這一輪先跳過這些點，留給下一個小視窗（那裡看得到整條軌跡）
        if (b < t1 && inl[inl.length - 1].t > b - o.edgeMargin) {
          for (const p of inl) p.skip = stamp;
          continue;
        }
        const built = buildShot(inl, pts, o);
        candidates++;
        // 不管成不成立，這些點都不再重複使用
        for (const p of inl) p.used = true;
        if (built.shot) shots.push(built.shot);
        else rejected[built.reason] = (rejected[built.reason] || 0) + 1;
      }
      if (b >= t1) break;
    }
    // 下一個範圍可能和這個重疊，指標退回去重新找起點
    lo = 0;
  }

  // 同一球被兩個視窗各抓到一次時，留點數多的
  shots.sort((a, b) => a.tCross - b.tCross);
  let merged = [];
  for (const s of shots) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(s.tCross - last.tCross) < 0.3) {
      if (s.points.length > last.points.length) merged[merged.length - 1] = s;
    } else merged.push(s);
  }

  // 相機和投籃位置是固定的，所以球都往同一個方向飛。
  // 反方向的少數幾球多半是沒進之後彈回來的球。
  let forward = 0;
  let backward = 0;
  for (const s of merged) {
    if (s.flip) backward++;
    else forward++;
  }
  if (forward > 0 && backward > 0) {
    if (backward * o.directionRatio <= forward) merged = merged.filter((s) => !s.flip);
    else if (forward * o.directionRatio <= backward) merged = merged.filter((s) => s.flip);
    const dropped = forward + backward - merged.length;
    if (dropped) rejected.wrong_direction = dropped;
  }

  return {
    shots: merged,
    stats: {
      detections: detections.length,
      usable: pts.length,
      static: staticCount,
      windows: windows.length,
      candidates,
      rejected,
    },
  };
}

/** 中位數（陣列會先複製再排序）。 */
function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 去掉頭尾「落單」的點：最前面或最後面一兩個點，和其他點之間隔了很久。
 * 這種點離主體很遠、槓桿很大，就算殘差不大也會把擬合帶偏。
 */
function trimEnds(pts, o) {
  const n = pts.length;
  if (n < 4) return pts;
  const dts = [];
  for (let i = 1; i < n; i++) dts.push(pts[i].t - pts[i - 1].t);
  const limit = Math.max(o.gapFactor * median(dts), o.gapMin);
  let start = 0;
  let end = n;
  for (let i = 1; i <= o.gapMaxTrim && i < n; i++) {
    if (dts[i - 1] > limit) start = i;
    if (dts[n - 1 - i] > limit) end = n - i;
  }
  return start === 0 && end === n ? pts : pts.slice(start, end);
}

/**
 * 時間核對：由軌跡中段的三個點開始（那裡最不可能混進別的東西），
 * 往更早、再往更晚一個一個看：水平位置要和「已接受的點的等速直線」對得上，對不上的丟掉。
 */
function chainFilter(pts, o) {
  const n = pts.length;
  if (n < 5) return pts;
  const mid = n >> 1;
  const acc = [mid - 1, mid, mid + 1];
  const fit = () =>
    fitLine(
      acc.map((i) => pts[i].t),
      acc.map((i) => pts[i].u),
    );
  let line = fit();
  if (!line) return pts;
  const consider = (i) => {
    if (Math.abs(pts[i].u - (line.p + line.q * pts[i].t)) > o.chainTol) return;
    acc.push(i);
    const next = fit();
    if (next) line = next;
  };
  for (let i = mid - 2; i >= 0; i--) consider(i);
  for (let i = mid + 2; i < n; i++) consider(i);
  if (acc.length === n) return pts;
  acc.sort((a, b) => a - b);
  return acc.map((i) => pts[i]);
}

function buildShot(inl, pts, o) {
  // 4. 只留過框前的自由飛行段，並去掉殘差特別大的點（混進來的別顆球），重新擬合。
  //    過框點和殘差都會跟著變，所以最多做幾輪。
  let kept = inl;
  let res;
  for (let pass = 0; ; pass++) {
    kept = trimEnds(kept, o);
    if (kept.length < o.minInliers) return { reason: 'few_points' };
    res = analyzeShot(
      kept.map((p) => ({ u: p.u, v: p.v, t: p.t })),
      { dragK: o.dragK },
    );
    if (!res.ok) return { reason: 'fit_failed' };
    if (pass >= 4) break;
    const Us = kept.map((p) => (res.flip ? 1 - p.u : p.u));
    const fitted = evalArc(res.model, Us);
    const absRes = kept.map((p, i) => Math.abs(p.v - fitted[i]));
    const residLimit = Math.max(o.residSigmas * 1.4826 * median(absRes), o.residFloor);
    const cutU = Math.min(res.crossS - o.preCrossCut, o.freeFlightMaxU);
    // 依時間順序走：球第一次進到框附近之後的點全部不要（之後可能已經碰框）；
    // 殘差太大、或水平位置倒退的點也不要。
    const keep = [];
    let runMax = -Infinity;
    let reached = false;
    for (let i = 0; i < kept.length; i++) {
      if (Us[i] > cutU) reached = true;
      if (reached) continue;
      if (absRes[i] > residLimit) continue;
      if (Us[i] < runMax - o.backtrackTol) continue;
      if (Us[i] > runMax) runMax = Us[i];
      keep.push(kept[i]);
    }
    const next = trimEnds(chainFilter(keep, o), o);
    if (next.length === kept.length) break;
    kept = next;
  }

  const n = kept.length;
  const tFirst = kept[0].t;
  const tLast = kept[n - 1].t;
  if (!(tLast - tFirst >= o.minDuration)) return { reason: 'short_duration' };
  // 水平跨距不看最兩端各一個點：只靠一個碰巧落在線上的假偵測撐起來的軌跡不算
  const us = kept.map((p) => p.u).sort((a, b) => a - b);
  if (!(us[n - 2] - us[1] >= o.minSpanU)) return { reason: 'short_span' };
  let bins = 1;
  let lastBin = Math.floor(us[0] / o.binWidth);
  for (let i = 1; i < n; i++) {
    const b = Math.floor(us[i] / o.binWidth);
    if (b !== lastBin) {
      bins++;
      lastBin = b;
    }
  }
  if (bins < o.minBins) return { reason: 'few_bins' };
  if (!(res.model.slope >= o.minSlope && res.model.slope <= o.maxSlope)) return { reason: 'angle_range' };
  if (!(res.apex.v >= o.minApex && res.apex.v <= o.maxApex)) return { reason: 'apex_range' };
  if (!(res.crossS >= o.sMin && res.crossS <= o.sMax)) return { reason: 'cross_range' };
  if (!(res.rms <= o.maxRms)) return { reason: 'rms' };
  // 「朝籃框飛來」同樣不看最早的那一個點
  const startU = res.flip ? 1 - kept[1].u : kept[1].u;
  if (!(Math.abs(startU - 0.5) - Math.abs(res.crossS - 0.5) >= o.minApproach)) return { reason: 'not_approaching' };
  // 至少要有幾個點在最高點之後（下降段），角度才有根據
  let descending = 0;
  for (const p of kept) {
    const U = res.flip ? 1 - p.u : p.u;
    if (U > res.apex.u) descending++;
  }
  if (descending < o.minDescending) return { reason: 'no_descent' };

  // 過框時間：水平位置對時間的直線，解出到達過框點的時間
  const line = fitLine(
    kept.map((p) => p.t),
    kept.map((p) => p.u),
  );
  if (!line || !(Math.abs(line.q) > 1e-9)) return { reason: 'time_fit' };
  const ucU = res.flip ? 1 - res.crossS : res.crossS;
  const tCross = (ucU - line.p) / line.q;

  // 5. 過框之後的證據
  //    net  ：球心出現在籃框正下方（球網的位置）→ 球穿過了籃框
  //    above：過框時間之後，球還在籃框附近、籃框平面以上 → 球彈起來了
  let net = 0;
  let above = 0;
  for (const p of pts) {
    if (!(p.t > tCross && p.t <= tCross + o.afterWindow)) continue;
    const U = res.flip ? 1 - p.u : p.u;
    if (p.v <= -0.3 && p.v >= -1.6 && U >= 0.05 && U <= 0.95) net++;
    else if (
      p.v >= 0.15 &&
      p.v <= o.bounceMaxV &&
      p.t >= tCross + 0.08 &&
      p.t <= tCross + o.bounceWindow &&
      Math.abs(U - 0.5) <= o.bounceRangeU
    ) {
      above++;
    }
  }
  let made = res.made;
  let madeBy = 'geometry';
  // 明顯偏短的球會從框的前下方穿過球網的位置，所以不採信 net 證據
  const clearShort = res.crossS < -0.3;
  if (!clearShort && net >= 2) {
    made = true;
    madeBy = 'net';
  } else if (above >= o.bounceMinCount && net < 2) {
    made = false;
    madeBy = 'bounce';
  }

  // 過框那一幀（原始內點裡最接近 tCross 的幀號，用來定位畫面）
  let fCross = inl[inl.length - 1].f;
  let best = Infinity;
  for (const p of inl) {
    const d = Math.abs(p.t - tCross);
    if (d < best) {
      best = d;
      fCross = p.f;
    }
  }

  const shot = {
    angle: roundAngle(res.angleRaw),
    angleRaw: res.angleRaw,
    crossS: res.crossS,
    made,
    madeGeometry: res.made,
    madeBy,
    zone: res.zone,
    flip: res.flip,
    model: res.model,
    parabola: res.parabola,
    apex: res.apex,
    rms: res.rms,
    tStart: tFirst,
    tEnd: tLast,
    tCross,
    fStart: kept[0].f,
    fEnd: kept[n - 1].f,
    fCross,
    evidence: { net, above },
    points: kept.map((p) => ({ f: p.f, t: p.t, x: p.x, y: p.y, conf: p.conf })),
  };
  return { shot };
}
