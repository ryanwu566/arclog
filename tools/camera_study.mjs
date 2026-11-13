// 鏡頭擺位對入框角度的影響：用針孔相機模型把一條已知角度的投籃軌跡投影到畫面上，
// 再用網站的同一套程式（校正 → 擬合 → 入框角度）去量，看量到的角度和真實角度差多少。
//
//   node tools/camera_study.mjs
//
// docs/SHOOTING_GUIDE.md 和 docs/EVAL.md 裡「鏡頭沒擺正會差多少」的數字都是這支程式算出來的。
// 這是幾何模擬：理想的針孔鏡頭、沒有鏡頭變形、籃框和球心都點得完全準。它不是實拍量測。
//
// tests/js/camera.test.mjs 用這裡的函式檢查兩件事：
//   1. 預設的水平基準（籃框連線並修正透視）在鏡頭擺正時沒有系統性偏差
//   2. 偏離正側面時的誤差符合 tan(量測) = tan(真實) / cos θ

import { pathToFileURL } from 'node:url';
import { makeHoopFrame, toHoop } from '../web/js/core/geometry.js';
import { analyzeShot } from '../web/js/core/shot.js';
import { DRAG_K_PER_M, DRAG_K_RIM } from '../web/js/core/constants.js';

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
 * 用網站的程式量一次，回傳量到的入框角度（度）。
 * level：'persp'（籃框連線並修正透視，實拍影片的預設）、'rim'（籃框連線）、'image'（畫面水平）
 * focal：程式「以為」的焦距（畫面寬的幾倍）；不給就用程式的預設值
 */
export function measure(shot, cam, level = 'persp', focal = undefined) {
  const { left, right } = rimClicks(cam);
  // 球從 -x 飛向籃框：前緣（靠近投籃者）在畫面左邊
  const hoop = makeHoopFrame(left, right, { level, width: W, height: H, focal });
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

function main() {
  const fmt = (v) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '  —  ');
  const shots = [50, 54, 58].map((launch) => designShot(launch));
  const LEVELS = [
    ['persp', '修正透視（預設）'],
    ['rim', '籃框連線'],
    ['image', '畫面水平'],
  ];
  const errs = (cam, level, focal) => shots.map((s) => measure(s, cam, level, focal) - s.angle);
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, ch) => a + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
  const table = (title, rows) => {
    console.log(title);
    console.log(`  ${pad('', 36)}${LEVELS.map(([, name]) => pad(name, 22)).join('')}`);
    for (const [label, cam] of rows) console.log(`  ${pad(label, 36)}${LEVELS.map(([level]) => pad(errs(cam, level).map(fmt).join(' '), 22)).join('')}`);
    console.log('');
  };

  console.log('每一格三個數字＝三種弧度（真實入框角度 ' + shots.map((s) => s.angle.toFixed(1)).join('、') + ' 度）量出來的誤差（度，正＝高估）。');
  console.log('三欄＝三種水平基準：籃框連線並修正透視（實拍影片的預設）、直接用籃框連線、畫面水平。');
  console.log('基準擺法：相機在出手點和籃框中間的正側面 8 公尺、鏡頭高 1.4 公尺、手機不仰、不轉、不歪；焦距＝畫面寬的 0.8 倍。');
  console.log('這是幾何模擬（理想鏡頭、點得完全準），不是實拍量測。');
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

  console.log('十、「修正透視」假設的焦距不準時（程式一律假設畫面寬的 0.8 倍），基準擺法、站的距離讓場景在畫面裡一樣大：');
  for (const ratio of [0.4, 0.6, 0.7, 0.8, 0.9, 1.0, 1.6]) {
    const cam = { ...BASE, f: ratio * W, dist: (8 * ratio) / 0.8 };
    console.log(`  ${pad(`真實焦距 ${ratio.toFixed(1)} 倍（距離 ${cam.dist.toFixed(0)} 公尺）`, 36)}${pad(errs(cam, 'persp').map(fmt).join(' '), 22)}不修正：${errs(cam, 'rim').map(fmt).join(' ')}`);
  }
  console.log('');

  console.log('十一、籃框點歪了：其中一個點的高度點錯 1 像素（基準擺法；籃框在畫面上寬約 ' + Math.round(Math.hypot(rimClicks(BASE).right.x - rimClicks(BASE).left.x, rimClicks(BASE).right.y - rimClicks(BASE).left.y)) + ' 像素）');
  {
    const { left, right } = rimClicks(BASE);
    for (const dyPx of [1, 2, 3]) {
      const hoop = makeHoopFrame(left, { x: right.x, y: right.y - dyPx }, { level: 'persp', width: W, height: H });
      const out = shots.map((s) => {
        const pts = [];
        for (let k = 0; k < s.pts.length; k += 8) {
          const p = s.pts[k];
          if (p.vy < 0 && p.y < RIM_H) break;
          const img = project(BASE, p.x, p.y, 0);
          const [u, v] = toHoop(hoop, img.x, img.y);
          pts.push({ u, v, t: p.t });
        }
        return analyzeShot(pts, { dragK: DRAG_K_RIM }).angleRaw - s.angle;
      });
      console.log(`  ${pad(`後緣點高了 ${dyPx} 像素`, 36)}${out.map(fmt).join(' ')}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
