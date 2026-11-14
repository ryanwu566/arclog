// 產生 3D 合成練投的畫面：給瀏覽器測試當「假相機」用（Chrome 的 --use-file-for-fake-video-capture 讀 .y4m），
// 也可以輸出幾張 PNG 預覽。畫面和網站示範模式用同一份繪圖程式（web/js/demo/scene3d.js），每一幀左下角有幀號條碼。
//
//   node tests/make_camera_feed.mjs --out <資料夾> --theta 0 [--background] [--png] [--width 640 --height 360]
//
// 輸出的檔案很大（.y4m 是沒有壓縮的影片），而且是測試時才產生的，所以一律寫到 repo 以外（預設是系統暫存資料夾）。

import { createCanvas } from '@napi-rs/canvas';
import { openSync, writeSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeScene3d } from '../web/js/core/synth3d.js';
import { createScene3dRenderer } from '../web/js/demo/scene3d.js';

/** RGBA → YUV 4:2:0（BT.601，limited range），寫成一幀 y4m。 */
function rgbaToI420(rgba, w, h) {
  const Y = new Uint8Array(w * h);
  const U = new Uint8Array((w / 2) * (h / 2));
  const V = new Uint8Array((w / 2) * (h / 2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      Y[y * w + x] = Math.max(0, Math.min(255, Math.round(16 + 0.257 * r + 0.504 * g + 0.098 * b)));
    }
  }
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const p = ((y + dy) * w + x + dx) * 4;
        r += rgba[p];
        g += rgba[p + 1];
        b += rgba[p + 2];
      }
      r /= 4;
      g /= 4;
      b /= 4;
      const i = (y / 2) * (w / 2) + x / 2;
      U[i] = Math.max(0, Math.min(255, Math.round(128 - 0.148 * r - 0.291 * g + 0.439 * b)));
      V[i] = Math.max(0, Math.min(255, Math.round(128 + 0.439 * r - 0.368 * g - 0.071 * b)));
    }
  }
  return [Y, U, V];
}

/**
 * @param {{out?:string, theta?:number, background?:boolean, width?:number, height?:number, fps?:number, script?:string[], seed?:number, png?:boolean, lead?:number}} o
 *   lead：開頭先放幾秒「還沒開始投」的畫面（給預檢找籃框用）
 * @returns {{file:string, plan:object}}
 */
export function makeCameraFeed(o = {}) {
  const width = o.width || 640;
  const height = o.height || 360;
  const fps = o.fps || 30;
  const plan = makeScene3d({
    seed: o.seed || 7,
    width,
    height,
    fps,
    camera: { thetaDeg: o.theta || 0, dist: 9, camHeight: 1.6, pitchDeg: 3 },
    background: !!o.background,
    script: o.script,
  });
  const out = o.out || join(tmpdir(), 'arclog-feed');
  mkdirSync(out, { recursive: true });
  const r = createScene3dRenderer(plan);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (o.png) {
    for (const t of [plan.shots[0].tRelease + 0.5, plan.shots[1] ? plan.shots[1].tCross + 0.1 : 1]) {
      const f = Math.round(t * fps);
      r.draw(ctx, f / fps, f);
      writeFileSync(join(out, `frame_${o.theta || 0}_${f}.png`), canvas.toBuffer('image/png'));
    }
    return { file: out, plan };
  }
  const file = join(out, `feed_t${o.theta || 0}${o.background ? '_bg' : ''}_${width}x${height}.y4m`);
  const fd = openSync(file, 'w');
  writeSync(fd, `YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420jpeg\n`);
  for (let f = 0; f < plan.frameCount; f++) {
    r.draw(ctx, f / fps, f);
    const img = ctx.getImageData(0, 0, width, height);
    const [Y, U, V] = rgbaToI420(img.data, width, height);
    writeSync(fd, 'FRAME\n');
    writeSync(fd, Y);
    writeSync(fd, U);
    writeSync(fd, V);
  }
  closeSync(fd);
  return { file, plan };
}

if (process.argv[1] && process.argv[1].endsWith('make_camera_feed.mjs')) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const res = makeCameraFeed({
    out: arg('out'),
    theta: Number(arg('theta', 0)),
    background: process.argv.includes('--background'),
    width: Number(arg('width', 640)),
    height: Number(arg('height', 360)),
    png: process.argv.includes('--png'),
  });
  console.log(res.file, `${res.plan.frameCount} 幀`);
}

/**
 * 同一個合成場景直接編成 H.264 MP4（畫面用管線送進 ffmpeg，不經過巨大的暫存檔）。給「上傳影片」的瀏覽器測試用。
 * 需要電腦裝有 ffmpeg；沒有就丟出錯誤（測試會跳過）。
 * @returns {Promise<{file:string, plan:object}>}
 */
export async function makeSceneMp4(o = {}) {
  const { spawn } = await import('node:child_process');
  const width = o.width || 1280;
  const height = o.height || 720;
  const fps = 30;
  const plan = makeScene3d({
    seed: o.seed || 11,
    width,
    height,
    fps,
    camera: { thetaDeg: o.theta || 0, dist: 9, camHeight: 1.6, pitchDeg: 3 },
    background: !!o.background,
    script: o.script,
  });
  const out = o.out || join(tmpdir(), 'arclog-feed');
  mkdirSync(out, { recursive: true });
  const file = join(out, o.name || `scene_t${o.theta || 0}_${width}x${height}.mp4`);
  const r = createScene3dRenderer(plan);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  const ff = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', '-',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file], { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  ff.stderr.on('data', (d) => (err += d));
  const done = new Promise((resolve, reject) => {
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 失敗：${err}`))));
  });
  for (let f = 0; f < plan.frameCount; f++) {
    r.draw(ctx, f / fps, f);
    const buf = Buffer.from(ctx.getImageData(0, 0, width, height).data.buffer);
    if (!ff.stdin.write(buf)) await new Promise((res) => ff.stdin.once('drain', res));
  }
  ff.stdin.end();
  await done;
  return { file, plan };
}
