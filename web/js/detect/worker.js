// 偵測用的 Web Worker：在背景執行緒載入 onnxruntime-web 和模型，逐幀找出籃球。
// 推論放在 Worker 裡，主畫面才不會卡住。
//
// 訊息（主畫面 → Worker）
//   { type: 'init', backend: 'webgpu'|'wasm', modelUrl | modelBuffer, input?: {width, height},
//     classIndex?, conf, iou, maxDet, threads }
//   { type: 'detect', id, buffer（已縮放補邊成模型輸入大小的 RGBA）, lb（letterbox 參數）}
//   { type: 'dispose' }
// 訊息（Worker → 主畫面）
//   { type: 'progress', stage: 'runtime'|'download'|'session'|'warmup', loaded?, total? }
//   { type: 'ready', backend, input, outputDims, classIndex, numClasses, warmupMs, threads }
//   { type: 'result', id, dets, ms }
//   { type: 'error', id, stage, message }

import { decodeDetections, rgbaToChw } from '../core/yolo.js';

const VENDOR = new URL('../../vendor/ort-1.31.1/', import.meta.url).href;

let ort = null;
let session = null;
let inputName = '';
let inW = 0;
let inH = 0;
let chw = null;
let cfg = null;
let classIndex = 0;

const post = (msg, transfer) => self.postMessage(msg, transfer || []);

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下載模型失敗（HTTP ${res.status}）`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.length, buf.length);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

async function run(data) {
  const tensor = new ort.Tensor('float32', data, [1, 3, inH, inW]);
  const outputs = await session.run({ [inputName]: tensor });
  const out = outputs[session.outputNames[0]];
  const values = typeof out.getData === 'function' && out.location && out.location !== 'cpu' ? await out.getData() : out.data;
  return { data: values, dims: Array.from(out.dims, Number) };
}

async function init(m) {
  cfg = m;
  if (m.backend === 'webgpu') {
    if (!self.navigator || !self.navigator.gpu) throw new Error('這個瀏覽器沒有 WebGPU');
    const adapter = await self.navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('拿不到 WebGPU 的顯示卡');
  }
  post({ type: 'progress', stage: 'runtime' });
  ort = await import(`${VENDOR}${m.backend === 'webgpu' ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'}`);
  ort.env.wasm.wasmPaths = VENDOR;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, m.threads || 1) : 1;
  ort.env.logLevel = 'error';

  let bytes;
  if (m.modelBuffer) bytes = new Uint8Array(m.modelBuffer);
  else bytes = await fetchWithProgress(m.modelUrl, (loaded, total) => post({ type: 'progress', stage: 'download', loaded, total }));

  post({ type: 'progress', stage: 'session' });
  session = await ort.InferenceSession.create(bytes, { executionProviders: [m.backend], graphOptimizationLevel: 'all' });
  inputName = session.inputNames[0];

  inW = m.input && m.input.width ? m.input.width : 0;
  inH = m.input && m.input.height ? m.input.height : 0;
  if (!(inW > 0 && inH > 0)) {
    const meta = session.inputMetadata && session.inputMetadata[0];
    const shape = meta && Array.isArray(meta.shape) ? meta.shape : null;
    if (shape && shape.length === 4 && Number(shape[2]) > 0 && Number(shape[3]) > 0) {
      inH = Number(shape[2]);
      inW = Number(shape[3]);
    }
  }
  if (!(inW > 0 && inH > 0)) throw new Error('看不出這個模型的輸入大小（需要固定的 [1, 3, 高, 寬]）');

  // 用一張全灰的圖跑一次：暖機，同時確認輸出的形狀和數值是合理的
  post({ type: 'progress', stage: 'warmup' });
  chw = new Float32Array(3 * inW * inH).fill(114 / 255);
  const t0 = performance.now();
  const out = await run(chw);
  const warmupMs = performance.now() - t0;
  if (out.dims.length !== 3) throw new Error(`模型輸出的形狀不對：[${out.dims.join(', ')}]`);
  for (let i = 0; i < out.data.length; i += 97) {
    if (!Number.isFinite(out.data[i])) throw new Error('模型輸出有無效的數值（這個裝置的推論後端可能有問題）');
  }
  const oneToOne = out.dims[2] === 6 && out.dims[1] !== 6;
  const numClasses = oneToOne ? null : out.dims[1] - 4;
  if (m.classIndex != null) classIndex = m.classIndex;
  else if (numClasses === 80) classIndex = 32; // COCO 的 sports ball
  else classIndex = 0;
  if (!oneToOne && (numClasses < 1 || classIndex >= numClasses)) {
    throw new Error(`模型只有 ${numClasses} 個類別，找不到類別 ${classIndex}`);
  }
  post({
    type: 'ready',
    backend: m.backend,
    input: { width: inW, height: inH },
    outputDims: out.dims,
    classIndex,
    numClasses,
    warmupMs,
    threads: ort.env.wasm.numThreads,
  });
}

async function detect(m) {
  const t0 = performance.now();
  rgbaToChw(new Uint8ClampedArray(m.buffer), inW, inH, chw);
  const out = await run(chw);
  const dets = decodeDetections(out.data, out.dims, {
    classIndex,
    conf: cfg.conf,
    iou: cfg.iou,
    maxDet: cfg.maxDet,
    lb: m.lb,
  });
  post({ type: 'result', id: m.id, dets, ms: performance.now() - t0 });
}

async function handle(m) {
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'detect') await detect(m);
    else if (m.type === 'dispose') {
      try {
        if (session) await session.release();
      } finally {
        self.close();
      }
    }
  } catch (err) {
    post({ type: 'error', id: m.id != null ? m.id : null, stage: m.type, message: String(err && err.message ? err.message : err) });
  }
}

// 一次只處理一個訊息。主畫面會提早送下一幀過來（讓解碼和推論重疊），
// 但同一個 session 不能同時跑兩次推論（WebGPU 版會卡住），而且輸入緩衝區是共用的。
let queue = Promise.resolve();
self.onmessage = (e) => {
  queue = queue.then(() => handle(e.data));
};
