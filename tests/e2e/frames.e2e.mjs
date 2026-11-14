// 逐幀定位的實測：在真的 Chrome 裡，用「每一幀畫著自己幀號條碼」的影片，
// 檢查兩個影格引擎（WebCodecs 主引擎、<video> 退路）拿到的每一幀都是要的那一幀、方向正確。
//
// 每支影片 × 每個引擎都做：
//   1. 時間戳和 ffprobe 一致
//   2. 由第 0 幀逐幀前進到最後
//   3. 由最後一幀逐幀後退到第 0 幀
//   4. 隨機跳 40 次
//   5. scan() 每 3 幀取一幀

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { startServer, launchBrowser, serveFixtures, collectErrors, FIXTURES } from './harness.mjs';

const expected = JSON.parse(readFileSync(join(FIXTURES, 'video', 'expected.json'), 'utf8'));
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

/** 在頁面裡執行：開影片、照各種順序取幀、讀條碼。回傳統計。 */
async function exercise({ name, engine, layout, info }) {
  const { openVideoFile } = await import('/js/media/open.js');
  const blob = await (await fetch(`/__fixtures__/video/${name}`)).blob();
  const file = new File([blob], name, { type: name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4' });
  let src;
  try {
    src = await openVideoFile(file, { engine });
  } catch (err) {
    return { opened: false, code: err.code, message: err.message, attempts: err.attempts || null };
  }
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const read = (draw) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw(ctx);
    const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const mean = (x0, y0, w, h) => {
      let s = 0;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
        const o = (y * canvas.width + x) * 4;
        s += px[o] + px[o + 1] + px[o + 2];
      }
      return s / (3 * w * h);
    };
    let value = 0;
    for (let k = 0; k < layout.bits; k++) {
      const cx = layout.cell.x0 + k * layout.cell.w + (layout.cell.w >> 1);
      const cy = layout.cell.y0 + (layout.cell.h >> 1);
      if (mean(cx - 4, cy - 4, 8, 8) > 128) value |= 1 << k;
    }
    const s = layout.marker.size;
    const white = mean(layout.marker.white[0] + 8, layout.marker.white[1] + 8, s - 16, s - 16);
    const black = mean(layout.marker.black[0] + 8, layout.marker.black[1] + 8, s - 16, s - 16);
    return { value, upright: white > 200 && black < 60 };
  };

  const out = {
    opened: true,
    engine: src.engine,
    width: src.width,
    height: src.height,
    frameCount: src.frameCount,
    fps: src.fps,
    timeSource: src.timeSource,
    codec: src.codec,
    vfr: src.vfr,
    warnings: src.warnings,
    maxTimeErr: 0,
    forward: { n: 0, wrong: [] },
    backward: { n: 0, wrong: [] },
    random: { n: 0, wrong: [] },
    scan: { n: 0, wrong: [] },
    reportedWrongIndex: 0,
    notUpright: 0,
    ms: {},
  };
  for (let i = 0; i < Math.min(src.frameCount, info.times.length); i++) {
    out.maxTimeErr = Math.max(out.maxTimeErr, Math.abs(src.frameTimes[i] - info.times[i]));
  }

  const check = async (i, bucket) => {
    const fr = await src.getFrame(i);
    const r = read((c) => c.drawImage(fr.image, 0, 0));
    bucket.n++;
    if (!r.upright) out.notUpright++;
    if (fr.index !== i) out.reportedWrongIndex++;
    // 以「引擎說它給的是第幾幀」為準來比對內容：說是第 k 幀，畫面就必須是第 k 幀
    if (r.value !== fr.index) bucket.wrong.push({ asked: i, reported: fr.index, got: r.value });
  };

  let t0 = performance.now();
  for (let i = 0; i < src.frameCount; i++) await check(i, out.forward);
  out.ms.forward = (performance.now() - t0) / src.frameCount;
  t0 = performance.now();
  for (let i = src.frameCount - 1; i >= 0; i--) await check(i, out.backward);
  out.ms.backward = (performance.now() - t0) / src.frameCount;
  // 固定種子的亂數
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  t0 = performance.now();
  for (let k = 0; k < 40; k++) await check(Math.floor(rnd() * src.frameCount), out.random);
  out.ms.random = (performance.now() - t0) / 40;

  t0 = performance.now();
  const res = await src.scan({
    stride: 3,
    onFrame: async ({ index, draw }) => {
      const r = read((c) => draw(c, 0, 0, canvas.width, canvas.height));
      out.scan.n++;
      if (!r.upright) out.notUpright++;
      if (r.value !== index) out.scan.wrong.push({ reported: index, got: r.value });
    },
  });
  out.ms.scan = (performance.now() - t0) / Math.max(1, out.scan.n);
  out.scanFrames = res.frames;

  // 取消：scan 到一半中止
  const ac = new AbortController();
  let seen = 0;
  const cancelled = await src.scan({
    signal: ac.signal,
    onFrame: async () => {
      seen++;
      if (seen === 5) ac.abort();
    },
  });
  out.cancel = { seen, cancelled: cancelled.cancelled };

  src.dispose();
  return out;
}

for (const engine of ['codec', 'video']) {
  for (const [name, info] of Object.entries(expected.files)) {
    test(`${engine === 'codec' ? 'WebCodecs 引擎' : '<video> 退路引擎'}：${name}`, async (t) => {
      const page = await browser.newPage();
      const errors = collectErrors(page);
      await serveFixtures(page);
      await page.goto(`${server.url}/index.html`);
      const r = await page.evaluate(exercise, { name, engine, layout: expected.layout, info });
      await page.close();

      if (!r.opened) {
        // HEVC 沒有硬體解碼時開不了是預期中的情況：記錄下來並略過
        if (info.codec === 'hevc') {
          t.skip(`這台機器的 Chrome 解不開 HEVC：${r.message}`);
          return;
        }
        assert.fail(`開不了 ${name}：${r.message} ${JSON.stringify(r.attempts)}`);
      }
      t.diagnostic(
        `${r.engine} ${r.width}x${r.height} ${r.frameCount} 幀 ${r.fps.toFixed(2)}fps ${r.codec} | 每幀 ms：前進 ${r.ms.forward.toFixed(1)} 後退 ${r.ms.backward.toFixed(1)} 隨機 ${r.ms.random.toFixed(1)} scan ${r.ms.scan.toFixed(1)}` +
          ` | 內容不符：前進 ${r.forward.wrong.length} 後退 ${r.backward.wrong.length} 隨機 ${r.random.wrong.length} scan ${r.scan.wrong.length}；回報幀號和要求不同 ${r.reportedWrongIndex} 次`,
      );
      assert.equal(r.engine, engine);
      assert.equal(r.width, info.displayWidth, '顯示寬度');
      assert.equal(r.height, info.displayHeight, '顯示高度');
      assert.equal(r.frameCount, info.frames, '幀數');
      assert.equal(r.timeSource, 'container');
      assert.ok(r.maxTimeErr < 2e-6, `時間戳和 ffprobe 最多差 ${r.maxTimeErr}`);
      assert.equal(r.notUpright, 0, '有畫面的方向不對（旋轉沒有套用好）');
      assert.deepEqual(r.forward.wrong, [], '逐幀前進');
      assert.deepEqual(r.backward.wrong, [], '逐幀後退');
      assert.deepEqual(r.random.wrong, [], '隨機跳');
      assert.deepEqual(r.scan.wrong, [], 'scan');
      assert.equal(r.forward.n, info.frames);
      assert.equal(r.scan.n, Math.ceil(info.frames / 3));
      assert.equal(r.cancel.cancelled, true, 'scan 可以中途取消');
      assert.ok(r.cancel.seen <= 6, '取消後不應該再繼續處理很多幀');
      if (engine === 'codec') assert.equal(r.reportedWrongIndex, 0, '主引擎給的一定是要求的那一幀');
      assert.equal(r.vfr, name.startsWith('vfr'), '可變幀率的判斷');
      assert.deepEqual(errors, [], '頁面不應該有錯誤');
    });
  }
}
