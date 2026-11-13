// 核心純函式的測試。讀 tests/vectors/ 的共用向量（Python 的 tests/py/test_vectors.py 讀同一份）。
//
//   node --test tests/js
//
// 每個案例檢查兩件事：
//   1. 和合成真值（truth）的差在門檻內，例如入框角度誤差 < 1 度
//   2. 和向量裡存的 expected 一致（核心演算法被改動時會在這裡發現）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { vectors, assertClose } from './helpers.mjs';
import * as C from '../../web/js/core/constants.js';
import { mulberry32, randInt, randNormal } from '../../web/js/core/prng.js';
import { makeHoopFrame, toHoop, toImage } from '../../web/js/core/geometry.js';
import { fitParabola, descendingCrossing, fitArc, evalArc, ransacArc, fitLine } from '../../web/js/core/fit.js';
import { analyzeShot, judgeMake, sampleArc } from '../../web/js/core/shot.js';
import { findShots, markStatic } from '../../web/js/core/track.js';
import { summarize, plainSummary } from '../../web/js/core/stats.js';
import { interpolateShot } from '../../web/js/core/interp.js';
import { shotsToCsv, parseCsv } from '../../web/js/core/csv.js';
import { validateBundle, buildBundle, BUNDLE_FORMAT } from '../../web/js/core/bundle.js';
import { letterbox, decodeDetections, rgbaToChw } from '../../web/js/core/yolo.js';

const TOL = 1e-9;
const hoopPts = (hoop, points) => points.map((p) => {
  const [u, v] = toHoop(hoop, p.x, p.y);
  return { u, v, t: p.t };
});

test('常數和 Python 那邊用同一份', () => {
  const v = vectors('constants.json');
  for (const k of Object.keys(v)) {
    if (k === 'roundAngle') continue;
    assert.equal(C[k], v[k], k);
  }
  for (const [x, want] of v.roundAngle) assert.equal(C.roundAngle(x), want, `roundAngle(${x})`);
  assert.ok(Math.abs(C.BALL_RADIUS_RIM - 0.12 / 0.45) < 1e-15);
});

test('亂數產生器可重現', () => {
  for (const s of vectors('prng.json').sequences) {
    const a = mulberry32(s.seed);
    assert.deepEqual(Array.from({ length: 8 }, () => a()), s.floats, `seed ${s.seed} floats`);
    const b = mulberry32(s.seed);
    assert.deepEqual(Array.from({ length: 8 }, () => randInt(b, 37)), s.ints, `seed ${s.seed} ints`);
    const c = mulberry32(s.seed);
    assertClose(Array.from({ length: 4 }, () => randNormal(c)), s.normals, 1e-12, `seed ${s.seed} normals`);
  }
});

test('籃框座標系', () => {
  for (const c of vectors('geometry.json').cases) {
    const frame = makeHoopFrame(c.front, c.back, { level: c.level });
    if (c.frame === null) {
      assert.equal(frame, null);
      continue;
    }
    assertClose(frame, c.frame, 1e-12, 'frame');
    for (const p of c.pts) {
      const [u, v] = toHoop(frame, p.x, p.y);
      assertClose([u, v], [p.u, p.v], 1e-12, 'toHoop');
      const [x, y] = toImage(frame, u, v);
      assert.ok(Math.abs(x - p.x) < 1e-9 && Math.abs(y - p.y) < 1e-9, '轉過去再轉回來要回到原點');
    }
  }
  // 前緣一定是 (0,0)、後緣一定是 (1,0)；v 軸在畫面上朝上
  const f = makeHoopFrame({ x: 400, y: 300 }, { x: 270, y: 310 });
  assertClose(toHoop(f, 400, 300), [0, 0], 1e-12);
  assertClose(toHoop(f, 270, 310), [1, 0], 1e-12);
  assert.ok(toHoop(f, 335, 200)[1] > 0, '畫面上方的點 v 應為正');
  assert.ok(Math.abs(f.ballDiameterPx / f.len - 0.24 / 0.45) < 1e-12, '球直徑由籃框比例推算');
});

test('進球判定', () => {
  const v = vectors('make.json');
  for (const g of v.grid) {
    const j = judgeMake(g.s, g.angle);
    assert.equal(j.zone, g.zone, `s=${g.s} angle=${g.angle}`);
    assert.equal(j.made, g.made);
    assertClose([j.nearClear, j.farGap], [g.nearClear, g.farGap], 1e-12);
  }
  for (const h of v.hand) {
    const j = judgeMake(h.s, h.angle);
    assert.equal(j.zone, h.zone, h.why);
    assert.equal(j.made, h.made, h.why);
  }
});

test('入框角度：已知角度的合成軌跡，誤差在門檻內', () => {
  const v = vectors('angle.json');
  let worst = 0;
  for (const c of v.cases) {
    const hoop = makeHoopFrame(c.front, c.back, { level: c.level });
    const res = analyzeShot(hoopPts(hoop, c.points), { dragK: c.dragK });
    assert.ok(res.ok, c.name);
    const err = Math.abs(res.angleRaw - c.truth.angleDeg);
    worst = Math.max(worst, err);
    assert.ok(err < c.tolDeg, `${c.name}：誤差 ${err.toFixed(3)} 度，門檻 ${c.tolDeg}`);
    assert.ok(c.tolDeg <= 1.0, '門檻不可以放寬到 1 度以上');
    // 幾何判定的進球建議要和「用真實過框位置算出來的」一致
    // （空心區和可能碰框區的交界附近，雜訊會讓分區互換，所以比的是建議進球與否）
    assert.equal(res.made, c.truth.zone === 'clean' || c.truth.zone === 'rim', `${c.name} 的進球建議`);
    assert.ok(Math.abs(res.crossS - c.truth.crossS) < 0.15, `${c.name} 的過框位置`);
    assertClose(
      { angleRaw: res.angleRaw, angleDeg: res.angleDeg, crossS: res.crossS, made: res.made, zone: res.zone, flip: res.flip, model: res.model, parabola: res.parabola, apex: res.apex, rms: res.rms, monotonic: res.monotonic },
      c.expected, TOL, c.name,
    );
  }
  assert.ok(v.cases.length >= 60);
  assert.ok(worst < 1.0);
});

test('入框角度：不合理的輸入會回報原因而不是亂算', () => {
  const v = vectors('angle_fail.json');
  for (const c of v.cases) {
    const res = analyzeShot(c.points);
    assert.equal(res.ok, false, c.name);
    assert.equal(res.reason, c.expected.reason, c.name);
  }
  const reasons = v.cases.map((c) => c.expected.reason);
  assert.deepEqual(reasons, ['too_few_points', 'not_arc', 'no_crossing', 'no_motion', 'degenerate']);
});

test('擬合：拋物線、阻力修正、直線', () => {
  for (const s of vectors('fit.json').sets) {
    assertClose(fitParabola(s.us, s.vs), s.parabola, TOL, 'parabola');
    assertClose(descendingCrossing(s.parabola), s.crossing, TOL, 'crossing');
    const arc0 = fitArc(s.us, s.vs, { dragK: 0 });
    const arcK = fitArc(s.us, s.vs, { dragK: C.DRAG_K_RIM });
    assertClose(arc0, s.arc0, TOL, 'arc0');
    assertClose(arcK, s.arcK, TOL, 'arcK');
    assertClose(evalArc({ uc: arc0.uc, slope: arc0.slope, kappa: arc0.kappa, k: 0 }, s.probe), s.eval0, TOL);
    assertClose(evalArc({ uc: arcK.uc, slope: arcK.slope, kappa: arcK.kappa, k: arcK.k }, s.probe), s.evalK, TOL);
    assertClose(fitLine(s.us, s.vs), s.line, TOL, 'line');
    // 關掉阻力時就是原本的最小平方拋物線
    for (const u of s.probe) {
      const viaModel = evalArc({ uc: arc0.uc, slope: arc0.slope, kappa: arc0.kappa, k: 0 }, [u])[0];
      const viaParabola = (s.parabola.a * u + s.parabola.b) * u + s.parabola.c;
      assert.ok(Math.abs(viaModel - viaParabola) < 1e-9, 'k=0 的模型要等於拋物線');
    }
    // 阻力修正後，在過框點 v=0、斜率 = −slope
    const m = { uc: arcK.uc, slope: arcK.slope, kappa: arcK.kappa, k: arcK.k };
    const h = 1e-5;
    const [v0, v1, v2] = evalArc(m, [m.uc, m.uc - h, m.uc + h]);
    assert.ok(Math.abs(v0) < 1e-12);
    assert.ok(Math.abs((v2 - v1) / (2 * h) + m.slope) < 1e-6);
    // 阻力讓下降段比拋物線更陡
    assert.ok(arcK.slope > arc0.slope, '加了阻力修正後入框角度會比純拋物線大');
  }
  assert.equal(fitParabola([1, 2], [1, 2]), null);
  assert.equal(fitParabola([1, 1, 1], [1, 2, 3]), null);
});

test('RANSAC：有離群點時仍找得到軌跡，角度誤差 < 1 度', () => {
  const v = vectors('ransac.json');
  for (const c of v.cases) {
    const hoop = makeHoopFrame(c.front, c.back);
    const pts = hoopPts(hoop, c.points);
    const arc = ransacArc(pts, { seed: c.seed, iters: c.iters });
    assert.ok(arc, c.name);
    assert.deepEqual(arc.inliers, c.expected.inliers, `${c.name} 的內點`);
    assertClose({ dir: arc.dir, parabola: arc.parabola, line: arc.line }, { dir: c.expected.dir, parabola: c.expected.parabola, line: c.expected.line }, TOL, c.name);
    const res = analyzeShot(arc.inliers.map((m) => pts[m]));
    assert.ok(Math.abs(res.angleRaw - c.truth.angleDeg) < 1.0, `${c.name}：誤差 ${Math.abs(res.angleRaw - c.truth.angleDeg)}`);
    assertClose(res.angleRaw, c.expected.angleRaw, TOL, c.name);
    // 混進內點的離群點不可以超過 2 個，真正的軌跡點至少要找回八成
    const truthSet = new Set(c.truth.inliers);
    const wrong = arc.inliers.filter((m) => !truthSet.has(m)).length;
    const found = arc.inliers.filter((m) => truthSet.has(m)).length;
    assert.ok(wrong <= 2, `${c.name}：${wrong} 個離群點被當成內點`);
    assert.ok(found >= 0.8 * c.truth.inliers.length, `${c.name}：只找回 ${found}/${c.truth.inliers.length} 個軌跡點`);
  }
  // 全是亂點時，RANSAC 本身仍可能湊出幾個點；兩種語言要湊出一樣的結果。
  // （會不會被當成投籃由 findShots 的其他條件把關，見下一個測試的「只有運球」情境）
  assertClose(ransacArc(v.noiseOnly.points, { seed: v.noiseOnly.seed }), v.noiseOnly.expected, TOL, 'noiseOnly');
});

test('整段影片的偵測 → 一球一球：球數、角度、進球判定', () => {
  const v = vectors('track.json');
  for (const sc of v.scenarios) {
    const hoop = makeHoopFrame(sc.front, sc.back);
    const res = findShots(sc.detections, hoop, sc.opts);
    assert.equal(res.shots.length, sc.truth.length, `${sc.name}：找到的球數`);
    assert.deepEqual(res.stats, sc.expected.stats, `${sc.name} stats`);
    res.shots.forEach((s, i) => {
      const t = sc.truth[i];
      assert.ok(Math.abs(s.angleRaw - t.angleDeg) < 1.0, `${sc.name} 第 ${i + 1} 球：角度誤差 ${Math.abs(s.angleRaw - t.angleDeg)}`);
      assert.equal(s.made, t.made, `${sc.name} 第 ${i + 1} 球的進球判定`);
      assert.ok(Math.abs(s.tCross - t.tCross) < 0.12, `${sc.name} 第 ${i + 1} 球的過框時間`);
      const e = sc.expected.shots[i];
      assertClose(
        { angle: s.angle, angleRaw: s.angleRaw, crossS: s.crossS, made: s.made, madeGeometry: s.madeGeometry, madeBy: s.madeBy, zone: s.zone, flip: s.flip, tCross: s.tCross, tStart: s.tStart, tEnd: s.tEnd, fStart: s.fStart, fEnd: s.fEnd, fCross: s.fCross, evidence: s.evidence, nPoints: s.points.length, rms: s.rms, firstPoint: s.points[0], lastPoint: s.points[s.points.length - 1] },
        e, TOL, `${sc.name} #${i + 1}`,
      );
    });
  }
  assert.deepEqual(markStatic(v.staticCase.dets, v.staticCase.ballDiameterPx), v.staticCase.expected);
  assert.ok(v.staticCase.expected.some((x) => x) && v.staticCase.expected.some((x) => !x), '靜止和移動的偵測都要有');
  // 沒有偵測時不會出錯
  const hoop = makeHoopFrame({ x: 900, y: 240 }, { x: 972, y: 240 });
  assert.deepEqual(findShots([], hoop).shots, []);
});

test('統計與白話摘要', () => {
  const v = vectors('stats.json');
  for (const c of v.cases) {
    const st = summarize(c.shots);
    assertClose(st, c.expected, 1e-12, 'stats');
    assert.deepEqual(plainSummary(st), c.summary);
  }
  // 人工核對：44, 46, 45, 47, 43, 45 → 平均 45、樣本標準差 √2、命中率 50%
  const st = summarize([44, 46, 45, 47, 43, 45].map((a, i) => ({ angle: a, made: i % 2 === 0 })));
  assert.equal(st.attempts, 6);
  assert.equal(st.makes, 3);
  assert.equal(st.pct, 50);
  assert.ok(Math.abs(st.angleMean - 45) < 1e-12);
  assert.ok(Math.abs(st.angleStd - Math.SQRT2) < 1e-12);
  assert.deepEqual([st.first.attempts, st.second.attempts], [3, 3]);
  assert.deepEqual([summarize(new Array(11).fill({ angle: 45, made: true })).first.attempts, summarize(new Array(11).fill({ angle: 45, made: true })).second.attempts], [5, 6]);
  // 摘要只描述數據，不給技術指導
  for (const c of v.cases) {
    for (const line of c.summary) {
      assert.ok(!/應該|建議|試著|需要|最好|記得|加強|調整/.test(line), `摘要不可以出現指導語氣：${line}`);
    }
    assert.ok(c.summary.length >= 1 && c.summary.length <= 3);
  }
  assert.deepEqual(plainSummary(summarize([])), ['還沒有任何出手紀錄。']);
});

test('標註內插：補出來的點貼著合成真值，手點所在的幀保持原樣', () => {
  for (const c of vectors('interp.json').cases) {
    const hoop = makeHoopFrame(c.front, c.back);
    const shot = analyzeShot(hoopPts(hoop, c.manual));
    const frames = interpolateShot(c.manual, c.frameTimes, hoop, shot);
    assertClose(frames, c.expected.frames, 1e-7, c.name);
    assert.equal(frames.length, c.manual[c.manual.length - 1].frame - c.manual[0].frame + 1, '每一幀都要有');
    const manualFrames = new Map(c.manual.map((m) => [m.frame, m]));
    frames.forEach((f, i) => {
      assert.equal(f.frame, c.manual[0].frame + i, '幀號連續');
      assert.equal(f.t, c.frameTimes[f.frame], '時間戳取自 frameTimes');
      if (manualFrames.has(f.frame)) {
        assert.equal(f.src, 'manual');
        assert.equal(f.x, manualFrames.get(f.frame).x);
        assert.equal(f.y, manualFrames.get(f.frame).y);
      } else {
        assert.equal(f.src, 'interp');
        const d = Math.hypot(f.x - c.truth[i].x, f.y - c.truth[i].y);
        assert.ok(d < c.tolPx, `${c.name} 第 ${f.frame} 幀離真值 ${d.toFixed(2)} 像素`);
      }
    });
  }
});

test('CSV：格式固定、匯出再匯入不變、寬鬆解析', () => {
  const v = vectors('csv.json');
  assert.equal(shotsToCsv(v.shots), v.text);
  assert.equal(v.text.split('\r\n')[0], '球序,入框角度,是否進球');
  assert.deepEqual(parseCsv(shotsToCsv(v.shots)).shots, v.shots, '匯出再匯入');
  for (const c of v.cases) assert.deepEqual(parseCsv(c.text), c.expected, c.name);
  // 匯出再匯入後統計完全相同（角度記到小數一位）
  const shots = [44.3, 47.0, 38.9, 52.1, 45.6, 41.2].map((a, i) => ({ angle: a, made: i % 3 !== 0 }));
  assert.deepEqual(summarize(parseCsv(shotsToCsv(shots)).shots), summarize(shots));
});

test('YOLO 前後處理：縮放補邊、兩種輸出格式的解碼、NMS', () => {
  const v = vectors('yolo.json');
  for (const l of v.letterbox) assertClose(letterbox(l.sw, l.sh, l.dw, l.dh), l.expected, 1e-12, 'letterbox');
  for (const c of v.many.cases) {
    const got = decodeDetections(new Float32Array(v.many.data), v.many.dims, { ...c.opts, lb: c.opts.lb || undefined });
    assertClose(got, c.expected, 1e-9, 'one-to-many');
  }
  for (const c of v.one.cases) {
    const got = decodeDetections(new Float32Array(v.one.data), v.one.dims, { ...c.opts, lb: c.opts.lb || undefined });
    assertClose(got, c.expected, 1e-9, 'one-to-one');
  }
  // 1920×1080 → 640×384：縮成 640×360，上下各補 12
  assert.deepEqual(letterbox(1920, 1080, 640, 384), { scale: 1 / 3, newW: 640, newH: 360, padX: 0, padY: 12 });
  // 模型座標 (320, 192) 是輸入中心 → 原始畫面中心 (960, 540)
  const lb = letterbox(1920, 1080, 640, 384);
  const data = new Float32Array(5 * 1);
  data.set([320, 192, 24, 24, 0.9]);
  const [d] = decodeDetections(data, [1, 5, 1], { classIndex: 0, lb });
  assertClose([d.x, d.y, d.w, d.h], [960, 540, 72, 72], 1e-9);
  assert.throws(() => decodeDetections(data, [1, 5, 1], { classIndex: 3 }), /找不到類別/);
  assert.throws(() => decodeDetections(data, [5, 1], { classIndex: 0 }), /形狀/);
  // RGBA → CHW
  const chw = rgbaToChw(new Uint8ClampedArray([255, 0, 51, 255, 0, 255, 102, 255]), 2, 1);
  assertClose(Array.from(chw), [1, 0, 0, 1, 0.2, 0.4], 1e-6);
});

test('標註包：正常的通過檢查，壞掉的說得出哪裡壞', () => {
  const v = vectors('bundle.json');
  assert.deepEqual(validateBundle(v.good), []);
  assert.equal(v.good.format, BUNDLE_FORMAT);
  for (const b of v.bads) {
    assert.deepEqual(validateBundle(b.bundle), b.expected, b.name);
    assert.ok(b.expected.length >= 1, b.name);
  }
  // 規格要求的欄位都在
  const g = v.good;
  assert.ok(g.video.name && g.video.width > 0 && g.video.height > 0 && g.video.fps > 0, '影片檔名、解析度、幀率');
  assert.equal(g.frameTimes.length, g.video.frameCount, '每幀時間戳');
  assert.ok(g.hoop.front && g.hoop.back, '籃框兩點');
  assert.ok(Math.abs(g.ball.diameterPx - g.hoop.pxPerM * 0.24) < 0.01, '球的像素直徑由籃框比例推算');
  for (const s of g.shots) {
    assert.equal(typeof s.made, 'boolean', '每球進球與否');
    assert.ok(s.frames.some((f) => f.src === 'manual') && s.frames.some((f) => f.src === 'interp'), '註明手點或內插');
    for (let i = 1; i < s.frames.length; i++) assert.equal(s.frames[i].f, s.frames[i - 1].f + 1, '飛行途中每一幀都有球心');
  }
  // buildBundle 不會改動輸入，重建一次結果相同
  const again = buildBundle({
    video: g.video, frameTimes: g.frameTimes, hoopPoints: { front: g.hoop.front, back: g.hoop.back, level: g.hoop.level },
    hoop: makeHoopFrame(g.hoop.front, g.hoop.back, { level: g.hoop.level }),
    shots: g.shots.map((s) => ({ ...s, frames: s.frames.map((f) => ({ frame: f.f, t: f.t, x: f.x, y: f.y, src: f.src })) })),
    noBall: g.noBall, synthetic: g.synthetic, createdAt: g.createdAt,
  });
  assert.deepEqual(again, g);
});

test('疊圖用的軌跡取樣會通過手點附近', () => {
  const c = vectors('angle.json').cases.find((x) => x.name.startsWith('鏡射'));
  const hoop = makeHoopFrame(c.front, c.back);
  const pts = hoopPts(hoop, c.points);
  const res = analyzeShot(pts, { dragK: c.dragK });
  assert.equal(res.flip, false, '鏡射畫面只要前後緣點對，球仍是由前緣飛向後緣');
  const us = pts.map((p) => p.u);
  const curve = sampleArc(res, Math.min(...us), Math.max(...us), 200);
  for (const p of pts) {
    const near = curve.reduce((b, q) => (Math.abs(q.u - p.u) < Math.abs(b.u - p.u) ? q : b), curve[0]);
    assert.ok(Math.abs(near.v - p.v) < 0.05, '曲線離手點不到 0.05 個框');
  }
});
