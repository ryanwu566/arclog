// 真的影片檔（H.264 MP4）走完整流程，並把瀏覽器匯出的標註包交給 Python 的訓練工具：
//
//   1. 產生一支合成影片和它的真值（training/make_synth.py）
//   2. 瀏覽器：載入 MP4 → 校正 → 逐球點球心 → 標「沒有球」的片段 → 匯出標註包 → 報告
//   3. Python：build_dataset.py 用時間戳把標註對到解出來的幀 → check_overlay.py 和真值比較
//      （標註的球心和真正的球心平均差不到 3 像素，代表瀏覽器和 Python 看到的是同一幀）
//   4. 重新整理後再載入同一個檔案 → 可以接續上次的標記
//   5. 網站的自動偵測（讀真的影片檔）和 tools/analyze.py 的結果一致；analyze.py 的 CSV 可以匯入網站
//
// 需要 Python 環境裡有 numpy、av、pillow、onnxruntime（requirements.txt），以及 npm install。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { startServer, launchBrowser, collectErrors, gotoApp, runPython, ROOT } from './harness.mjs';

const OUT = join(ROOT, 'data', 'e2e', 'video');
const SRC = join(OUT, 'src');
const NAME = 'synth_01';
const MP4 = join(SRC, `${NAME}.mp4`);
let server;
let browser;
let truth;
let bundlePath;
let hoopUsed;

before(async () => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  const gen = await runPython(['training/make_synth.py', '--out', SRC, '--videos', '1', '--shots', '4', '--small', '--seed', '7']);
  assert.equal(gen.code, 0, `make_synth.py 失敗：\n${gen.output}`);
  truth = JSON.parse(readFileSync(join(SRC, `${NAME}.truth.json`), 'utf8'));
  server = await startServer();
  browser = await launchBrowser(['--enable-unsafe-webgpu', '--enable-features=Vulkan']);
});
after(async () => {
  if (browser) await browser.close();
  if (server) await server.stop();
});

async function openWithVideo() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = collectErrors(page);
  await gotoApp(page, server.url + '/index.html');
  await page.setInputFiles('#file-video', MP4);
  return { context, page, errors };
}

async function tapImage(page, x, y) {
  const p = await page.evaluate(([px, py]) => {
    const r = document.querySelector('#stage').getBoundingClientRect();
    window.scrollBy(0, r.top - 64);
    return window.__arclog.work.view.toClient(px, py);
  }, [x, y]);
  await page.mouse.click(p.x, p.y);
}
const gotoFrame = (page, f) => page.evaluate((i) => window.__arclog.work.goto(i), f);

/** 校正：點真值的籃框位置；合成畫面沒有透視，所以把水平基準改成「籃框連線，不修正」。 */
async function calibrate(page) {
  await page.waitForSelector('#view-work:not([hidden])', { timeout: 60000 });
  assert.equal(await page.isChecked('input[name="level"][value="persp"]'), true, '實拍影片預設的水平基準應該是「修正透視」');
  await tapImage(page, truth.hoop.front.x, truth.hoop.front.y);
  await tapImage(page, truth.hoop.back.x, truth.hoop.back.y);
  await page.check('input[name="level"][value="rim"]');
  await page.click('#cal-done');
  await page.waitForSelector('#panel-mark:not([hidden])');
}

/** 這一球飛行途中、過框之前，平均挑 count 幀。 */
function flightFrames(shot, count) {
  const last = Math.floor(shot.tCross * truth.fps) - 1;
  const frames = [];
  for (let f = shot.fRelease + 1; f <= last; f++) {
    const b = truth.balls[f];
    if (b && b.phase === 'flight' && !b.partial) frames.push(f);
  }
  const out = [];
  for (let i = 0; i < count; i++) out.push(frames[Math.floor(((i + 0.5) * frames.length) / count)]);
  return [...new Set(out)];
}

test('真的 MP4：校正、逐球標記、標「沒有球」、匯出標註包；Python 用時間戳對齊後，標註落在真正的球上', async (t) => {
  const { context, page, errors } = await openWithVideo();
  await calibrate(page);

  const info = await page.evaluate(() => ({ ...window.__arclog.session.info, frames: window.__arclog.source.frameCount }));
  t.diagnostic(`影片 ${info.width}×${info.height}、${info.frames} 幀、引擎 ${info.engine}、時間戳來源 ${info.timeSource}`);
  assert.equal(info.engine, 'codec', '應該用 WebCodecs 引擎讀這支 H.264 影片');
  assert.equal(info.timeSource, 'container');
  assert.equal(info.width, truth.width);
  assert.equal(info.height, truth.height);
  assert.equal(info.frames, truth.frameCount, '瀏覽器看到的幀數應該和產生影片時寫入的一樣');

  // 逐球：點 5 個球心（各偏不到 1 像素），依真值設定進球與否，儲存
  await page.selectOption('#auto-advance', '0');
  for (const [i, shot] of truth.shots.entries()) {
    for (const [k, f] of flightFrames(shot, 5).entries()) {
      await gotoFrame(page, f);
      const b = truth.balls[f];
      await tapImage(page, b.x + (k % 2 ? 0.6 : -0.5), b.y + (k % 3 ? -0.4 : 0.7));
    }
    assert.equal(await page.isDisabled('#btn-save-shot'), false, `第 ${i + 1} 球點完應該可以儲存`);
    await page.click(`#draft-box .made-btn[data-made="${shot.made ? 1 : 0}"]`);
    await page.click('#btn-save-shot');
  }
  assert.equal(await page.textContent('#shot-count'), String(truth.shots.length));

  // 標一段「畫面上沒有球」
  let a = truth.balls.findIndex((b, f) => b === null && truth.balls.slice(f, f + 6).every((x) => x === null));
  assert.ok(a >= 0, '合成影片裡應該有一段沒有球');
  await page.click('summary:has-text("訓練資料用")');
  await gotoFrame(page, a);
  await page.click('#noball-start');
  await gotoFrame(page, a + 5);
  await page.click('#noball-end');

  // 匯出標註包
  await page.evaluate(() => { window.__arclogLastDownload = null; });
  await page.click('#btn-export-bundle');
  await page.waitForFunction(() => window.__arclogLastDownload && /json/.test(window.__arclogLastDownload.type));
  const text = await page.evaluate(() => window.__arclogLastDownload.blob.text());
  const bundle = JSON.parse(text);
  assert.equal(bundle.format, 'arclog-annotations');
  assert.equal(bundle.video.name, `${NAME}.mp4`);
  assert.equal(bundle.frameTimes.length, truth.frameCount);
  assert.equal(bundle.hoop.level, 'rim');
  assert.equal(bundle.shots.length, truth.shots.length);
  assert.deepEqual(bundle.noBall, [{ from: a, to: a + 5 }]);
  assert.ok(Math.abs(bundle.ball.diameterPx - truth.ballDiameterPx) < 1.5, `球直徑 ${bundle.ball.diameterPx} vs ${truth.ballDiameterPx}`);
  for (const [i, s] of bundle.shots.entries()) {
    assert.equal(s.made, truth.shots[i].made);
    assert.ok(s.frames.some((f) => f.src === 'manual') && s.frames.some((f) => f.src === 'interp'), '每一球應該有手點和內插的幀');
    assert.ok(Math.abs(s.angleDeg - truth.shots[i].angleDeg) < 1, `第 ${i + 1} 球角度 ${s.angleDeg} vs 真值 ${truth.shots[i].angleDeg.toFixed(2)}`);
  }
  bundlePath = join(OUT, `${NAME}.arclog.json`);
  writeFileSync(bundlePath, text);
  hoopUsed = bundle.hoop;

  // 報告
  await page.click('#btn-to-report');
  await page.waitForSelector('#view-report:not([hidden])');
  const rows = await page.evaluate(() => window.__arclogReport.rows.map((r) => ({ angle: r.angle, made: r.made })));
  assert.equal(rows.length, truth.shots.length);
  const errs = rows.map((r, i) => Math.abs(r.angle - truth.shots[i].angleDeg));
  t.diagnostic(`報告：${rows.length} 球，角度誤差最大 ${Math.max(...errs).toFixed(2)} 度`);
  assert.ok(Math.max(...errs) < 1);
  assert.match(await page.textContent('#report-cli-cmd'), /--level rim/);
  assert.deepEqual(errors, [], `頁面上不應該有錯誤：${errors.join('\n')}`);
  await context.close();

  // ── Python：用時間戳對齊，抽出畫面，和真值比較 ──
  const ds = join(OUT, 'dataset');
  const build = await runPython(['training/build_dataset.py', '--pair', MP4, bundlePath, '--out', ds, '--clean']);
  assert.equal(build.code, 0, `build_dataset.py 失敗：\n${build.output}`);
  assert.match(build.output, /幀號直接對應/, build.output);
  const manifest = JSON.parse(readFileSync(join(ds, 'manifest.json'), 'utf8'));
  const positives = manifest.images.filter((im) => im.boxes > 0).length;
  const negatives = manifest.images.filter((im) => im.boxes === 0).length;
  assert.ok(positives >= truth.shots.length * 10, `有球的畫面 ${positives} 張`);
  assert.ok(negatives >= 1 && negatives <= 6, `沒有球的畫面 ${negatives} 張`);
  const check = await runPython(['training/check_overlay.py', '--dataset', ds, '--truth', SRC, '--max-error', '3']);
  assert.equal(check.code, 0, `check_overlay.py 發現標註和畫面沒有對齊：\n${check.output}`);
  const m = /平均差 ([\d.]+) 像素、中位數 ([\d.]+)、最大 ([\d.]+)/.exec(check.output);
  assert.ok(m, check.output);
  t.diagnostic(`瀏覽器標註 → Python 抽幀：${positives} 張有球的畫面，標註和真值平均差 ${m[1]} 像素（最大 ${m[3]}）；${negatives} 張負樣本確實沒有球`);
  assert.match(check.output, /每一張都確實沒有球/);
  assert.ok(existsSync(join(ds, 'overlay_check.jpg')));
});

test('重新整理後載入同一個檔案：詢問要不要接續，接續後校正和每一球都還在', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await gotoApp(page, server.url + '/index.html');
  await page.setInputFiles('#file-video', MP4);
  await page.waitForSelector('#view-work:not([hidden])', { timeout: 60000 });
  // 標一球之後重新整理
  await tapImage(page, truth.hoop.front.x, truth.hoop.front.y);
  await tapImage(page, truth.hoop.back.x, truth.hoop.back.y);
  await page.check('input[name="level"][value="rim"]');
  await page.click('#cal-done');
  await page.selectOption('#auto-advance', '0');
  for (const f of flightFrames(truth.shots[0], 5)) {
    await gotoFrame(page, f);
    await tapImage(page, truth.balls[f].x, truth.balls[f].y);
  }
  await page.click('#btn-save-shot');
  await page.waitForFunction(() => document.querySelector('#shot-count').textContent === '1');
  await page.waitForTimeout(600); // 草稿是稍後才寫入的
  await page.reload();
  await page.waitForFunction(() => !!window.__arclog);
  await page.setInputFiles('#file-video', MP4);
  await page.waitForSelector('#dialog[open]', { timeout: 60000 });
  assert.match(await page.textContent('#dialog-title'), /接續上次的標記/);
  await page.click('#dialog-ok');
  await page.waitForFunction(() => document.querySelector('#shot-count') && document.querySelector('#shot-count').textContent === '1');
  const s = await page.evaluate(() => ({ level: window.__arclog.session.level, hoop: window.__arclog.session.hoopPoints, shots: window.__arclog.session.shots.length }));
  assert.equal(s.level, 'rim');
  assert.equal(s.shots, 1);
  assert.ok(s.hoop.front && s.hoop.back);
  await context.close();
});

test('自動偵測讀真的影片檔：結果和 tools/analyze.py 一致；analyze.py 的 CSV 可以匯入網站', async (t) => {
  const { context, page, errors } = await openWithVideo();
  await calibrate(page);
  const hoop = await page.evaluate(() => window.__arclog.session.hoopPoints);
  await page.click('#btn-auto');
  await page.waitForSelector('#view-auto:not([hidden])');
  await page.click('#auto-start');
  await page.waitForFunction(() => !document.querySelector('#auto-results').hidden || !document.querySelector('#auto-error').hidden, null, { timeout: 420000 });
  const error = await page.evaluate(() => (document.querySelector('#auto-error').hidden ? null : document.querySelector('#auto-error').textContent));
  assert.equal(error, null, `自動偵測不應該出錯：${error}`);
  const run = await page.evaluate(() => window.__arclogLastAuto);
  await page.click('#auto-accept-all');
  await page.waitForSelector('#panel-mark:not([hidden])');
  await page.click('#btn-to-report');
  await page.waitForSelector('#view-report:not([hidden])');
  const web = await page.evaluate(() => window.__arclogReport.rows.map((r) => ({ angle: r.angle, made: r.made })));
  t.diagnostic(`網站：${run.backend}，${run.frames} 幀，找到 ${web.length} 球（真值 ${truth.shots.length} 球）：${web.map((r) => r.angle.toFixed(1)).join('、')}`);

  // 同一支影片、同樣的籃框座標，交給指令工具
  const out = join(OUT, 'analyze');
  const res = await runPython(['tools/analyze.py', MP4, '--hoop', `${hoop.front.x},${hoop.front.y},${hoop.back.x},${hoop.back.y}`, '--level', 'rim', '--out', out]);
  assert.equal(res.code, 0, `analyze.py 失敗：\n${res.output}`);
  const csvPath = join(out, `${NAME}.arclog.csv`);
  const csv = readFileSync(csvPath, 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(csv[0], '球序,入框角度,是否進球');
  const cli = csv.slice(1).map((line) => {
    const [, angle, made] = line.split(',');
    return { angle: Number(angle), made: made === '是' };
  });
  t.diagnostic(`analyze.py：找到 ${cli.length} 球：${cli.map((r) => r.angle.toFixed(1)).join('、')}`);
  assert.ok(existsSync(join(out, `${NAME}.arclog.mp4`)), '應該輸出檢查影片');
  assert.ok(existsSync(join(out, `${NAME}.arclog-auto.json`)));

  // 兩邊用同一個模型、同一套軌跡邏輯：找到的球數相同，角度幾乎一樣
  assert.ok(web.length >= truth.shots.length - 1, `網站只找到 ${web.length} 球`);
  assert.equal(cli.length, web.length, '網站和指令工具找到的球數應該相同');
  const diffs = web.map((r, i) => Math.abs(r.angle - cli[i].angle));
  t.diagnostic(`網站和指令工具的角度差：最大 ${Math.max(...diffs).toFixed(2)} 度`);
  assert.ok(Math.max(...diffs) <= 0.3, `角度差 ${diffs.map((d) => d.toFixed(2)).join('、')}`);
  assert.deepEqual(web.map((r) => r.made), cli.map((r) => r.made));

  // 把指令工具的 CSV 匯入網站。左上角的返回在報告頁是「回標記」，要再按一次才回首頁
  await page.click('#nav-home');
  await page.waitForSelector('#panel-mark:not([hidden])');
  await page.click('#nav-home');
  await page.waitForSelector('#view-home:not([hidden])');
  await page.setInputFiles('#file-csv', csvPath);
  await page.waitForSelector('#view-report:not([hidden])');
  const imported = await page.evaluate(() => window.__arclogReport.rows.map((r) => ({ angle: r.angle, made: r.made })));
  assert.deepEqual(imported, cli);
  assert.deepEqual(errors, [], `頁面上不應該有錯誤：${errors.join('\n')}`);
  await context.close();
});

test('垂直參考線：自動偵測讀真的影片檔；報告頁的指令帶著參考線，analyze.py 照這行指令跑出一樣的結果', async (t) => {
  const { context, page, errors } = await openWithVideo();
  await page.waitForSelector('#view-work:not([hidden])', { timeout: 60000 });
  await page.check('input[name="level"][value="vertical"]');
  await tapImage(page, truth.hoop.front.x, truth.hoop.front.y);
  await tapImage(page, truth.hoop.back.x, truth.hoop.back.y);
  // 故意點一條斜 2 度（上端往右）的「參考線」：角度會和「籃框連線」不同，用來確認網站和 analyze.py 都真的用了這條線
  const rimW = Math.hypot(truth.hoop.back.x - truth.hoop.front.x, truth.hoop.back.y - truth.hoop.front.y);
  const L = 4 * rimW;
  const a = (2 * Math.PI) / 180;
  const bottom = { x: truth.hoop.back.x + 0.4 * rimW, y: truth.hoop.back.y + 2.5 * rimW };
  const top = { x: bottom.x + L * Math.sin(a), y: bottom.y - L * Math.cos(a) };
  await tapImage(page, top.x, top.y);
  await tapImage(page, bottom.x, bottom.y);
  assert.equal(await page.isDisabled('#cal-done'), false);
  await page.click('#cal-done');
  await page.waitForSelector('#panel-mark:not([hidden])');
  await page.click('#btn-auto');
  await page.waitForSelector('#view-auto:not([hidden])');
  await page.click('#auto-start');
  await page.waitForFunction(() => !document.querySelector('#auto-results').hidden || !document.querySelector('#auto-error').hidden, null, { timeout: 420000 });
  const error = await page.evaluate(() => (document.querySelector('#auto-error').hidden ? null : document.querySelector('#auto-error').textContent));
  assert.equal(error, null, `自動偵測不應該出錯：${error}`);
  await page.click('#auto-accept-all');
  await page.waitForSelector('#panel-mark:not([hidden])');
  await page.click('#btn-to-report');
  await page.waitForSelector('#view-report:not([hidden])');
  const web = await page.evaluate(() => window.__arclogReport.rows.map((r) => ({ angle: r.angle, made: r.made })));
  const cmd = await page.textContent('#report-cli-cmd');
  t.diagnostic(`報告頁的指令：${cmd}`);
  assert.match(cmd, /--level vertical --vertical [\d.]+,[\d.]+,[\d.]+,[\d.]+$/);
  assert.deepEqual(errors, [], `頁面上不應該有錯誤：${errors.join('\n')}`);
  await context.close();

  // 照報告頁給的參數執行 analyze.py（影片路徑換成實際位置）
  const args = cmd.replace(/^python tools\/analyze\.py "[^"]*"\s*/, '').split(/\s+/);
  const out = join(OUT, 'analyze_vertical');
  const res = await runPython(['tools/analyze.py', MP4, ...args, '--out', out]);
  assert.equal(res.code, 0, `analyze.py 失敗：\n${res.output}`);
  const tilt = /依垂直參考線，手機歪了 ([\d.]+) 度/.exec(res.output);
  assert.ok(tilt && Math.abs(Number(tilt[1]) - 2) < 0.5, `analyze.py 應該印出參考線換算的歪斜（約 2 度）：\n${res.output}`);
  const readCsv = (dir) => readFileSync(join(dir, `${NAME}.arclog.csv`), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).slice(1).map((line) => {
    const [, angle, made] = line.split(',');
    return { angle: Number(angle), made: made === '是' };
  });
  const cli = readCsv(out);
  t.diagnostic(`網站（垂直參考線）：${web.map((r) => r.angle.toFixed(1)).join('、')}；analyze.py：${cli.map((r) => r.angle.toFixed(1)).join('、')}`);
  assert.ok(web.length >= truth.shots.length - 1, `網站只找到 ${web.length} 球`);
  assert.equal(cli.length, web.length, '網站和指令工具找到的球數應該相同');
  const diffs = web.map((r, i) => Math.abs(r.angle - cli[i].angle));
  assert.ok(Math.max(...diffs) <= 0.3, `角度差 ${diffs.map((d) => d.toFixed(2)).join('、')}`);
  assert.deepEqual(web.map((r) => r.made), cli.map((r) => r.made));

  // 對照：同一支影片用「籃框連線」。參考線斜了 2 度，至少有一球的角度要明顯不同
  const outRim = join(OUT, 'analyze_rim');
  const hoopArg = args[args.indexOf('--hoop') + 1];
  const rim = await runPython(['tools/analyze.py', MP4, '--hoop', hoopArg, '--level', 'rim', '--out', outRim]);
  assert.equal(rim.code, 0, rim.output);
  const base = readCsv(outRim);
  const shift = Math.max(...base.slice(0, cli.length).map((r, i) => Math.abs(r.angle - cli[i].angle)));
  t.diagnostic(`和籃框連線相比，角度最多差 ${shift.toFixed(1)} 度`);
  assert.ok(shift >= 0.2, `斜 2 度的參考線應該讓角度改變（最多只差 ${shift.toFixed(2)} 度）`);
});
