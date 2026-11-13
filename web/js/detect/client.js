// 主畫面這一側的偵測器：負責開 Worker、選後端（WebGPU 優先，不行就 WASM）、送畫面、收結果。

const WORKER_URL = new URL('./worker.js', import.meta.url);
const MODELS_BASE = new URL('../../models/', import.meta.url).href;

/** 讀 models/manifest.json。讀不到就丟出錯誤。 */
export async function loadManifest() {
  const res = await fetch(`${MODELS_BASE}manifest.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`讀不到模型清單（HTTP ${res.status}）`);
  const m = await res.json();
  if (!m || !Array.isArray(m.models) || !m.models.length) throw new Error('模型清單是空的');
  return m;
}

/** 這個瀏覽器看起來能不能用 WebGPU（真的能不能用要到 Worker 裡試了才知道）。 */
export function webgpuLikely() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;
}

function startWorker(init, onProgress, timeoutMs) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_URL, { type: 'module' });
    } catch (err) {
      reject(new Error(`無法啟動背景執行緒：${err.message || err}`));
      return;
    }
    let timer = null;
    const fail = (message) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(message));
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail('等太久沒有回應'), timeoutMs);
    };
    worker.onerror = (e) => fail(e.message || '背景執行緒發生錯誤');
    worker.onmessageerror = () => fail('背景執行緒傳回無法讀取的訊息');
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        arm();
        onProgress(m);
      } else if (m.type === 'ready') {
        clearTimeout(timer);
        resolve({ worker, info: m });
      } else if (m.type === 'error') {
        fail(m.message);
      }
    };
    arm();
    const transfer = init.modelBuffer ? [init.modelBuffer] : [];
    worker.postMessage({ type: 'init', ...init }, transfer);
  });
}

/**
 * 建立偵測器。
 *
 * @param {object} o
 * @param {object} [o.model] manifest 裡的一筆模型
 * @param {File} [o.file] 或是使用者自己載入的 .onnx 檔
 * @param {boolean} [o.forceWasm] 不試 WebGPU
 * @param {number} [o.conf] 信心門檻（預設用模型建議值）
 * @param {(p:{stage:string, backend:string, loaded?:number, total?:number}) => void} [o.onProgress]
 * @returns {Promise<{backend:string, input:{width:number,height:number}, info:object, attempts:object[],
 *                    detect:(buffer:ArrayBuffer, lb:object) => Promise<{dets:object[], ms:number}>,
 *                    dispose:() => void}>}
 */
export async function createDetector(o) {
  const onProgress = o.onProgress || (() => {});
  const backends = [];
  if (!o.forceWasm && webgpuLikely()) backends.push('webgpu');
  backends.push('wasm');
  const threads = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2) || 1));
  const conf = o.conf != null ? o.conf : o.model && o.model.conf != null ? o.model.conf : 0.15;
  const attempts = [];

  for (const backend of backends) {
    const init = { backend, conf, iou: 0.5, maxDet: 12, threads };
    if (o.file) {
      // 每次嘗試都要一份新的緩衝區（傳給 Worker 之後這邊就不能再用了）
      init.modelBuffer = await o.file.arrayBuffer();
      init.classIndex = null;
    } else {
      const v = o.model.sha256 ? `?v=${String(o.model.sha256).slice(0, 12)}` : '';
      init.modelUrl = `${MODELS_BASE}${o.model.file}${v}`;
      init.input = o.model.input;
      init.classIndex = o.model.classIndex;
    }
    try {
      const { worker, info } = await startWorker(init, (p) => onProgress({ ...p, backend }), backend === 'webgpu' ? 45000 : 120000);
      return wrap(worker, info, attempts);
    } catch (err) {
      attempts.push({ backend, message: String(err.message || err) });
    }
  }
  const error = new Error(`偵測模型載入失敗：${attempts.map((a) => `${a.backend === 'webgpu' ? 'WebGPU' : 'WASM'}：${a.message}`).join('；')}`);
  error.attempts = attempts;
  throw error;
}

function wrap(worker, info, attempts) {
  const waiting = new Map();
  let nextId = 1;
  let dead = null;
  const killAll = (message) => {
    dead = new Error(message);
    for (const w of waiting.values()) w.reject(dead);
    waiting.clear();
  };
  worker.onerror = (e) => killAll(e.message || '背景執行緒發生錯誤');
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'result') {
      const w = waiting.get(m.id);
      if (w) {
        waiting.delete(m.id);
        w.resolve({ dets: m.dets, ms: m.ms });
      }
    } else if (m.type === 'error') {
      const w = m.id != null ? waiting.get(m.id) : null;
      if (w) {
        waiting.delete(m.id);
        w.reject(new Error(m.message));
      } else killAll(m.message);
    }
  };
  return {
    backend: info.backend,
    input: info.input,
    info,
    attempts,
    /** 目前還在等結果的幀數（用來控制送畫面的速度）。 */
    get pending() {
      return waiting.size;
    },
    detect(buffer, lb) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ type: 'detect', id, buffer, lb }, [buffer]);
      });
    },
    dispose() {
      killAll('偵測已經結束');
      try {
        worker.postMessage({ type: 'dispose' });
      } catch {
        /* Worker 已經不在了 */
      }
      setTimeout(() => worker.terminate(), 500);
    },
  };
}
