// 自動模式的核心：多類別解碼、自動校正、鏡頭角度、投籃平面換算、分球、進球判定。
// 用 3D 合成場景（web/js/core/synth3d.js）和模擬偵測器（simdetect.js），答案是已知的。
// 這些都是模擬：通過只代表程式照設計在運作，不代表實拍準確度。
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeScene3d, scene3dTruth, truthAt, rimClickTruth, KINDS } from '../../web/js/core/synth3d.js';
import { project, makeCamera } from '../../web/js/core/camera3d.js';
import { simulateDetections } from '../../web/js/core/simdetect.js';
import { clusterBoxes, autoCalibrate, hoopPointsFromBox, RIM_OUTER_M } from '../../web/js/core/autocal.js';
import { fitPose, toShotPlane, gradeView, correctForYaw, GRADE_LIMITS } from '../../web/js/core/viewangle.js';
import { analyzeAuto, judgeAfter, countAttempts, G_RIM, linkTracks } from '../../web/js/core/autoshots.js';
import { makeHoopFrame } from '../../web/js/core/geometry.js';
import { decodeMulti } from '../../web/js/core/yolo.js';
import { RIM_DIAMETER_M } from '../../web/js/core/constants.js';

const CAM = { dist: 9, camHeight: 1.6, pitchDeg: 3 };
const alphaOf = (cam) => (Math.atan2(-cam.along, cam.z) * 180) / Math.PI;

function run(thetaDeg, extra = {}) {
  const plan = makeScene3d({ seed: extra.seed || 3, camera: { ...CAM, thetaDeg, ...(extra.camera || {}) }, background: !!extra.background, script: extra.script });
  const dets = simulateDetections(plan, { seed: 11 });
  const res = analyzeAuto(dets, { width: plan.width, height: plan.height });
  const truth = scene3dTruth(plan);
  const match = truth.map((t) => ({ t, s: res.shots.find((s) => Math.abs(s.tCross - t.tCross) < 0.35) || null }));
  const extraShots = res.shots.filter((s) => !truth.some((t) => Math.abs(s.tCross - t.tCross) < 0.35));
  return { plan, res, truth, match, extraShots };
}

test('多類別解碼：每個類別各自 NMS，結果帶類別名稱', () => {
  // [1, 7, 3]：三個候選框、三個類別
  const N = 3;
  const boxes = [[100, 100, 20, 20, [0.9, 0.1, 0.0]], [300, 100, 60, 10, [0.0, 0.8, 0.0]], [300, 60, 90, 70, [0.0, 0.0, 0.7]]];
  const data = new Float32Array(7 * N);
  boxes.forEach((b, i) => {
    data[i] = b[0]; data[N + i] = b[1]; data[2 * N + i] = b[2]; data[3 * N + i] = b[3];
    for (let c = 0; c < 3; c++) data[(4 + c) * N + i] = b[4][c];
  });
  const out = decodeMulti(data, [1, 7, N], { classes: { ball: 0, rim: 1, backboard: 2 }, conf: 0.5, iou: 0.5 });
  assert.deepEqual(out.map((d) => d.cls), ['ball', 'rim', 'backboard']);
  assert.equal(Math.round(out[1].w), 60);
  // 每類不同門檻
  assert.equal(decodeMulti(data, [1, 7, N], { classes: { ball: 0, rim: 1, backboard: 2 }, conf: { ball: 0.5, rim: 0.9, backboard: 0.5 } }).length, 2);
});

test('3D 合成場景：各種球的結果符合設計（空心進、麵包球、從旁邊和後面經過都沒進）', () => {
  const plan = makeScene3d({ seed: 5, script: ['swish', 'short', 'side', 'behind', 'rimout', 'swish', 'offset'] });
  const t = scene3dTruth(plan);
  assert.equal(t.length, 7);
  assert.equal(t[0].made, true);
  assert.equal(t[1].made, false);
  assert.equal(t[2].made, false);
  assert.equal(t[3].made, false);
  assert.equal(t[5].made, true);
  assert.equal(t[2].contact, false, '從旁邊經過的球不碰框');
  for (const k of Object.keys(KINDS)) assert.equal(typeof KINDS[k](() => 0.5).s, 'number');
});

test('自動校正：兩個籃框時選大的那個；兩點取鐵圈內緣；偵測抖動太大時標示不穩定', () => {
  const near = { x0: 600, y0: 300, x1: 660, y1: 312 };
  const far = { x0: 900, y0: 200, x1: 920, y1: 204 };
  const dets = [];
  for (let i = 0; i < 20; i++) {
    const j = (i % 3) - 1;
    dets.push({ cls: 'rim', x: (near.x0 + near.x1) / 2 + j, y: (near.y0 + near.y1) / 2, w: 60, h: 12 });
    dets.push({ cls: 'rim', x: (far.x0 + far.x1) / 2, y: (far.y0 + far.y1) / 2, w: 20, h: 4 });
  }
  const cal = autoCalibrate(dets);
  assert.equal(cal.ok, true);
  assert.equal(cal.candidates.length, 2);
  assert.equal(Math.round(cal.rim.w), 60);
  assert.equal(cal.stable, true);
  const pts = hoopPointsFromBox(cal.rim.box);
  assert.ok(Math.abs(pts.back.x - pts.front.x - (60 * RIM_DIAMETER_M) / RIM_OUTER_M) < 1e-6);
  assert.equal(pts.front.y, 306);
  // 連球網一起框：高度取上緣往下一點
  const withNet = { x0: 600, y0: 300, x1: 660, y1: 340 };
  assert.ok(hoopPointsFromBox(withNet, 'rim+net').front.y < hoopPointsFromBox(withNet, 'rim').front.y - 10);
  // 抖動
  const shaky = [];
  for (let i = 0; i < 20; i++) shaky.push({ cls: 'rim', x: 630 + (i % 2 ? 9 : -9), y: 306 + (i % 3) * 4, w: 60, h: 12 });
  assert.equal(autoCalibrate(shaky).stable, false);
  assert.equal(autoCalibrate([]).reason, 'no_rim');
  assert.equal(clusterBoxes([]).length, 0);
});

test('鏡頭角度：由精確的籃框、籃板框推算的偏角和真實偏角差 1 度以內；沒有籃板時不給偏角', () => {
  for (const thetaDeg of [0, -30, -60, -90, 30]) {
    const plan = makeScene3d({ camera: { ...CAM, thetaDeg }, script: ['swish'] });
    const tr = truthAt(plan, 1);
    const r = fitPose(tr.rims[0], tr.boards[0], { width: plan.width, height: plan.height });
    const a = alphaOf(plan.cam);
    assert.ok(Math.abs(r.devDeg - Math.abs(a)) < 1, `θ ${thetaDeg}：真實 ${a.toFixed(1)}、推算 ${r.devDeg}`);
    assert.ok(r.devRange[0] <= Math.abs(a) + 1 && r.devRange[1] >= Math.abs(a) - 1);
    assert.ok(Math.abs(r.heightM - 1.6) < 0.1);
    const nb = fitPose(tr.rims[0], null, { width: plan.width, height: plan.height });
    assert.equal(nb.devDeg, null);
  }
});

test('投籃平面換算是投影的反運算', () => {
  const cam = makeCamera({ thetaDeg: -35, rollDeg: 2, pitchDeg: 4 });
  for (const [X, Y] of [[-3, 2.5], [-1, 4], [0.1, 3.05]]) {
    const p = project(cam, X, Y, 0);
    const q = toShotPlane(cam, p.x, p.y);
    assert.ok(Math.abs(q.X - X) < 1e-9 && Math.abs(q.Y - Y) < 1e-9);
  }
});

test('分級：用不確定範圍的上限，跨過門檻就取比較差的一級', () => {
  assert.equal(gradeView(20, [15, 25]).grade, 'A');
  assert.equal(gradeView(28, [24, 33]).grade, 'B');
  assert.equal(gradeView(55, [50, 61]).grade, 'C');
  assert.equal(gradeView(null, null).grade, 'unknown');
  assert.equal(GRADE_LIMITS.A < GRADE_LIMITS.B, true);
  assert.ok(Math.abs(correctForYaw(45, 0) - 45) < 1e-12);
  assert.ok(correctForYaw(45, 30) < 45);
});

test('進球判定：自由落體經過 → 沒進；被網子拖慢 → 進；彈起 → 沒進；明顯偏短 → 沒進', () => {
  const shot = { crossS: 0.5, tCross: 1, flip: false, angleRaw: 45 };
  const q = 10; // 籃框內徑／秒
  const vy0 = -q;
  const free = [];
  const net = [];
  const bounce = [];
  for (let k = 1; k <= 12; k++) {
    const dt = k / 30;
    free.push({ t: 1 + dt, u: 0.5 + q * dt, v: vy0 * dt - 0.5 * G_RIM * dt * dt });
    // 網子：水平停住、往下只有自由落體的三成速度
    net.push({ t: 1 + dt, u: 0.5 + 0.3 * dt, v: -0.3 * q * dt });
    bounce.push({ t: 1 + dt, u: 0.9 - 2 * dt, v: 0.3 + 3 * dt - 0.5 * G_RIM * dt * dt * 0.2 });
  }
  assert.equal(judgeAfter(shot, free, { q }).by, 'freefall');
  assert.equal(judgeAfter(shot, free, { q }).made, false);
  const j = judgeAfter(shot, net, { q });
  assert.equal(j.made, true);
  assert.equal(j.by, 'net');
  assert.equal(judgeAfter(shot, bounce, { q }).made, false);
  assert.equal(judgeAfter({ ...shot, crossS: -0.6 }, net, { q }).by, 'short');
  // 被網子擋住：過框後 0.25 秒才在網子下面出現一次
  const hidden = [{ t: 1.27, u: 0.55, v: -1.2 }, { t: 1.3, u: 0.52, v: -1.4 }];
  assert.equal(judgeAfter(shot, hidden, { q }).made, true);
  // 什麼都沒看到：依過框位置，而且標成不確定
  const none = judgeAfter(shot, [], { q });
  assert.equal(none.by, 'geometry');
  assert.equal(none.uncertain, true);
});

test('正側面附近（A 級）：10 球全部找到、沒有多抓、進球判定全對、進球的角度誤差 < 1.2 度', () => {
  const { res, match, extraShots } = run(0);
  assert.equal(res.mode, 'plane');
  assert.equal(res.view.grade, 'A');
  assert.equal(match.filter((m) => !m.s).length, 0);
  assert.equal(extraShots.length, 0);
  for (const { t, s } of match) {
    assert.equal(s.made, t.made, `${t.kind}：真實 ${t.made}、判定 ${s.made}（${s.madeBy}）`);
    if (t.made) assert.ok(Math.abs(s.angle - t.angleDeg) < 1.2, `${t.kind} 誤差 ${(s.angle - t.angleDeg).toFixed(2)}`);
  }
  assert.ok(res.gRatio > 0.9 && res.gRatio < 1.1, `重力比 ${res.gRatio}`);
});

test('偏 40 度（B 級）：仍然給角度；最多漏 1 球（模擬裡這個角度 50 球漏 0 到 1 球），找到的進球判定全對', () => {
  const { res, match } = run(-30);
  assert.equal(res.view.grade, 'B');
  assert.equal(res.mode, 'plane');
  assert.ok(match.filter((m) => !m.s).length <= 1);
  for (const { t, s } of match) {
    if (!s) continue;
    assert.equal(s.made, t.made, t.kind);
    if (t.made) assert.ok(Math.abs(s.angle - t.angleDeg) < 1.5);
  }
});

test('從投籃者正後方拍（C 級）：只數出手和進球，不給角度', () => {
  const { res, match, extraShots } = run(-90);
  assert.equal(res.view.grade, 'C');
  assert.equal(res.mode, 'count');
  for (const s of res.shots) assert.equal(s.angle, null);
  const found = match.filter((m) => m.s);
  assert.ok(found.length >= 9, `只找到 ${found.length}`);
  assert.ok(extraShots.length <= 1);
  const wrong = found.filter((m) => m.s.made !== m.t.made).length;
  assert.ok(wrong <= 2, `進球判定錯 ${wrong} 球`);
});

test('背景有別的籃框在投、有人運球和傳球：只留往我們籃框投的球', () => {
  for (const theta of [0, -40]) {
    const { res, match, extraShots } = run(theta, { background: true });
    assert.equal(extraShots.length, 0, `θ ${theta}：多抓 ${extraShots.length} 球`);
    assert.ok(match.filter((m) => m.s).length >= 9);
    // 隔壁的籃框也有被偵測到，但選的是我們的
    assert.ok(res.candidates.length >= 2);
    assert.ok(!res.notes.includes('switched_hoop'));
  }
});

test('手機歪 5 度：由軌跡估出歪斜，角度誤差仍在 1.2 度以內', () => {
  const { res, match } = run(0, { camera: { rollDeg: -5 } });
  assert.ok(Math.abs(res.rollDeg + 5) < 1.5, `估出 ${res.rollDeg}`);
  for (const { t, s } of match) if (t.made && s) assert.ok(Math.abs(s.angle - t.angleDeg) < 1.2, `${t.kind} ${(s.angle - t.angleDeg).toFixed(2)}`);
});

test('沒有籃框類別（使用者點兩下）：用 2D 座標系，偏角由球的大小粗估', () => {
  const plan = makeScene3d({ seed: 3, camera: { ...CAM, thetaDeg: 0 } });
  const dets = simulateDetections(plan, { seed: 11 }).filter((d) => d.cls === 'ball');
  const c = rimClickTruth(plan);
  const res = analyzeAuto(dets, { width: plan.width, height: plan.height, hoopPoints: { front: c.left, back: c.right } });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'image');
  assert.equal(res.view.source, 'ballsize');
  assert.ok(res.shots.length >= 9);
  // 模型找不到籃框又沒給兩點：回報原因，不亂猜
  assert.equal(analyzeAuto(dets, { width: plan.width, height: plan.height }).reason, 'no_rim');
});

test('數出手的軌跡串接：零星的誤偵測串不成軌跡', () => {
  const pts = [];
  for (let k = 0; k < 20; k++) pts.push({ t: k / 30, u: -3 + k * 0.2, v: 1 + Math.sin(k / 6) });
  pts.push({ t: 0.3, u: 5, v: 2 }, { t: 0.5, u: -5, v: 3 });
  pts.sort((a, b) => a.t - b.t);
  const tr = linkTracks(pts, 30);
  assert.equal(Math.max(...tr.map((x) => x.length)), 20);
  const hoop = makeHoopFrame({ x: 0, y: 0 }, { x: 45, y: 0 }, { level: 'rim' });
  assert.deepEqual(countAttempts([], hoop).attempts, []);
});
