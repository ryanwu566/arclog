// 畫面背後的純函式模組：一次練習的狀態（session）、歷次紀錄、報告資料、圖表、本機儲存。
// 這些都不碰 DOM，所以可以直接在 Node 裡測。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as S from '../../web/js/ui/session.js';
import { createStore, loadHistory, saveHistory, loadDraft, saveDraft, clearDraft } from '../../web/js/ui/storage.js';
import { scatterChart, trendChart, reportSvg, wrapText, textWidth } from '../../web/js/ui/charts.js';
import { buildReport, signed1, signed0, fmt1, fmtPct } from '../../web/js/core/report.js';
import * as H from '../../web/js/core/history.js';
import { validateBundle } from '../../web/js/core/bundle.js';
import { parseCsv, shotsToCsv } from '../../web/js/core/csv.js';
import { makeDemoPlan, planTruth, simulateClicks, hoopPx, verticalPx, ballAt, frameTime } from '../../web/js/core/synth.js';

function demoSession() {
  const plan = makeDemoPlan({});
  const frameTimes = Float64Array.from({ length: plan.frameCount }, (_, i) => frameTime(plan, i));
  const info = { name: '合成示範', size: null, width: plan.width, height: plan.height, fps: plan.fps, frameCount: plan.frameCount, duration: plan.frameCount / plan.fps, codec: null, rotation: 0, timeSource: 'synthetic', engine: 'synthetic' };
  const s = S.createSession({ mode: 'demo', info, truth: planTruth(plan) });
  const hp = hoopPx(plan);
  S.setHoopPoint(s, 'front', hp.front);
  S.setHoopPoint(s, 'back', hp.back);
  return { s, plan, frameTimes };
}

function markShot(s, plan, i, opts = {}) {
  for (const c of simulateClicks(plan, i, { count: 5, noisePx: 1, seed: 3, ...opts })) S.addDraftPoint(s, c);
  return S.saveDraftShot(s, null);
}

test('session：校正、點球心、儲存一球、復原', () => {
  const { s, plan } = demoSession();
  assert.ok(S.hoopFrame(s));
  assert.deepEqual(S.hoopWarnings(s), []);
  assert.equal(S.draftStatus(s).count, 0);

  const clicks = simulateClicks(plan, 0, { count: 5, noisePx: 0, seed: 1 });
  S.addDraftPoint(s, clicks[0]);
  S.addDraftPoint(s, clicks[1]);
  let st = S.draftStatus(s);
  assert.equal(st.count, 2);
  assert.equal(st.result, null, '不到 3 點還不擬合');
  assert.equal(S.saveDraftShot(s, null).ok, false, '不到 4 點不能存');
  S.addDraftPoint(s, clicks[2]);
  st = S.draftStatus(s);
  assert.ok(st.result && !st.enough, '3 點開始有估計值，但還不能存');
  // 同一幀再點一次是取代，不是多一個點
  S.addDraftPoint(s, { ...clicks[2], x: clicks[2].x + 1 });
  assert.equal(s.draft.length, 3);
  S.addDraftPoint(s, clicks[4]);
  S.addDraftPoint(s, clicks[3]); // 不照順序點也會排好
  assert.deepEqual(s.draft.map((p) => p.frame), clicks.map((c) => c.frame));

  const saved = S.saveDraftShot(s, null);
  assert.ok(saved.ok);
  assert.equal(s.shots.length, 1);
  assert.equal(s.draft.length, 0);
  assert.ok(Math.abs(saved.shot.angleRaw - plan.shots[0].angleDeg) < 0.3);
  assert.equal(saved.shot.angle, Math.floor(saved.shot.angleRaw * 10 + 0.5) / 10, '角度記到小數一位');
  assert.equal(saved.shot.made, saved.shot.madeSuggested);

  // 復原：回到「5 個點、還沒存」
  assert.ok(S.undo(s));
  assert.equal(s.shots.length, 0);
  assert.equal(s.draft.length, 5);
  assert.ok(S.undo(s));
  assert.equal(s.draft.length, 4);
  // 一路復原到最開始也不會壞
  while (S.undo(s));
  assert.equal(S.hoopFrame(s), null);
  assert.equal(S.undo(s), false);
});

test('session：10 球的角度都在 1 度內；改進球、刪除、重標、依時間排序', () => {
  const { s, plan } = demoSession();
  // 故意不照順序標
  for (const i of [3, 0, 7, 1, 9, 2, 8, 4, 6, 5]) assert.ok(markShot(s, plan, i).ok);
  assert.equal(s.shots.length, 10);
  const firstFrames = s.shots.map((x) => x.points[0].frame);
  assert.deepEqual(firstFrames, [...firstFrames].sort((a, b) => a - b), '球序依時間排');
  const truth = S.truthForShots(s);
  s.shots.forEach((shot, i) => {
    assert.ok(truth[i], `第 ${i + 1} 球對得到真實答案`);
    assert.ok(Math.abs(shot.angleRaw - truth[i].angleDeg) < 1, `第 ${i + 1} 球誤差 ${Math.abs(shot.angleRaw - truth[i].angleDeg)}`);
    assert.equal(shot.made, truth[i].made, `第 ${i + 1} 球的進球建議`);
  });

  const id = s.shots[2].id;
  const was = s.shots[2].made;
  S.setMade(s, id, !was);
  assert.equal(s.shots[2].made, !was);
  S.undo(s);
  assert.equal(s.shots[2].made, was);

  S.deleteShot(s, id);
  assert.equal(s.shots.length, 9);
  S.undo(s);
  assert.equal(s.shots.length, 10);

  assert.ok(S.editShot(s, id));
  assert.equal(s.shots.length, 9);
  assert.equal(s.draft.length, 5, '重標：點回到畫面上可以調整');
  assert.ok(S.saveDraftShot(s, true).ok);
  assert.equal(s.shots.length, 10);

  const shots = S.reportShots(s);
  assert.equal(shots.length, 10);
  assert.ok(shots.every((x) => typeof x.angle === 'number' && typeof x.made === 'boolean'));
});

test('session：改水平基準或重新校正後，每一球都會重新計算', () => {
  const { s, plan } = demoSession();
  markShot(s, plan, 0);
  const before = s.shots[0].angleRaw;
  // 把後緣往上移 3 像素（籃框 67.5 像素寬，等於連線歪了 2.5 度）：角度會跟著變。
  // 變化量比 2.5 度小很多（約 0.6 度），因為擬合的拋物線會吸收掉大部分的歪斜。
  S.setHoopPoint(s, 'back', { x: s.hoopPoints.back.x, y: s.hoopPoints.back.y - 3 });
  const tilted = s.shots[0].angleRaw;
  assert.ok(tilted - before > 0.3 && tilted - before < 1.5, `籃框連線歪掉後角度應該改變（${before} → ${tilted}）`);
  assert.ok(Math.abs(S.hoopFrame(s).tiltDeg) > 2);
  // 改用畫面水平：兩點取平均高度，角度回到原本的值
  S.setLevel(s, 'image');
  assert.ok(Math.abs(s.shots[0].angleRaw - before) < 0.15, `以畫面為水平後應該接近原本的角度（${before} → ${s.shots[0].angleRaw}）`);
  S.undo(s);
  assert.equal(s.level, 'rim');
  assert.ok(Math.abs(s.shots[0].angleRaw - tilted) < 1e-9);
});

test('session：不合理的點會回報原因', () => {
  const { s } = demoSession();
  const hoop = S.hoopFrame(s);
  // 四個點排成開口向上的弧
  const base = { x: hoop.ox - 400, y: hoop.oy + 100 };
  [[0, 0], [100, 60], [200, 80], [300, 40]].forEach(([dx, dy], i) => S.addDraftPoint(s, { frame: 10 + i * 5, t: (10 + i * 5) / 30, x: base.x + dx, y: base.y + dy }));
  const st = S.draftStatus(s);
  assert.equal(st.result, null);
  assert.equal(st.reason, 'not_arc');
  assert.match(S.reasonText(st.reason), /拋物線/);
  assert.equal(S.saveDraftShot(s, null).ok, false);
  for (const r of ['no_hoop', 'no_crossing', 'no_motion', 'degenerate', 'too_few_points', 'whatever']) assert.ok(S.reasonText(r).length > 4);
  // 沒有校正就不能分析
  const fresh = S.createSession({ mode: 'video', info: { name: 'a.mp4', width: 1280, height: 720, fps: 30, frameCount: 100, duration: 3.3 } });
  for (let i = 0; i < 4; i++) S.addDraftPoint(fresh, { frame: i, t: i / 30, x: i * 50, y: 100 });
  assert.equal(S.draftStatus(fresh).reason, 'no_hoop');
});

test('session：校正的提醒（籃框太小、連線太歪）', () => {
  const s = S.createSession({ mode: 'video', info: { name: 'a.mp4', width: 1280, height: 720, fps: 30, frameCount: 100, duration: 3.3 } });
  S.setHoopPoint(s, 'front', { x: 600, y: 200 });
  S.setHoopPoint(s, 'back', { x: 620, y: 200 });
  assert.match(S.hoopWarnings(s).join(''), /只有 20 像素寬/);
  S.setHoopPoint(s, 'back', { x: 700, y: 185 });
  assert.match(S.hoopWarnings(s).join(''), /歪了 8\.\d 度/);
  S.setHoopPoint(s, 'back', { x: 1300, y: 200 });
  assert.match(S.hoopWarnings(s).join(''), /超過半個畫面/);
  S.resetHoop(s);
  assert.deepEqual(S.hoopWarnings(s), []);
});

test('session：垂直參考線基準（點完籃框再點一條鉛直的邊；提醒、復原、草稿、標註包）', () => {
  const { s, plan, frameTimes } = demoSession();
  for (const i of [0, 1, 2]) assert.ok(markShot(s, plan, i).ok);
  const before = s.shots.map((x) => x.angleRaw);
  S.setLevel(s, 'vertical');
  assert.equal(S.nextCalPoint(s), 'top', '籃框點好了，下一個要點參考線的一端');
  assert.equal(S.hoopFrame(s), null, '參考線還沒點完就沒有座標系');
  assert.equal(S.calibrationProblem(s), null, '還沒點完不算有問題');
  const vp = verticalPx(plan);
  S.setHoopPoint(s, 'top', vp.top);
  assert.equal(S.nextCalPoint(s), 'bottom');
  S.setHoopPoint(s, 'bottom', vp.bottom);
  assert.equal(S.nextCalPoint(s), null);
  const hoop = S.hoopFrame(s);
  assert.equal(hoop.level, 'vertical');
  assert.ok(Math.abs(hoop.vertDeg) < 1e-9, '合成畫面沒有歪');
  assert.equal(hoop.focal, null, '合成畫面沒有透視，不扣籃框比例');
  // 合成畫面沒有透視、也沒有歪：和「籃框連線」量到的角度一樣
  s.shots.forEach((x, i) => assert.ok(Math.abs(x.angleRaw - before[i]) < 1e-9, `第 ${i + 1} 球 ${before[i]} → ${x.angleRaw}`));
  assert.deepEqual(S.hoopWarnings(s), []);
  // 點成橫線：建不了座標系，說得出是參考線的問題；復原就好
  S.setHoopPoint(s, 'bottom', { x: vp.top.x + 150, y: vp.top.y + 5 });
  assert.equal(S.hoopFrame(s), null);
  assert.equal(S.calibrationProblem(s), 'vertical');
  S.undo(s);
  assert.ok(S.hoopFrame(s));
  // 參考線太短：提醒
  S.setHoopPoint(s, 'bottom', { x: vp.top.x, y: vp.top.y + 40 });
  assert.match(S.hoopWarnings(s).join(''), /垂直參考線只有 40 像素長/);
  S.undo(s);
  // 標註包帶著參考線
  const bundle = S.sessionBundle(s, frameTimes, { createdAt: '2026-11-14T00:00:00.000Z' });
  assert.deepEqual(validateBundle(bundle), []);
  assert.equal(bundle.hoop.level, 'vertical');
  assert.ok(Math.abs(bundle.hoop.vertical.top.x - vp.top.x) < 0.001 && Math.abs(bundle.hoop.vertical.bottom.y - vp.bottom.y) < 0.001);
  // 草稿存起來再還原：基準和參考線都還在
  const d = JSON.parse(JSON.stringify(S.serializeDraft(s)));
  const s2 = S.createSession({ mode: 'demo', info: { ...s.info } });
  assert.equal(S.restoreDraft(s2, d), 3);
  assert.equal(s2.level, 'vertical');
  assert.deepEqual(s2.hoopPoints.bottom, s.hoopPoints.bottom);
  // 換回其他基準就不需要參考線；重新點會把參考線一起清掉
  S.setLevel(s, 'rim');
  assert.equal(S.nextCalPoint(s), null);
  S.resetHoop(s);
  assert.deepEqual(s.hoopPoints, { front: null, back: null, top: null, bottom: null });
});

test('session：垂直參考線和籃框（扣掉透視後）推算的水平差太多時提醒；示範模式不套透視', () => {
  const s = S.createSession({ mode: 'video', info: { name: 'a.mp4', width: 1920, height: 1080, fps: 30, frameCount: 100, duration: 3.3 } });
  S.setLevel(s, 'vertical');
  S.setHoopPoint(s, 'front', { x: 1403.5, y: 412 });
  S.setHoopPoint(s, 'back', { x: 1538.2, y: 405.1 });
  S.setHoopPoint(s, 'top', { x: 1560, y: 300 });
  S.setHoopPoint(s, 'bottom', { x: 1560, y: 520 });
  const sk = S.hoopSkew(s);
  // 籃框連線斜 2.9 度，其中透視約 1.5 度；鉛直的參考線說手機沒歪
  assert.ok(Math.abs(sk.vert) < 1e-9);
  assert.ok(sk.rimRoll > 1 && sk.rimRoll < 2, String(sk.rimRoll));
  assert.ok(S.hoopFrame(s).focal > 0, '實拍影片會扣籃框比例');
  assert.deepEqual(S.hoopWarnings(s), []);
  // 參考線其實斜了 1 度（例如點到斜的支架）：兩個估計差超過 2 度
  const a = (1 * Math.PI) / 180;
  S.setHoopPoint(s, 'top', { x: 1560 + 220 * Math.sin(a), y: 520 - 220 * Math.cos(a) });
  assert.match(S.hoopWarnings(s).join(''), /差了 2\.\d 度/);
  // 同樣的點放進示範模式：合成畫面沒有透視，「修正透視」等於「籃框連線」，也不做這個比較
  const demo = S.createSession({ mode: 'demo', info: { ...s.info } });
  for (const k of ['front', 'back', 'top', 'bottom']) S.setHoopPoint(demo, k, s.hoopPoints[k]);
  S.setLevel(demo, 'persp');
  assert.equal(S.hoopFrame(demo).level, 'rim');
  S.setLevel(demo, 'vertical');
  assert.equal(S.hoopSkew(demo).rimRoll, null);
  // 「畫面水平」配上下對齊的籃框兩點：問題出在籃框，不是參考線
  S.setLevel(demo, 'image');
  S.setHoopPoint(demo, 'back', { x: demo.hoopPoints.front.x, y: demo.hoopPoints.front.y + 30 });
  assert.equal(S.hoopFrame(demo), null);
  assert.equal(S.calibrationProblem(demo), 'rim');
});

test('session：自動偵測的球加進來；時間重疊的不重複加；標註包', () => {
  const { s, plan, frameTimes } = demoSession();
  markShot(s, plan, 0);
  const auto = (i) => {
    const sh = plan.shots[i];
    const pts = [];
    for (let f = Math.ceil((sh.tRelease + 0.03) * plan.fps); f <= Math.floor((sh.tCross - 0.05) * plan.fps); f += 2) {
      const b = ballAt(plan, frameTimes[f]);
      pts.push({ f, t: frameTimes[f], x: b.x, y: b.y, conf: 0.5 });
    }
    return { fStart: pts[0].f, fEnd: pts[pts.length - 1].f, fCross: pts[pts.length - 1].f, points: pts, made: sh.made, madeGeometry: sh.made, madeBy: 'geometry', evidence: { net: 0, above: 0 }, zone: 'clean', angle: Math.round(sh.angleDeg * 10) / 10, angleRaw: sh.angleDeg, crossS: sh.crossS, model: { uc: sh.crossS, slope: Math.tan((sh.angleDeg * Math.PI) / 180), kappa: 0.1, k: 0 }, flip: false, apex: { u: -3, v: 2 }, rms: 0.01 };
  };
  assert.equal(S.addAutoShots(s, [auto(0), auto(1), auto(2)]), 2, '第 1 球已經手動標過，不重複加');
  assert.deepEqual(s.shots.map((x) => x.source), ['manual', 'auto', 'auto']);
  S.addNoBall(s, 5, 0);
  assert.deepEqual(s.noBall, [{ from: 0, to: 5 }], '起點和終點反了會自動對調');

  assert.ok(S.canExportBundle(s));
  const bundle = S.sessionBundle(s, frameTimes, { createdAt: '2026-11-13T00:00:00.000Z' });
  assert.deepEqual(validateBundle(JSON.parse(JSON.stringify(bundle))), []);
  assert.equal(bundle.synthetic, true);
  assert.equal(bundle.shots.length, 3);
  assert.deepEqual([...new Set(bundle.shots[0].frames.map((f) => f.src))].sort(), ['interp', 'manual']);
  assert.deepEqual([...new Set(bundle.shots[1].frames.map((f) => f.src))].sort(), ['auto', 'interp'], '自動偵測的點標成 auto');
  assert.deepEqual(bundle.noBall, [{ from: 0, to: 5 }]);
  for (const shot of bundle.shots) {
    for (const f of shot.frames) {
      const b = ballAt(plan, f.t);
      assert.ok(Math.hypot(f.x - b.x, f.y - b.y) < 4, '標註包裡的球心貼著真實位置');
    }
  }
  S.removeNoBall(s, 0);
  assert.deepEqual(s.noBall, []);
});

test('session：草稿存起來再還原，球和校正都還在，代號不變', () => {
  const { s, plan } = demoSession();
  s.mode = 'video';
  s.info.name = 'IMG_0001.MOV';
  s.info.size = 123456;
  for (const i of [0, 1, 2]) markShot(s, plan, i);
  S.setMade(s, s.shots[1].id, !s.shots[1].made);
  s.player = '王小明';
  const draft = JSON.parse(JSON.stringify(S.serializeDraft(s)));

  const again = S.createSession({ mode: 'video', info: { ...s.info } });
  assert.notEqual(again.id, s.id);
  assert.equal(S.restoreDraft(again, draft), 3);
  assert.equal(again.id, s.id, '同一次練習沿用同一個代號');
  assert.deepEqual(again.shots.map((x) => [x.angle, x.made]), s.shots.map((x) => [x.angle, x.made]));
  assert.equal(again.player, '王小明');
  assert.ok(S.hoopFrame(again));
  // 別支影片的草稿不會被套用
  const other = S.createSession({ mode: 'video', info: { ...s.info, name: 'IMG_0002.MOV' } });
  assert.equal(S.restoreDraft(other, draft), 0);
  assert.equal(other.shots.length, 0);
  assert.equal(S.hasContent(other), false);
  assert.equal(S.hasContent(again), true);
});

test('儲存：正常、空間滿了、完全不能用，三種情況都不會丟例外', () => {
  const fake = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const rec = H.makeRecord({ id: 'x1', player: '甲', date: '2026-11-13', shots: [{ angle: 44.3, made: true }, { angle: 46.1, made: false }] });

  const ok = createStore(fake());
  assert.equal(ok.persistent, true);
  assert.deepEqual(saveHistory([rec], ok), { ok: true, persisted: true, error: null });
  assert.deepEqual(loadHistory(ok).list, [rec]);

  const full = fake();
  const realSet = full.setItem;
  full.setItem = (k, v) => {
    if (k.startsWith('__arclog_probe')) return realSet(k, v);
    const e = new Error('quota');
    e.name = 'QuotaExceededError';
    throw e;
  };
  const quota = createStore(full);
  const r = saveHistory([rec], quota);
  assert.equal(r.ok, false);
  assert.equal(r.persisted, false);
  assert.equal(r.error, 'QuotaExceededError');
  assert.deepEqual(loadHistory(quota).list, [rec], '寫不進去時，這次開著的期間還是讀得到');

  const none = createStore(null);
  assert.equal(none.persistent, false);
  assert.deepEqual(saveHistory([rec], none), { ok: true, persisted: false, error: null });
  assert.deepEqual(loadHistory(none).list, [rec]);
  assert.equal(loadHistory(none).persistent, false);

  const throwing = createStore({ getItem() { throw new Error('nope'); }, setItem() { throw new Error('nope'); }, removeItem() { throw new Error('nope'); } });
  assert.equal(throwing.persistent, false);
  assert.equal(throwing.get('k'), null);

  // 草稿：每支影片各存一份，最多留 4 支
  const st = createStore(fake());
  for (let i = 1; i <= 6; i++) saveDraft({ key: `v${i}`, n: i }, st);
  assert.equal(loadDraft('v6', st).n, 6);
  assert.equal(loadDraft('v3', st).n, 3);
  assert.equal(loadDraft('v2', st), null, '太舊的被擠掉');
  saveDraft({ key: 'v3', n: 33 }, st);
  assert.equal(loadDraft('v3', st).n, 33);
  clearDraft('v3', st);
  assert.equal(loadDraft('v3', st), null);
  assert.equal(loadDraft('v6', st).n, 6);
  st.set('arclog.draft.v1', 'not json');
  assert.equal(loadDraft('v6', st), null);
});

test('歷次紀錄：新增、更新、排序、趨勢、備份與還原', () => {
  const mk = (id, date, player, angles, savedAt) => ({ id, savedAt, date, player, note: '', videoName: '', source: 'manual', shots: angles.map((a, i) => ({ angle: a, made: i % 2 === 0 })) });
  let list = [];
  list = H.upsertRecord(list, mk('a', '2026-11-01', '甲', [42, 44], '2026-11-01T10:00:00.000Z'));
  list = H.upsertRecord(list, mk('b', '2026-11-08', '乙', [45, 47], '2026-11-08T10:00:00.000Z'));
  list = H.upsertRecord(list, mk('c', '2026-11-05', '甲', [43, 45, 47], '2026-11-05T10:00:00.000Z'));
  assert.deepEqual(list.map((r) => r.id), ['b', 'c', 'a'], '新的在前面');
  list = H.upsertRecord(list, mk('a', '2026-11-01', '甲', [50, 52], '2026-11-02T10:00:00.000Z'));
  assert.equal(list.length, 3, '同一個代號是更新，不是多一筆');
  assert.deepEqual(H.playerNames(list), ['乙', '甲'].sort((x, y) => x.localeCompare(y, 'zh-Hant')));

  const all = H.trendPoints(list);
  assert.deepEqual(all.map((p) => p.date), ['2026-11-01', '2026-11-05', '2026-11-08'], '趨勢由舊到新');
  assert.equal(all[0].angleMean, 51);
  assert.equal(all[1].pct, (2 / 3) * 100);
  assert.deepEqual(H.trendPoints(list, { player: '甲' }).map((p) => p.id), ['a', 'c']);

  const backup = JSON.parse(JSON.stringify(H.exportBackup(list, new Date('2026-11-13T00:00:00Z'))));
  assert.equal(backup.format, 'arclog-history');
  const older = mk('a', '2026-11-01', '甲', [10, 12], '2026-10-01T00:00:00.000Z');
  const res = H.importBackup({ ...backup, sessions: [...backup.sessions, mk('d', '2026-11-10', '丙', [44], '2026-11-10T00:00:00.000Z'), { id: 'bad' }, older] }, H.removeRecord(list, 'b'));
  assert.equal(res.error, null);
  assert.deepEqual([res.added, res.updated, res.unchanged, res.invalid], [2, 0, 3, 1]);
  assert.equal(res.list.find((r) => r.id === 'a').shots[0].angle, 50, '比較舊的那一筆不會蓋掉新的');
  assert.match(H.importBackup({ foo: 1 }, list).error, /不是 ArcLog 的備份檔/);
  assert.match(H.importBackup({ format: 'arclog-history', version: 99, sessions: [] }, list).error, /版本/);
  assert.match(H.importBackup(null, list).error, /不是/);

  assert.deepEqual(H.parseStored(''), { list: [], dropped: 0 });
  assert.equal(H.parseStored('{bad').corrupt, true);
  assert.equal(H.parseStored('{"a":1}').corrupt, true);
  const parsed = H.parseStored(JSON.stringify([...list, { id: 'x', shots: [{ angle: 200, made: true }] }]));
  assert.equal(parsed.list.length, 3);
  assert.equal(parsed.dropped, 1, '角度不合理的紀錄會被略過');
  assert.equal(H.normalizeRecord({ id: 'ok', shots: [], player: 'x'.repeat(100) }).player.length, 40);
  assert.match(H.todayString(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('makeRecord：依球的來源標示這次練習是手動、自動或混合', () => {
  const shots = (kinds) => kinds.map((k) => ({ angle: 45, made: true, source: k }));
  assert.equal(H.makeRecord({ id: 'a', shots: shots(['manual', 'manual']) }).source, 'manual');
  assert.equal(H.makeRecord({ id: 'a', shots: shots(['auto']) }).source, 'auto');
  assert.equal(H.makeRecord({ id: 'a', shots: shots(['auto', 'manual']) }).source, 'mixed');
  assert.equal(H.makeRecord({ id: 'a', shots: shots(['csv', 'csv']) }).source, 'csv');
  assert.match(H.makeRecord({ id: 'a', shots: [] }, new Date(2026, 10, 13)).date, /^2026-11-13$/);
});

test('報告資料：四個數字、前後半、示範模式的誤差', () => {
  const shots = [44.3, 47.0, 38.9, 52.1, 45.6, 41.2, 43.3, 46.1].map((a, i) => ({ angle: a, made: i % 3 !== 0 }));
  const r = buildReport({ shots, player: '甲', date: '2026-11-13' });
  assert.deepEqual(r.tiles.map((t) => t.label), ['出手數', '命中率', '平均入框角度', '角度標準差']);
  assert.equal(r.tiles[0].value, '8');
  assert.equal(r.tiles[1].value, '63%');
  assert.equal(r.tiles[2].value, '44.8°');
  assert.match(r.tiles[2].sub, /比 45° 參考線低 0\.2°/);
  assert.equal(r.halves.length, 3);
  assert.equal(r.halves[0].delta, '+25 個百分點');
  assert.equal(r.halves[1].delta, '−1.5°');
  assert.equal(r.firstCount, 4);
  assert.equal(r.demoStats, null);
  assert.equal(r.rows.length, 8);
  assert.ok(r.summary.length >= 2 && r.summary.length <= 3);

  const truth = shots.map((s, i) => ({ angleDeg: s.angle - 0.3, made: i === 0 ? !s.made : s.made }));
  const d = buildReport({ shots, truth, demo: true }).demoStats;
  assert.ok(Math.abs(d.mae - 0.3) < 1e-9 && Math.abs(d.maxErr - 0.3) < 1e-9);
  assert.deepEqual([d.madeCorrect, d.madeTotal], [7, 8]);

  // 球數很少時不做前後半比較，也不會出錯
  assert.equal(buildReport({ shots: shots.slice(0, 3) }).halves, null);
  const empty = buildReport({ shots: [] });
  assert.equal(empty.tiles[1].value, '—');
  assert.deepEqual(empty.summary, ['還沒有任何出手紀錄。']);
  assert.equal(buildReport({ shots: [{ angle: 45, made: true }] }).tiles[3].value, '—', '只有一球沒有標準差');
  assert.match(buildReport({ shots: [{ angle: 45, made: true }, { angle: 45, made: true }] }).tiles[2].sub, /相同/);

  assert.equal(signed1(0.04), '0.0');
  assert.equal(signed1(-0.04), '0.0');
  assert.equal(signed1(1.25), '+1.3');
  assert.equal(signed1(-2), '−2.0');
  assert.equal(signed0(-0.4), '0');
  assert.equal(signed0(12.5), '+13');
  assert.equal(fmt1(null), '—');
  assert.equal(fmtPct(66.666), '67%');
});

test('圖表：SVG 結構正確、形狀加顏色區分進球與否、有 45 度參考線', () => {
  const rows = [50.2, 45.9, 51.9, 45.6, 39.6, 47.7, 38.0, 42.0, 43.4, 44.2].map((a, i) => ({ n: i + 1, angle: a, made: [1, 1, 0, 1, 0, 1, 0, 0, 1, 1][i] === 1 }));
  const c = scatterChart({ rows, width: 360, height: 250, firstCount: 5 });
  assert.match(c.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(c.svg, /role="img"/);
  assert.match(c.svg, /aria-label="每球入框角度散點圖，共 10 球/);
  assert.equal(c.points.length, 10);
  // 進球：藍色實心圓（6 顆＋圖例 1 個）；沒進：橘色的叉（4 個＋圖例 1 個，每個叉兩筆：底色襯線＋橘線）
  assert.equal((c.svg.match(/<circle [^>]*fill="#2a78d6"/g) || []).length, 7);
  assert.equal((c.svg.match(/<path [^>]*stroke="#eb6834"/g) || []).length, 5);
  assert.match(c.svg, /stroke-dasharray="6 5"/, '45 度參考線是虛線');
  assert.match(c.svg, /45° 參考線/);
  assert.match(c.svg, /進球/);
  assert.match(c.svg, /沒進/);
  assert.match(c.svg, /前半/);
  // 資料點都落在圖的範圍內，而且角度越大位置越高
  for (const p of c.points) assert.ok(p.x > 0 && p.x < 360 && p.y > 0 && p.y < 250);
  const hi = c.points.find((p) => p.angle === 51.9);
  const lo = c.points.find((p) => p.angle === 38.0);
  assert.ok(hi.y < lo.y);
  // 格線是實線：除了參考線和它的圖例以外沒有別的虛線
  assert.equal((c.svg.match(/stroke-dasharray/g) || []).length, 2);
  // 標籤和括號都有成對（簡單檢查沒有壞掉的標記）
  assert.equal((c.svg.match(/<text/g) || []).length, (c.svg.match(/<\/text>/g) || []).length);
  assert.ok(!/NaN|undefined|Infinity/.test(c.svg));

  const empty = scatterChart({ rows: [] });
  assert.match(empty.svg, /還沒有資料/);
  assert.ok(!/NaN|undefined/.test(empty.svg));
  const one = scatterChart({ rows: [{ n: 1, angle: 45, made: true }] });
  assert.ok(!/NaN|undefined/.test(one.svg));
  const many = scatterChart({ rows: Array.from({ length: 120 }, (_, i) => ({ n: i + 1, angle: 40 + (i % 11), made: i % 2 === 0 })) });
  assert.ok((many.svg.match(/text-anchor="middle" style="font-variant-numeric:tabular-nums"/g) || []).length <= 12, '球很多時 x 軸標籤要抽樣');

  const t = trendChart({ title: '平均入框角度', points: [{ label: '11/1', value: 42.1 }, { label: '11/5', value: null }, { label: '11/9', value: 44.8 }], reference: 45, referenceLabel: '45°', format: (v) => `${v.toFixed(1)}°` });
  assert.equal(t.points.length, 2, '沒有數值的那一次不畫點');
  assert.match(t.svg, /平均入框角度/);
  assert.match(t.svg, /44\.8°/);
  assert.ok(!/NaN|undefined/.test(t.svg));
  assert.ok(!/NaN|undefined/.test(trendChart({ title: 'x', points: [] }).svg));
  assert.ok(!/NaN|undefined/.test(trendChart({ title: 'x', points: [{ label: 'a', value: 50 }], domain: [0, 100] }).svg));
});

test('報告圖片：內容完整，姓名裡的特殊字元會跳脫', () => {
  const shots = [44.3, 47.0, 38.9, 52.1, 45.6, 41.2].map((a, i) => ({ angle: a, made: i % 2 === 0 }));
  const r = buildReport({ shots, player: '<b>A&B</b>', date: '2026-11-13', demo: true, truth: shots.map((s) => ({ angleDeg: s.angle, made: s.made })) });
  const { svg, width, height } = reportSvg(r);
  assert.equal(width, 1080);
  assert.ok(height > 1400);
  assert.ok(svg.includes('&lt;b&gt;A&amp;B&lt;/b&gt;'), '姓名要跳脫');
  assert.ok(!svg.includes('<b>A&B</b>'));
  for (const text of ['練投報告', '出手數', '命中率', '平均入框角度', '角度標準差', '每一球的入框角度', '前半和後半', '摘要', '合成示範', '僅供練習參考']) {
    assert.ok(svg.includes(text), `報告圖片要有「${text}」`);
  }
  assert.ok(!/NaN|undefined/.test(svg));
  assert.deepEqual(wrapText('這是一段很長的文字，需要換行。', 20, 100), ['這是一段很', '長的文字，', '需要換行。']);
  assert.ok(Math.abs(textWidth('中a', 10) - 15.6) < 1e-9);
  assert.ok(!/NaN|undefined/.test(reportSvg(buildReport({ shots: [] })).svg));
});

test('CSV：匯出的角度永遠是小數一位，和報告顯示的一樣', () => {
  const { s, plan } = demoSession();
  for (const i of [0, 1, 2, 3]) markShot(s, plan, i);
  const shots = S.reportShots(s);
  const back = parseCsv(shotsToCsv(shots)).shots;
  assert.deepEqual(back, shots.map((x) => ({ angle: x.angle, made: x.made })));
});

// ── 自動模式 ──────────────────────────────────────────────────────────────
import { displayName } from '../../web/js/ui/names.js';
import { makeScene3d, scene3dTruth } from '../../web/js/core/synth3d.js';
import { simulateDetections } from '../../web/js/core/simdetect.js';
import { analyzeAuto } from '../../web/js/core/autoshots.js';
import { readBarcode, drawBarcode } from '../../web/js/demo/scene3d.js';

test('標題列的影片名稱：iPhone 的亂碼檔名換成「影片」加時間，太長的截短', () => {
  const when = new Date(2026, 10, 14, 18, 5);
  assert.equal(displayName({ name: 'IMG_4821.MOV' }, when), '影片 11/14 18:05');
  assert.equal(displayName({ name: '6F9619FF-8B86-D011-B42D-00C04FC964FF.mov' }, when), '影片 11/14 18:05');
  assert.equal(displayName({ name: 'trim.6F2A1C9B.MOV' }), '影片');
  assert.equal(displayName({ name: '1114_A.mp4' }), '1114_A');
  assert.equal(displayName({ name: '一段很長很長很長很長很長很長很長很長很長很長的練投影片名稱.mp4' }).length, 27);
  assert.equal(displayName(null), '影片');
});

test('手動校正：點的位置明顯不合理時提醒（上下排列、高度差很多、點到地板、垂直線歪很多）', () => {
  const s = S.createSession({ mode: 'video', info: { width: 1280, height: 720 } });
  const warn = () => S.calibrationSanity(s).join('｜');
  S.setHoopPoint(s, 'front', { x: 600, y: 300 });
  S.setHoopPoint(s, 'back', { x: 690, y: 302 });
  assert.equal(warn(), '');
  S.setHoopPoint(s, 'back', { x: 610, y: 380 });
  assert.match(warn(), /上下排列/);
  S.setHoopPoint(s, 'back', { x: 690, y: 340 });
  assert.match(warn(), /高度差/);
  S.setHoopPoint(s, 'front', { x: 600, y: 650 });
  S.setHoopPoint(s, 'back', { x: 690, y: 652 });
  assert.match(warn(), /地板/);
  S.setHoopPoint(s, 'front', { x: 600, y: 300 });
  S.setHoopPoint(s, 'back', { x: 690, y: 302 });
  S.setLevel(s, 'vertical');
  S.setHoopPoint(s, 'top', { x: 760, y: 150 });
  S.setHoopPoint(s, 'bottom', { x: 720, y: 330 });
  assert.match(warn(), /歪了 \d+ 度/);
  // hoopWarnings 也會帶出這些提醒
  assert.ok(S.hoopWarnings(s).some((w) => /歪了/.test(w)));
});

test('幀號條碼：畫上去再讀回來（含縮放補邊成模型輸入大小）', () => {
  const W = 1280;
  const H = 720;
  const rgba = new Uint8ClampedArray(W * H * 4).fill(128);
  // 用最簡單的「畫布」：只實作 fillRect 和 fillStyle
  const ctx = {
    fillStyle: '#000',
    save() {},
    restore() {},
    fillRect(x, y, w, h) {
      const v = this.fillStyle === '#fff' ? 255 : 0;
      for (let yy = Math.round(y); yy < Math.round(y + h); yy++) for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
        const p = (yy * W + xx) * 4;
        rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
      }
    },
  };
  drawBarcode(ctx, 777, W, H);
  assert.equal(readBarcode(rgba, W, H, W, H), 777);
  assert.equal(readBarcode(new Uint8ClampedArray(W * H * 4).fill(200), W, H, W, H), null);
});

test('自動分析的結果放進這次練習：角度不因校正改變而重算；C 級的球沒有角度也照樣進報告和 CSV', () => {
  const plan = makeScene3d({ seed: 4, camera: { thetaDeg: -90, dist: 9, camHeight: 1.6, pitchDeg: 3 } });
  const res = analyzeAuto(simulateDetections(plan, { seed: 2 }), { width: plan.width, height: plan.height });
  assert.equal(res.mode, 'count');
  const s = S.createSession({ mode: 'demo', info: { width: plan.width, height: plan.height, perspective: true }, truth: scene3dTruth(plan) });
  S.setAutoResult(s, res.shots.map((x, i) => ({ id: i + 1, source: 'auto', points: [], made: x.made, angle: null, auto: { mode: res.mode, tCross: x.tCross } })), { grade: 'C', mode: 'count' }, res.points);
  const rs = S.reportShots(s);
  assert.equal(rs.length, res.shots.length);
  assert.ok(rs.every((x) => x.angle === null));
  const truth = S.truthForShots(s);
  assert.ok(truth.filter(Boolean).length >= rs.length - 1, '用過框時間對到真實答案');
  const report = buildReport({ shots: rs, truth });
  assert.equal(report.stats.angleMean, null);
  assert.ok(report.stats.attempts >= 9);
  const csv = shotsToCsv(rs);
  assert.match(csv, /^1,,/m);
  assert.deepEqual(parseCsv(csv).shots, rs.map((x) => ({ angle: null, made: x.made })));
  // 校正改了：自動分析的球不重算
  S.setHoopPoint(s, 'front', { x: 100, y: 100 });
  assert.ok(S.reportShots(s).every((x) => x.angle === null));
  // 草稿存起來再還原，自動結果還在
  const d = S.serializeDraft(s);
  const s2 = S.createSession({ mode: 'demo', info: s.info });
  S.restoreDraft(s2, JSON.parse(JSON.stringify(d)));
  assert.equal(s2.shots.length, s.shots.length);
  assert.equal(s2.auto.grade, 'C');
  // 歷次紀錄接受沒有角度的球
  assert.ok(H.normalizeRecord({ id: 'x', shots: [{ angle: null, made: true }, { angle: 44.5, made: false }] }));
});
