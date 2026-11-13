// 瀏覽器實測的共用工具：起本機靜態伺服器（tools/serve.py）、開真的 Chrome。
//
//   npm run test:e2e
//
// 用的是這台電腦安裝的 Google Chrome（不是 Playwright 自帶的 Chromium，那個沒有 H.264 解碼器）。
// 環境變數：
//   ARCLOG_E2E_CHANNEL   chrome（預設）或 msedge
//   ARCLOG_E2E_HEADED=1  顯示瀏覽器視窗
//   ARCLOG_E2E_PYTHON    啟動伺服器用的 python 指令（預設 python）

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright-core';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = join(ROOT, 'tests', 'fixtures');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 啟動 tools/serve.py。
 * @param {{isolation?: boolean}} [opts] isolation=false 時不送 COOP/COEP 標頭
 * @returns {Promise<{url:string, stop:() => Promise<void>}>}
 */
export async function startServer(opts = {}) {
  const port = await freePort();
  const args = [join(ROOT, 'tools', 'serve.py'), '--port', String(port), '--quiet'];
  if (opts.isolation === false) args.push('--no-isolation');
  const proc = spawn(process.env.ARCLOG_E2E_PYTHON || 'python', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`伺服器啟動失敗：${log}`);
    try {
      const res = await fetch(`${url}/index.html`, { method: 'HEAD' });
      if (res.status < 500) break;
    } catch {
      /* 還沒好 */
    }
    if (Date.now() - t0 > 15000) {
      proc.kill();
      throw new Error(`等不到伺服器：${log}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill();
      }),
  };
}

/** 開瀏覽器。回傳 Playwright 的 Browser。 */
export async function launchBrowser(extraArgs = []) {
  return chromium.launch({
    channel: process.env.ARCLOG_E2E_CHANNEL || 'chrome',
    headless: process.env.ARCLOG_E2E_HEADED !== '1',
    args: ['--autoplay-policy=no-user-gesture-required', ...extraArgs],
  });
}

/** 讓頁面可以用 /__fixtures__/… 讀到 tests/fixtures/ 裡的檔案。 */
export async function serveFixtures(page) {
  await page.route('**/__fixtures__/**', async (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.split('/__fixtures__/')[1]);
    try {
      const body = readFileSync(join(FIXTURES, rel));
      const type = rel.endsWith('.json') ? 'application/json' : rel.endsWith('.png') ? 'image/png' : 'application/octet-stream';
      await route.fulfill({ status: 200, body, contentType: type, headers: { 'Cross-Origin-Resource-Policy': 'same-origin' } });
    } catch {
      await route.fulfill({ status: 404, body: 'not found' });
    }
  });
}

/**
 * 開啟網站首頁，並等主程式（js/ui/app.js）真的載入完成才回傳。
 * 沒等的話，偶爾會在事件處理函式掛上去之前就按了按鈕，變成按了沒反應。
 */
export async function gotoApp(page, url) {
  await page.goto(url);
  try {
    await page.waitForFunction(() => !!window.__arclog, null, { timeout: 30000 });
  } catch (err) {
    throw new Error(`主程式沒有載入完成：${url}`);
  }
}

/** 收集頁面上的錯誤（console.error 和沒接住的例外），測試最後可以檢查。 */
export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}
