// 產生測試用的合成畫面（tests/fixtures/img/）和它們的真值。
//
//   node tests/make_fixtures.mjs
//
// 這些圖是程式畫出來的示範畫面（沒有任何實拍內容），用來測偵測模型的前後處理。
// 只有改了 web/js/demo/scene.js 或示範劇本時才需要重新產生。

import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeDemoPlan, ballAt, frameTime, hoopPx } from '../web/js/core/synth.js';
import { makeHoopFrame } from '../web/js/core/geometry.js';
import { createSceneRenderer } from '../web/js/demo/scene.js';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'img');
mkdirSync(OUT, { recursive: true });

const plan = makeDemoPlan({});
const renderer = createSceneRenderer(plan, createCanvas);
const canvas = createCanvas(plan.width, plan.height);
const ctx = canvas.getContext('2d');
const hp = hoopPx(plan);
const hoop = makeHoopFrame(hp.front, hp.back);
const sh = plan.shots[0];
const r1 = (x) => Math.round(x * 10) / 10;

// 第一球的最高點附近、下降段、以及還沒有球的畫面。
// 飛行中每一幀的偵測信心起伏很大（球在模型眼中只有 19 像素左右），這裡挑的是信心穩定的兩幀。
const picks = {
  'synth_apex.png': 38 / plan.fps,
  'synth_late.png': 48 / plan.fps,
  'synth_empty.png': sh.tAppear - 0.2,
};
const meta = { width: plan.width, height: plan.height, ballDiameterPx: r1(hoop.ballDiameterPx), hoop: { front: hp.front, back: hp.back }, frames: {} };
for (const [name, t] of Object.entries(picks)) {
  const f = Math.max(0, Math.round(t * plan.fps));
  const time = frameTime(plan, f);
  renderer.draw(ctx, time);
  writeFileSync(join(OUT, name), canvas.toBuffer('image/png'));
  const b = ballAt(plan, time);
  meta.frames[name] = { frame: f, ball: b ? { x: r1(b.x), y: r1(b.y), phase: b.phase } : null };
  console.log(name, 'frame', f, b ? `ball (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) ${b.phase}` : '沒有球');
}
writeFileSync(join(OUT, 'synth_frames.json'), JSON.stringify(meta, null, 1) + '\n');
