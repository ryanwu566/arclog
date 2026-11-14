// 追蹤邏輯的隨機壓力測試：很多組不同的幀率、漏偵測率、假偵測率、雜訊、取景。
// 被 tests/js/track-stress.test.mjs 用小規模跑；也可以直接執行看完整統計：
//
//   node tests/js/track-stress.mjs 200
//
// 產生偵測的方式和 tests/gen_vectors.mjs 的情境相同（真球＋地上的球＋運球＋隨機假偵測）。

import { fileURLToPath } from 'node:url';

import { mulberry32, randNormal } from '../../web/js/core/prng.js';
import { makeHoopFrame } from '../../web/js/core/geometry.js';
import { findShots } from '../../web/js/core/track.js';
import { makeDemoPlan, planTruth, hoopPx, ballAt, frameTime, worldToPx } from '../../web/js/core/synth.js';

const r3 = (x) => Math.round(x * 1000) / 1000;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

/** 依種子產生一組條件。 */
export function randomCase(seed) {
  const rng = mulberry32(seed * 7919 + 13);
  const hi = rng() < 0.4;
  const fps = rng() < 0.5 ? 30 : 60;
  return {
    seed,
    plan: {
      seed: 1000 + seed,
      fps,
      mirror: rng() < 0.5,
      rollDeg: Math.round((rng() * 6 - 3) * 10) / 10,
      pxPerM: hi ? 300 : 150,
      width: hi ? 2400 : 1280,
      height: hi ? 1350 : 720,
    },
    stride: fps === 60 ? 1 + Math.floor(rng() * 4) : 1 + Math.floor(rng() * 2),
    keep: 0.55 + rng() * 0.4,
    fp: rng() * 0.3,
    noisePx: (hi ? 1.0 : 0.5) + rng() * (hi ? 2.0 : 1.0),
    floorBall: rng() < 0.7,
    dribble: rng() < 0.7,
  };
}

/** 跑一組條件，回傳和真值比較的結果。 */
export function runCase(c) {
  const plan = makeDemoPlan(c.plan);
  const hp = hoopPx(plan);
  const hoop = makeHoopFrame({ x: r3(hp.front.x), y: r3(hp.front.y) }, { x: r3(hp.back.x), y: r3(hp.back.y) });
  const ballPx = hoop.ballDiameterPx;
  const rng = mulberry32(c.seed + 555);
  const dets = [];
  const size = () => r3(ballPx * (0.9 + rng() * 0.25));
  const floorBall = worldToPx(plan, -5.2, -3.05 + 0.12);
  for (let f = 0; f < plan.frameCount; f += c.stride) {
    const t = frameTime(plan, f);
    const b = ballAt(plan, t);
    if (b && b.alpha >= 0.5 && rng() < c.keep) {
      dets.push({ f, t: r6(t), x: r3(b.x + randNormal(rng) * c.noisePx), y: r3(b.y + randNormal(rng) * c.noisePx), w: size(), h: size(), conf: r3(0.3 + rng() * 0.6) });
    }
    if (c.floorBall && rng() < 0.7) {
      dets.push({ f, t: r6(t), x: r3(floorBall.x + randNormal(rng) * 0.8), y: r3(floorBall.y + randNormal(rng) * 0.8), w: size(), h: size(), conf: r3(0.2 + rng() * 0.3) });
    }
    const phase = t % 8;
    if (c.dribble && phase > 4 && phase < 7 && rng() < 0.8) {
      const bounce = Math.abs(Math.sin((phase - 4) * Math.PI * 2.2));
      const p = worldToPx(plan, -4.9 + 0.2 * Math.sin(phase), -3.05 + 0.12 + 1.1 * bounce);
      dets.push({ f, t: r6(t), x: r3(p.x), y: r3(p.y), w: size(), h: size(), conf: r3(0.25 + rng() * 0.5) });
    }
    if (rng() < c.fp) {
      dets.push({ f, t: r6(t), x: r3(rng() * plan.width), y: r3(rng() * plan.height), w: size(), h: size(), conf: r3(0.15 + rng() * 0.25) });
    }
  }
  const res = findShots(dets, hoop);
  const truth = planTruth(plan);
  // 依過框時間配對
  const usedShot = new Set();
  const errs = [];
  let missed = 0;
  let wrongMake = 0;
  for (const t of truth) {
    let best = -1;
    for (let i = 0; i < res.shots.length; i++) {
      if (usedShot.has(i)) continue;
      if (Math.abs(res.shots[i].tCross - t.tCross) <= 0.3 && (best < 0 || Math.abs(res.shots[i].tCross - t.tCross) < Math.abs(res.shots[best].tCross - t.tCross))) best = i;
    }
    if (best < 0) {
      missed++;
      continue;
    }
    usedShot.add(best);
    errs.push(res.shots[best].angleRaw - t.angleDeg);
    if (res.shots[best].made !== t.made) wrongMake++;
  }
  // 每球飛行段實際有幾個偵測（用來判斷條件有多嚴苛）
  const effectiveFps = (plan.fps / c.stride) * c.keep;
  return { case: c, shots: truth.length, found: res.shots.length, missed, extra: res.shots.length - usedShot.size, wrongMake, errs, effectiveFps };
}

/** 跑很多組，回傳彙總。 */
export function runMany(count, firstSeed = 1) {
  const out = { cases: count, shots: 0, missed: 0, extra: 0, wrongMake: 0, errs: [], worst: null, failures: [] };
  for (let s = firstSeed; s < firstSeed + count; s++) {
    const r = runCase(randomCase(s));
    out.shots += r.shots;
    out.missed += r.missed;
    out.extra += r.extra;
    out.wrongMake += r.wrongMake;
    for (const e of r.errs) {
      out.errs.push(e);
      if (!out.worst || Math.abs(e) > Math.abs(out.worst.err)) out.worst = { err: e, case: r.case };
    }
    if (r.missed || r.extra || r.wrongMake || r.errs.some((e) => Math.abs(e) >= 1)) out.failures.push(r);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = Number(process.argv[2] || 60);
  const t0 = performance.now();
  const r = runMany(n);
  const abs = r.errs.map(Math.abs).sort((a, b) => a - b);
  const q = (p) => abs[Math.min(abs.length - 1, Math.floor(abs.length * p))];
  console.log(`${n} 組條件、${r.shots} 球：漏 ${r.missed}、多抓 ${r.extra}、進球判定錯 ${r.wrongMake}`);
  console.log(`角度誤差（度）：中位數 ${q(0.5).toFixed(3)}、90% ${q(0.9).toFixed(3)}、99% ${q(0.99).toFixed(3)}、最大 ${abs[abs.length - 1].toFixed(3)}；超過 1 度的有 ${abs.filter((e) => e >= 1).length} 球`);
  console.log(`耗時 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
  for (const f of r.failures.slice(0, 12)) {
    const c = f.case;
    console.log(`  seed ${c.seed}: fps ${c.plan.fps}/${c.stride} keep ${c.keep.toFixed(2)}（每秒約 ${f.effectiveFps.toFixed(0)} 個偵測）fp ${c.fp.toFixed(2)} noise ${c.noisePx.toFixed(1)}px@${c.plan.pxPerM} → 漏 ${f.missed} 多 ${f.extra} 判錯 ${f.wrongMake} 最大誤差 ${Math.max(0, ...f.errs.map(Math.abs)).toFixed(2)}`);
  }
}
