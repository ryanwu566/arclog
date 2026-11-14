// 鏡頭擺位對入框角度的影響：用針孔相機模型把一條已知角度的投籃軌跡投影到畫面上，
// 再用網站的同一套程式（校正 → 擬合 → 入框角度）去量，看量到的角度和真實角度差多少。
//
//   node tools/camera_study.mjs
//
// docs/SHOOTING_GUIDE.md 和 docs/EVAL.md 裡「鏡頭沒擺正會差多少」的數字都是這支程式算出來的。
// 這是幾何模擬：理想的針孔鏡頭、沒有鏡頭變形、籃框和球心都點得完全準。它不是實拍量測。
//
// tests/js/camera.test.mjs 用這裡的函式檢查：
//   1. 預設的水平基準（籃框連線並修正透視）在鏡頭擺正時沒有系統性偏差
//   2. 偏離正側面時的誤差符合 tan(量測) = tan(真實) / cos θ
//   3. 垂直參考線基準不受手機歪斜和焦距假設影響；仰角時和其他基準一樣有偏差

import { pathToFileURL } from 'node:url';
import { makeHoopFrame, toHoop } from '../web/js/core/geometry.js';
import { analyzeShot } from '../web/js/core/shot.js';
import { DRAG_K_PER_M, DRAG_K_RIM } from '../web/js/core/constants.js';
import { makeScene3d, scene3dTruth, rimClickTruth } from '../web/js/core/synth3d.js';
import { simulateDetections } from '../web/js/core/simdetect.js';
import { analyzeAuto } from '../web/js/core/autoshots.js';
import { fitPose } from '../web/js/core/viewangle.js';
import { autoCalibrate } from '../web/js/core/autocal.js';

export const RIM_H = 3.05; // 籃框高度（公尺）
export const RIM_R = 0.225; // 籃框內半徑
export const SHOT_DIST = 4.2; // 出手點到籃框中心的水平距離（罰球線附近）
export const RELEASE_H = 2.2; // 出手高度
export const MID = -SHOT_DIST / 2; // 出手點和籃框的中間
export const W = 1920; // 模擬的畫面大小
export const H = 1080;
const G = 9.81;

/** 含空氣阻力的拋體。x 是離籃框中心的水平距離（出手時為負），y 是高度。 */
function fly(v0, launchDeg, dt = 1 / 240) {
  let x = -SHOT_DIST;
  let y = RELEASE_H;
  let vx = v0 * Math.cos((launchDeg * Math.PI) / 180);
  let vy = v0 * Math.sin((launchDeg * Math.PI) / 180);
  const pts = [{ t: 0, x, y, vx, vy }];
  const acc = (ux, uy) => {
    const s = Math.hypot(ux, uy);
    return [-DRAG_K_PER_M * s * ux, -G - DRAG_K_PER_M * s * uy];
  };
  for (let t = dt; t < 3; t += dt) {
    const [a1x, a1y] = acc(vx, vy);
    const [a2x, a2y] = acc(vx + (a1x * dt) / 2, vy + (a1y * dt) / 2);
    const [a3x, a3y] = acc(vx + (a2x * dt) / 2, vy + (a2y * dt) / 2);
    const [a4x, a4y] = acc(vx + a3x * dt, vy + a3y * dt);
    x += dt * (vx + (dt / 6) * (a1x + a2x + a3x));
    y += dt * (vy + (dt / 6) * (a1y + a2y + a3y));
    vx += (dt / 6) * (a1x + 2 * a2x + 2 * a3x + a4x);
    vy += (dt / 6) * (a1y + 2 * a2y + 2 * a3y + a4y);
    pts.push({ t, x, y, vx, vy });
    if (vy < 0 && y < RIM_H - 0.3) break;
  }
  return pts;
}

/** 找出「以 launchDeg 出手、剛好通過籃框中心」的一球。回傳 {pts, angle}，angle 是真實入框角度（度）。 */
export function designShot(launchDeg) {
  let lo = 4;
  let hi = 14;
  let best = null;
  for (let i = 0; i < 60; i++) {
    const v0 = (lo + hi) / 2;
    const pts = fly(v0, launchDeg);
    let cross = null;
    for (let k = 1; k < pts.length; k++) {
      if (pts[k].vy < 0 && pts[k - 1].y >= RIM_H && pts[k].y < RIM_H) {
        const f = (pts[k - 1].y - RIM_H) / (pts[k - 1].y - pts[k].y);
        const vx = pts[k - 1].vx + f * (pts[k].vx - pts[k - 1].vx);
        const vy = pts[k - 1].vy + f * (pts[k].vy - pts[k - 1].vy);
        cross = { x: pts[k - 1].x + f * (pts[k].x - pts[k - 1].x), angle: (Math.atan2(-vy, vx) * 180) / Math.PI };
        break;
      }
    }
    if (!cross || cross.x < 0) lo = v0;
    else hi = v0;
    best = { pts, angle: cross ? cross.angle : NaN };
  }
  return best;
}

/**
 * 針孔相機。投籃平面是 z = 0（x 沿投籃方向、y 向上），相機在 z > 0 的那一側。
 *
 * cam.dist     相機到投籃平面的距離（公尺）
 * cam.along    相機沿投籃方向的位置（0＝籃框的正側面，-4.2＝出手點的正側面）
 * cam.height   鏡頭高度
 * cam.yawDeg   鏡頭往籃框那一側轉了幾度（0＝光軸垂直於投籃方向）
 * cam.pitchDeg 鏡頭往上仰幾度
 * cam.rollDeg  手機左右歪了幾度
 * cam.f        焦距（像素）
 */
export function project(cam, x, y, z) {
  const yaw = (cam.yawDeg * Math.PI) / 180;
  const pitch = (cam.pitchDeg * Math.PI) / 180;
  const roll = (cam.rollDeg * Math.PI) / 180;
  const dx = x - cam.along;
  const dy = y - cam.height;
  const dz = z - cam.dist;
  const x1 = dx * Math.cos(yaw) + dz * Math.sin(yaw);
  const z1 = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
  const y2 = dy * Math.cos(pitch) + z1 * Math.sin(pitch);
  const z2 = -dy * Math.sin(pitch) + z1 * Math.cos(pitch);
  const depth = -z2;
  let px = (cam.f * x1) / depth;
  let py = (-cam.f * y2) / depth; // 影像的 y 向下
  if (roll) {
    const c = Math.cos(roll);
    const s = Math.sin(roll);
    [px, py] = [px * c - py * s, px * s + py * c];
  }
  return { x: px + W / 2, y: py + H / 2 };
}

/** 畫面上籃框橢圓最左和最右的兩點：使用者校正時實際會點的位置。 */
export function rimClicks(cam) {
  let left = null;
  let right = null;
  for (let i = 0; i < 1440; i++) {
    const a = (i / 1440) * 2 * Math.PI;
    const p = project(cam, RIM_R * Math.cos(a), RIM_H, RIM_R * Math.sin(a));
    if (!left || p.x < left.x) left = p;
    if (!right || p.x > right.x) right = p;
  }
  return { left, right };
}

/**
 * 籃架上鉛直的線（FIBA 規格：籃板正面在籃框中心後方 0.375 公尺，寬 1.8、高 1.05，下緣離地 2.90）。
 *   board    籃板靠近相機的那一條側邊（「垂直參考線」預設用這條）
 *   boardFar 籃板遠側的側邊
 *   post     籃架立柱（籃板後方 1.6 公尺、離地 1.0 到 2.8 公尺那一段；移動式籃架常見的樣子）
 */
export const VERTICALS = {
  board: { x: 0.375, z: 0.9, y0: 2.9, y1: 3.95 },
  boardFar: { x: 0.375, z: -0.9, y0: 2.9, y1: 3.95 },
  post: { x: 0.375 + 1.6, z: 0.2, y0: 1.0, y1: 2.8 },
};

/**
 * 使用者選「垂直參考線」時會點的兩點：那條鉛直線在畫面裡看得到的那一段的兩端（離畫面邊緣至少 10 像素）。
 * opts.leanDeg：那條線其實不是鉛直的，往投籃方向斜了幾度（例如斜的支架）
 * opts.dxPx：上端點往右點歪了幾個像素
 */
export function verticalClicks(cam, which = 'board', opts = {}) {
  const s = VERTICALS[which];
  const lean = Math.tan(((opts.leanDeg || 0) * Math.PI) / 180);
  const a = project(cam, s.x, s.y0, s.z);
  const b = project(cam, s.x + lean * (s.y1 - s.y0), s.y1, s.z);
  // 只留畫面裡的那一段（直線投影到畫面上還是直線，所以直接在畫面上裁）
  const m = 10;
  let t0 = 0;
  let t1 = 1;
  const clip = (p, q) => {
    // 限制 p + t·q ≥ 0
    if (Math.abs(q) < 1e-12) return p >= 0;
    const t = -p / q;
    if (q > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    return true;
  };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const ok = clip(a.x - m, dx) && clip(W - m - a.x, -dx) && clip(a.y - m, dy) && clip(H - m - a.y, -dy);
  if (!ok || !(t1 > t0)) return null;
  const bottom = { x: a.x + t0 * dx, y: a.y + t0 * dy };
  const top = { x: a.x + t1 * dx + (opts.dxPx || 0), y: a.y + t1 * dy };
  return { top, bottom };
}

/**
 * 用網站的程式量一次，回傳量到的入框角度（度）。
 * level：'persp'（籃框連線並修正透視，實拍影片的預設）、'vertical'（垂直參考線）、'rim'（籃框連線）、'image'（畫面水平）
 * focal：程式「以為」的焦距（畫面寬的幾倍）；不給就用程式的預設值
 * vref：level='vertical' 時用哪一條線、點歪多少（見 verticalClicks）；預設是籃板靠近相機的側邊、點得完全準
 */
export function measure(shot, cam, level = 'persp', focal = undefined, vref = {}) {
  const { left, right } = rimClicks(cam);
  const vertical = level === 'vertical' ? verticalClicks(cam, vref.which || 'board', vref) : null;
  // 球從 -x 飛向籃框：前緣（靠近投籃者）在畫面左邊
  const hoop = makeHoopFrame(left, right, { level, width: W, height: H, focal, vertical });
  return measureWithFrame(shot, cam, hoop);
}

/** 用指定的籃框座標系量一球（給「點歪了」這類要自己建座標系的情況用）。 */
export function measureWithFrame(shot, cam, hoop) {
  if (!hoop) return NaN;
  // 取樣：整段飛行每 1/30 秒一點（像自動偵測），只到通過籃框平面為止
  const step = Math.round(240 / 30);
  const pts = [];
  for (let k = 0; k < shot.pts.length; k += step) {
    const p = shot.pts[k];
    if (p.vy < 0 && p.y < RIM_H) break;
    const img = project(cam, p.x, p.y, 0);
    const [u, v] = toHoop(hoop, img.x, img.y);
    pts.push({ u, v, t: p.t });
  }
  const res = analyzeShot(pts, { dragK: DRAG_K_RIM });
  return res.ok ? res.angleRaw : NaN;
}

/**
 * 同一個擺法下，兩種獨立的「手機歪斜」估計（度，右端高為正）：
 *   rim      籃框連線扣掉透視之後剩下的傾斜（'persp' 基準顯示的那個數字）
 *   vertical 鉛直參考線換算出來的傾斜（'vertical' 基準用的那個數字）
 * 鏡頭有仰角時兩個都會偏；用來檢查「能不能拿兩者的差估出仰角」。
 */
export function rollEstimates(cam, which = 'board') {
  const { left, right } = rimClicks(cam);
  const p = makeHoopFrame(left, right, { level: 'persp', width: W, height: H });
  const v = makeHoopFrame(left, right, { level: 'vertical', width: W, height: H, vertical: verticalClicks(cam, which) });
  return { rim: p.tiltDeg - p.perspDeg, vertical: v ? v.vertDeg : NaN };
}

/** 模擬用的真實焦距：畫面寬的 0.8 倍（手機 1 倍鏡頭錄影的典型值）。 */
export const F = 0.8 * W;

/** 基準擺法：相機在出手點和籃框中間的正側面 8 公尺、鏡頭高 1.4 公尺、手機不仰不轉不歪。 */
export const BASE = { dist: 8, along: MID, height: 1.4, yawDeg: 0, pitchDeg: 0, rollDeg: 0, f: F };

/** 相機繞著「出手點和籃框的中間」偏離正側面 theta 度（正＝往籃框後方偏），鏡頭仍然對準那個點。 */
export function around(theta, dist, extra = {}) {
  const t = (theta * Math.PI) / 180;
  return { ...BASE, dist: dist * Math.cos(t), along: MID + dist * Math.sin(t), yawDeg: -theta, ...extra };
}

/** 規格裡的公式：偏離正側面 theta 度時量到的角度（平行投影的近似）。 */
export function yawFormula(trueDeg, thetaDeg) {
  return (Math.atan(Math.tan((trueDeg * Math.PI) / 180) / Math.cos((thetaDeg * Math.PI) / 180)) * 180) / Math.PI;
}

// ── 自動模式（第十四到十七段）：3D 合成場景＋模擬偵測器，量鏡頭角度估計和分級後的誤差 ──────────
//
// 和前面各段一樣是模擬，不是實拍。偵測框的雜訊大小（simdetect.js 的 SIMDET_DEFAULTS）是假設的。

/** 一次自動分析對真實答案的比較。cam：makeCamera 的參數；focalRatio：程式「以為」的焦距。 */
export function autoTrial({ camera, seed = 1, focalRatio, script, background = false, detOpts = {}, gradeLimits, taps = false, shotYawDeg = 0 }) {
  const plan = makeScene3d({ seed, camera: { dist: 9, camHeight: 1.6, pitchDeg: 3, ...camera }, script, background, shotYawDeg });
  let dets = simulateDetections(plan, { seed: seed * 7 + 1, ...detOpts });
  let hoopPoints;
  if (taps) {
    // 模型沒有籃框類別：使用者點兩下籃框（點在鐵圈內緣橢圓的最左、最右，各有 1 像素的誤差）
    const c = rimClickTruth(plan);
    hoopPoints = { front: { x: c.left.x + 0.7, y: c.left.y - 0.7 }, back: { x: c.right.x - 0.7, y: c.right.y + 0.7 } };
    dets = dets.filter((d) => d.cls === 'ball');
  }
  const res = analyzeAuto(dets, { width: plan.width, height: plan.height, focalRatio, gradeLimits, hoopPoints });
  const truth = scene3dTruth(plan);
  const c = plan.cam;
  const alphaTrue = (Math.atan2(-c.along, c.z) * 180) / Math.PI;
  const out = { alphaTrue, devTrue: Math.abs(alphaTrue), ok: res.ok, mode: res.mode, grade: res.view ? res.view.grade : null, devEst: res.view ? res.view.devDeg : null, devRange: res.view ? res.view.devRange : null, found: 0, missed: 0, extra: 0, madeWrong: 0, errs: [], madeErrs: [] };
  if (!res.ok) return out;
  for (const t of truth) {
    const s = res.shots.find((x) => Math.abs(x.tCross - t.tCross) < 0.35);
    if (!s) {
      out.missed++;
      continue;
    }
    out.found++;
    if (s.made !== t.made) out.madeWrong++;
    if (s.angle != null) {
      out.errs.push(s.angle - t.angleDeg);
      if (t.made) out.madeErrs.push(s.angle - t.angleDeg);
    }
  }
  out.extra = res.shots.filter((s) => !truth.some((t) => Math.abs(s.tCross - t.tCross) < 0.35)).length;
  return out;
}

/** 只估偏角（不跑分球）：用模擬偵測器 60 幀的籃框、籃板框。 */
export function poseTrial({ camera, seed = 1, focalRatio }) {
  const plan = makeScene3d({ seed, camera: { dist: 9, camHeight: 1.6, pitchDeg: 3, ...camera }, script: ['swish'] });
  const dets = simulateDetections(plan, { seed: seed * 13 + 5 }).filter((d) => d.f < 60);
  const cal = autoCalibrate(dets);
  const c = plan.cam;
  const alphaTrue = (Math.atan2(-c.along, c.z) * 180) / Math.PI;
  if (!cal.ok || !cal.board) return { alphaTrue, devEst: null };
  const r = fitPose(cal.rim.box, cal.board.box, { width: plan.width, height: plan.height, focalRatio });
  return { alphaTrue, devTrue: Math.abs(alphaTrue), devEst: r.devDeg, devRange: r.devRange };
}

const pctl = (a, q) => {
  if (!a.length) return NaN;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
};

/** 第十五段：每個相機位置跑 seeds 次，統計角度誤差和分球、進球判定。 */
export function autoSweep(thetas, seeds, extra = {}) {
  const rows = [];
  for (const thetaDeg of thetas) {
    const trials = [];
    for (let k = 1; k <= seeds; k++) trials.push(autoTrial({ camera: { thetaDeg, ...(extra.camera || {}) }, seed: k, focalRatio: extra.focalRatio, background: extra.background, script: extra.script, gradeLimits: extra.gradeLimits, taps: extra.taps, shotYawDeg: extra.shotYawDeg }));
    const errs = trials.flatMap((t) => t.madeErrs.map(Math.abs));
    const all = trials.flatMap((t) => t.errs.map(Math.abs));
    rows.push({
      thetaDeg,
      devTrue: trials[0].devTrue,
      grades: trials.map((t) => t.grade).join(''),
      devEst: trials.map((t) => t.devEst),
      madeP90: pctl(errs, 0.9),
      madeMax: errs.length ? Math.max(...errs) : NaN,
      allP90: pctl(all, 0.9),
      allMax: all.length ? Math.max(...all) : NaN,
      shots: trials.reduce((a, t) => a + t.found + t.missed, 0),
      missed: trials.reduce((a, t) => a + t.missed, 0),
      extra: trials.reduce((a, t) => a + t.extra, 0),
      madeWrong: trials.reduce((a, t) => a + t.madeWrong, 0),
      angles: errs.length,
    });
  }
  return rows;
}

function autoSections() {
  const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '—');
  const thetas = [20, 10, 0, -10, -20, -30, -40, -50, -60, -70, -80, -90];
  console.log('十四、自動判斷鏡頭角度：籃框和籃板的偵測框（模擬偵測器，60 幀取穩定值）推算的偏角，和真實偏角比較（度）');
  console.log('  偏角是「從籃框看過去」相機偏離正側面的角度；θ 是相機繞出手點和籃框中間轉了幾度（正＝往底線那一側）。');
  console.log('  焦距：程式假設畫面長邊的 0.8 倍；後兩欄是實際焦距 0.7、0.9 倍（程式不知道）時的估計。');
  for (const thetaDeg of thetas) {
    const cols = [0.8, 0.7, 0.9].map((fr) => {
      const est = [1, 2, 3, 4, 5].map((seed) => poseTrial({ camera: { thetaDeg, focalRatio: fr }, seed, focalRatio: 0.8 }));
      return est;
    });
    const t = cols[0][0];
    const fmtE = (arr) => arr.map((e) => (e.devEst == null ? '—' : (e.devEst - e.devTrue >= 0 ? '+' : '') + (e.devEst - e.devTrue).toFixed(1))).join(' ');
    console.log(`  θ = ${String(thetaDeg).padStart(3)}（偏角 ${f1(t.devTrue).padStart(4)}）  焦距相同 ${fmtE(cols[0])}   0.7 倍 ${fmtE(cols[1])}   0.9 倍 ${fmtE(cols[2])}`);
  }
  console.log('');

  const show = (title, rows) => {
    console.log(title);
    console.log('  θ      偏角   分級     進球的角度誤差 p90／最大   全部的 p90／最大   漏／多／判錯（共幾球）');
    for (const r of rows) {
      console.log(`  ${String(r.thetaDeg).padStart(4)}  ${f1(r.devTrue).padStart(5)}   ${r.grades.padEnd(6)}   ${f1(r.madeP90).padStart(5)} ／${f1(r.madeMax).padStart(5)}          ${f1(r.allP90).padStart(5)} ／${f1(r.allMax).padStart(5)}      ${r.missed}／${r.extra}／${r.madeWrong}（${r.shots}）`);
    }
    console.log('');
  };
  show('十五、自動模式整條流程（每個位置 5 段、每段 10 球：空心、擦框進出、麵包球、從旁邊和後面經過），焦距假設正確', autoSweep(thetas, 5));
  show('十六、同上，但實際焦距是 0.7 倍（程式以為 0.8）', autoSweep([0, -20, -40, -60], 5, { camera: { focalRatio: 0.7 } }));
  show('    同上，實際焦距 0.9 倍', autoSweep([0, -20, -40, -60], 5, { camera: { focalRatio: 0.9 } }));
  show('    同上，焦距正確、背景有另一個籃框在投籃、有人運球和傳球', autoSweep([0, -30, -50, -70, -90], 3, { background: true }));
  show('    同上，手機歪 3 度、鏡頭仰 8 度', autoSweep([0, -30, -50], 3, { camera: { rollDeg: 3, pitchDeg: 8 } }));
  show('    同上，手機歪 −5 度', autoSweep([0, -30], 3, { camera: { rollDeg: -5 } }));
  const offset = ['swish', 'offset', 'swish', 'offset', 'swish', 'offset', 'swish', 'offset'];
  show('    進球但左右偏了約 9 公分（球心離開投籃平面）：每段 8 球，一半偏', autoSweep([0, -20, -40, -55], 3, { script: offset }));
  show('    投籃方向和籃板不垂直 8 度（從側翼投；程式假設投籃方向垂直籃板）', autoSweep([0, -10, -20, -30, -40, -55], 3, { shotYawDeg: 8 }));
  show('十七、如果 60 度以上也照樣換到投籃平面算角度（不分 C 級）：為什麼 C 級不給角度', autoSweep([-50, -60, -70, -80], 3, { gradeLimits: { A: 30, B: 95 } }));
  show('十八、模型沒有籃框、籃板類別（使用者點兩下籃框）：偏角只能由球的大小變化粗估，A、B 級用 tan(真) = tan(量)·cos θ 修正', autoSweep([10, 0, -10, -20, -30, -40, -50, -70, -90], 3, { taps: true }));
}

function main() {
  const fmt = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '  —  ');
  const shots = [50, 54, 58].map((launch) => designShot(launch));
  const LEVELS = [
    ['persp', '修正透視（預設）'],
    ['vertical', '垂直參考線'],
    ['rim', '籃框連線'],
    ['image', '畫面水平'],
  ];
  const errs = (cam, level, focal, vref) => shots.map((s) => measure(s, cam, level, focal, vref) - s.angle);
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
  const table = (title, rows) => {
    console.log(title);
    console.log(`  ${pad('', 36)}${LEVELS.map(([, name]) => pad(name, 22)).join('')}`);
    for (const [label, cam] of rows) console.log(`  ${pad(label, 36)}${LEVELS.map(([level]) => pad(errs(cam, level).map(fmt).join(' '), 22)).join('')}`);
    console.log('');
  };

  console.log('每一格三個數字＝三種弧度（真實入框角度 ' + shots.map((s) => s.angle.toFixed(1)).join('、') + ' 度）量出來的誤差（度，正＝高估）。');
  console.log('四欄＝四種水平基準：籃框連線並修正透視（實拍影片的預設）、垂直參考線（籃板靠近相機的側邊）、直接用籃框連線、畫面水平。');
  console.log('基準擺法：相機在出手點和籃框中間的正側面 8 公尺、鏡頭高 1.4 公尺、手機不仰、不轉、不歪；焦距＝畫面寬的 0.8 倍。');
  console.log('這是幾何模擬（理想鏡頭、點得完全準），不是實拍量測。');
  console.log('「—」＝那條鉛直線不在畫面裡（太近，或腳架在罰球線旁邊時籃板出了畫面），這種擺法沒辦法用垂直參考線。');
  console.log('');

  console.log('一、驗證公式 tan(量測) = tan(真實) / cos θ：相機離得很遠（300 公尺，接近平行投影），偏離正側面 θ 度');
  for (const theta of [5, 10, 15, 20]) {
    const sim = errs(around(theta, 300, { f: F * 37.5 }), 'image');
    const formula = shots.map((s) => yawFormula(s.angle, theta) - s.angle);
    console.log(`  θ = ${String(theta).padStart(2)} 度   模擬 ${sim.map(fmt).join(' ')}   公式 ${formula.map(fmt).join(' ')}`);
  }
  console.log('');

  table('二、相機離場景 8 公尺，偏離正側面 θ 度（正＝往籃框後方偏，負＝往投籃者後方偏）', [-20, -10, -5, 0, 5, 10, 20].map((t) => [`θ = ${t} 度`, around(t, 8)]));
  table('三、同樣偏 +10 度，相機距離不同', [5, 6, 8, 10, 15, 30].map((d) => [`距離 ${d} 公尺`, around(10, d)]));
  table('四、鏡頭垂直於投籃方向，只是腳架沿著邊線的位置不同（不轉鏡頭）', [-SHOT_DIST, -3, MID, -1, 0].map((along) => [along === 0 ? '籃框的正側面' : `籃框往投籃者方向 ${(-along).toFixed(1)} 公尺`, { ...BASE, along }]));
  table('五、鏡頭往上仰 φ 度', [0, 3, 5, 8, 10, 15].map((pitchDeg) => [`仰角 ${pitchDeg} 度`, { ...BASE, pitchDeg }]));
  table('六、鏡頭高度不同（不仰）', [0.9, 1.2, 1.4, 1.7, 2.2].map((height) => [`鏡頭高 ${height} 公尺`, { ...BASE, height }]));
  table('七、手機左右歪了 ε 度', [0, 1, 2, 3, 5].map((rollDeg) => [`歪 ${rollDeg} 度`, { ...BASE, rollDeg }]));
  table('八、相機距離不同（其他照基準擺法）', [5, 6, 8, 10, 12].map((dist) => [`距離 ${dist} 公尺`, { ...BASE, dist }]));
  table(
    '九、常見的錯誤擺法：站在罰球線的正側面，把鏡頭轉向出手點和籃框的中間，並往上仰讓整條弧線入鏡',
    [6, 8, 10].map((dist) => {
      const yawDeg = (Math.atan((MID + SHOT_DIST) / dist) * 180) / Math.PI;
      const pitchDeg = (Math.atan((2.4 - 1.2) / dist) * 180) / Math.PI;
      return [`距離 ${dist} 公尺（轉 ${yawDeg.toFixed(0)} 度、仰 ${pitchDeg.toFixed(0)} 度）`, { ...BASE, dist, along: -SHOT_DIST, height: 1.2, yawDeg, pitchDeg }];
    }),
  );

  console.log('十、程式假設的焦距（畫面寬的 0.8 倍）和實際不同時，基準擺法、站的距離讓場景在畫面裡一樣大：');
  console.log(`  ${pad('', 36)}${pad('修正透視（預設）', 22)}${pad('垂直參考線', 22)}籃框連線（不用焦距）`);
  for (const ratio of [0.4, 0.6, 0.7, 0.8, 0.9, 1.0, 1.6]) {
    const cam = { ...BASE, f: ratio * W, dist: (8 * ratio) / 0.8 };
    console.log(`  ${pad(`真實焦距 ${ratio.toFixed(1)} 倍（距離 ${cam.dist.toFixed(0)} 公尺）`, 36)}${['persp', 'vertical', 'rim'].map((lv) => pad(errs(cam, lv).map(fmt).join(' '), 22)).join('')}`);
  }
  console.log('');

  const { left, right } = rimClicks(BASE);
  console.log('十一、籃框點歪了：後緣點的高度點錯幾個像素（基準擺法；籃框在畫面上寬約 ' + Math.round(Math.hypot(right.x - left.x, right.y - left.y)) + ' 像素）');
  console.log(`  ${pad('', 36)}${pad('修正透視（預設）', 22)}垂直參考線`);
  for (const dyPx of [1, 2, 3]) {
    const back = { x: right.x, y: right.y - dyPx };
    const out = ['persp', 'vertical'].map((level) => {
      const hoop = makeHoopFrame(left, back, { level, width: W, height: H, vertical: verticalClicks(BASE, 'board') });
      return shots.map((s) => measureWithFrame(s, BASE, hoop) - s.angle);
    });
    console.log(`  ${pad(`後緣點高了 ${dyPx} 像素`, 36)}${out.map((o) => pad(o.map(fmt).join(' '), 22)).join('')}`);
  }
  console.log('');

  const vb = verticalClicks(BASE, 'board');
  const vp = verticalClicks(BASE, 'post');
  const vlen = (v) => Math.round(Math.hypot(v.top.x - v.bottom.x, v.top.y - v.bottom.y));
  console.log(`十二、垂直參考線本身的誤差（基準擺法；籃板側邊在畫面上看得到約 ${vlen(vb)} 像素長、籃架立柱約 ${vlen(vp)} 像素）`);
  for (const dxPx of [1, 2, 3]) {
    console.log(`  ${pad(`上端點往旁邊點歪 ${dxPx} 像素`, 36)}籃板側邊 ${errs(BASE, 'vertical', undefined, { dxPx }).map(fmt).join(' ')}   立柱 ${errs(BASE, 'vertical', undefined, { which: 'post', dxPx }).map(fmt).join(' ')}`);
  }
  for (const leanDeg of [0.5, 1, 2]) {
    console.log(`  ${pad(`那條線其實斜了 ${leanDeg} 度`, 36)}${errs(BASE, 'vertical', undefined, { leanDeg }).map(fmt).join(' ')}`);
  }
  console.log('  鏡頭往上仰時，鉛直線會往畫面上方收斂，離畫面中央越遠的線斜得越多，所以用哪一條線結果不同：');
  for (const pitchDeg of [3, 5, 10]) {
    const cam = { ...BASE, pitchDeg };
    const cols = ['board', 'boardFar', 'post'].map((which) => errs(cam, 'vertical', undefined, { which }).map(fmt).join(' '));
    console.log(`  ${pad(`仰 ${pitchDeg} 度`, 36)}籃板近側 ${cols[0]}   籃板遠側 ${cols[1]}   立柱 ${cols[2]}`);
  }
  console.log('');

  console.log('十三、能不能用「垂直參考線」和「籃框扣掉透視」兩個歪斜估計的差，反推鏡頭仰角？（度）');
  console.log('  兩者在鏡頭擺正時都等於手機真正的歪斜；仰角讓兩個一起偏，差值才是可以拿來估仰角的訊號。');
  for (const [label, cam] of [
    ['擺正', BASE], ['仰 3 度', { ...BASE, pitchDeg: 3 }], ['仰 5 度', { ...BASE, pitchDeg: 5 }], ['仰 10 度', { ...BASE, pitchDeg: 10 }],
    ['歪 3 度', { ...BASE, rollDeg: 3 }], ['真實焦距 0.6 倍', { ...BASE, f: 0.6 * W, dist: 6 }], ['真實焦距 1.0 倍', { ...BASE, f: 1.0 * W, dist: 10 }],
  ]) {
    const r = rollEstimates(cam);
    const rp = rollEstimates(cam, 'post');
    console.log(`  ${pad(label, 20)}籃框 ${fmt(r.rim)}   籃板側邊 ${fmt(r.vertical)}（差 ${fmt(r.vertical - r.rim)}）   立柱 ${fmt(rp.vertical)}（差 ${fmt(rp.vertical - r.rim)}）`);
  }
  {
    const hp = makeHoopFrame(left, { x: right.x, y: right.y - 1 }, { level: 'persp', width: W, height: H });
    const h0 = makeHoopFrame(left, right, { level: 'persp', width: W, height: H });
    console.log(`  對照：籃框後緣點高 1 像素，籃框那個估計就變 ${fmt((hp.tiltDeg - hp.perspDeg) - (h0.tiltDeg - h0.perspDeg))} 度；`
      + `籃板側邊上端點歪 1 像素，參考線那個估計變 ${fmt(Math.atan2(1, vlen(vb)) * 180 / Math.PI)} 度。`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--auto')) autoSections();
  else {
    main();
    if (!process.argv.includes('--classic')) {
      console.log('');
      autoSections();
    }
  }
}
