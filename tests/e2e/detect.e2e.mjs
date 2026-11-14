// 偵測器的實測：在真的 Chrome 裡，Worker 載入 onnxruntime-web 和階段 A 的模型，
// 對合成畫面（tests/fixtures/img/）找出球。WebGPU 和 WASM 兩條路徑都要能用，
// 而且 WebGPU 不能用的時候要自動退回 WASM。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { startServer, launchBrowser, serveFixtures, collectErrors, FIXTURES } from './harness.mjs';

const meta = JSON.parse(readFileSync(join(FIXTURES, 'img', 'synth_frames.json'), 'utf8'));
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

/** 在頁面裡執行：建立偵測器，對幾張合成畫面做偵測。 */
async function detectFixtures({ forceWasm, names }) {
  const { createDetector, loadManifest, webgpuLikely } = await import('/js/detect/client.js');
  const { letterbox } = await import('/js/core/yolo.js');
  const manifest = await loadManifest();
  const model = manifest.models.find((m) => m.id === manifest.default);
  const stages = [];
  const det = await createDetector({ model, forceWasm, conf: 0.05, onProgress: (p) => stages.push(`${p.backend}:${p.stage}`) });
  const out = {
    backend: det.backend,
    webgpuLikely: webgpuLikely(),
    isolated: self.crossOriginIsolated,
    input: det.input,
    info: det.info,
    attempts: det.attempts,
    stages: [...new Set(stages)],
    frames: {},
    ms: [],
  };
  const { width: W, height: H } = det.input;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (const name of names) {
    const img = new Image();
    img.src = `/__fixtures__/img/${name}`;
    await img.decode();
    const lb = letterbox(img.naturalWidth, img.naturalHeight, W, H);
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, lb.padX, lb.padY, lb.newW, lb.newH);
    // 同一張圖跑三次，取後面兩次的時間（第一次可能還在暖機）
    let last = null;
    for (let k = 0; k < 3; k++) {
      const data = ctx.getImageData(0, 0, W, H);
      last = await det.detect(data.data.buffer, lb);
      if (k > 0) out.ms.push(last.ms);
    }
    out.frames[name] = last.dets;
  }
  det.dispose();
  return out;
}

const names = ['synth_apex.png', 'synth_late.png', 'synth_empty.png'];

function checkDetections(r) {
  const ballPx = meta.ballDiameterPx;
  for (const name of ['synth_apex.png', 'synth_late.png']) {
    const truth = meta.frames[name].ball;
    const near = r.frames[name].filter((d) => Math.hypot(d.x - truth.x, d.y - truth.y) <= 0.35 * ballPx);
    assert.ok(near.length >= 1, `${name}：沒有在球的位置偵測到球（${JSON.stringify(r.frames[name])}）`);
    const best = near.reduce((a, b) => (b.conf > a.conf ? b : a));
    assert.ok(best.conf >= 0.1, `${name}：信心只有 ${best.conf}`);
    assert.ok(Math.hypot(best.x - truth.x, best.y - truth.y) < 3, `${name}：球心差了 ${Math.hypot(best.x - truth.x, best.y - truth.y).toFixed(2)} 像素`);
    assert.ok(best.w > 0.6 * ballPx && best.w < 1.6 * ballPx, `${name}：框的大小 ${best.w}`);
  }
  assert.ok(r.frames['synth_empty.png'].every((d) => d.conf < 0.25), '沒有球的畫面不應該有高信心的偵測');
}

test('WASM 後端：載入模型並偵測到合成畫面裡的球', async (t) => {
  const page = await browser.newPage();
  const errors = collectErrors(page);
  await serveFixtures(page);
  await page.goto(`${server.url}/index.html`);
  const r = await page.evaluate(detectFixtures, { forceWasm: true, names });
  await page.close();
  t.diagnostic(`後端 ${r.backend}、輸入 ${r.input.width}x${r.input.height}、執行緒 ${r.info.threads}、crossOriginIsolated ${r.isolated}、每幀 ${Math.min(...r.ms).toFixed(0)}–${Math.max(...r.ms).toFixed(0)} ms、暖機 ${r.info.warmupMs.toFixed(0)} ms`);
  assert.equal(r.backend, 'wasm');
  assert.deepEqual(r.input, { width: 640, height: 384 });
  assert.equal(r.info.classIndex, 32);
  assert.equal(r.isolated, true, '本機伺服器有送 COOP/COEP，所以應該是 crossOriginIsolated');
  assert.ok(r.info.threads >= 1);
  assert.ok(r.stages.includes('wasm:download') && r.stages.includes('wasm:session'), `進度回報：${r.stages}`);
  checkDetections(r);
  assert.deepEqual(errors, []);
});

test('自動選後端：有 WebGPU 就用，沒有就退回 WASM，兩種情況都偵測得到球', async (t) => {
  const page = await browser.newPage();
  const errors = collectErrors(page);
  await serveFixtures(page);
  await page.goto(`${server.url}/index.html`);
  const r = await page.evaluate(detectFixtures, { forceWasm: false, names });
  await page.close();
  t.diagnostic(`navigator.gpu ${r.webgpuLikely ? '有' : '沒有'} → 實際後端 ${r.backend}；每幀 ${Math.min(...r.ms).toFixed(0)}–${Math.max(...r.ms).toFixed(0)} ms；失敗的嘗試 ${JSON.stringify(r.attempts)}`);
  assert.ok(['webgpu', 'wasm'].includes(r.backend));
  if (r.backend === 'wasm' && r.webgpuLikely) {
    assert.ok(r.attempts.some((a) => a.backend === 'webgpu'), 'WebGPU 失敗時要留下紀錄再退回 WASM');
  }
  checkDetections(r);
  // WebGPU 失敗退回時，瀏覽器可能在主控台印出 GPU 相關的訊息；真正的頁面例外才算錯
  assert.deepEqual(errors.filter((e) => e.startsWith('pageerror')), []);
});

test('沒有 COOP/COEP 標頭時（單執行緒 WASM）仍然可以偵測', async (t) => {
  const plain = await startServer({ isolation: false });
  try {
    const page = await browser.newPage();
    await serveFixtures(page);
    await page.goto(`${plain.url}/index.html`);
    const r = await page.evaluate(detectFixtures, { forceWasm: true, names });
    await page.close();
    t.diagnostic(`crossOriginIsolated ${r.isolated}、執行緒 ${r.info.threads}、每幀 ${Math.min(...r.ms).toFixed(0)}–${Math.max(...r.ms).toFixed(0)} ms`);
    assert.equal(r.isolated, false);
    assert.equal(r.info.threads, 1);
    checkDetections(r);
  } finally {
    await plain.stop();
  }
});
