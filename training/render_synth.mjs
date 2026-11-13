// 用和網站示範模式同一份物理與繪圖程式，產生一支合成練投影片的畫面、真值和標註包。
// 一般不直接執行，而是由 training/make_synth.py 呼叫（它負責把畫面編碼成 MP4）。
//
//   node training/render_synth.mjs --spec spec.json --raw > frames.rgba
//
// spec.json：
//   { "name": "synth_01", "plan": { makeDemoPlan 的參數 }, "look": { 覆寫外觀 },
//     "clicks": { "count": 6, "noisePx": 1.5, "seed": 7 },
//     "out": { "bundle": "path.arclog.json", "truth": "path.truth.json", "meta": "path.meta.json",
//              "framesDir": "選填：把每一幀存成 PNG（除錯用）" } }
//
// 加 --raw 時，每一幀的 RGBA 像素（寬×高×4 位元組）依序寫到標準輸出。
//
// 標註包走的是和網站完全相同的程式路徑：模擬使用者在每球點幾個球心 → 擬合 → 內插 → buildBundle。
// 真值檔另外記錄每一幀球的真實位置，給測試和評估用（實拍影片不會有這個檔）。

import { createCanvas } from '@napi-rs/canvas';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { once } from 'node:events';

import { makeDemoPlan, planTruth, simulateClicks, hoopPx, ballAt, frameTime } from '../web/js/core/synth.js';
import { makeHoopFrame, toHoop } from '../web/js/core/geometry.js';
import { analyzeShot } from '../web/js/core/shot.js';
import { interpolateShot } from '../web/js/core/interp.js';
import { buildBundle, validateBundle } from '../web/js/core/bundle.js';
import { DRAG_K_RIM } from '../web/js/core/constants.js';
import { createSceneRenderer } from '../web/js/demo/scene.js';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const specPath = arg('--spec');
if (!specPath) {
  console.error('用法：node training/render_synth.mjs --spec spec.json [--raw]');
  process.exit(2);
}
const RAW = args.includes('--raw');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const r3 = (x) => Math.round(x * 1000) / 1000;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

const plan = makeDemoPlan(spec.plan || {});
const hp = hoopPx(plan);
const hoopPoints = {
  front: { x: r3(hp.front.x), y: r3(hp.front.y) },
  back: { x: r3(hp.back.x), y: r3(hp.back.y) },
  level: 'rim',
};
const hoop = makeHoopFrame(hoopPoints.front, hoopPoints.back, { level: 'rim' });
const frameTimes = Array.from({ length: plan.frameCount }, (_, f) => r6(frameTime(plan, f)));
const dragK = plan.dragK === 0 ? 0 : DRAG_K_RIM;

// ── 標註包：模擬手點 → 擬合 → 內插 ──
const clickOpts = { count: 6, noisePx: 1.5, seed: 7, ...(spec.clicks || {}) };
const shots = [];
plan.shots.forEach((sh, i) => {
  const manual = simulateClicks(plan, i, clickOpts).map((c) => ({ frame: c.frame, t: frameTimes[c.frame], x: r3(c.x), y: r3(c.y) }));
  const res = analyzeShot(
    manual.map((p) => {
      const [u, v] = toHoop(hoop, p.x, p.y);
      return { u, v, t: p.t };
    }),
    { dragK },
  );
  if (!res.ok) return;
  shots.push({
    id: i + 1,
    source: 'manual',
    made: sh.made, // 使用者看過畫面後確認的結果（這裡直接用劇本的答案）
    angleDeg: res.angleDeg,
    crossS: res.crossS,
    frames: interpolateShot(manual, frameTimes, hoop, res),
  });
});

// 畫面上確定沒有球的幀範圍（兩球之間）
const noBall = [];
let start = null;
for (let f = 0; f < plan.frameCount; f++) {
  const empty = ballAt(plan, frameTimes[f]) === null;
  if (empty && start === null) start = f;
  if (!empty && start !== null) {
    noBall.push({ from: start, to: f - 1 });
    start = null;
  }
}
if (start !== null) noBall.push({ from: start, to: plan.frameCount - 1 });

const videoName = `${spec.name || 'synth'}.mp4`;
const bundle = buildBundle({
  video: {
    name: videoName,
    size: null,
    width: plan.width,
    height: plan.height,
    fps: plan.fps,
    duration: plan.frameCount / plan.fps,
    codec: 'avc',
    rotation: 0,
    timeSource: 'synthetic',
    engine: 'synthetic',
  },
  frameTimes,
  hoopPoints,
  hoop,
  shots,
  noBall,
  synthetic: true,
  createdAt: spec.createdAt || '2026-01-01T00:00:00.000Z',
});
const errs = validateBundle(bundle);
if (errs.length) {
  console.error('產生的標註包沒有通過檢查：' + errs.join('；'));
  process.exit(1);
}

// ── 真值：每一幀球的真實位置 ──
const truth = {
  synthetic: true,
  name: spec.name || 'synth',
  video: videoName,
  width: plan.width,
  height: plan.height,
  fps: plan.fps,
  frameCount: plan.frameCount,
  hoop: hoopPoints,
  ballDiameterPx: r3(hoop.ballDiameterPx),
  dragK,
  shots: planTruth(plan).map((t, i) => ({
    ...t,
    kind: plan.shots[i].kind,
    fRelease: Math.ceil(plan.shots[i].tRelease * plan.fps),
    fHandover: Math.floor(plan.shots[i].tHandover * plan.fps),
  })),
  // 每幀：null 代表沒有球；partial 代表球正在淡出（評估時不算）
  balls: frameTimes.map((t) => {
    const b = ballAt(plan, t);
    return b ? { x: r3(b.x), y: r3(b.y), phase: b.phase, shot: b.shot + 1, partial: b.alpha < 1 } : null;
  }),
};

const out = spec.out || {};
const write = (path, obj) => {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj));
};
write(out.bundle, bundle);
write(out.truth, truth);
write(out.meta, { name: spec.name || 'synth', width: plan.width, height: plan.height, fps: plan.fps, frameCount: plan.frameCount, video: videoName });

// ── 畫面 ──
if (RAW || out.framesDir) {
  const renderer = createSceneRenderer(plan, createCanvas, spec.look || {});
  const canvas = createCanvas(plan.width, plan.height);
  const ctx = canvas.getContext('2d');
  if (out.framesDir) mkdirSync(out.framesDir, { recursive: true });
  for (let f = 0; f < plan.frameCount; f++) {
    renderer.draw(ctx, frameTimes[f]);
    if (out.framesDir) writeFileSync(join(out.framesDir, `${String(f).padStart(5, '0')}.png`), canvas.toBuffer('image/png'));
    if (RAW) {
      const data = ctx.getImageData(0, 0, plan.width, plan.height).data;
      const ok = process.stdout.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      if (!ok) await once(process.stdout, 'drain');
    }
  }
}
if (!RAW) console.log(`${spec.name || 'synth'}：${plan.frameCount} 幀、${shots.length} 球`);
