// 產生 JS 和 Python 共用的測試向量（tests/vectors/*.json）。
//
//   node tests/gen_vectors.mjs           重新產生
//   node tests/gen_vectors.mjs --check   只檢查現有的檔案是不是最新的（測試會跑這個）
//
// 每個案例有三種資料：
//   input    兩邊都讀的輸入
//   truth    由合成物理直接得到的真實答案（和估計器無關），用來檢查「誤差在 1 度以內」
//   expected JS 版算出來的結果，Python 版必須算出一樣的數字（差 < 1e-6）
//
// 產生時就會檢查 truth 的誤差門檻；有案例超過會直接失敗，不會悄悄寫出檔案。
// 修改核心演算法後要重新產生，並在提交訊息說明為什麼數值變了。

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as C from '../web/js/core/constants.js';
import { mulberry32, randInt, randNormal } from '../web/js/core/prng.js';
import { makeHoopFrame, toHoop, toImage } from '../web/js/core/geometry.js';
import { fitParabola, descendingCrossing, fitArc, evalArc, ransacArc, fitLine } from '../web/js/core/fit.js';
import { analyzeShot, judgeMake, sampleArc } from '../web/js/core/shot.js';
import { findShots, markStatic } from '../web/js/core/track.js';
import { summarize, plainSummary } from '../web/js/core/stats.js';
import { interpolateShot } from '../web/js/core/interp.js';
import { shotsToCsv, parseCsv } from '../web/js/core/csv.js';
import { buildBundle, validateBundle } from '../web/js/core/bundle.js';
import { letterbox, decodeDetections } from '../web/js/core/yolo.js';
import {
  makeDemoPlan, planTruth, simulateClicks, hoopPx, verticalPx, ballAt, frameTime, worldToPx,
} from '../web/js/core/synth.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'vectors');
mkdirSync(OUT, { recursive: true });
const r3 = (x) => Math.round(x * 1000) / 1000;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const CHECK = process.argv.includes('--check');
const stale = [];
const save = (name, obj) => {
  const text = JSON.stringify(obj) + '\n';
  const path = join(OUT, name);
  if (CHECK) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) stale.push(name);
    return;
  }
  writeFileSync(path, text);
  console.log(`  ${name}: ${(text.length / 1024).toFixed(1)} KB`);
};
const report = [];

// ── constants / prng ────────────────────────────────────────────────────────
save('constants.json', {
  RIM_DIAMETER_M: C.RIM_DIAMETER_M,
  BALL_DIAMETER_M: C.BALL_DIAMETER_M,
  BALL_RADIUS_RIM: C.BALL_RADIUS_RIM,
  IDEAL_ENTRY_DEG: C.IDEAL_ENTRY_DEG,
  DRAG_K_PER_M: C.DRAG_K_PER_M,
  DRAG_K_RIM: C.DRAG_K_RIM,
  MAKE_NEAR_FACTOR: C.MAKE_NEAR_FACTOR,
  MAKE_FAR_FACTOR: C.MAKE_FAR_FACTOR,
  MIN_MANUAL_POINTS: C.MIN_MANUAL_POINTS,
  roundAngle: [44.449999, 44.45, 44.95, 45, 0.05, 89.96, 37.25, 52.349].map((x) => [x, C.roundAngle(x)]),
});

save('prng.json', {
  sequences: [1, 42, 12345, 20261113, 4294967295, 0].map((seed) => {
    const rng = mulberry32(seed);
    const floats = Array.from({ length: 8 }, () => rng());
    const rng2 = mulberry32(seed);
    const ints = Array.from({ length: 8 }, () => randInt(rng2, 37));
    const rng3 = mulberry32(seed);
    const normals = Array.from({ length: 4 }, () => randNormal(rng3));
    return { seed, floats, ints, normals };
  }),
});

// ── geometry ────────────────────────────────────────────────────────────────
{
  const cases = [];
  const defs = [
    { front: { x: 900, y: 240 }, back: { x: 1035, y: 240 }, level: 'rim' },
    { front: { x: 900, y: 240 }, back: { x: 1034.2, y: 233.1 }, level: 'rim' },
    { front: { x: 900, y: 240 }, back: { x: 1034.2, y: 233.1 }, level: 'image' },
    { front: { x: 400, y: 300.5 }, back: { x: 268.25, y: 306.75 }, level: 'rim' }, // 投籃者在右邊
    { front: { x: 400, y: 300.5 }, back: { x: 268.25, y: 306.75 }, level: 'image' },
    // 修正透視：籃框在畫面右上、左上（投籃者在右邊）、直拍並指定焦距、沒給畫面大小（→ 當成 rim）
    { front: { x: 1403.5, y: 412 }, back: { x: 1538.2, y: 405.1 }, level: 'persp', width: 1920, height: 1080 },
    { front: { x: 400, y: 300.5 }, back: { x: 268.25, y: 306.75 }, level: 'persp', width: 1280, height: 720 },
    { front: { x: 700, y: 900 }, back: { x: 815, y: 893 }, level: 'persp', width: 1080, height: 1920, focal: 0.72 },
    { front: { x: 900, y: 240 }, back: { x: 1034.2, y: 233.1 }, level: 'persp' },
    { front: { x: 10, y: 10 }, back: { x: 10, y: 10 }, level: 'rim' }, // 兩點重合 → null
    { front: { x: 10, y: 10 }, back: { x: 10, y: 80 }, level: 'image' }, // 垂直線配 image → null
    // 垂直參考線：籃框在畫面右上、參考線是籃板側邊（稍微斜）
    { front: { x: 1403.5, y: 412 }, back: { x: 1538.2, y: 405.1 }, level: 'vertical', width: 1920, height: 1080, vertical: { top: { x: 1561.3, y: 300.2 }, bottom: { x: 1558.9, y: 520.6 } } },
    // 同一條線、兩點反過來點：結果要一樣
    { front: { x: 1403.5, y: 412 }, back: { x: 1538.2, y: 405.1 }, level: 'vertical', width: 1920, height: 1080, vertical: { top: { x: 1558.9, y: 520.6 }, bottom: { x: 1561.3, y: 300.2 } } },
    // 投籃者在右邊；直拍並指定焦距；沒給畫面大小（不扣比例）
    { front: { x: 400, y: 300.5 }, back: { x: 268.25, y: 306.75 }, level: 'vertical', width: 1280, height: 720, vertical: { top: { x: 240.5, y: 200 }, bottom: { x: 243.7, y: 380 } } },
    { front: { x: 700, y: 900 }, back: { x: 815, y: 893 }, level: 'vertical', width: 1080, height: 1920, focal: 0.72, vertical: { top: { x: 850, y: 760 }, bottom: { x: 851.5, y: 980 } } },
    { front: { x: 900, y: 240 }, back: { x: 1034.2, y: 233.1 }, level: 'vertical', vertical: { top: { x: 1060, y: 120 }, bottom: { x: 1058, y: 330 } } },
    // 手機歪了 8 度：籃框連線和參考線一起轉
    { front: { x: 900, y: 240 }, back: { x: 1033.7, y: 221.2 }, level: 'vertical', width: 1920, height: 1080, vertical: { top: { x: 1072.4, y: 110.3 }, bottom: { x: 1043.2, y: 318.1 } } },
    { front: { x: 900, y: 240 }, back: { x: 1034.2, y: 233.1 }, level: 'vertical', width: 1920, height: 1080 }, // 沒有參考線 → null
    { front: { x: 900, y: 240 }, back: { x: 1034.2, y: 233.1 }, level: 'vertical', width: 1920, height: 1080, vertical: { top: { x: 50, y: 50 }, bottom: { x: 50, y: 50 } } }, // 參考線兩點重合 → null
    { front: { x: 900, y: 240 }, back: { x: 1034.2, y: 233.1 }, level: 'vertical', width: 1920, height: 1080, vertical: { top: { x: 900, y: 300 }, bottom: { x: 1000, y: 310 } } }, // 點到的是橫線 → null
  ];
  for (const d of defs) {
    const frame = makeHoopFrame(d.front, d.back, { level: d.level, width: d.width, height: d.height, focal: d.focal, vertical: d.vertical });
    const pts = frame
      ? [[d.front.x, d.front.y], [d.back.x, d.back.y], [123.4, 567.8], [1000, 50], [640, 360]].map(([x, y]) => {
          const [u, v] = toHoop(frame, x, y);
          const [bx, by] = toImage(frame, u, v);
          return { x, y, u, v, bx, by };
        })
      : [];
    cases.push({ ...d, frame, pts });
  }
  save('geometry.json', { cases });
}

// ── 進球判定 ────────────────────────────────────────────────────────────────
{
  const grid = [];
  for (const angle of [25, 33, 38, 42, 45, 48, 52, 58, 65]) {
    for (let s = -0.6; s <= 1.6001; s += 0.05) {
      const sv = Math.round(s * 100) / 100;
      const j = judgeMake(sv, angle);
      grid.push({ s: sv, angle, made: j.made, zone: j.zone, nearClear: j.nearClear, farGap: j.farGap });
    }
  }
  // 人工核對過的案例（不是由程式產生的預期值）
  const hand = [
    { s: 0.5, angle: 45, made: true, zone: 'clean', why: '正中、45 度：前緣餘裕 0.354、後緣 0.5，都大於球半徑 0.267' },
    { s: 0.61, angle: 45, made: true, zone: 'clean', why: '常被引用的理想落點：過籃框中心大約 5 公分' },
    { s: 0.3, angle: 45, made: true, zone: 'rim', why: '前緣餘裕 0.212，介於 0.6R=0.16 和 R=0.267 之間：會擦到前緣' },
    { s: 0.8, angle: 45, made: true, zone: 'rim', why: '離後緣 0.2，介於 0.5R=0.133 和 R=0.267 之間：會碰後緣內側' },
    { s: 0.1, angle: 45, made: false, zone: 'short', why: '前緣餘裕 0.071 < 0.16：正面撞上前緣' },
    { s: -0.2, angle: 50, made: false, zone: 'short', why: '球心落在前緣之外' },
    { s: 0.95, angle: 45, made: false, zone: 'long', why: '離後緣 0.05 < 0.133：撞上後緣上方' },
    { s: 1.2, angle: 40, made: false, zone: 'long', why: '球心落在後緣之外' },
    { s: 0.5, angle: 28, made: true, zone: 'rim', why: '角度太平時，正中也只剩 0.235 的餘裕，小於球半徑' },
    { s: 0.5, angle: 15, made: false, zone: 'short', why: '15 度時前緣餘裕 0.129 < 0.16' },
  ];
  for (const h of hand) {
    const j = judgeMake(h.s, h.angle);
    if (j.made !== h.made || j.zone !== h.zone) throw new Error(`人工核對案例不符：${JSON.stringify(h)} → ${JSON.stringify(j)}`);
  }
  save('make.json', { grid, hand });
}

// ── 入框角度（已知真實角度的合成軌跡）──────────────────────────────────────
function oneShotPlan(o) {
  return makeDemoPlan({
    seed: o.seed ?? 1,
    fps: o.fps ?? 30,
    width: o.width ?? 1280,
    height: o.height ?? 720,
    pxPerM: o.pxPerM ?? 160,
    mirror: !!o.mirror,
    rollDeg: o.rollDeg ?? 0,
    dragK: o.truthDragK,
    script: [{ angle: o.angle, kind: o.kind ?? 'make', s: o.s, releaseX: o.releaseX ?? -3.9, releaseY: o.releaseY ?? -0.8 }],
  });
}

{
  const cases = [];
  let idx = 0;
  const add = (o) => {
    idx++;
    const plan = oneShotPlan(o);
    const hp = hoopPx(plan);
    const level = o.level ?? 'rim';
    const front = { x: r3(hp.front.x), y: r3(hp.front.y) };
    const back = { x: r3(hp.back.x), y: r3(hp.back.y) };
    const clicks = simulateClicks(plan, 0, { count: o.n, noisePx: o.noisePx, seed: 1000 + idx });
    const points = clicks.map((c) => ({ x: r3(c.x), y: r3(c.y), t: r6(c.t) }));
    const dragK = o.fitDragK ?? (o.truthDragK === 0 ? 0 : C.DRAG_K_RIM);
    const hoop = makeHoopFrame(front, back, { level });
    const res = analyzeShot(points.map((p) => { const [u, v] = toHoop(hoop, p.x, p.y); return { u, v, t: p.t }; }), { dragK });
    // zone：把「真實的過框位置和角度」代進幾何判定得到的分區（手點流程只能做到幾何判定）。
    // simMade：碰撞模擬裡球最後有沒有進（碰框後彈進去的球，幾何判定猜不到，所以只記錄不比對）。
    const truth = {
      angleDeg: plan.shots[0].angleDeg,
      crossS: plan.shots[0].crossS,
      zone: judgeMake(plan.shots[0].crossS, plan.shots[0].angleDeg).zone,
      simMade: plan.shots[0].made,
    };
    const tol = o.tol ?? 1.0;
    const err = res.ok ? res.angleRaw - truth.angleDeg : NaN;
    report.push({ file: 'angle', name: o.name, err, tol });
    if (!(Math.abs(err) < tol)) throw new Error(`angle 案例「${o.name}」誤差 ${err} 超過 ${tol} 度`);
    cases.push({
      name: o.name, front, back, level, dragK, points, truth, tolDeg: tol,
      expected: {
        angleRaw: res.angleRaw, angleDeg: res.angleDeg, crossS: res.crossS, made: res.made, zone: res.zone,
        flip: res.flip, model: res.model, parabola: res.parabola, apex: res.apex, rms: res.rms, monotonic: res.monotonic,
      },
    });
  };

  // 沒有雜訊：純拋物線與含阻力兩種物理，各種角度
  for (const angle of [30, 36, 41, 45, 49, 54, 60]) {
    add({ name: `無雜訊 拋物線 ${angle}°`, angle, s: 0.55, truthDragK: 0, n: 6, noisePx: 0, tol: 0.05 });
    add({ name: `無雜訊 含阻力 ${angle}°`, angle, s: 0.55, n: 6, noisePx: 0, tol: 0.05 });
  }
  // 只點最少的 4 點、點很多點
  add({ name: '無雜訊 4 點', angle: 46.3, s: 0.6, n: 4, noisePx: 0, tol: 0.05 });
  add({ name: '無雜訊 12 點', angle: 43.7, s: 0.5, n: 12, noisePx: 0, tol: 0.05 });
  // 進球、偏短、偏長
  add({ name: '偏短', angle: 44.2, s: -0.25, kind: 'short', n: 6, noisePx: 0, tol: 0.05 });
  add({ name: '偏長', angle: 39.4, s: 1.15, kind: 'long', n: 6, noisePx: 0, tol: 0.05 });
  // 投籃者在右邊（畫面鏡射）、手機歪 3 度（以籃框連線當水平）
  add({ name: '鏡射 無雜訊', angle: 47.1, s: 0.52, mirror: true, n: 6, noisePx: 0, tol: 0.05 });
  add({ name: '相機歪 3 度 無雜訊', angle: 45.6, s: 0.58, rollDeg: 3, n: 6, noisePx: 0, tol: 0.05 });
  add({ name: '相機歪 -4 度 鏡射 無雜訊', angle: 42.2, s: 0.5, rollDeg: -4, mirror: true, n: 6, noisePx: 0, tol: 0.05 });
  add({ name: '畫面水平基準 無雜訊', angle: 45.0, s: 0.55, level: 'image', n: 6, noisePx: 0, tol: 0.05 });
  // 較遠的出手點（約三分線）
  add({ name: '遠距離 無雜訊', angle: 44.0, s: 0.55, releaseX: -6.4, releaseY: -0.7, pxPerM: 130, width: 1280, n: 6, noisePx: 0, tol: 0.05 });
  // 真實的阻力係數和估計器假設的不一樣（±20%），誤差仍應在 1 度內
  add({ name: '阻力係數少 20%', angle: 45.0, s: 0.55, truthDragK: C.DRAG_K_PER_M * 0.8, n: 6, noisePx: 0, tol: 0.5 });
  add({ name: '阻力係數多 20%', angle: 45.0, s: 0.55, truthDragK: C.DRAG_K_PER_M * 1.2, n: 6, noisePx: 0, tol: 0.5 });
  // 有點擊雜訊：720p 取景（每公尺 160 像素）標準差 1 像素；1080p 取景（每公尺 300 像素）標準差 2 像素
  const angles = [33.5, 37.2, 40.8, 43.1, 44.6, 45.9, 47.4, 49.8, 52.3, 56.7];
  angles.forEach((angle, i) => {
    add({ name: `雜訊 1px 720p 6 點 ${angle}°`, angle, s: 0.48 + 0.02 * i, n: 6, noisePx: 1.0, pxPerM: 160 });
    add({ name: `雜訊 2px 1080p 6 點 ${angle}°`, angle, s: 0.66 - 0.02 * i, n: 6, noisePx: 2.0, pxPerM: 300, width: 2400, height: 1350 });
    add({ name: `雜訊 2px 1080p 5 點 ${angle}°`, angle, s: 0.55, n: 5, noisePx: 2.0, pxPerM: 300, width: 2400, height: 1350, mirror: i % 2 === 1 });
    add({ name: `雜訊 1px 1080p 4 點 ${angle}°`, angle, s: 0.55, n: 4, noisePx: 1.0, pxPerM: 300, width: 2400, height: 1350, rollDeg: (i % 3) - 1 });
  });
  save('angle.json', { cases });

  // 失敗案例：點太少、不是拋物線、沒有通過籃框平面
  const hoop = makeHoopFrame({ x: 900, y: 240 }, { x: 972, y: 240 });
  const mk = (arr) => arr.map(([u, v, t]) => ({ u, v, t }));
  const bad = [
    { name: '只有 2 點', points: mk([[-5, 1, 0], [-3, 2, 0.2]]) },
    { name: '開口向上', points: mk([[-6, 3, 0], [-4, 1.2, 0.2], [-2, 0.8, 0.4], [0, 2.2, 0.6]]) },
    { name: '最高點比籃框低', points: mk([[-6, -3, 0], [-4, -1.5, 0.2], [-2, -1.2, 0.4], [0, -2.1, 0.6]]) },
    { name: '同一個位置', points: mk([[-3, 1, 0], [-3, 1, 0.1], [-3, 1, 0.2]]) },
    { name: '只有兩個不同的水平位置', points: mk([[-3, 1, 0], [-3, 2, 0.1], [-2, 1.5, 0.2]]) },
  ].map((b) => ({ ...b, expected: analyzeShot(b.points) }));
  save('angle_fail.json', { hoop, cases: bad });
}

// ── 擬合的中間函式 ──────────────────────────────────────────────────────────
{
  const rng = mulberry32(77);
  const sets = [];
  for (let c = 0; c < 6; c++) {
    const n = 4 + c * 3;
    const a = -(0.05 + rng() * 0.08);
    const b = -(0.3 + rng() * 0.9);
    const cc = 0.1 + rng() * 0.5;
    const us = [];
    const vs = [];
    for (let i = 0; i < n; i++) {
      const u = -9 + (9.5 * i) / (n - 1) + (rng() - 0.5) * 0.2;
      us.push(u);
      vs.push(a * u * u + b * u + cc + randNormal(rng) * 0.01);
    }
    const parabola = fitParabola(us, vs);
    const crossing = descendingCrossing(parabola);
    const arc0 = fitArc(us, vs, { dragK: 0 });
    const arcK = fitArc(us, vs, { dragK: C.DRAG_K_RIM });
    const probe = [-9.5, -6.1, -3.3, -1, 0, 0.5, 1, 1.4];
    sets.push({
      us, vs, parabola, crossing, arc0, arcK,
      probe,
      eval0: evalArc({ uc: arc0.uc, slope: arc0.slope, kappa: arc0.kappa, k: 0 }, probe),
      evalK: evalArc({ uc: arcK.uc, slope: arcK.slope, kappa: arcK.kappa, k: arcK.k }, probe),
      line: fitLine(us, vs),
    });
  }
  save('fit.json', { sets });
}

// ── RANSAC（含離群點）───────────────────────────────────────────────────────
{
  const cases = [];
  const defs = [
    { name: '25 個軌跡點 + 10 個離群點', angle: 45.4, s: 0.55, keep: 1.0, outliers: 10, noisePx: 1.5, pxPerM: 300 },
    { name: '漏掉三成偵測 + 15 個離群點', angle: 41.8, s: 0.6, keep: 0.7, outliers: 15, noisePx: 1.5, pxPerM: 300 },
    { name: '鏡射 + 20 個離群點', angle: 49.2, s: 0.5, keep: 0.85, outliers: 20, noisePx: 2.0, pxPerM: 300, mirror: true },
    { name: '720p + 離群點貼近軌跡', angle: 46.7, s: 0.52, keep: 0.9, outliers: 12, noisePx: 1.0, pxPerM: 160, near: true },
    { name: '偏短 + 離群點', angle: 43.3, s: -0.2, kind: 'short', keep: 0.9, outliers: 12, noisePx: 1.5, pxPerM: 300 },
    { name: '60fps + 30 個離群點', angle: 44.1, s: 0.58, keep: 0.8, outliers: 30, noisePx: 1.5, pxPerM: 300, fps: 60 },
    { name: '離群點超過一半', angle: 47.9, s: 0.56, keep: 0.75, outliers: 40, noisePx: 1.5, pxPerM: 300 },
  ];
  defs.forEach((d, ci) => {
    const wide = d.pxPerM === 300;
    const plan = oneShotPlan({ ...d, width: wide ? 2400 : 1280, height: wide ? 1350 : 720 });
    const hp = hoopPx(plan);
    const front = { x: r3(hp.front.x), y: r3(hp.front.y) };
    const back = { x: r3(hp.back.x), y: r3(hp.back.y) };
    const hoop = makeHoopFrame(front, back);
    const rng = mulberry32(500 + ci);
    const sh = plan.shots[0];
    const raw = [];
    const f0 = Math.ceil(sh.tRelease * plan.fps);
    const f1 = Math.floor(Math.min(sh.tCross, sh.tHandover) * plan.fps);
    for (let f = f0; f <= f1; f++) {
      if (rng() > d.keep) continue;
      const t = frameTime(plan, f);
      const b = ballAt(plan, t);
      raw.push({ x: b.x + randNormal(rng) * d.noisePx, y: b.y + randNormal(rng) * d.noisePx, t, inlier: true });
    }
    for (let k = 0; k < d.outliers; k++) {
      const t = sh.tRelease - 0.5 + rng() * (sh.flight.T + 1.0);
      let x = rng() * plan.width;
      let y = rng() * plan.height;
      if (d.near && k % 2 === 0) {
        // 離軌跡 0.5–1.5 顆球遠的假偵測
        const b = ballAt(plan, Math.min(Math.max(t, sh.tRelease + 0.01), sh.tHandover - 0.01));
        const off = (0.5 + rng()) * hoop.ballDiameterPx * (rng() < 0.5 ? -1 : 1);
        x = b.x + off * 0.3;
        y = b.y + off;
      }
      raw.push({ x, y, t, inlier: false });
    }
    raw.sort((p, q) => p.t - q.t);
    const points = raw.map((p) => ({ x: r3(p.x), y: r3(p.y), t: r6(p.t) }));
    const pts = points.map((p) => { const [u, v] = toHoop(hoop, p.x, p.y); return { u, v, t: p.t }; });
    const arc = ransacArc(pts, { seed: 9 + ci, iters: 600 });
    if (!arc) throw new Error(`ransac 案例「${d.name}」沒有找到軌跡`);
    const res = analyzeShot(arc.inliers.map((m) => pts[m]));
    const truth = { angleDeg: sh.angleDeg, crossS: sh.crossS, inliers: raw.map((p, i) => (p.inlier ? i : -1)).filter((i) => i >= 0) };
    const err = res.angleRaw - truth.angleDeg;
    report.push({ file: 'ransac', name: d.name, err, tol: 1 });
    if (!(Math.abs(err) < 1)) throw new Error(`ransac 案例「${d.name}」誤差 ${err} 度`);
    const got = new Set(arc.inliers);
    const wrong = arc.inliers.filter((m) => !raw[m].inlier).length;
    const missed = truth.inliers.filter((m) => !got.has(m)).length;
    cases.push({
      name: d.name, front, back, points, seed: 9 + ci, iters: 600, truth,
      expected: { dir: arc.dir, inliers: arc.inliers, parabola: arc.parabola, line: arc.line, angleRaw: res.angleRaw, falseInliers: wrong, missedInliers: missed },
    });
  });
  // 找不到的情況：全是亂點
  const rng = mulberry32(31337);
  const noise = Array.from({ length: 30 }, (_, i) => ({ u: -8 + rng() * 9, v: -4 + rng() * 6, t: i * 0.033 }));
  save('ransac.json', { cases, noiseOnly: { points: noise, seed: 3, expected: ransacArc(noise, { seed: 3 }) } });
}

// ── 整段影片的偵測 → 一球一球 ───────────────────────────────────────────────
{
  const scenarios = [];
  const defs = [
    { name: '示範 10 球 30fps', plan: {}, stride: 1, keep: 0.85, fp: 0.15, noisePx: 1.2 },
    { name: '示範 10 球 每 2 幀偵測一次', plan: {}, stride: 2, keep: 0.9, fp: 0.1, noisePx: 1.2 },
    { name: '鏡射、相機歪 2 度、60fps', plan: { mirror: true, rollDeg: 2, fps: 60, seed: 99 }, stride: 2, keep: 0.8, fp: 0.2, noisePx: 1.5 },
    { name: '1080p 取景、漏掉四成偵測', plan: { pxPerM: 300, width: 2400, height: 1350, seed: 7 }, stride: 1, keep: 0.6, fp: 0.25, noisePx: 2.5 },
    { name: '純拋物線物理（估計器關閉阻力修正）', plan: { dragK: 0, seed: 3 }, stride: 1, keep: 0.9, fp: 0.1, noisePx: 1.0, dragK: 0 },
  ];
  defs.forEach((d, si) => {
    const plan = makeDemoPlan(d.plan);
    const hp = hoopPx(plan);
    const front = { x: r3(hp.front.x), y: r3(hp.front.y) };
    const back = { x: r3(hp.back.x), y: r3(hp.back.y) };
    const hoop = makeHoopFrame(front, back);
    const ballPx = hoop.ballDiameterPx;
    const rng = mulberry32(8000 + si);
    const dets = [];
    const size = () => r3(ballPx * (0.9 + rng() * 0.25));
    // 干擾物：一顆一直放在地上的球、一段運球、偶爾出現的假偵測
    const floorBall = worldToPx(plan, -5.2, -3.05 + 0.12);
    for (let f = 0; f < plan.frameCount; f += d.stride) {
      const t = frameTime(plan, f);
      const b = ballAt(plan, t);
      if (b && b.alpha >= 0.5 && rng() < d.keep) {
        dets.push({ f, t: r6(t), x: r3(b.x + randNormal(rng) * d.noisePx), y: r3(b.y + randNormal(rng) * d.noisePx), w: size(), h: size(), conf: r3(0.3 + rng() * 0.6) });
      }
      if (rng() < 0.7) {
        dets.push({ f, t: r6(t), x: r3(floorBall.x + randNormal(rng) * 0.8), y: r3(floorBall.y + randNormal(rng) * 0.8), w: size(), h: size(), conf: r3(0.2 + rng() * 0.3) });
      }
      // 運球：每 8 秒有 3 秒，在投籃者後方、籃框高度以下彈跳
      const phase = t % 8;
      if (phase > 4 && phase < 7 && rng() < 0.8) {
        const bounce = Math.abs(Math.sin((phase - 4) * Math.PI * 2.2));
        const p = worldToPx(plan, -4.9 + 0.2 * Math.sin(phase), -3.05 + 0.12 + 1.1 * bounce);
        dets.push({ f, t: r6(t), x: r3(p.x), y: r3(p.y), w: size(), h: size(), conf: r3(0.25 + rng() * 0.5) });
      }
      if (rng() < d.fp) {
        dets.push({ f, t: r6(t), x: r3(rng() * plan.width), y: r3(rng() * plan.height), w: size(), h: size(), conf: r3(0.15 + rng() * 0.25) });
      }
    }
    const opts = d.dragK != null ? { dragK: d.dragK } : {};
    const res = findShots(dets, hoop, opts);
    const truth = planTruth(plan);
    if (res.shots.length !== truth.length) {
      throw new Error(`track 情境「${d.name}」找到 ${res.shots.length} 球，應為 ${truth.length} 球`);
    }
    res.shots.forEach((s, i) => {
      const err = s.angleRaw - truth[i].angleDeg;
      report.push({ file: 'track', name: `${d.name} #${i + 1}`, err, tol: 1 });
      if (!(Math.abs(err) < 1)) throw new Error(`track 情境「${d.name}」第 ${i + 1} 球誤差 ${err} 度`);
      if (Math.abs(s.tCross - truth[i].tCross) > 0.12) throw new Error(`track 情境「${d.name}」第 ${i + 1} 球過框時間差太多`);
      if (s.made !== truth[i].made) throw new Error(`track 情境「${d.name}」第 ${i + 1} 球進球判定錯誤（${s.madeBy}）`);
    });
    scenarios.push({
      name: d.name, front, back, opts, detections: dets,
      truth: truth.map((t) => ({ angleDeg: t.angleDeg, made: t.made, tCross: t.tCross })),
      expected: {
        stats: res.stats,
        shots: res.shots.map((s) => ({
          angle: s.angle, angleRaw: s.angleRaw, crossS: s.crossS, made: s.made, madeGeometry: s.madeGeometry, madeBy: s.madeBy,
          zone: s.zone, flip: s.flip, tCross: s.tCross, tStart: s.tStart, tEnd: s.tEnd, fStart: s.fStart, fEnd: s.fEnd, fCross: s.fCross,
          evidence: s.evidence, nPoints: s.points.length, rms: s.rms, firstPoint: s.points[0], lastPoint: s.points[s.points.length - 1],
        })),
      },
    });
  });

  // 不該被當成投籃的情況：只有運球和亂點
  const plan = makeDemoPlan({});
  const hp = hoopPx(plan);
  const hoop = makeHoopFrame(hp.front, hp.back);
  const rng = mulberry32(4242);
  const dets = [];
  for (let f = 0; f < 600; f++) {
    const t = f / 30;
    const bounce = Math.abs(Math.sin(t * Math.PI * 2.2));
    const p = worldToPx(plan, -4.5 + 0.5 * Math.sin(t), -3.05 + 0.12 + 1.3 * bounce);
    dets.push({ f, t: r6(t), x: r3(p.x), y: r3(p.y), w: 38, h: 38, conf: 0.5 });
    if (rng() < 0.3) dets.push({ f, t: r6(t), x: r3(rng() * 1280), y: r3(rng() * 720), w: 38, h: 38, conf: 0.2 });
    // 從籃下回傳給投籃者的高吊球：最高點高於籃框，但下降時離籃框很遠
    const ph = t % 5;
    if (ph < 1.2) {
      const X = 0.3 - (ph / 1.2) * 4.3;
      const Y = -1.2 + 4.2 * (ph / 1.2) * (1 - ph / 1.2) * 1.6 - 0.2 * (ph / 1.2);
      const q = worldToPx(plan, X, Y);
      dets.push({ f, t: r6(t), x: r3(q.x), y: r3(q.y), w: 38, h: 38, conf: 0.6 });
    }
  }
  const none = findShots(dets, hoop);
  if (none.shots.length !== 0) throw new Error(`「沒有投籃」情境卻找到 ${none.shots.length} 球`);
  const front = { x: r3(hp.front.x), y: r3(hp.front.y) };
  const back = { x: r3(hp.back.x), y: r3(hp.back.y) };
  const none2 = findShots(dets, makeHoopFrame(front, back));
  scenarios.push({ name: '只有運球、回傳球和假偵測', front, back, opts: {}, detections: dets, truth: [], expected: { stats: none2.stats, shots: [] } });

  // markStatic 單獨測
  const sdets = [];
  for (let i = 0; i < 40; i++) sdets.push({ t: r6(i / 30), x: 500 + (i % 3) * 0.5, y: 600 });
  for (let i = 0; i < 40; i++) sdets.push({ t: r6(i / 30 + 0.001), x: 100 + i * 12, y: 300 - i * 4 });
  sdets.sort((a, b) => a.t - b.t);
  save('track.json', { scenarios, staticCase: { dets: sdets, ballDiameterPx: 38.4, expected: markStatic(sdets, 38.4) } });
}

// ── 統計 ────────────────────────────────────────────────────────────────────
{
  const lists = [
    [],
    [{ angle: 44.2, made: true }],
    [{ angle: 44.2, made: true }, { angle: 46.8, made: false }],
    [44.0, 46.0, 45.0, 47.0, 43.0, 45.0].map((a, i) => ({ angle: a, made: i % 2 === 0 })),
    [41.3, 42.8, 44.1, 43.7, 45.2, 46.9, 47.3, 44.4, 43.0, 42.1, 40.6].map((a, i) => ({ angle: a, made: [1, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0][i] === 1 })),
    Array.from({ length: 10 }, (_, i) => ({ angle: 45, made: i < 7 })),
    [48.0, 48.5, 49.0, 47.5, 44.0, 43.5, 43.0, 44.5].map((a, i) => ({ angle: a, made: i < 4 })),
  ];
  const cases = lists.map((shots) => {
    const stats = summarize(shots);
    return { shots, expected: stats, summary: plainSummary(stats) };
  });
  // 人工核對：44,46,45,47,43,45 → 平均 45，樣本標準差 sqrt(10/5)=√2
  const c3 = cases[3].expected;
  if (Math.abs(c3.angleMean - 45) > 1e-12 || Math.abs(c3.angleStd - Math.SQRT2) > 1e-12 || c3.makes !== 3 || c3.pct !== 50) {
    throw new Error('統計的人工核對案例不符');
  }
  if (c3.first.attempts !== 3 || c3.second.attempts !== 3 || Math.abs(c3.first.angleMean - 45) > 1e-12 || Math.abs(c3.second.angleMean - 45) > 1e-12) {
    throw new Error('前後半的人工核對案例不符');
  }
  if (cases[4].expected.first.attempts !== 5 || cases[4].expected.second.attempts !== 6) throw new Error('奇數球的前後半切分不符');
  save('stats.json', { cases });
}

// ── 標註內插 ────────────────────────────────────────────────────────────────
{
  const cases = [];
  const defs = [
    { name: '30fps 6 個手點', plan: { seed: 5 }, shot: 2, count: 6, noisePx: 0 },
    { name: '60fps 5 個手點', plan: { seed: 6, fps: 60 }, shot: 4, count: 5, noisePx: 0 },
    { name: '鏡射、相機歪 3 度、4 個手點', plan: { seed: 8, mirror: true, rollDeg: 3 }, shot: 1, count: 4, noisePx: 0 },
    { name: '手點有 1.5 像素雜訊', plan: { seed: 9 }, shot: 6, count: 6, noisePx: 1.5 },
    { name: '可變幀率（時間戳不等距）', plan: { seed: 10 }, shot: 3, count: 5, noisePx: 0, vfr: true },
  ];
  defs.forEach((d, ci) => {
    const plan = makeDemoPlan(d.plan);
    const hp = hoopPx(plan);
    const front = { x: r3(hp.front.x), y: r3(hp.front.y) };
    const back = { x: r3(hp.back.x), y: r3(hp.back.y) };
    const hoop = makeHoopFrame(front, back);
    const rng = mulberry32(600 + ci);
    // 每一幀的時間戳；可變幀率的案例把每一幀往前後挪一點
    const frameTimes = [];
    for (let f = 0; f < plan.frameCount; f++) {
      let t = frameTime(plan, f);
      if (d.vfr && f > 0) t += (rng() - 0.5) * (0.6 / plan.fps);
      frameTimes.push(r6(t));
    }
    const base = simulateClicks(plan, d.shot, { count: d.count, noisePx: 0, seed: 1 });
    const manual = base.map((c) => {
      const t = frameTimes[c.frame];
      const b = ballAt(plan, t);
      return { frame: c.frame, t, x: r3(b.x + randNormal(rng) * d.noisePx), y: r3(b.y + randNormal(rng) * d.noisePx) };
    });
    const shot = analyzeShot(manual.map((p) => { const [u, v] = toHoop(hoop, p.x, p.y); return { u, v, t: p.t }; }));
    const frames = interpolateShot(manual, frameTimes, hoop, shot);
    // 和合成真值比較
    let maxErr = 0;
    const truth = frames.map((fr) => {
      const b = ballAt(plan, fr.t);
      const e = Math.hypot(fr.x - b.x, fr.y - b.y);
      if (fr.src === 'interp' && e > maxErr) maxErr = e;
      return { x: r3(b.x), y: r3(b.y) };
    });
    const tol = d.noisePx > 0 ? 4 : 2;
    report.push({ file: 'interp', name: d.name, err: maxErr, tol, unit: 'px' });
    if (!(maxErr < tol)) throw new Error(`interp 案例「${d.name}」內插點離真值 ${maxErr} 像素`);
    if (frames.length !== manual[manual.length - 1].frame - manual[0].frame + 1) throw new Error('內插結果的幀數不對');
    cases.push({ name: d.name, front, back, frameTimes, manual, tolPx: tol, truth, expected: { frames, shot: { model: shot.model, flip: shot.flip } } });
  });
  save('interp.json', { cases });
}

// ── CSV ─────────────────────────────────────────────────────────────────────
{
  const shots = [{ angle: 44.3, made: true }, { angle: 47.0, made: false }, { angle: 38.9, made: true }, { angle: 52.1, made: false }];
  const text = shotsToCsv(shots);
  const want = '球序,入框角度,是否進球\r\n1,44.3,是\r\n2,47.0,否\r\n3,38.9,是\r\n4,52.1,否\r\n';
  if (text !== want) throw new Error('CSV 輸出格式和規格不符');
  const variants = [
    { name: '標準輸出', text },
    { name: '有 BOM、LF 換行', text: '﻿' + text.replace(/\r\n/g, '\n') },
    { name: '英文表頭、欄位順序不同', text: 'made,shot,angle\nyes,1,44.3\nno,2,47\nY,3,38.9\nmiss,4,52.1\n' },
    { name: '沒有表頭', text: '1,44.3,1\n2,47.0,0\n3,38.9,1\n4,52.1,0\n' },
    { name: '分號分隔', text: '球序;入框角度;是否進球\n1;44.3;是\n2;47.0;否\n3;38.9;是\n4;52.1;否\n' },
    { name: 'Tab 分隔', text: '球序\t入框角度\t是否進球\n1\t44.3\t進\n2\t47.0\t沒進\n3\t38.9\t進球\n4\t52.1\t未進\n' },
    { name: '球序亂掉會排回來', text: '球序,入框角度,是否進球\n3,38.9,是\n1,44.3,是\n4,52.1,否\n2,47.0,否\n' },
    { name: '有引號和空白', text: '"球序","入框角度","是否進球"\n"1"," 44.3 ","是"\n2,47.0, 否 \n3,38.9,是\n4,52.1,否\n' },
    { name: '壞掉的列會被略過', text: '球序,入框角度,是否進球\n1,44.3,是\n2,abc,否\n3,38.9,也許\n4,120,是\n5,,是\n6,47.0,否\n7,0x2D,是\n8,4_5,是\n' },
    { name: '空檔案', text: '' },
    { name: '只有表頭', text: '球序,入框角度,是否進球\r\n' },
  ];
  const cases = variants.map((v) => ({ ...v, expected: parseCsv(v.text) }));
  for (const c of cases.slice(0, 8)) {
    if (JSON.stringify(c.expected.shots) !== JSON.stringify(shots)) throw new Error(`CSV 案例「${c.name}」解析結果不對：${JSON.stringify(c.expected)}`);
  }
  if (cases[8].expected.shots.length !== 2 || cases[8].expected.warnings.length !== 6) throw new Error(`壞列案例不符：${JSON.stringify(cases[8].expected)}`);
  save('csv.json', { shots, text, cases });
}

// ── YOLO 前後處理 ───────────────────────────────────────────────────────────
{
  const lbs = [[1920, 1080, 640, 384], [1280, 720, 640, 384], [1080, 1920, 640, 384], [3840, 2160, 640, 384], [640, 480, 640, 384], [1919, 1079, 640, 384], [720, 1280, 640, 640], [641, 361, 640, 384]]
    .map(([sw, sh, dw, dh]) => ({ sw, sh, dw, dh, expected: letterbox(sw, sh, dw, dh) }));
  const f32 = (arr) => Array.from(new Float32Array(arr));
  const rng = mulberry32(2026);

  // one-to-many：3 個類別（共 7 個通道）、12 個候選框
  const N = 12;
  const boxes = [
    [100, 100, 30, 30, [0.05, 0.9, 0.1]],
    [102, 101, 31, 29, [0.02, 0.8, 0.1]], // 和上一個重疊 → 被 NMS 去掉
    [300, 200, 24, 24, [0.6, 0.4, 0.0]],
    [500, 50, 20, 22, [0.0, 0.151, 0.9]],
    [501, 51, 20, 22, [0.0, 0.149, 0.9]], // 低於門檻
    [50, 300, 40, 40, [0.0, 0.5, 0.0]],
    [320, 192, 18, 18, [0.0, 0.5, 0.0]], // 和上一個同分 → 依索引排序
    [600, 370, 26, 26, [0.3, 0.33, 0.2]],
  ];
  while (boxes.length < N) boxes.push([rng() * 640, rng() * 384, 10 + rng() * 30, 10 + rng() * 30, [rng() * 0.1, rng() * 0.1, rng() * 0.1]]);
  const data = new Array(7 * N).fill(0);
  boxes.forEach((b, i) => {
    data[i] = b[0]; data[N + i] = b[1]; data[2 * N + i] = b[2]; data[3 * N + i] = b[3];
    data[4 * N + i] = b[4][0]; data[5 * N + i] = b[4][1]; data[6 * N + i] = b[4][2];
  });
  const many = f32(data);
  const lb = letterbox(1920, 1080, 640, 384);
  const decodeMany = [
    { classIndex: 1, conf: 0.15, iou: 0.5, maxDet: 8, lb: null },
    { classIndex: 1, conf: 0.15, iou: 0.5, maxDet: 8, lb },
    { classIndex: 1, conf: 0.15, iou: 0.5, maxDet: 2, lb },
    { classIndex: 0, conf: 0.25, iou: 0.5, maxDet: 8, lb },
    { classIndex: 2, conf: 0.5, iou: 0.99, maxDet: 8, lb },
  ].map((o) => ({ opts: o, expected: decodeDetections(new Float32Array(many), [1, 7, N], { ...o, lb: o.lb || undefined }) }));
  // 人工核對：類別 1 超過 0.15 的有第 0、1、2、3、5、6、7 個框；第 1 個和第 0 個重疊被 NMS 去掉 → 剩 6 個，
  // 依分數排序是 0.9、0.5（x=50）、0.5（x=320）、0.4、0.33、0.151
  {
    const got = decodeMany[0].expected;
    const xs = got.map((g) => Math.round(g.x));
    if (got.length !== 6 || xs.join(',') !== '100,50,320,300,600,500') {
      throw new Error(`YOLO 解碼的人工核對案例不符：${JSON.stringify(got)}`);
    }
  }

  // one-to-one：[1, 8, 6]
  const rows = [
    [90, 90, 120, 120, 0.9, 1], [200, 200, 230, 232, 0.4, 0], [400, 100, 430, 131, 0.3, 1], [10, 10, 20, 20, 0.1, 1],
    [91, 91, 121, 121, 0.85, 1], [500, 300, 540, 340, 0.6, 2], [0, 0, 0, 0, 0, 0], [300, 50, 322, 73, 0.151, 1.0000001],
  ];
  const one = f32(rows.flat());
  const decodeOne = [
    { classIndex: 1, conf: 0.15, iou: 0.5, maxDet: 8, lb: null },
    { classIndex: 1, conf: 0.15, iou: 0.5, maxDet: 8, lb },
    { classIndex: 2, conf: 0.15, iou: 0.5, maxDet: 8, lb },
  ].map((o) => ({ opts: o, expected: decodeDetections(new Float32Array(one), [1, 8, 6], { ...o, lb: o.lb || undefined }) }));
  save('yolo.json', { letterbox: lbs, many: { dims: [1, 7, N], data: many, cases: decodeMany }, one: { dims: [1, 8, 6], data: one, cases: decodeOne } });
}

// ── 標註包 ──────────────────────────────────────────────────────────────────
{
  const plan = makeDemoPlan({ seed: 11 });
  const hp = hoopPx(plan);
  const hoopPoints = { front: { x: r3(hp.front.x), y: r3(hp.front.y) }, back: { x: r3(hp.back.x), y: r3(hp.back.y) }, level: 'rim' };
  const hoop = makeHoopFrame(hoopPoints.front, hoopPoints.back);
  const frameTimes = Array.from({ length: plan.frameCount }, (_, f) => r6(frameTime(plan, f)));
  const shots = [0, 1, 2].map((i) => {
    const manual = simulateClicks(plan, i, { count: 5, noisePx: 0.8, seed: 3 });
    const shot = analyzeShot(manual.map((p) => { const [u, v] = toHoop(hoop, p.x, p.y); return { u, v, t: p.t }; }));
    return { id: i + 1, source: 'manual', made: shot.made, angleDeg: shot.angleDeg, crossS: shot.crossS, frames: interpolateShot(manual, frameTimes, hoop, shot) };
  });
  const good = buildBundle({
    video: { name: '合成示範.mp4', size: 123456, width: plan.width, height: plan.height, fps: plan.fps, duration: plan.duration, codec: 'avc', rotation: 0, timeSource: 'synthetic', engine: 'synthetic' },
    frameTimes, hoopPoints, hoop, shots, noBall: [{ from: 0, to: 5 }], synthetic: true, createdAt: '2026-11-13T00:00:00.000Z',
  });
  if (validateBundle(good).length) throw new Error('正常的標註包沒有通過檢查：' + validateBundle(good).join('；'));
  // 同一支影片改用垂直參考線校正（籃板的鉛直邊）：多存參考線的兩點和換算出來的歪斜
  const vp = verticalPx(plan);
  const vertical = { top: { x: r3(vp.top.x), y: r3(vp.top.y) }, bottom: { x: r3(vp.bottom.x), y: r3(vp.bottom.y) } };
  const vHoop = makeHoopFrame(hoopPoints.front, hoopPoints.back, { level: 'vertical', width: plan.width, height: plan.height, vertical });
  const goodVertical = buildBundle({
    video: { name: '合成示範.mp4', size: 123456, width: plan.width, height: plan.height, fps: plan.fps, duration: plan.duration, codec: 'avc', rotation: 0, timeSource: 'synthetic', engine: 'synthetic' },
    frameTimes, hoopPoints: { ...hoopPoints, level: 'vertical', vertical }, hoop: vHoop, shots: shots.slice(0, 1), synthetic: true, createdAt: '2026-11-13T00:00:00.000Z',
  });
  if (validateBundle(goodVertical).length) throw new Error('垂直參考線的標註包沒有通過檢查：' + validateBundle(goodVertical).join('；'));
  const clone = () => JSON.parse(JSON.stringify(good));
  const bads = [
    ['format 錯', (b) => { b.format = 'something-else'; }],
    ['version 錯', (b) => { b.version = 2; }],
    ['沒有 frameTimes', (b) => { delete b.frameTimes; }],
    ['frameTimes 沒有遞增', (b) => { b.frameTimes[10] = b.frameTimes[9]; }],
    ['hoop 缺一點', (b) => { delete b.hoop.back; }],
    ['球直徑為 0', (b) => { b.ball.diameterPx = 0; }],
    ['made 不是布林', (b) => { b.shots[0].made = 1; }],
    ['幀號超出範圍', (b) => { b.shots[1].frames[0].f = 999999; }],
    ['幀號沒有遞增', (b) => { b.shots[1].frames[2].f = b.shots[1].frames[1].f; }],
    ['座標不是數字', (b) => { b.shots[2].frames[1].x = 'abc'; }],
    ['src 不認得', (b) => { b.shots[2].frames[1].src = 'guess'; }],
    ['沒有 frames', (b) => { b.shots[0].frames = []; }],
    ['noBall 範圍顛倒', (b) => { b.noBall = [{ from: 9, to: 3 }]; }],
    ['寬度不對', (b) => { b.video.width = 0; }],
    ['基準是垂直參考線卻沒有參考線', (b) => { b.hoop.level = 'vertical'; }],
    ['垂直參考線的座標不是數字', (b) => { b.hoop.level = 'vertical'; b.hoop.vertical = { top: { x: 10, y: 'abc' }, bottom: { x: 10, y: 200 } }; }],
    ['不是物件', () => null],
  ].map(([name, fn]) => {
    const b = clone();
    const r = fn(b);
    const bundle = r === null ? [1, 2, 3] : b;
    return { name, bundle, expected: validateBundle(bundle) };
  });
  for (const b of bads) if (!b.expected.length) throw new Error(`壞掉的標註包「${b.name}」卻通過檢查`);
  save('bundle.json', { good, goodVertical, bads });
}

// ── 摘要 ────────────────────────────────────────────────────────────────────
if (CHECK) {
  if (stale.length) {
    console.error(`tests/vectors/ 不是最新的：${stale.join(', ')}。請執行 node tests/gen_vectors.mjs 重新產生。`);
    process.exit(1);
  }
  console.log('tests/vectors/ 和目前的程式碼一致。');
}
console.log('\n誤差統計（和合成真值比較）：');
for (const file of ['angle', 'ransac', 'track', 'interp']) {
  const rows = report.filter((r) => r.file === file);
  const errs = rows.map((r) => Math.abs(r.err));
  const max = Math.max(...errs);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const worst = rows[errs.indexOf(max)];
  console.log(`  ${file.padEnd(7)} ${String(rows.length).padStart(3)} 例  平均 ${mean.toFixed(3)}  最大 ${max.toFixed(3)} ${worst.unit || '度'}（${worst.name}）`);
}
const noisy = report.filter((r) => r.file === 'angle' && r.name.startsWith('雜訊'));
const ne = noisy.map((r) => Math.abs(r.err)).sort((a, b) => a - b);
console.log(`  其中有雜訊的 angle 案例 ${ne.length} 例：中位數 ${ne[Math.floor(ne.length / 2)].toFixed(3)} 度、第 90 百分位 ${ne[Math.floor(ne.length * 0.9)].toFixed(3)} 度、最大 ${ne[ne.length - 1].toFixed(3)} 度`);
