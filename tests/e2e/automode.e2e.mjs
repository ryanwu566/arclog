// 自動模式的瀏覽器實測（真的 Chrome）：
//   示範（3D 合成畫面＋模擬偵測器）：側面、斜 45 度、投籃者正後方，背景有別人投籃 → 直接出報告，和真實答案比較
//   報告：結論在最上面、鏡頭角度等級的說明、每一球點開看疊圖、修正（改進球與否、重新標點）
//   示範錄影（不開相機）、真的相機路徑（Chrome 的假相機播合成畫面）：手機尺寸跑完「開始練投 → 停止 → 報告」
//   錄影存在 IndexedDB：分析沒做完時首頁看得到、可以下載
//   上傳影片＋真的模型（COCO，沒有籃框類別）：請使用者點兩下籃框 → 自動偵測 → 報告
//
// 模擬偵測器不是偵測模型：這些測試只證明流程和邏輯在已知答案下運作，不代表實拍準確度。
// 假相機只在 Chrome 測得到；iPhone Safari 的相機、錄影、背景限制沒有實機測過（docs/NEXT_STEPS.md）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { startServer, launchBrowser, collectErrors, gotoApp, ROOT } from './harness.mjs';
import { makeCameraFeed, makeSceneMp4 } from '../make_camera_feed.mjs';
import { rimClickTruth } from '../../web/js/core/synth3d.js';

// 假相機的影片：路徑不能有中文（Chrome 讀不到），所以放在 repo 裡被 .gitignore 擋掉的 data/
const FEED_DIR = join(ROOT, 'data', 'e2e-feed');
const FEED = join(FEED_DIR, 'feed_t0_bg_640x360.y4m');
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

let server;
let browser;
let camBrowser;
let upload = null;

before(async () => {
  mkdirSync(FEED_DIR, { recursive: true });
  if (!existsSync(FEED)) makeCameraFeed({ out: FEED_DIR, theta: 0, background: true, width: 640, height: 360 });
  if (HAS_FFMPEG) upload = await makeSceneMp4({ out: FEED_DIR, name: 'upload_t0.mp4', theta: 0, script: ['swish', 'short', 'swish', 'rimout', 'swish', 'swish'] });
  server = await startServer();
  browser = await launchBrowser(['--enable-unsafe-webgpu']);
  camBrowser = await launchBrowser(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${FEED.replace(/\\/g, '/')}`]);
});
after(async () => {
  if (browser) await browser.close();
  if (camBrowser) await camBrowser.close();
  if (server) await server.stop();
});

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const PHONE_LAND = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function demoReport(view, opts = {}) {
  const context = await browser.newContext(opts.ctx || PHONE);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await gotoApp(page, server.url + '/index.html');
  await page.click('#demo-options summary');
  await page.selectOption('#demo-view', view);
  if (opts.background === false) await page.uncheck('#demo-background');
  await page.click('#btn-demo-auto');
  await page.waitForSelector('#view-report:not([hidden]), #analyze-error:not([hidden])', { timeout: 180000 });
  return { context, page, errors };
}

const summary = (page) =>
  page.evaluate(() => {
    const r = window.__arclogReport;
    return {
      view: window.__arclog.view,
      rows: r.rows.length,
      demo: r.demoStats,
      angles: r.rows.map((x) => x.angle),
      grade: document.querySelector('#report-grade') && document.querySelector('#report-grade').dataset.grade,
      notice: document.querySelector('#report-view-notice').innerText,
      conclusion: document.querySelector('#report-conclusion').innerText,
      truthShots: window.__arclog.session.truth.length,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });

test('示範（側面、背景有別人投籃）：不用點籃框、不用標記，直接出報告；進球判定和角度對得上真實答案', async () => {
  const { context, page, errors } = await demoReport('side');
  const s = await summary(page);
  assert.equal(s.view, 'report');
  assert.equal(s.rows, s.truthShots, '每一球都找到，沒有多抓（背景別人的球不算）');
  assert.ok(s.demo.madeCorrect >= s.demo.madeTotal - 1, `進球判定 ${s.demo.madeCorrect}/${s.demo.madeTotal}`);
  assert.ok(s.demo.mae < 1, `角度平均誤差 ${s.demo.mae}`);
  assert.equal(s.grade, 'A');
  assert.match(s.conclusion, /命中率/);
  assert.match(s.conclusion, /平均入框角度/);
  assert.match(s.conclusion, /穩定度/);
  assert.match(s.conclusion, /前半 → 後半/);
  assert.match(s.notice, /模擬偵測器/, '示範要說明偵測是模擬的');
  assert.equal(s.overflow, false, '手機寬度沒有水平溢出');
  // 標題列：ArcLog 不換行
  const brand = await page.evaluate(() => {
    const b = document.querySelector('.brand-name').getBoundingClientRect();
    return { h: b.height, lh: parseFloat(getComputedStyle(document.querySelector('.brand-name')).lineHeight) || 30 };
  });
  assert.ok(brand.h < brand.lh * 1.5, `ArcLog 被擠成兩行（高 ${brand.h}）`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('報告：每一球點開看疊圖；改進球與否；重新標點（修正）會帶到手動標記畫面', async () => {
  const { context, page, errors } = await demoReport('side', { background: false });
  const before = await page.evaluate(() => window.__arclogReport.stats.makes);
  await page.click('#report-shot-cards li:nth-child(1) .shot-row');
  await page.waitForSelector('#report-shot-cards .shot-detail canvas');
  // 疊圖真的畫了東西（不是全黑）
  await page.waitForTimeout(500);
  const lit = await page.evaluate(() => {
    const c = document.querySelector('#report-shot-cards .shot-detail canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let bright = 0;
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 300) bright++;
    return bright;
  });
  assert.ok(lit > 50, '疊圖是空的');
  const firstMade = await page.evaluate(() => window.__arclogReport.rows[0].made);
  await page.click(`#report-shot-cards .shot-detail button:has-text("${firstMade ? '改成沒進' : '改成進球'}")`);
  const after = await page.evaluate(() => window.__arclogReport.stats.makes);
  assert.equal(after, before + (firstMade ? -1 : 1));
  // 重新標點（改完進球與否，那一球還是展開的）
  await page.click('#report-shot-cards .shot-detail button:has-text("修正")');
  await page.waitForSelector('#view-work:not([hidden]) #panel-mark:not([hidden])');
  const draft = await page.evaluate(() => window.__arclog.session.draft.length);
  assert.ok(draft >= 4, `修正時要把那一球的點放回畫面（${draft} 點）`);
  assert.deepEqual(errors, []);
  await context.close();
});

test('示範（斜後方約 45 度）：B 級，報告標示誤差較大', async () => {
  const { context, page, errors } = await demoReport('oblique');
  const s = await summary(page);
  assert.equal(s.grade, 'B');
  assert.match(s.notice, /誤差較大/);
  assert.match(s.conclusion, /誤差較大/);
  assert.ok(s.rows >= s.truthShots - 1);
  assert.ok(s.demo.madeCorrect >= s.demo.madeTotal - 1);
  assert.deepEqual(errors, []);
  await context.close();
});

test('示範（投籃者正後方）：C 級，只給出手數和命中率，入框角度不顯示；CSV 的角度欄留空', async () => {
  const { context, page, errors } = await demoReport('behind');
  const s = await summary(page);
  assert.equal(s.grade, 'C');
  assert.match(s.notice, /量不到入框角度/);
  assert.ok(s.angles.every((a) => a === null), '不可以有任何角度數字');
  assert.ok(s.rows >= s.truthShots - 1 && s.rows <= s.truthShots + 1, `出手數 ${s.rows}／${s.truthShots}`);
  assert.ok(s.demo.madeCorrect >= s.demo.madeTotal - 2, `進球判定 ${s.demo.madeCorrect}/${s.demo.madeTotal}`);
  assert.equal(await page.isVisible('#report-chart'), false, '沒有角度就不畫角度圖');
  assert.doesNotMatch(s.conclusion, /\d+\.\d°/);
  await page.evaluate(() => (window.__arclogLastDownload = null));
  await page.click('#report-csv');
  await page.waitForFunction(() => window.__arclogLastDownload);
  const csv = await page.evaluate(() => window.__arclogLastDownload.blob.text());
  assert.match(csv, /^1,,(是|否)/m, 'C 級的角度欄要留空');
  assert.deepEqual(errors, []);
  await context.close();
});

test('示範錄影（手機橫拿的尺寸，不開相機）：預檢通過 → 開始錄 → 停止 → 報告', async () => {
  const context = await browser.newContext(PHONE_LAND);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await gotoApp(page, server.url + '/index.html');
  await page.click('#demo-options summary');
  await page.click('#btn-demo-capture');
  await page.waitForSelector('#capture-start:not([disabled])', { timeout: 60000 });
  // 「開始錄」只要找到籃框就能按；鏡頭角度的推算每 2 秒做一次，等它出來
  await page.waitForFunction(() => document.querySelector('#chk-angle').dataset.state !== 'wait', null, { timeout: 15000 });
  const checks = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#capture-checks li')].map((l) => [l.id, l.dataset.state])));
  assert.deepEqual(checks, { 'chk-camera': 'ok', 'chk-model': 'ok', 'chk-hoop': 'ok', 'chk-angle': 'ok' });
  // 停止鍵不用捲動就看得到
  await page.click('#capture-start');
  const box = await page.locator('#capture-stop').boundingBox();
  assert.ok(box && box.y + box.height <= 390, '停止鍵要在畫面裡');
  await page.waitForTimeout(13000);
  await page.click('#capture-stop');
  await page.waitForSelector('#view-report:not([hidden])', { timeout: 120000 });
  const s = await summary(page);
  assert.ok(s.rows >= 3, `錄了 13 秒應該有 3 球以上（${s.rows}）`);
  assert.equal(s.grade, 'A');
  assert.deepEqual(errors, []);
  await context.close();
});

test('真的相機路徑（Chrome 假相機播合成畫面，iPhone 直拿尺寸）：開始練投 → 開始錄 → 停止 → 報告；錄影存在這台裝置', async () => {
  const context = await camBrowser.newContext(PHONE);
  await context.grantPermissions(['camera']);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await gotoApp(page, server.url + '/index.html?fakecam=theta:0,bg:1,w:640,h:360,seed:7');
  await page.click('#btn-capture');
  await page.waitForSelector('#capture-start:not([disabled])', { timeout: 60000 });
  await page.click('#capture-start');
  await page.waitForTimeout(14000);
  await page.click('#capture-stop');
  await page.waitForSelector('#view-report:not([hidden])', { timeout: 120000 });
  const s = await summary(page);
  assert.ok(s.rows >= 3, `錄了 14 秒應該有 3 球以上（${s.rows}）`);
  assert.ok(s.demo.madeCorrect >= s.demo.madeTotal - 1, `進球判定 ${s.demo.madeCorrect}/${s.demo.madeTotal}`);
  assert.ok(s.demo.mae < 1.2, `角度平均誤差 ${s.demo.mae}`);
  const rec = await page.evaluate(async () => {
    const m = await import('./js/ui/recstore.js');
    const list = await m.listRecordings();
    const r = list[0];
    const got = await m.getRecordingBlob(r.id);
    return { n: list.length, status: r.status, bytes: got.blob.size, mime: r.mime };
  });
  assert.equal(rec.status, 'done');
  assert.ok(rec.bytes > 50000, `錄下來的影片太小（${rec.bytes} bytes）`);
  // 報告裡的疊圖用的是錄好的影片
  assert.ok(await page.evaluate(() => window.__arclog.source.frameCount > 100));
  assert.deepEqual(errors, []);
  await context.close();
});

test('分析沒做完的錄影不會丟：首頁提示，可以下載、可以刪除', async () => {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const errors = collectErrors(page);
  await gotoApp(page, server.url + '/index.html');
  // 模擬「錄完、分析途中頁面當掉」：IndexedDB 裡有一段狀態還是 recorded 的錄影
  await page.evaluate(async () => {
    const m = await import('./js/ui/recstore.js');
    const id = await m.createRecording({ mime: 'video/webm' });
    await m.appendChunk(id, 0, new Blob([new Uint8Array(1000).fill(7)], { type: 'video/webm' }));
    await m.appendChunk(id, 1, new Blob([new Uint8Array(500).fill(9)], { type: 'video/webm' }));
    await m.updateRecording(id, { status: 'recorded', seconds: 12 });
  });
  await page.reload();
  await page.waitForFunction(() => !!window.__arclog);
  await page.waitForSelector('#home-pending:not([hidden])');
  assert.match(await page.textContent('#home-pending'), /還沒分析完/);
  await page.evaluate(() => (window.__arclogLastDownload = null));
  await page.click('#home-pending button:has-text("下載影片")');
  await page.waitForFunction(() => window.__arclogLastDownload);
  const size = await page.evaluate(() => window.__arclogLastDownload.size);
  assert.equal(size, 1500, '下載的影片要是完整的兩段');
  await page.click('#home-pending button:has-text("刪除")');
  await page.waitForSelector('#home-pending', { state: 'hidden' });
  assert.deepEqual(errors, []);
  await context.close();
});

test('上傳影片＋真的模型（COCO，沒有籃框類別）：請使用者點兩下籃框，之後自動偵測、出報告', { skip: !HAS_FFMPEG && '這台電腦沒有 ffmpeg，做不出測試影片' }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await gotoApp(page, server.url + '/index.html');
  await page.setInputFiles('#file-video', upload.file);
  await page.waitForSelector('#view-work:not([hidden]) #panel-calibrate:not([hidden])', { timeout: 120000 });
  assert.match(await page.textContent('#work-warnings'), /還不會自動找籃框/);
  assert.equal(await page.textContent('#cal-done'), '繼續自動分析');
  const c = rimClickTruth(upload.plan);
  for (const p of [c.left, c.right]) {
    const q = await page.evaluate(([x, y]) => window.__arclog.work.view.toClient(x, y), [p.x, p.y]);
    await page.mouse.click(q.x, q.y);
  }
  await page.click('#cal-done');
  await page.waitForSelector('#view-report:not([hidden]), #analyze-error:not([hidden])', { timeout: 600000 });
  const out = await page.evaluate(() => ({
    view: window.__arclog.view,
    error: document.querySelector('#analyze-error').innerText,
    rows: window.__arclogReport ? window.__arclogReport.rows.length : 0,
    auto: window.__arclog.session.auto,
    run: window.__arclog.session.autoRun,
  }));
  // 真的模型（COCO 的 sports ball）在合成畫面上不一定每球都找得到；這裡要求的是流程走得完、
  // 找到的球數合理，並且說明籃框是使用者點的
  assert.equal(out.view, 'report', `沒有出報告：${out.error}`);
  assert.ok(out.rows >= 3 && out.rows <= 6, `找到 ${out.rows} 球（影片裡有 6 球）`);
  assert.equal(out.auto.hoopFromTaps, true);
  assert.match(await page.textContent('#report-view-notice'), /籃框位置是你點的/);
  assert.notEqual(out.run.backend, 'simulated');
  assert.deepEqual(errors, []);
  await context.close();
});
