// 自動模式的整條分析：偵測結果 → 自動校正 → 鏡頭角度 → 分球 → 入框角度 → 進球判定。純函式，不碰 DOM。
//
// 建立在 track.js 的 findShots 之上（Python 也有一份、共用測試向量），不改它，在前後各加一層：
//   前：有籃板時推算相機位置（viewangle.js），把球換到投籃平面上（像從正側面看），偏角和透視一起修掉；
//       沒有籃板時用籃框兩點的 2D 座標系（和半自動相同），偏角由球的大小變化粗估。
//   後：只留往這個籃框投的球（靠近籃框時有實際的偵測點、球的大小對得上），
//       進球判定改看「過框之後的運動」（judgeAfter）。
// 偏角超過 C 級門檻時，畫面上的軌跡幾乎是上下走，算不出可信的入框角度，改用 countAttempts 只數出手和進球。

import { RIM_DIAMETER_M, BALL_DIAMETER_M, DRAG_K_RIM, DRAG_K_PER_M, roundAngle } from './constants.js';
import { makeHoopFrame, toHoop } from './geometry.js';
import { findShots, markStatic } from './track.js';
import { fitLine } from './fit.js';
import { judgeMake } from './shot.js';
import { autoCalibrate, calibrateWith, AUTOCAL_DEFAULTS } from './autocal.js';
import { fitPose, rectify, gradeView, alphaFromBallSize, correctForYaw, toShotPlane, GRADE_LIMITS, PLANE_PX_PER_M } from './viewangle.js';
import { project } from './camera3d.js';

/** 重力加速度，以「籃框內徑每秒平方」為單位（籃框座標系的長度單位是籃框內徑）。 */
export const G_RIM = 9.81 / RIM_DIAMETER_M;

export const JUDGE_DEFAULTS = {
  window: 0.8, // 過框後看多久（秒）
  minDt: 0.07, // 過框後至少過多久的點才拿來比（剛過框時自由落體和被網子拖住差不多）
  freeTol: 0.4, // 和自由落體預測的距離（籃框內徑）小於這個值算「照自由落體走」
  lagMin: 0.45, // 比自由落體高出這麼多（籃框內徑）算「被球網拖住」
  netU: 0.75, // 球網的水平範圍：|U − 0.5| 小於這個值
  netVTop: -0.15,
  netVBottom: -2.6,
  bounceV: 0.15,
  bounceRangeU: 2.0,
  floorV: -(3.05 - 0.3) / RIM_DIAMETER_M, // 地板（球心離地 0.3 公尺）在籃框座標系的高度
  lowV: -3.6, // 籃框下方 1.6 公尺：球網早就過了，再下去就是快落地
  rateWindow: 0.4, // 量速度用過框後多久以內的點
  rollWindow: 1.4, // 碰框後在框上滾動，最多看多久
  freeRatio: 0.6,
  slowRatio: 0.45,
};

/** 過框之後，第一次在籃框附近看到球低於 lowV 的時間（之後的點不再拿來判斷）；沒有就回傳 Infinity。 */
function firstLow(after, t0, lowV, flipU) {
  for (const p of after) {
    if (p.t > t0 && p.v < lowV && Math.abs(flipU(p.u) - 0.5) <= 2.5) return p.t;
  }
  return Infinity;
}

/** 由籃框平面（v = 0）以垂直速度 vy0 往下自由落體，落到 floorV 要多久（秒）。 */
function floorTime(vy0, floorV) {
  // floorV = vy0·t − ½·g·t²
  const a = 0.5 * G_RIM;
  const b = -vy0;
  const c = floorV;
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

/**
 * 過框之後的運動判斷進球。
 *
 * 側拍時，從籃框旁邊或後面經過的球在畫面上也會「穿過」籃框，只看位置會誤判成進球。
 * 差別在速度：進網的球被球網拖慢、水平被拉到籃框中間，而且常常被網子遮住幾幀才在網子下面出現；
 * 從旁邊經過的球是自由落體，水平速度不變。
 *
 * 不直接比「預測位置」：離開投籃平面的球（從旁邊、後面經過）換到平面上時，位置會整體偏移、運動也會縮放一點，
 * 過框時間也估得不完全準。改比「速度剩下幾成」：過框後一小段時間內，
 *   ru＝水平速度 ÷ 過框前的水平速度，rv＝垂直速度 ÷ 自由落體在同一時間應有的垂直速度。
 * 兩個都還有六成以上＝照自由落體走（沒進）；在球網的範圍裡、而且其中一個掉到四成五以下＝被網子拖住（進球）。
 *
 * @param {object} shot findShots 的一球（crossS、tCross、flip、angleRaw）
 * @param {{u:number, v:number, t:number}[]} after 過框後所有（非靜止、大小對得上的）偵測點的籃框座標，依時間排序
 * @param {{q:number}} motion 過框前的水平速度（籃框內徑／秒，飛行方向為正）
 * @returns {{made:boolean, by:string, uncertain:boolean, evidence:object}}
 *   by：'short'（明顯偏短）、'bounce'（彈出）、'freefall'（照自由落體經過）、'net'（被網子拖慢）、
 *       'net_hidden'（被網子遮住後在下面出現）、'outside'（落在球網範圍外）、
 *       'rim_in'（在框上滾動後從籃框裡面掉下去）、'geometry'（證據不足，依過框位置）
 */
export function judgeAfter(shot, after, motion, o = JUDGE_DEFAULTS) {
  const flipU = (u) => (shot.flip ? 1 - u : u);
  const geo = judgeMake(shot.crossS, shot.angleRaw);
  const q = Math.max(0.5, motion.q);
  const slope = Math.tan((shot.angleRaw * Math.PI) / 180);
  const vy0 = -slope * q; // 過框時的垂直速度（籃框內徑／秒）
  const tLow = firstLow(after, shot.tCross, o.lowV, flipU);
  const ev = { above: 0, net: 0, outside: 0, n: 0, ru: null, rv: null, firstSeen: null };
  const win = [];
  for (const p of after) {
    const dt = p.t - shot.tCross;
    if (!(dt > 0 && dt <= Math.min(o.window, tLow - shot.tCross + 1e-9))) continue;
    const U = flipU(p.u);
    if (Math.abs(U - 0.5) > o.bounceRangeU) continue;
    if (ev.firstSeen == null) ev.firstSeen = dt;
    if (p.v >= o.bounceV && dt >= 0.08 && dt <= 0.6) {
      ev.above++;
      continue;
    }
    const inNet = Math.abs(U - 0.5) <= o.netU && p.v <= o.netVTop && p.v >= o.netVBottom;
    if (inNet) ev.net++;
    else if (p.v < o.netVTop && p.v > o.netVBottom) ev.outside++;
    if (dt >= 0.03 && dt <= o.rateWindow) win.push({ U, v: p.v, dt });
  }
  ev.n = win.length;
  if (win.length >= 3 && win[win.length - 1].dt - win[0].dt >= 0.08) {
    const lu = fitLine(win.map((p) => p.dt), win.map((p) => p.U));
    const lv = fitLine(win.map((p) => p.dt), win.map((p) => p.v));
    const tMid = win.reduce((a, p) => a + p.dt, 0) / win.length;
    if (lu && lv) {
      ev.ru = lu.q / q;
      ev.rv = lv.q / (vy0 - G_RIM * tMid);
    }
  }
  if (shot.crossS < -0.3) return { made: false, by: 'short', uncertain: false, evidence: ev };
  // 碰框後在框上彈跳、滾動（過框後還在籃框以上好幾幀）：看它最後從哪裡掉下去——
  // 從籃框裡面掉下去是滾進，從外面掉下去是滾出
  if (ev.above >= 3) {
    // 球最後一次在框上的時間：從過框開始，一個接一個（間隔不超過 0.3 秒）的「在籃框以上」的點，
    // 零星的誤偵測或之後別的球不會把這個時間往後拉
    let tA = shot.tCross;
    for (const p of after) {
      if (!(p.t > shot.tCross && p.t <= shot.tCross + o.rollWindow)) continue;
      if (p.v >= o.bounceV && Math.abs(flipU(p.u) - 0.5) <= o.bounceRangeU && p.t - tA <= 0.3) tA = p.t;
    }
    let inside = 0;
    let outside = 0;
    // 從籃框裡面掉下去：球心離籃框中心不到 0.35 個內徑（內半徑 0.5 減掉球半徑約 0.27，再留一點偵測誤差），
    // 而且已經在籃框平面下面；離中心超過 0.5 個內徑就是從框外掉下去
    for (const p of after) {
      if (!(p.t > tA && p.t <= tA + 0.6 && p.v < -0.5 && p.v > o.lowV)) continue;
      const d = Math.abs(flipU(p.u) - 0.5);
      if (d <= 0.35) inside++;
      else if (d > 0.5) outside++;
    }
    ev.dropIn = inside;
    ev.dropOut = outside;
    if (inside >= 2 && inside > outside) return { made: true, by: 'rim_in', uncertain: true, evidence: ev };
    return { made: false, by: 'bounce', uncertain: inside > 0 || outside < 2, evidence: ev };
  }
  if (ev.ru != null) {
    if (ev.ru >= o.freeRatio && ev.rv >= o.freeRatio) return { made: false, by: 'freefall', uncertain: false, evidence: ev };
    if (ev.net >= 2 && (ev.ru <= o.slowRatio || ev.rv <= o.slowRatio)) return { made: true, by: 'net', uncertain: false, evidence: ev };
    if (ev.outside >= 2 && ev.net === 0) return { made: false, by: 'outside', uncertain: false, evidence: ev };
  }
  // 過框後一段時間都看不到球（被網子擋住），之後在網子下面、籃框寬度內出現
  if (ev.net >= 1 && ev.firstSeen != null && ev.firstSeen >= 0.2 && ev.outside === 0 && ev.above < 3) {
    return { made: true, by: 'net_hidden', uncertain: ev.net < 2, evidence: ev };
  }
  if (ev.above >= 3) return { made: false, by: 'bounce', uncertain: true, evidence: ev };
  return { made: geo.made, by: 'geometry', uncertain: true, evidence: ev };
}

/** 一群點的水平速度（籃框內徑／秒，飛行方向為正）。 */
function horizontalSpeed(shot, points, hoop) {
  const us = points.map((p) => toHoop(hoop, p.x, p.y)[0]);
  const line = fitLine(points.map((p) => p.t), us);
  const q = line ? line.q : 0;
  return shot.flip ? -q : q;
}

/**
 * 只留往這個籃框投的球：
 *   near：最靠近籃框中心的實際偵測點要在 nearMax 個籃框內徑以內（不是只靠延長線）
 *   size：那些靠近籃框的點，球框大小要是「籃框旁邊的球」的 sizeLo 到 sizeHi 倍
 */
function belongsHere(shot, hoop, o) {
  let best = Infinity;
  const sizes = [];
  for (const p of shot.points) {
    const [u, v] = toHoop(hoop, p.x, p.y);
    const d = Math.hypot(u - 0.5, v);
    if (d < best) best = d;
    if (d < 3 && p.w > 0) sizes.push(Math.max(p.w, p.h || 0) / hoop.ballDiameterPx);
  }
  if (!(best <= o.nearMax)) return 'far_from_hoop';
  if (o.checkSize && sizes.length >= 2) {
    sizes.sort((a, b) => a - b);
    const m = sizes[sizes.length >> 1];
    if (m < o.sizeLo || m > o.sizeHi) return 'size_mismatch';
  }
  return null;
}

export const AUTO_DEFAULTS = {
  nearMax: 2.2,
  sizeLo: 0.55,
  sizeHi: 1.8,
  planeSizeLo: 0.7,
  planeSizeHi: 1.45,
  gLo: 0.72, // 投籃平面上量到的重力和 9.81 的比值，超出這個範圍代表相機位置推算錯了
  gHi: 1.35,
};

/** 二次式最小平方 y = a + b·t + c·t²，回傳 [a, b, c]（點不夠時 null）。 */
function fitQuad(ts, ys) {
  const n = ts.length;
  if (n < 4) return null;
  const S = [0, 0, 0, 0, 0];
  const T = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    let tk = 1;
    for (let k = 0; k < 5; k++) {
      S[k] += tk;
      if (k < 3) T[k] += ys[i] * tk;
      tk *= ts[i];
    }
  }
  const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (!(Math.abs(D) > 1e-12)) return null;
  const col = (i) => M.map((row, r) => row.map((x, c) => (c === i ? T[r] : x)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/**
 * 手機左右歪斜（度），由原本畫面上的軌跡估：每球的加速度（像素／秒²）扣掉空氣阻力，剩下的就是重力在畫面上的方向；
 * 和「相機沒歪時這個位置的鉛直方向」（用推算的相機算，含仰角造成的鉛直線收斂）比較，差的角度就是歪斜。
 * 空氣阻力要扣：它和水平速度方向相反，會讓加速度斜 3 到 4 度，而且每球都斜同一邊，不會平均掉。
 * 阻力的大小 k·|v|·v 要用公尺：畫面上的重力大小（像素／秒²）÷ 9.81 就是球所在深度的「每公尺幾像素」。
 */
function estimateRollImage(cam, shots) {
  const est = [];
  for (const s of shots) {
    const pts = s.points;
    if (pts.length < 8 || pts[pts.length - 1].t - pts[0].t < 0.35) continue;
    const t0 = pts[0].t;
    const ts = pts.map((p) => p.t - t0);
    const fx = fitQuad(ts, pts.map((p) => p.x));
    const fy = fitQuad(ts, pts.map((p) => p.y));
    if (!fx || !fy) continue;
    const tm = ts[ts.length >> 1];
    const vx = fx[1] + 2 * fx[2] * tm;
    const vy = fy[1] + 2 * fy[2] * tm;
    const ax = 2 * fx[2];
    const ay = 2 * fy[2];
    const pxPerM = Math.hypot(ax, ay) / 9.81;
    if (!(pxPerM > 1)) continue;
    const speedM = Math.hypot(vx, vy) / pxPerM;
    const gx = ax + DRAG_K_PER_M * speedM * vx;
    const gy = ay + DRAG_K_PER_M * speedM * vy;
    // 這個位置的鉛直方向（相機沒歪）
    const xm = pts[pts.length >> 1].x;
    const ym = pts[pts.length >> 1].y;
    const q = toShotPlane({ ...cam, rollDeg: 0 }, xm, ym);
    if (!q) continue;
    const p0 = project({ ...cam, rollDeg: 0 }, q.X, q.Y, 0);
    const p1 = project({ ...cam, rollDeg: 0 }, q.X, q.Y - 0.5, 0);
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    est.push((Math.atan2(dx * gy - dy * gx, dx * gx + dy * gy) * 180) / Math.PI);
  }
  if (est.length < 2) return null;
  est.sort((a, b) => a - b);
  return est[est.length >> 1];
}

/**
 * 手機左右歪斜的殘差（度）：在投籃平面上，球的水平加速度應該只有空氣阻力（−k·|v|·vx，很小、方向已知）。
 * 換算時沒扣掉的歪斜會讓重力有一部分跑到水平方向：水平加速度 ≈ −k·|v|·vx + g·sin(歪斜)。
 * 每球估一次取中位數。只用沒碰框之前的點（findShots 給的點本來就是過框前的自由飛行段）。
 */
function estimateRoll(shots) {
  const est = [];
  for (const s of shots) {
    const pts = s.points;
    if (pts.length < 8 || pts[pts.length - 1].t - pts[0].t < 0.35) continue;
    const t0 = pts[0].t;
    const ts = pts.map((p) => p.t - t0);
    const fx = fitQuad(ts, pts.map((p) => p.x / PLANE_PX_PER_M));
    const fy = fitQuad(ts, pts.map((p) => -p.y / PLANE_PX_PER_M));
    if (!fx || !fy) continue;
    const tm = ts[ts.length >> 1];
    const vx = fx[1] + 2 * fx[2] * tm;
    const vy = fy[1] + 2 * fy[2] * tm;
    const sp = Math.hypot(vx, vy);
    const ax = 2 * fx[2];
    const sinR = (ax + DRAG_K_PER_M * sp * vx) / 9.81;
    if (Math.abs(sinR) < 0.3) est.push((Math.asin(sinR) * 180) / Math.PI);
  }
  if (est.length < 2) return null;
  est.sort((a, b) => a - b);
  return est[est.length >> 1];
}

/** 把框的中心繞畫面中心轉 deg 度（框的大小不變；小角度時夠用）。 */
function rotateBox(b, deg, W, H) {
  const r = (deg * Math.PI) / 180;
  const cx = (b.x0 + b.x1) / 2 - W / 2;
  const cy = (b.y0 + b.y1) / 2 - H / 2;
  const nx = cx * Math.cos(r) - cy * Math.sin(r) + W / 2;
  const ny = cx * Math.sin(r) + cy * Math.cos(r) + H / 2;
  const hw = (b.x1 - b.x0) / 2;
  const hh = (b.y1 - b.y0) / 2;
  return { x0: nx - hw, y0: ny - hh, x1: nx + hw, y1: ny + hh };
}

/** 用「每一點的重力」檢查投籃平面的換算對不對：平面上的垂直位置對時間擬合二次式，加速度應該接近 9.81。 */
function gravityRatio(shots) {
  const ratios = [];
  for (const s of shots) {
    const pts = s.planePts;
    if (!pts || pts.length < 6) continue;
    const n = pts.length;
    const t0 = pts[0].t;
    // 最小平方擬合 Y = a + b t + c t²
    let S = [0, 0, 0, 0, 0];
    let T = [0, 0, 0];
    for (const p of pts) {
      const t = p.t - t0;
      const Y = p.Y;
      for (let k = 0; k < 5; k++) S[k] += t ** k;
      for (let k = 0; k < 3; k++) T[k] += Y * t ** k;
    }
    const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]];
    const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det(M);
    if (!(Math.abs(D) > 1e-12) || n < 6) continue;
    const Mc = M.map((row, i) => [row[0], row[1], T[i]]);
    const c = det(Mc) / D;
    ratios.push((-2 * c) / 9.81);
  }
  if (!ratios.length) return null;
  ratios.sort((a, b) => a - b);
  return ratios[ratios.length >> 1];
}

/**
 * 偏角太大（C 級）時只數出手和進球。在籃框座標系裡：
 *   出手：球升到籃框以上（v > 0.6）、再落回籃框附近（v ≤ 0.5、水平距離籃框 1.6 個內徑以內）。
 *         彈框的球不一定會掉到籃框平面以下，所以「落回籃框附近」就算一次。
 *   進球：之後在籃框正下方出現，而且比自由落體慢（被網子拖住）。自由落體用過框前 0.3 秒量到的下降速度預測。
 * @returns {{attempts:{t:number, f:number, made:boolean, uncertain:boolean, evidence:object}[]}}
 */
export function countAttempts(balls, hoop, o = {}) {
  const skip = o.skip || 1.6;
  const floorV = JUDGE_DEFAULTS.floorV;
  const pts = balls.map((d) => {
    const [u, v] = toHoop(hoop, d.x, d.y);
    return { u, v, t: d.t, f: d.f };
  }).sort((a, b) => a.t - b.t);
  // 先把偵測點一幀一幀串成軌跡（每秒最多移動 maxSpeed 個籃框內徑），零星的誤偵測串不起來
  const tracks = linkTracks(pts, o.maxSpeed || 30);
  const cands = [];
  for (const tr of tracks) {
    if (tr.length < 5) continue;
    let apexV = -Infinity;
    for (let j = 0; j < tr.length; j++) {
      const q = tr[j];
      if (Math.abs(q.u - 0.5) < 2.5 && q.v > apexV) apexV = q.v;
      if (apexV > 0.6 && q.v <= 0.5 && Math.abs(q.u - 0.5) < 1.6) {
        // 下降段要有幾個點（真的是落下來，不是一兩個跳動的點）
        const pre = tr.slice(0, j + 1).filter((x) => x.t >= q.t - 0.3);
        if (pre.length >= 3 && pre[0].v - q.v > 0.3) cands.push({ cross: q, pre });
        apexV = -Infinity; // 同一條軌跡之後如果又升起來（彈框），可以再算一次，但會被下面的 skip 合併
      }
    }
  }
  cands.sort((a, b) => a.cross.t - b.cross.t);
  const attempts = [];
  let lastT = -Infinity;
  for (const { cross, pre } of cands) {
    if (cross.t - lastT < skip) continue;
    lastT = cross.t;
    // 過框前的下降速度（籃框內徑／秒）
    const line = pre.length >= 3 ? fitLine(pre.map((q) => q.t), pre.map((q) => q.v)) : null;
    const vy0 = line && line.q < -1 ? line.q : -10;
    const tFloor = Math.min(floorTime(vy0, floorV - cross.v), firstLow(pts, cross.t, JUDGE_DEFAULTS.lowV, (u) => u) - cross.t + 0.05);
    let lag = 0;
    let free = 0;
    let above = 0;
    let seen = 0;
    for (const q of pts) {
      const dt = q.t - cross.t;
      if (!(dt > 0.03 && dt <= Math.min(0.8, tFloor - 0.05))) continue;
      if (Math.abs(q.u - 0.5) > 2) continue;
      seen++;
      if (dt < 0.1) continue; // 剛過框的那一下，自由落體和被網子拖住還分不出來
      if (q.v > 0.3 && dt < 0.6) {
        above++;
        continue;
      }
      const vP = cross.v + vy0 * dt - 0.5 * G_RIM * dt * dt;
      if (Math.abs(q.u - 0.5) <= 0.7 && q.v < 0 && q.v > -2.6 && q.v - vP > 0.45) lag++;
      else if (Math.abs(q.v - vP) <= 0.45) free++;
    }
    let made = lag >= 2 && lag >= free && above < 3;
    let uncertain = !(lag >= 3 || free >= 2 || above >= 3);
    // 過框後在籃框附近完全看不到球：多半是進了網子被擋住（沒進的球通常還看得到：彈起來或從旁邊掉下去）
    if (lag + free + above === 0 && Math.abs(cross.u - 0.5) <= 0.6) {
      made = true;
      uncertain = true;
    }
    attempts.push({ t: cross.t, f: cross.f, made, uncertain, evidence: { lag, free, above, seen, vy0 } });
  }
  return { attempts };
}

/** 最近鄰串接：每個點接到「時間差 0.25 秒以內、距離最近而且移動速度合理」的軌跡尾端。 */
export function linkTracks(pts, maxSpeed) {
  const tracks = [];
  const active = [];
  for (const p of pts) {
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < active.length; k++) {
      const tr = active[k];
      const last = tr[tr.length - 1];
      const dt = p.t - last.t;
      if (!(dt > 0 && dt <= 0.25)) continue;
      const d = Math.hypot(p.u - last.u, p.v - last.v);
      if (d <= maxSpeed * dt + 0.3 && d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) active[best].push(p);
    else {
      const tr = [p];
      tracks.push(tr);
      active.push(tr);
    }
    // 太久沒有接上的軌跡收起來
    for (let k = active.length - 1; k >= 0; k--) {
      if (p.t - active[k][active[k].length - 1].t > 0.25) active.splice(k, 1);
    }
  }
  return tracks;
}

function isStaticFilter(balls, hoop) {
  const flags = markStatic(balls, hoop.ballDiameterPx);
  return balls.filter((_, i) => !flags[i]);
}

/**
 * 整條自動分析。
 *
 * @param {{f:number, t:number, cls:string, x:number, y:number, w:number, h:number, conf:number}[]} dets 整段的偵測（ball／rim／backboard）
 * @param {object} o
 * @param {number} o.width @param {number} o.height 影片大小
 * @param {number} [o.focalRatio]
 * @param {'rim'|'rim+net'} [o.rimBox]
 * @param {{front:{x,y}, back:{x,y}}} [o.hoopPoints] 使用者點的籃框兩點（模型沒有籃框類別，或使用者改了）；有給就不用自動校正
 * @param {boolean} [o.drag=true]
 * @returns {object} 見檔案最後的 return
 */
export function analyzeAuto(dets, o) {
  const opts = { ...AUTO_DEFAULTS, ...o };
  const dragK = opts.drag === false ? 0 : DRAG_K_RIM;
  const balls = dets.filter((d) => d.cls === 'ball' || d.cls == null);
  const notes = [];

  // ── 1. 籃框 ──
  let cal = null;
  let candidates = [];
  if (!opts.hoopPoints) {
    cal = autoCalibrate(dets, { rimBox: opts.rimBox || AUTOCAL_DEFAULTS.rimBox });
    candidates = cal.candidates || [];
    if (!cal.ok) return { ok: false, reason: cal.reason === 'no_rim' ? 'no_rim' : 'rim_unstable', candidates, notes };
    if (!cal.stable) notes.push('rim_unstable');
  }

  const runFor = (c) => {
    const points = c ? c.points : opts.hoopPoints;
    const hoop2d = makeHoopFrame(points.front, points.back, { level: 'persp', width: opts.width, height: opts.height, focal: opts.focalRatio });
    if (!hoop2d) return null;
    let pose = null;
    if (c && c.rim) pose = fitPose(c.rim.box, c.board ? c.board.box : null, { width: opts.width, height: opts.height, focalRatio: opts.focalRatio, rimBox: c.rimBox });
    let view = pose && pose.devDeg != null ? { ...gradeView(pose.devDeg, pose.devRange, opts.gradeLimits), source: 'board', alphaDeg: pose.alphaDeg } : null;
    return { points, hoop2d, pose, view, cal: c };
  };

  // 候選籃框：最多試兩個，選找到最多球的那一個（隔壁場地的籃框不會有朝它飛的完整軌跡）
  const tries = [];
  if (cal) {
    const list = [cal];
    if (candidates.length > 1 && candidates[1].count >= 5) {
      const alt = calibrateWith(candidates[1], null, candidates, { ...AUTOCAL_DEFAULTS, rimBox: cal.rimBox });
      // 籃板要重新配對
      list.push({ ...alt, board: null });
    }
    for (const c of list) tries.push(runFor(c));
  } else tries.push(runFor(null));

  // 預設用最大、最穩定的籃框（使用者會把自己的籃框放在引導框裡，通常是最近的那一個）。
  // 只有它幾乎找不到球、而另一個找到很多時才換：只比球數的話，隔壁場地比較忙就會被選走。
  let best = null;
  for (const tr of tries) {
    if (!tr) continue;
    const res = analyzeWith(tr, balls, opts, dragK);
    if (!best) best = res;
    else if (best.shotCount <= 1 && res.shotCount >= 3) {
      res.notes = (res.notes || []).concat(['switched_hoop']);
      best = res;
    }
  }
  if (!best) return { ok: false, reason: 'no_hoop', candidates, notes };
  best.notes = notes.concat(best.notes);
  best.candidates = candidates;
  return best;
}

/** 用某一個籃框（和相機位置）跑分球。 */
function analyzeWith(tr, balls, opts, dragK) {
  const notes = [];
  let { view } = tr;
  const { hoop2d } = tr;
  let { pose } = tr;
  const byKey = new Map();
  for (const d of balls) byKey.set(`${d.f}|${d.x}|${d.y}`, d);

  // C 級（有籃板而且確定偏很多）：只數出手和進球
  if (view && view.grade === 'C') {
    const moving = isStaticFilter(balls.slice().sort((a, b) => a.t - b.t), hoop2d);
    const { attempts } = countAttempts(moving, hoop2d);
    return {
      ok: true,
      mode: 'count',
      view,
      pose,
      hoop: hoop2d,
      points: tr.points,
      cal: tr.cal,
      shots: attempts.map((a) => ({ angle: null, made: a.made, madeBy: 'count', uncertain: a.uncertain, evidence: a.evidence, tCross: a.t, fCross: a.f, points: [] })),
      shotCount: attempts.length,
      notes,
      stats: null,
    };
  }

  let mode = pose && view && view.grade !== 'C' ? 'plane' : 'image';
  let hoop = hoop2d;
  let input = balls;
  let back = null;
  let found = null;
  let rollDeg = 0;
  let cam = pose ? pose.cam : null;
  // 投籃平面模式：球框大小已經換成平面上的實際大小，在平面上的球應該是 1 倍左右。
  // 別的籃框的球離鏡頭遠很多，換到平面上只有 0.4 倍左右，用比較緊的範圍濾掉。
  const sizeMin = mode === 'plane' ? opts.planeSizeLo : 0.35;
  const sizeMax = mode === 'plane' ? opts.planeSizeHi : 3.0;
  const run = () => {
    input = balls;
    back = null;
    if (mode === 'plane') {
      const r = rectify(cam, balls);
      hoop = r.hoop;
      input = r.dets;
      back = new Map();
      for (const d of r.dets) back.set(`${d.f}|${d.x}|${d.y}`, d);
    }
    input = input.filter((d) => {
      const r = Math.max(d.w, d.h) / hoop.ballDiameterPx;
      return r >= sizeMin && r <= sizeMax;
    });
    found = findShots(input, hoop, { dragK, sizeMin, sizeMax });
  };
  run();
  // 手機歪斜。相機位置推算時當成 0；歪了的話籃板框整個轉了，相機位置也會推錯，所以要一起修。
  // 兩個起點各自往下修：(1) 不歪；(2) 由原本畫面上軌跡的加速度方向估的歪斜（側拍時準，斜拍時會被透視帶偏）。
  // 每個起點再用「投籃平面上水平方向多出來的重力」反覆修正、重新推算相機位置。
  // 最後留物理上最說得通的那一個：平面上量到的重力最接近 9.81、剩下的歪斜最小。
  if (mode === 'plane' && opts.estimateRoll !== false && tr.cal && tr.cal.rim) {
    const refitWith = (roll) => {
      if (Math.abs(roll) < 1e-9) return pose;
      const un = (b) => rotateBox(b, -roll, opts.width, opts.height);
      const r = fitPose(un(tr.cal.rim.box), tr.cal.board ? un(tr.cal.board.box) : null, { width: opts.width, height: opts.height, focalRatio: opts.focalRatio, rimBox: tr.cal.rimBox });
      return r && r.ok ? r : null;
    };
    // 起點：不歪（不修正）、不歪（往下修正）、由畫面上的加速度方向估的歪斜（往下修正）。
    // 「不修正」也要留著比：從側翼投的球（投籃方向和籃板不垂直）在平面上也會多出水平加速度，
    // 看起來很像手機歪了，一路修下去反而錯。歪超過 MAX_ROLL 度的解直接不要（照引導架好的手機不會歪那麼多）。
    const MAX_ROLL = 8;
    const starts = [[0, false], [0, true]];
    const rImg = estimateRollImage(pose.cam, findShots(balls, hoop2d, { dragK }).shots);
    if (rImg != null && Math.abs(rImg) >= 0.5 && Math.abs(rImg) <= MAX_ROLL) starts.push([rImg, true]);
    let bestState = null;
    for (const [r0, refine] of starts) {
      let roll = r0;
      let p = refitWith(roll);
      if (!p) continue;
      cam = { ...p.cam, rollDeg: roll };
      run();
      for (let iter = 0; refine && iter < 3; iter++) {
        const r = estimateRoll(found.shots);
        if (r == null || Math.abs(r) < 0.3) break;
        roll -= 0.8 * r;
        if (Math.abs(roll) > MAX_ROLL) break;
        const q = refitWith(roll);
        if (!q) break;
        p = q;
        cam = { ...p.cam, rollDeg: roll };
        run();
      }
      if (Math.abs(roll) > MAX_ROLL) continue;
      const resid = estimateRoll(found.shots);
      const g = gravityRatio(found.shots.map((x) => ({ planePts: x.points.map((pt) => ({ t: pt.t, Y: -pt.y / PLANE_PX_PER_M })) })));
      // 剩下的歪斜估不出來（可用的球太少）不能當成 0；另外稍微偏好「沒歪」（手機多半大致放平）
      const score = (g != null ? Math.abs(Math.log(g)) * 10 : 5) + (resid != null ? Math.abs(resid) / 5 : 1) + Math.abs(roll) / 10 - found.shots.length * 0.05;
      if (!bestState || score < bestState.score) bestState = { score, roll, p, cam, found, hoop, input, back };
    }
    if (bestState) {
      ({ roll: rollDeg, cam, found, hoop, input, back } = bestState);
      pose = { ...bestState.p, cam };
      if (bestState.p.devDeg != null) {
        view = { ...view, ...gradeView(bestState.p.devDeg, bestState.p.devRange, opts.gradeLimits), alphaDeg: bestState.p.alphaDeg };
        if (view.grade === 'C') return analyzeWith({ ...tr, view, pose }, balls, { ...opts, estimateRoll: false }, dragK);
      }
    }
  }

  const rejected = { ...found.stats.rejected };

  // 過框之後的點（所有非靜止的偵測，籃框座標）
  const sorted = input.slice().sort((a, b) => a.t - b.t);
  const moving = isStaticFilter(sorted, hoop);
  const allPts = moving.map((d) => {
    const [u, v] = toHoop(hoop, d.x, d.y);
    return { u, v, t: d.t };
  });

  const shots = [];
  for (const s of found.shots) {
    // 換回原本畫面的座標和球框大小（疊圖、大小檢查、球的大小估偏角都要）
    const pts = s.points.map((p) => {
      const src = back ? back.get(`${p.f}|${p.x}|${p.y}`) : byKey.get(`${p.f}|${p.x}|${p.y}`);
      return { ...p, w: src ? src.w : 0, h: src ? src.h : 0, px: src && src.px != null ? src.px : p.x, py: src && src.py != null ? src.py : p.y };
    });
    const shot = { ...s, points: pts };
    const why = belongsHere(shot, hoop, { ...opts, checkSize: true });
    if (why) {
      rejected[why] = (rejected[why] || 0) + 1;
      continue;
    }
    const q = horizontalSpeed(shot, pts, hoop);
    const after = allPts.filter((p) => p.t > s.tCross && p.t <= s.tCross + 2.0);
    const j = judgeAfter(shot, after, { q });
    shot.made = j.made;
    shot.madeBy = j.by;
    shot.uncertain = j.uncertain;
    shot.evidence = j.evidence;
    if (mode === 'plane') shot.planePts = pts.map((p) => ({ t: p.t, Y: -p.y / 200 }));
    shots.push(shot);
  }

  // 沒有籃板：由球的大小變化粗估偏角
  if (!view) {
    const est = alphaFromBallSize(shots, hoop2d, { width: opts.width, height: opts.height, focalRatio: opts.focalRatio });
    view = est.devDeg != null ? { ...gradeView(est.devDeg, est.devRange, opts.gradeLimits), source: 'ballsize', alphaDeg: est.alphaDeg } : { grade: 'unknown', devDeg: null, devRange: null, source: null };
  }

  // 投籃平面的換算檢查：重力對不上代表相機位置推算錯了，不採信修正，退回 B 級並提醒
  let gRatio = null;
  if (mode === 'plane') {
    gRatio = gravityRatio(shots);
    if (gRatio != null && (gRatio < opts.gLo || gRatio > opts.gHi)) {
      notes.push('gravity_mismatch');
      if (view.grade === 'A') view = { ...view, grade: 'B' };
    }
  }

  // 入框角度：平面模式已經修正過偏角和透視；2D 模式在 A、B 級套用平行投影的偏角修正
  for (const s of shots) {
    let a = s.angleRaw;
    if (mode === 'image' && view.devDeg != null && view.grade !== 'C') a = correctForYaw(a, view.devDeg);
    s.angleMeasured = s.angleRaw;
    s.angleRaw = a;
    s.angle = roundAngle(a);
    delete s.planePts;
  }

  if (view.grade === 'C' && mode === 'image') {
    // 由球的大小估出來偏很多：角度不可信，只留出手和進球
    for (const s of shots) s.angle = null;
  }

  return {
    ok: true,
    mode,
    view,
    pose,
    hoop,
    hoop2d,
    points: tr.points,
    cal: tr.cal,
    shots,
    shotCount: shots.length,
    gRatio,
    rollDeg,
    cam,
    notes,
    stats: { ...found.stats, rejected },
  };
}

export { GRADE_LIMITS, BALL_DIAMETER_M };
