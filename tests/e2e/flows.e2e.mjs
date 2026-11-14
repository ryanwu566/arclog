// 整個流程的實測（真的 Chrome、手機尺寸、觸控）：
//   示範模式：校正 → 每球點 5 個球心 → 報告（和真實角度比較）
//   CSV 匯出再匯入、報告圖片、標註包、歷次紀錄的備份與還原
//   放大鏡、兩指縮放、復原、逐幀按鈕
//   本機儲存壞掉時頁面照常運作
//   各個畫面在 360 和 390 寬的手機上沒有水平溢出

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { startServer, launchBrowser, collectErrors, gotoApp, ROOT } from './harness.mjs';

const OUT = join(ROOT, 'data', 'e2e');
mkdirSync(OUT, { recursive: true });
let server;
let browser;

before(async () => {
  server = await startServer();
  browser = await launchBrowser();
});
after(async () => {
  if (browser) await browser.close();
  if (server) await server.stop();
});

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };

async function open(contextOptions = PHONE, path = '/index.html', initScript = null) {
  const context = await browser.newContext(contextOptions);
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await gotoApp(page, server.url + path);
  await page.waitForSelector('#view-home:not([hidden])');
  return { context, page, errors };
}

/** 把畫面捲到影片畫布剛好在頂端列下方，回傳某個影片座標在螢幕上的位置。 */
async function clientOf(page, x, y) {
  return page.evaluate(([px, py]) => {
    const r = document.querySelector('#stage').getBoundingClientRect();
    window.scrollBy(0, r.top - 64);
    return window.__arclog.work.view.toClient(px, py);
  }, [x, y]);
}
async function tapImage(page, x, y) {
  const p = await clientOf(page, x, y);
  // 觸控裝置用手指點；桌面用滑鼠點
  if (page.viewportSize().width < 900) await page.touchscreen.tap(p.x, p.y);
  else await page.mouse.click(p.x, p.y);
}
const gotoFrame = (page, f) => page.evaluate((i) => window.__arclog.work.goto(i), f);
const noOverflow = async (page, what) => {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(m.sw <= m.cw, `${what}：頁面寬 ${m.sw} 超過螢幕寬 ${m.cw}（水平溢出）`);
};
const lastDownload = (page) =>
  page.evaluate(async () => {
    const d = window.__arclogLastDownload;
    if (!d) return null;
    const isText = /json|csv|text/.test(d.type);
    return { filename: d.filename, size: d.size, type: d.type, text: isText ? await d.blob.text() : null };
  });

/** 示範模式：校正（點真實的籃框位置，各偏 1 像素）。 */
async function demoCalibrate(page) {
  await page.click('#home-advanced summary');
  await page.click('#btn-demo');
  await page.waitForSelector('#view-work:not([hidden])');
  const hoop = await page.evaluate(() => window.__arclog.source.hoopTruth);
  await tapImage(page, hoop.front.x + 0.6, hoop.front.y - 0.5);
  await tapImage(page, hoop.back.x - 0.7, hoop.back.y + 0.6);
  return hoop;
}

/** 示範模式：把指定的幾球各點 5 個球心並儲存。 */
async function demoMarkShots(page, indices) {
  await page.selectOption('#auto-advance', '0');
  for (const i of indices) {
    const clicks = await page.evaluate(async (k) => {
      const { simulateClicks } = await import('/js/core/synth.js');
      return simulateClicks(window.__arclog.source.plan, k, { count: 5, noisePx: 1.0, seed: 3 });
    }, i);
    for (const c of clicks) {
      await gotoFrame(page, c.frame);
      await tapImage(page, c.x, c.y);
    }
    assert.equal(await page.isDisabled('#btn-save-shot'), false, `第 ${i + 1} 球點完 5 點應該可以儲存`);
    await page.click('#btn-save-shot');
  }
}

test('示範模式：校正 → 半自動標記 10 球 → 報告，角度誤差 < 1 度', async (t) => {
  const { context, page, errors } = await open();
  await noOverflow(page, '首頁');
  assert.match(await page.textContent('.privacy'), /不會上傳/);

  // ── 校正 ──
  await page.click('#home-advanced summary');
  await page.click('#btn-demo');
  await page.waitForSelector('#view-work:not([hidden])');
  assert.equal(await page.isVisible('#demo-banner'), true, '示範模式要清楚標示');
  assert.match(await page.textContent('#demo-banner'), /合成示範/);
  assert.equal(await page.isDisabled('#cal-done'), true);
  const hoop = await page.evaluate(() => window.__arclog.source.hoopTruth);

  // 逐幀按鈕與時間軸
  await page.tap('[data-jump="1"]');
  await page.waitForFunction(() => window.__arclog.work.index === 1);
  await page.tap('[data-jump="10"]');
  await page.waitForFunction(() => window.__arclog.work.index === 11);
  await page.tap('[data-jump="-1"]');
  await page.waitForFunction(() => window.__arclog.work.index === 10);
  assert.match(await page.textContent('#frame-label'), /第 11 \/ \d+ 幀/);
  await gotoFrame(page, 0);

  // 放大鏡：手指按住時出現，放開後消失
  const cdp = await context.newCDPSession(page);
  const front = await clientOf(page, hoop.front.x + 0.6, hoop.front.y - 0.5);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: front.x + 30, y: front.y + 20, id: 1 }] });
  assert.equal(await page.isVisible('#loupe'), true, '按住時要出現放大鏡');
  // 滑到正確的位置再放開：放開的位置才算數
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: front.x, y: front.y, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  assert.equal(await page.isVisible('#loupe'), false);
  let hp = await page.evaluate(() => window.__arclog.session.hoopPoints);
  assert.ok(Math.hypot(hp.front.x - hoop.front.x, hp.front.y - hoop.front.y) < 2.5, `前緣點到 (${hp.front.x.toFixed(1)}, ${hp.front.y.toFixed(1)})`);
  assert.match(await page.textContent('#cal-next'), /後緣/);

  // 兩指放大，再點後緣：放大後座標仍然正確
  const mid = await clientOf(page, hoop.back.x, hoop.back.y);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mid.x - 20, y: mid.y, id: 1 }, { x: mid.x + 20, y: mid.y, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mid.x - 60, y: mid.y, id: 1 }, { x: mid.x + 60, y: mid.y, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const zoom = await page.evaluate(() => window.__arclog.work.view.zoom);
  assert.ok(zoom > 2.5 && zoom < 3.5, `兩指拉開 3 倍後的縮放倍率是 ${zoom}`);
  hp = await page.evaluate(() => window.__arclog.session.hoopPoints);
  assert.equal(hp.back, null, '兩指縮放不可以被當成點擊');
  await tapImage(page, hoop.back.x - 0.7, hoop.back.y + 0.6);
  hp = await page.evaluate(() => window.__arclog.session.hoopPoints);
  assert.ok(Math.hypot(hp.back.x - hoop.back.x, hp.back.y - hoop.back.y) < 1.6, `放大後後緣點到 (${hp.back.x.toFixed(1)}, ${hp.back.y.toFixed(1)})`);
  await page.tap('#zoom-reset');
  assert.equal(await page.evaluate(() => window.__arclog.work.view.zoom), 1);
  assert.match(await page.textContent('#cal-width'), /6[5-9]|7[0-1] ?像素|像素/);
  await noOverflow(page, '校正');

  // 復原：把後緣拿掉再點回來
  await page.keyboard.press('Control+z');
  hp = await page.evaluate(() => window.__arclog.session.hoopPoints);
  assert.equal(hp.back, null, 'Ctrl+Z 復原上一步');
  await tapImage(page, hoop.back.x - 0.7, hoop.back.y + 0.6);
  assert.equal(await page.isDisabled('#cal-done'), false);
  await page.tap('#cal-done');
  await page.waitForSelector('#panel-mark:not([hidden])');

  // ── 標記 ──
  assert.equal(await page.isDisabled('#btn-save-shot'), true);
  assert.equal(await page.isDisabled('#btn-to-report'), true);
  // 先試「復原」和「清掉這球」
  const probe = await page.evaluate(async () => {
    const { simulateClicks } = await import('/js/core/synth.js');
    return simulateClicks(window.__arclog.source.plan, 0, { count: 5, noisePx: 0, seed: 1 });
  });
  await page.selectOption('#auto-advance', '0');
  await gotoFrame(page, probe[0].frame);
  await tapImage(page, probe[0].x, probe[0].y);
  await gotoFrame(page, probe[1].frame);
  await tapImage(page, probe[1].x, probe[1].y);
  assert.match(await page.textContent('#draft-count'), /已點 2 個/);
  await page.tap('#btn-undo');
  assert.match(await page.textContent('#draft-count'), /已點 1 個/);
  await page.tap('#btn-clear-draft');
  assert.match(await page.textContent('#draft-count'), /還沒有點/);

  // 點完自動前進
  await page.selectOption('#auto-advance', '5');
  await gotoFrame(page, probe[0].frame);
  await tapImage(page, probe[0].x, probe[0].y);
  await page.waitForFunction((f) => window.__arclog.work.index === f + 5, probe[0].frame);
  await page.tap('#btn-clear-draft');

  // 10 球各點 5 個球心
  const nShots = await page.evaluate(() => window.__arclog.source.plan.shots.length);
  await demoMarkShots(page, Array.from({ length: nShots }, (_, i) => i));
  assert.equal(await page.textContent('#shot-count'), String(nShots));
  await noOverflow(page, '標記（已記錄 10 球）');

  // 一鍵改正：把第 1 球改成另一個結果，再改回來
  const before = await page.evaluate(() => window.__arclog.session.shots[0].made);
  await page.locator('#shot-list .shot-row').first().locator('.mini-btn').first().tap();
  assert.equal(await page.evaluate(() => window.__arclog.session.shots[0].made), !before);
  await page.locator('#shot-list .shot-row').first().locator('.mini-btn').first().tap();
  assert.equal(await page.evaluate(() => window.__arclog.session.shots[0].made), before);

  // ── 標註包 ──
  await page.tap('#btn-export-bundle');
  const bundleFile = await lastDownload(page);
  assert.match(bundleFile.filename, /\.arclog\.json$/);
  const bundle = JSON.parse(bundleFile.text);
  const bundleErrors = await page.evaluate(async (b) => (await import('/js/core/bundle.js')).validateBundle(b), bundle);
  assert.deepEqual(bundleErrors, []);
  assert.equal(bundle.synthetic, true);
  assert.equal(bundle.shots.length, nShots);
  assert.equal(bundle.frameTimes.length, bundle.video.frameCount);
  assert.equal(bundle.video.width, 1280);
  assert.ok(Math.abs(bundle.ball.diameterPx - bundle.hoop.pxPerM * 0.24) < 0.01);
  for (const s of bundle.shots) {
    assert.equal(s.frames.filter((f) => f.src === 'manual').length, 5, '每球 5 個手點');
    assert.ok(s.frames.filter((f) => f.src === 'interp').length > 10, '其餘的幀是內插');
    assert.equal(typeof s.made, 'boolean');
  }
  // 標註包裡每一幀的球心都要貼著合成畫面的真實位置
  const worst = await page.evaluate(async (b) => {
    const { ballAt } = await import('/js/core/synth.js');
    const plan = window.__arclog.source.plan;
    let w = 0;
    for (const s of b.shots) for (const f of s.frames) {
      const truth = ballAt(plan, f.t);
      w = Math.max(w, Math.hypot(f.x - truth.x, f.y - truth.y));
    }
    return w;
  }, bundle);
  assert.ok(worst < 4, `標註包裡的球心離真實位置最多 ${worst.toFixed(2)} 像素`);
  writeFileSync(join(OUT, 'demo.arclog.json'), bundleFile.text);

  // ── 報告 ──
  await page.tap('#btn-to-report');
  await page.waitForSelector('#view-report:not([hidden])');
  await noOverflow(page, '報告');
  const report = await page.evaluate(() => window.__arclogReport);
  assert.equal(report.rows.length, nShots);
  const maxErr = Math.max(...report.rows.map((r) => Math.abs(r.error)));
  t.diagnostic(`示範 ${nShots} 球：角度誤差平均 ${report.demoStats.mae.toFixed(2)} 度、最大 ${maxErr.toFixed(2)} 度；進球判定 ${report.demoStats.madeCorrect}/${report.demoStats.madeTotal} 相同；標註包球心最大偏差 ${worst.toFixed(2)} 像素`);
  assert.ok(maxErr < 1.0, `角度誤差最大 ${maxErr.toFixed(2)} 度`);
  assert.equal(report.demoStats.madeCorrect, report.demoStats.madeTotal, '示範的 10 球進球判定都應該和合成畫面一致');
  assert.equal(report.demo, true);
  assert.equal((await page.locator('#report-tiles .tile').count()), 4);
  assert.match(await page.textContent('#report-rows'), /真實角度/);
  assert.match(await page.textContent('#report-rows'), /誤差/);
  assert.match(await page.textContent('#report-demo-note'), /不代表實拍/);
  assert.equal(await page.locator('#report-chart svg circle[fill="#2a78d6"]').count() >= report.stats.makes, true, '進球用藍色實心圓');
  assert.match(await page.textContent('#report-chart'), /45° 參考線/);
  assert.match(await page.textContent('#report-halves'), /前半/);
  const lines = await page.locator('#report-summary p').allTextContents();
  assert.ok(lines.length >= 2 && lines.length <= 3, `摘要 ${lines.length} 句`);
  assert.match(await page.textContent('#report-saved'), /示範的結果不會存進歷次紀錄/);

  // 填姓名和日期
  await page.fill('#report-player', '測試球員');
  await page.fill('#report-date', '2026-11-13');

  // 圖表的提示框
  const pt = await page.evaluate(() => {
    const svg = document.querySelector('#report-chart svg');
    svg.scrollIntoView({ block: 'center' });
    // 第一個藍色圓是圖例，最後一個才是資料點
    const dots = svg.querySelectorAll('circle[fill="#2a78d6"]');
    const c = dots[dots.length - 1].getBoundingClientRect();
    return { x: c.left + c.width / 2, y: c.top + c.height / 2 };
  });
  await page.touchscreen.tap(pt.x, pt.y);
  assert.equal(await page.isVisible('#chart-tip'), true);
  assert.match(await page.textContent('#chart-tip'), /第 \d+ 球/);

  // ── 匯出 CSV ──
  await page.tap('#report-csv');
  const csv = await lastDownload(page);
  assert.match(csv.filename, /^arclog_測試球員_2026-11-13_示範\.csv$/);
  const csvLines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(csvLines[0], '球序,入框角度,是否進球');
  assert.equal(csvLines.length, nShots + 1);
  assert.match(csvLines[1], /^1,\d+\.\d,(是|否)$/);
  writeFileSync(join(OUT, 'demo.csv'), '﻿' + csv.text.replace(/^﻿/, ''));

  // ── 匯出報告圖片 ──
  await page.evaluate(() => { window.__arclogLastDownload = null; navigator.canShare = undefined; });
  await page.tap('#report-image');
  await page.waitForFunction(() => window.__arclogLastDownload && /png/.test(window.__arclogLastDownload.type));
  const png = await page.evaluate(async () => {
    const d = window.__arclogLastDownload;
    const bmp = await createImageBitmap(d.blob);
    return { filename: d.filename, size: d.size, width: bmp.width, height: bmp.height };
  });
  assert.match(png.filename, /\.png$/);
  assert.equal(png.width, 1080);
  assert.ok(png.height > 1500 && png.size > 40000, `報告圖片 ${png.width}x${png.height}、${png.size} 位元組`);

  // ── 回首頁匯入剛剛的 CSV：報告數字相同 ──
  const statsBefore = report.stats;
  await page.tap('#nav-home'); // 報告 → 標記
  await page.waitForSelector('#view-work:not([hidden])');
  await page.tap('#nav-home'); // 標記 → 首頁
  await page.waitForSelector('#view-home:not([hidden])');
  await page.setInputFiles('#file-csv', join(OUT, 'demo.csv'));
  await page.waitForSelector('#view-report:not([hidden])');
  const imported = await page.evaluate(() => window.__arclogReport);
  assert.deepEqual(imported.stats, statsBefore, 'CSV 匯出再匯入後統計完全相同');
  assert.equal(imported.demo, false);
  assert.equal(await page.isVisible('#demo-banner'), false);
  assert.match(await page.textContent('#report-notices'), /匯入的 CSV/);
  assert.match(await page.textContent('#report-saved'), /已經存進這台裝置/);
  await noOverflow(page, '報告（CSV）');

  // ── 歷次紀錄：備份、清除、還原 ──
  await page.tap('#report-history');
  await page.waitForSelector('#view-history:not([hidden])');
  assert.equal(await page.locator('#history-list .session-row').count(), 1, '匯入 CSV 的那次練習已經存進紀錄（示範不會存）');
  await noOverflow(page, '歷次紀錄');
  await page.tap('#history-export');
  const backup = await lastDownload(page);
  assert.match(backup.filename, /備份.*\.json$/);
  const backupData = JSON.parse(backup.text);
  assert.equal(backupData.format, 'arclog-history');
  assert.equal(backupData.sessions.length, 1);
  assert.equal(backupData.sessions[0].shots.length, nShots);
  writeFileSync(join(OUT, 'backup.json'), backup.text);
  await page.tap('#history-clear');
  await page.tap('#dialog-ok');
  await page.waitForFunction(() => document.querySelectorAll('#history-list .session-row').length === 0);
  assert.equal(await page.isVisible('#history-empty'), true);
  await page.setInputFiles('#file-backup', join(OUT, 'backup.json'));
  await page.waitForFunction(() => document.querySelectorAll('#history-list .session-row').length === 1);
  // 重新整理後紀錄還在（真的存進 localStorage）
  await page.reload();
  await page.waitForSelector('#view-home:not([hidden])');
  await page.tap('#btn-history');
  assert.equal(await page.locator('#history-list .session-row').count(), 1);
  // 點進去看那次的報告
  await page.locator('#history-list .session-main').first().tap();
  await page.waitForSelector('#view-report:not([hidden])');
  assert.deepEqual((await page.evaluate(() => window.__arclogReport)).stats, statsBefore);

  assert.deepEqual(errors, [], '頁面不應該有任何錯誤');
  await context.close();
});

test('垂直參考線：依提示點籃框和一條鉛直的邊、可以拖曳調整 → 標 3 球 → 報告；標註包帶著參考線', async (t) => {
  // 用桌面尺寸和滑鼠，點得比較準（手機的觸控操作在上一個測試已經測過）
  const { context, page, errors } = await open({ viewport: { width: 1280, height: 860 } });
  await page.click('#home-advanced summary');
  await page.click('#btn-demo');
  await page.waitForSelector('#view-work:not([hidden])');
  const hoop = await page.evaluate(() => window.__arclog.source.hoopTruth);
  const vt = await page.evaluate(() => window.__arclog.source.verticalTruth);
  await page.check('input[name="level"][value="vertical"]');
  assert.match(await page.textContent('#cal-next'), /前緣/);
  await tapImage(page, hoop.front.x + 0.6, hoop.front.y - 0.5);
  await tapImage(page, hoop.back.x - 0.7, hoop.back.y + 0.6);
  assert.match(await page.textContent('#cal-next'), /垂直參考線的一端/);
  assert.equal(await page.isDisabled('#cal-done'), true, '參考線還沒點，不能進下一步');
  // 先故意把下端點歪 8 像素，再拖回正確的位置
  await tapImage(page, vt.top.x + 0.5, vt.top.y);
  assert.match(await page.textContent('#cal-next'), /另一端/);
  await tapImage(page, vt.bottom.x + 8, vt.bottom.y);
  assert.equal(await page.isDisabled('#cal-done'), false);
  assert.equal(await page.textContent('#cal-tilt-label'), '手機歪斜');
  assert.match(await page.textContent('#cal-tilt'), /依垂直參考線/);
  const skewed = await page.evaluate(() => window.__arclog.session.hoopPoints.bottom);
  const from = await clientOf(page, skewed.x, skewed.y);
  const to = await clientOf(page, vt.bottom.x - 0.4, vt.bottom.y);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
  const hp = await page.evaluate(() => window.__arclog.session.hoopPoints);
  assert.ok(Math.abs(hp.bottom.x - vt.bottom.x) < 2, `下端點拖到 x=${hp.bottom.x.toFixed(1)}（應為 ${vt.bottom.x.toFixed(1)}）`);
  assert.ok(Math.hypot(hp.front.x - hoop.front.x, hp.front.y - hoop.front.y) < 1.5, '拖參考線不會動到籃框的點');
  assert.equal(await page.evaluate(() => window.__arclog.session.level), 'vertical');
  await noOverflow(page, '校正（垂直參考線）');
  await page.click('#cal-done');
  await page.waitForSelector('#panel-mark:not([hidden])');

  await demoMarkShots(page, [0, 1, 2]);
  await page.click('#btn-export-bundle');
  const bundle = JSON.parse((await lastDownload(page)).text);
  assert.deepEqual(await page.evaluate(async (b) => (await import('/js/core/bundle.js')).validateBundle(b), bundle), []);
  assert.equal(bundle.hoop.level, 'vertical');
  assert.ok(Math.abs(bundle.hoop.vertical.top.x - vt.top.x) < 2 && Math.abs(bundle.hoop.vertical.bottom.x - vt.bottom.x) < 2);
  assert.ok(Math.abs(bundle.hoop.vertDeg) < 1, `合成畫面沒有歪，參考線換算的歪斜 ${bundle.hoop.vertDeg} 度只來自點擊誤差`);

  await page.click('#btn-to-report');
  await page.waitForSelector('#view-report:not([hidden])');
  const report = await page.evaluate(() => window.__arclogReport);
  assert.equal(report.rows.length, 3);
  const maxErr = Math.max(...report.rows.map((r) => Math.abs(r.error)));
  t.diagnostic(`垂直參考線基準，示範 3 球：角度誤差最大 ${maxErr.toFixed(2)} 度`);
  assert.ok(maxErr < 1.0, `角度誤差最大 ${maxErr.toFixed(2)} 度`);

  // 回到校正改成其他基準：不需要參考線，可以直接進標記
  await page.click('#nav-home'); // 報告 → 標記
  await page.waitForSelector('#panel-mark:not([hidden])');
  await page.click('.step[data-step="calibrate"]');
  await page.check('input[name="level"][value="persp"]');
  assert.match(await page.textContent('#cal-next'), /都點好了/);
  assert.equal(await page.isDisabled('#cal-done'), false);
  assert.deepEqual(errors, [], '頁面不應該有任何錯誤');
  await context.close();
});

test('歷次紀錄：兩次以上會畫出趨勢圖；壞掉的備份檔不會弄壞頁面', async () => {
  const { context, page, errors } = await open();
  const mk = (id, date, player, angles) => ({ id, savedAt: `${date}T10:00:00.000Z`, date, player, note: '', videoName: '', source: 'manual', shots: angles.map((a, i) => ({ angle: a, made: i % 2 === 0 })) });
  const data = {
    format: 'arclog-history', version: 1, exportedAt: '2026-11-13T00:00:00.000Z',
    sessions: [mk('a', '2026-11-01', '甲', [42, 43, 44, 41]), mk('b', '2026-11-05', '甲', [44, 45, 46, 44]), mk('c', '2026-11-09', '乙', [47, 48, 46, 49]), { id: 'bad', shots: 'nope' }],
  };
  writeFileSync(join(OUT, 'history3.json'), JSON.stringify(data));
  writeFileSync(join(OUT, 'notjson.json'), '{ this is not json');
  writeFileSync(join(OUT, 'other.json'), JSON.stringify({ hello: 'world' }));
  await page.tap('#btn-history');
  await page.setInputFiles('#file-backup', join(OUT, 'notjson.json'));
  await page.waitForFunction(() => /不是 JSON/.test(document.querySelector('#toast').textContent));
  await page.setInputFiles('#file-backup', join(OUT, 'other.json'));
  await page.waitForFunction(() => /不是 ArcLog 的備份檔/.test(document.querySelector('#toast').textContent));
  await page.setInputFiles('#file-backup', join(OUT, 'history3.json'));
  await page.waitForFunction(() => document.querySelectorAll('#history-list .session-row').length === 3);
  assert.match(await page.textContent('#toast'), /新增 3 次.*略過 1 筆/);
  assert.equal(await page.locator('#history-trends svg').count(), 2, '命中率和平均角度各一張趨勢圖');
  await noOverflow(page, '歷次紀錄（有趨勢圖）');
  // 依球員篩選
  await page.selectOption('#history-player', 'p:甲');
  assert.equal(await page.locator('#history-list .session-row').count(), 2);
  await page.selectOption('#history-player', 'p:乙');
  assert.equal(await page.locator('#history-list .session-row').count(), 1);
  assert.equal(await page.locator('#history-trends svg').count(), 0, '只有一次紀錄時不畫趨勢圖');
  // 刪除一筆
  await page.locator('#history-list .session-row .mini-btn').first().tap();
  await page.tap('#dialog-ok');
  await page.waitForFunction(() => document.querySelector('#history-player').value === '');
  assert.equal(await page.locator('#history-list .session-row').count(), 2);
  assert.deepEqual(errors, []);
  await context.close();
});

test('CSV 匯入：格式不對時說明原因，不會卡住', async () => {
  const { context, page, errors } = await open();
  writeFileSync(join(OUT, 'bad.csv'), 'hello,world\nfoo,bar\n');
  writeFileSync(join(OUT, 'partial.csv'), '球序,入框角度,是否進球\n1,44.5,是\n2,abc,否\n3,47.2,否\n4,43.1,是\n5,46.0,是\n');
  await page.setInputFiles('#file-csv', join(OUT, 'bad.csv'));
  await page.waitForSelector('#home-error:not([hidden])');
  assert.match(await page.textContent('#home-error'), /沒有可以用的資料/);
  assert.equal(await page.isVisible('#view-home'), true);
  await page.setInputFiles('#file-csv', join(OUT, 'partial.csv'));
  await page.waitForSelector('#view-report:not([hidden])');
  const r = await page.evaluate(() => window.__arclogReport);
  assert.equal(r.stats.attempts, 4);
  assert.match(await page.textContent('#report-notices'), /有 1 列沒有匯入/);
  assert.equal(await page.isVisible('#report-bundle'), false, '匯入的 CSV 沒有標記資料，不能匯出標註包');
  assert.deepEqual(errors, []);
  await context.close();
});

test('本機儲存寫不進去（空間滿了）：頁面照常運作，並告訴使用者', async () => {
  const { context, page, errors } = await open(PHONE, '/index.html', () => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (String(key).startsWith('__arclog_probe')) return real.call(this, key, value);
      throw new DOMException('quota', 'QuotaExceededError');
    };
  });
  await page.setInputFiles('#file-csv', join(OUT, 'partial.csv'));
  await page.waitForSelector('#view-report:not([hidden])');
  assert.match(await page.textContent('#report-saved'), /存不進這台裝置/);
  await page.tap('#report-history');
  await page.waitForSelector('#view-history:not([hidden])');
  assert.equal(await page.locator('#history-list .session-row').count(), 1, '雖然存不進去，這次開著的時候還是看得到');
  assert.deepEqual(errors, []);
  await context.close();
});

test('瀏覽器完全不給用 localStorage（例如擋掉 Cookie）：頁面照常運作', async () => {
  const { context, page, errors } = await open(PHONE, '/index.html', () => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
  });
  await page.setInputFiles('#file-csv', join(OUT, 'partial.csv'));
  await page.waitForSelector('#view-report:not([hidden])');
  assert.match(await page.textContent('#report-saved'), /不能保存資料/);
  await page.tap('#report-history');
  assert.match(await page.textContent('#history-notices'), /不能保存資料/);
  // 示範模式也照常可以用
  await page.tap('#nav-home');
  await demoCalibrate(page);
  await page.tap('#cal-done');
  await demoMarkShots(page, [0]);
  assert.equal(await page.textContent('#shot-count'), '1');
  assert.deepEqual(errors, []);
  await context.close();
});

test('存檔內容損壞：略過壞掉的資料，頁面照常運作', async () => {
  const { context, page, errors } = await open(PHONE, '/index.html', () => {
    try {
      localStorage.setItem('arclog.history.v1', '{{{ broken');
      localStorage.setItem('arclog.draft.v1', 'also broken');
    } catch {
      /* 沒關係 */
    }
  });
  await page.tap('#btn-history');
  await page.waitForSelector('#view-history:not([hidden])');
  assert.match(await page.textContent('#history-notices'), /讀不出來/);
  assert.equal(await page.locator('#history-list .session-row').count(), 0);
  await page.tap('#nav-home');
  await demoCalibrate(page);
  assert.equal(await page.isDisabled('#cal-done'), false);
  assert.deepEqual(errors, []);
  await context.close();
});

for (const size of [{ width: 360, height: 740 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
  test(`版面：${size.width}×${size.height} 各畫面沒有水平溢出，按鈕夠大`, async () => {
    const touch = size.width < 900;
    const { context, page, errors } = await open({ viewport: size, deviceScaleFactor: touch ? 2 : 1, hasTouch: touch, isMobile: touch });
    await noOverflow(page, '首頁');
    await page.locator('details.card summary').first().click();
    await noOverflow(page, '首頁（展開拍攝說明）');
    await demoCalibrate(page);
    await noOverflow(page, '校正');
    await page.click('#cal-done');
    await demoMarkShots(page, [0, 1, 2, 3]);
    await noOverflow(page, '標記');
    // 影片畫面完整地在螢幕裡，而且長寬比正確
    const stage = await page.evaluate(() => {
      const r = document.querySelector('#stage').getBoundingClientRect();
      return { w: r.width, h: r.height, vw: window.innerWidth };
    });
    assert.ok(stage.w <= stage.vw + 0.5 && stage.w > 200, `影片畫面寬 ${stage.w}`);
    assert.ok(Math.abs(stage.w / stage.h - 1280 / 720) < 0.03, `影片畫面的長寬比 ${(stage.w / stage.h).toFixed(3)}`);
    // 主要按鈕的觸控範圍至少 40 像素高
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('#view-work button:not([hidden]), #view-work select, #view-work label.btn')]
        .filter((b) => b.offsetParent !== null)
        .map((b) => ({ text: (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 12), h: b.getBoundingClientRect().height }))
        .filter((b) => b.h < 36),
    );
    assert.deepEqual(small, [], '有按鈕太小不好按');
    await page.click('#btn-auto');
    await page.waitForSelector('#view-auto:not([hidden])');
    await noOverflow(page, '自動偵測');
    await page.click('#auto-back');
    await page.click('#btn-to-report');
    await page.waitForSelector('#view-report:not([hidden])');
    await noOverflow(page, '報告');
    const chart = await page.evaluate(() => {
      const r = document.querySelector('#report-chart svg').getBoundingClientRect();
      return { w: r.width, vw: window.innerWidth };
    });
    assert.ok(chart.w <= chart.vw, '圖表沒有超出螢幕');
    await page.click('#report-history');
    await noOverflow(page, '歷次紀錄');
    assert.deepEqual(errors, []);
    await context.close();
  });
}
