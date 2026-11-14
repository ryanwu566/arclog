// 訓練到部署的最後一段：網站載入「剛訓練出來」的模型並偵測到球。
//
// 用的是合成資料訓練出來的模型（data/models_synth/arclog-ball-synth.onnx，不進版控）。
// 這個檔案不存在時整個測試會跳過；產生方式見 docs/EVAL.md 第 2 節的指令。
// 這只證明流程接得起來：合成資料訓練的模型不代表真實準確度，也不會放進 models/。
//
// 測兩條路：
//   1. 模型登記在 manifest 裡（階段 B、C 的模型上線後就是走這條路）：選單出現新模型、下載、偵測
//   2. 使用者自己載入 .onnx 檔（還沒部署前先試用）

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { startServer, launchBrowser, collectErrors, gotoApp, ROOT } from './harness.mjs';

const DIR = join(ROOT, 'data', 'models_synth');
const ONNX = join(DIR, 'arclog-ball-synth.onnx');
const skip = existsSync(ONNX) ? false : '沒有 data/models_synth/arclog-ball-synth.onnx（先跑一次合成資料的訓練和匯出）';

let server;
let browser;
before(async () => {
  if (skip) return;
  server = await startServer();
  browser = await launchBrowser(['--enable-unsafe-webgpu', '--enable-features=Vulkan']);
});
after(async () => {
  if (browser) await browser.close();
  if (server) await server.stop();
});

async function demoAtAuto(page, frame = null) {
  await page.click('#home-advanced summary');
  await page.click('#btn-demo');
  await page.waitForSelector('#view-work:not([hidden])');
  await page.click('#cal-demo');
  await page.click('#cal-done');
  await page.waitForSelector('#panel-mark:not([hidden])');
  if (frame != null) await page.evaluate((f) => window.__arclog.work.goto(f), frame);
  await page.click('#btn-auto');
  await page.waitForSelector('#view-auto:not([hidden])');
}

async function runAndCompare(page) {
  await page.click('#auto-start');
  await page.waitForFunction(() => !document.querySelector('#auto-results').hidden || !document.querySelector('#auto-error').hidden, null, { timeout: 420000 });
  const error = await page.evaluate(() => (document.querySelector('#auto-error').hidden ? null : document.querySelector('#auto-error').textContent));
  assert.equal(error, null, `不應該出錯：${error}`);
  const run = await page.evaluate(() => window.__arclogLastAuto);
  await page.click('#auto-accept-all');
  await page.waitForSelector('#panel-mark:not([hidden])');
  await page.click('#btn-to-report');
  await page.waitForSelector('#view-report:not([hidden])');
  const cmp = await page.evaluate(() => {
    const r = window.__arclogReport;
    const matched = r.rows.filter((x) => x.error != null);
    return {
      shots: r.rows.length,
      truthShots: window.__arclog.source.plan.shots.length,
      matched: matched.length,
      maxErr: matched.length ? Math.max(...matched.map((x) => Math.abs(x.error))) : null,
    };
  });
  return { run, cmp };
}

test('新模型登記在 manifest：選單出現、下載、偵測到球，角度誤差 < 1 度', { skip }, async (t) => {
  const side = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
  const entry = side.models.find((m) => m.id === 'arclog-ball-synth');
  assert.ok(entry, 'data/models_synth/manifest.json 裡應該有 arclog-ball-synth');
  assert.equal(entry.stage, 'synthetic');
  assert.equal(entry.numClasses, 1);
  assert.equal(entry.classIndex, 0);
  const real = JSON.parse(readFileSync(join(ROOT, 'web', 'models', 'manifest.json'), 'utf8'));

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = collectErrors(page);
  // 模擬「新模型已經放進 models/ 並部署」：模型清單多一筆，模型檔由測試提供
  await page.route('**/models/manifest.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...real, models: [...real.models, entry] }) }),
  );
  await page.route('**/models/arclog-ball-synth.onnx*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/octet-stream', body: readFileSync(ONNX), headers: { 'Cross-Origin-Resource-Policy': 'same-origin' } }),
  );
  await gotoApp(page, server.url + '/index.html');
  await demoAtAuto(page);
  const options = await page.$$eval('#auto-model option', (os) => os.map((o) => ({ value: o.value, text: o.textContent })));
  assert.ok(options.some((o) => o.value === 'arclog-ball-synth'), `選單裡應該有新模型：${JSON.stringify(options)}`);
  assert.equal(await page.inputValue('#auto-model'), real.default, '預設仍然是原本的模型');
  await page.selectOption('#auto-model', 'arclog-ball-synth');
  assert.match(await page.textContent('#auto-model-note'), /不代表真實準確度/);
  const { run, cmp } = await runAndCompare(page);
  t.diagnostic(`合成資料訓練的模型（${run.backend}）：找到 ${cmp.shots}/${cmp.truthShots} 球，最大誤差 ${cmp.maxErr == null ? '—' : cmp.maxErr.toFixed(2)} 度`);
  assert.equal(run.model, 'arclog-ball-synth');
  assert.ok(cmp.matched >= cmp.truthShots - 2, `只配對到 ${cmp.matched} 球`);
  assert.ok(cmp.maxErr < 1, `最大誤差 ${cmp.maxErr}`);
  assert.deepEqual(errors, [], errors.join('\n'));
  await context.close();
});

test('使用者自己載入剛訓練的 .onnx：單一類別的模型不用任何設定就能用', { skip }, async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await gotoApp(page, server.url + '/index.html?backend=wasm');
  await demoAtAuto(page, 520);
  await page.setInputFiles('#file-onnx', ONNX);
  await page.waitForFunction(() => document.querySelector('#auto-model').value === '__file__');
  await page.selectOption('#auto-range', 'from');
  const { run, cmp } = await runAndCompare(page);
  t.diagnostic(`自己載入（${run.backend}）：${run.frames} 幀，找到 ${cmp.shots} 球，最大誤差 ${cmp.maxErr == null ? '—' : cmp.maxErr.toFixed(2)} 度`);
  assert.equal(run.backend, 'wasm');
  assert.ok(cmp.shots >= 2, `只找到 ${cmp.shots} 球`);
  await context.close();
});
