// 自動偵測流程的實測（真的 Chrome、示範模式的合成畫面、階段 A 的 COCO 預訓練模型）：
//   WebGPU（有的話）跑完整段示範 → 確認卡 → 全部接受 → 報告和真實角度比較
//   強制 WASM 的退回路徑
//   取消、模型載入失敗、模型清單讀不到：都要能回到半自動標記，不可卡住
//   載入自己的 ONNX、把自動結果拿去「修正」

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { startServer, launchBrowser, collectErrors, gotoApp, ROOT } from './harness.mjs';

let server;
let browser;

before(async () => {
  server = await startServer();
  browser = await launchBrowser(['--enable-unsafe-webgpu', '--enable-features=Vulkan']);
});
after(async () => {
  if (browser) await browser.close();
  if (server) await server.stop();
});

async function openDemoAtAuto(path = '/index.html', opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = collectErrors(page);
  if (opts.route) await opts.route(page);
  await gotoApp(page, server.url + path);
  await page.click('#home-advanced summary');
  await page.click('#btn-demo');
  await page.waitForSelector('#view-work:not([hidden])');
  await page.click('#cal-demo');
  await page.click('#cal-done');
  await page.waitForSelector('#panel-mark:not([hidden])');
  if (opts.frame != null) await page.evaluate((f) => window.__arclog.work.goto(f), opts.frame);
  await page.click('#btn-auto');
  await page.waitForSelector('#view-auto:not([hidden])');
  return { context, page, errors };
}

/** 等偵測跑完，回傳這次執行的摘要。 */
async function waitForResults(page, timeout = 420000) {
  await page.waitForFunction(
    () => !document.querySelector('#auto-results').hidden || !document.querySelector('#auto-error').hidden,
    null,
    { timeout },
  );
  return page.evaluate(() => ({
    error: document.querySelector('#auto-error').hidden ? null : document.querySelector('#auto-error').textContent,
    run: window.__arclogLastAuto || null,
    cards: document.querySelectorAll('#auto-cards .auto-card').length,
  }));
}

/** 把報告裡每一球和真實答案比較。 */
async function compareWithTruth(page) {
  return page.evaluate(() => {
    const r = window.__arclogReport;
    const plan = window.__arclog.source.plan;
    const matched = r.rows.filter((x) => x.error != null);
    return {
      shots: r.rows.length,
      truthShots: plan.shots.length,
      matched: matched.length,
      maxErr: matched.length ? Math.max(...matched.map((x) => Math.abs(x.error))) : null,
      meanErr: matched.length ? matched.reduce((a, x) => a + Math.abs(x.error), 0) / matched.length : null,
      madeCorrect: r.demoStats.madeCorrect,
      madeTotal: r.demoStats.madeTotal,
    };
  });
}

test('自動偵測（預設後端）：跑完示範影片，每球一張確認卡，全部接受後的報告誤差 < 1 度', async (t) => {
  const { context, page, errors } = await openDemoAtAuto();
  assert.match(await page.textContent('#auto-model'), /階段 A/);
  assert.match(await page.textContent("#auto-model-note"), /尚未驗證/);
  await page.click('#auto-start');
  await page.waitForSelector('#auto-progress:not([hidden])');
  assert.equal(await page.isVisible('#auto-bar'), true, '要有進度條');
  assert.equal(await page.isVisible('#auto-cancel'), true, '要可以取消');
  await page.waitForFunction(() => /逐幀偵測中/.test(document.querySelector('#auto-stage').textContent), null, { timeout: 180000 });
  const res = await waitForResults(page);
  assert.equal(res.error, null, `不應該出錯：${res.error}`);
  t.diagnostic(`後端 ${res.run.backend}、${res.run.frames} 幀、每幀推論 ${res.run.msPerFrame.toFixed(0)} ms、共 ${res.run.seconds.toFixed(0)} 秒；偵測到 ${res.run.detections} 個位置，找到 ${res.run.shots} 球；排除的候選 ${JSON.stringify(res.run.stats.rejected)}`);
  assert.ok(['webgpu', 'wasm'].includes(res.run.backend));
  assert.ok(res.cards >= 8, `示範有 10 球，只找到 ${res.cards} 球`);
  assert.ok(res.cards <= 10, `示範只有 10 球，卻找到 ${res.cards} 球`);

  // 確認卡：有疊圖（畫布不是空白的）、角度、進球與否可以改
  const card = page.locator('#auto-cards .auto-card').first();
  await page.waitForFunction(() => {
    const c = document.querySelector('#auto-cards canvas');
    if (!c || c.width < 100) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let yellow = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 190 && d[i + 2] < 110) yellow++;
    return yellow > 30; // 軌跡是黃色的線
  });
  assert.match(await card.locator('.auto-title strong').textContent(), /^\d+\.\d°$/);
  const firstMade = await card.locator('.made-btn[aria-checked="true"]').textContent();
  await card.locator('.made-btn[aria-checked="false"]').click();
  assert.notEqual(await page.locator('#auto-cards .auto-card').first().locator('.made-btn[aria-checked="true"]').textContent(), firstMade, '可以改正進球與否');
  await page.locator('#auto-cards .auto-card').first().locator('.made-btn[aria-checked="false"]').click(); // 改回來

  // 刪除最後一張，再全部接受
  const n = res.cards;
  await page.locator('#auto-cards .auto-card').last().locator('button', { hasText: '刪除' }).click();
  assert.equal(await page.locator('#auto-cards .auto-card').count(), n - 1);
  await page.click('#auto-accept-all');
  await page.waitForSelector('#panel-mark:not([hidden])');
  assert.equal(await page.textContent('#shot-count'), String(n - 1));
  assert.match(await page.textContent('#shot-list'), /自動/);

  await page.click('#btn-to-report');
  await page.waitForSelector('#view-report:not([hidden])');
  const cmp = await compareWithTruth(page);
  t.diagnostic(`接受 ${cmp.shots} 球：角度誤差平均 ${cmp.meanErr.toFixed(2)} 度、最大 ${cmp.maxErr.toFixed(2)} 度；進球判定 ${cmp.madeCorrect}/${cmp.madeTotal} 和合成畫面相同`);
  assert.equal(cmp.matched, cmp.shots, '每一球都對得到真實的那一球');
  assert.ok(cmp.maxErr < 1.0, `角度誤差最大 ${cmp.maxErr} 度`);
  assert.ok(cmp.madeCorrect >= cmp.madeTotal - 1, `進球判定 ${cmp.madeCorrect}/${cmp.madeTotal}`);
  assert.deepEqual(errors.filter((e) => e.startsWith('pageerror')), []);
  await context.close();
});

test('WASM 退回路徑：?backend=wasm 強制不用 WebGPU，仍然找得到球', async (t) => {
  // 只跑最後三球，節省時間
  const { context, page, errors } = await openDemoAtAuto('/index.html?backend=wasm', { frame: 560 });
  assert.equal(await page.isChecked('#auto-force-wasm'), true);
  await page.selectOption('#auto-range', 'from');
  await page.click('#auto-start');
  const res = await waitForResults(page);
  assert.equal(res.error, null, `不應該出錯：${res.error}`);
  t.diagnostic(`後端 ${res.run.backend}、${res.run.frames} 幀、每幀推論 ${res.run.msPerFrame.toFixed(0)} ms；找到 ${res.run.shots} 球`);
  assert.equal(res.run.backend, 'wasm');
  assert.ok(res.run.frames < 260, '只處理了目前這一幀之後的畫面');
  assert.ok(res.cards >= 2 && res.cards <= 3, `最後這段有 3 球，找到 ${res.cards} 球`);

  // 修正：把第一球的點拿去標記畫面調整，存起來之後變成手動標記的球
  await page.locator('#auto-cards .auto-card').first().locator('button', { hasText: '修正' }).click();
  await page.waitForSelector('#panel-mark:not([hidden])');
  const draft = await page.evaluate(() => window.__arclog.session.draft.length);
  assert.ok(draft >= 4 && draft <= 8, `帶過去 ${draft} 個點`);
  assert.equal(await page.isDisabled('#btn-save-shot'), false);
  await page.click('#btn-save-shot');
  assert.deepEqual(await page.evaluate(() => window.__arclog.session.shots.map((s) => s.source)), ['manual']);
  assert.deepEqual(errors.filter((e) => e.startsWith('pageerror')), []);
  await context.close();
});

test('取消：偵測到一半按取消，回到設定畫面，可以繼續用半自動', async () => {
  const { context, page } = await openDemoAtAuto('/index.html?backend=wasm');
  await page.click('#auto-start');
  await page.waitForFunction(() => /逐幀偵測中… [1-9]/.test(document.querySelector('#auto-stage').textContent), null, { timeout: 180000 });
  await page.click('#auto-cancel');
  await page.waitForSelector('#auto-setup:not([hidden])', { timeout: 30000 });
  assert.match(await page.textContent('#toast'), /已取消/);
  assert.equal(await page.isVisible('#auto-progress'), false);
  await page.click('#auto-back');
  await page.waitForSelector('#panel-mark:not([hidden])');
  assert.equal(await page.textContent('#shot-count'), '0');
  await context.close();
});

test('模型下載失敗：顯示原因，並可以改用半自動標記（不卡住）', async () => {
  const { context, page } = await openDemoAtAuto('/index.html', { route: (p) => p.route('**/models/*.onnx*', (r) => r.abort()) });
  await page.click('#auto-start');
  await page.waitForSelector('#auto-error:not([hidden])', { timeout: 180000 });
  assert.match(await page.textContent('#auto-error'), /載入失敗/);
  assert.match(await page.textContent('#auto-error'), /半自動/);
  assert.equal(await page.isVisible('#auto-progress'), false, '進度畫面要收起來');
  await page.locator('#auto-error button', { hasText: '改用半自動標記' }).click();
  await page.waitForSelector('#panel-mark:not([hidden])');
  // 半自動照常可以用
  const c = await page.evaluate(async () => {
    const { simulateClicks } = await import('/js/core/synth.js');
    return simulateClicks(window.__arclog.source.plan, 0, { count: 5, noisePx: 0, seed: 1 });
  });
  await page.selectOption('#auto-advance', '0');
  for (const p of c) {
    await page.evaluate((f) => window.__arclog.work.goto(f), p.frame);
    const q = await page.evaluate(([x, y]) => window.__arclog.work.view.toClient(x, y), [p.x, p.y]);
    await page.mouse.click(q.x, q.y);
  }
  await page.click('#btn-save-shot');
  assert.equal(await page.textContent('#shot-count'), '1');
  await context.close();
});

test('模型清單讀不到：說明原因，可以回到半自動', async () => {
  const { context, page } = await openDemoAtAuto('/index.html', { route: (p) => p.route('**/models/manifest.json', (r) => r.fulfill({ status: 404, body: 'nope' })) });
  assert.match(await page.textContent('#auto-model-note'), /讀不到模型清單/);
  await page.click('#auto-start');
  await page.waitForSelector('#auto-error:not([hidden])');
  assert.match(await page.textContent('#auto-error'), /沒有可以用的偵測模型/);
  await page.locator('#auto-error button', { hasText: '改用半自動標記' }).click();
  await page.waitForSelector('#panel-mark:not([hidden])');
  await context.close();
});

test('載入自己的 ONNX 模型：不必重新部署就能試新訓練的模型', async (t) => {
  const { context, page } = await openDemoAtAuto('/index.html', { frame: 560 });
  await page.setInputFiles('#file-onnx', join(ROOT, 'models', 'arclog-ball-a-coco.onnx'));
  await page.waitForFunction(() => document.querySelector('#auto-model').value === '__file__');
  assert.match(await page.textContent('#auto-model'), /自己載入的/);
  await page.selectOption('#auto-range', 'from');
  await page.click('#auto-start');
  const res = await waitForResults(page);
  assert.equal(res.error, null, `不應該出錯：${res.error}`);
  t.diagnostic(`自己載入的模型：後端 ${res.run.backend}、找到 ${res.run.shots} 球`);
  assert.equal(res.run.model, 'arclog-ball-a-coco.onnx');
  assert.ok(res.cards >= 2);
  await context.close();
});

test('沒有校正就不能自動偵測；壞掉的 ONNX 檔會顯示錯誤', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await gotoApp(page, server.url + '/index.html');
  await page.click('#home-advanced summary');
  await page.click('#btn-demo');
  await page.waitForSelector('#view-work:not([hidden])');
  // 還沒校正：進不了標記，也就按不到自動偵測
  assert.equal(await page.isDisabled('#cal-done'), true);
  await page.click('.step[data-step="mark"]');
  assert.equal(await page.isVisible('#panel-mark'), false);
  assert.match(await page.textContent('#toast'), /請先點好籃框/);
  // 校正後載入一個不是 ONNX 的檔案
  await page.click('#cal-demo');
  await page.click('#cal-done');
  await page.click('#btn-auto');
  await page.setInputFiles('#file-onnx', { name: 'broken.onnx', mimeType: 'application/octet-stream', buffer: Buffer.from('this is not an onnx model') });
  await page.waitForFunction(() => document.querySelector('#auto-model').value === '__file__');
  await page.click('#auto-start');
  await page.waitForSelector('#auto-error:not([hidden])', { timeout: 180000 });
  assert.match(await page.textContent('#auto-error'), /載入失敗/);
  await context.close();
});
