// 模擬偵測器（只在示範模式用）：讀畫面左下角的幀號條碼，查 3D 合成場景這一幀的真實答案，
// 加上雜訊和漏偵測後回傳（core/simdetect.js）。介面和 client.js 的 createDetector 相同，
// 所以自動流程的其他部分（相機錄影、即時分析、自動校正、分球）不知道也不需要知道它是模擬的。
//
// 它不是偵測模型：用它跑通流程，不代表真的模型在實拍影片上也找得到球、籃框、籃板。

import { createSimDetector } from '../core/simdetect.js';
import { readBarcode } from '../demo/scene3d.js';

/**
 * @param {object} plan makeScene3d 的結果
 * @param {{width:number, height:number}} [input] 模型輸入大小（和真的模型一樣，畫面會先縮放補邊成這個大小）
 */
export function createSimulatedDetector(plan, input = { width: 640, height: 384 }, opts = {}) {
  const sim = createSimDetector(plan, opts);
  let pending = 0;
  let unreadable = 0;
  return {
    backend: 'simulated',
    input,
    info: { threads: 1, backend: 'simulated' },
    attempts: [],
    classes: { ball: 0, rim: 1, backboard: 2 },
    simulated: true,
    get pending() {
      return pending;
    },
    /** 讀不到條碼的幀數（畫面不是合成場景，或被縮得太小）。 */
    get unreadable() {
      return unreadable;
    },
    async detect(buffer, lb) {
      pending++;
      const t0 = performance.now();
      try {
        await Promise.resolve();
        const rgba = new Uint8ClampedArray(buffer);
        // 實際的影片大小（相機可能把畫面縮放成和劇本不同的大小）：由縮放補邊的參數反推
        const srcW = lb ? lb.newW / lb.scale : plan.width;
        const srcH = lb ? lb.newH / lb.scale : plan.height;
        const sx = srcW / plan.width;
        const sy = srcH / plan.height;
        const frame = readBarcode(rgba, input.width, input.height, srcW, srcH, lb);
        if (frame == null || frame >= plan.frameCount * 1000) {
          unreadable++;
          return { dets: [], ms: performance.now() - t0, frame: null };
        }
        // 示範錄影的假相機會從頭重播：幀號除以總幀數取餘數
        const f = frame % plan.frameCount;
        const dets = sim(f, f / plan.fps).map((d) => ({
          cls: d.cls,
          x: d.x * sx,
          y: d.y * sy,
          w: d.w * sx,
          h: d.h * sy,
          conf: d.conf,
        }));
        return { dets, ms: performance.now() - t0, frame: f };
      } finally {
        pending--;
      }
    },
    dispose() {},
  };
}
