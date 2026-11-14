// 模擬偵測器：只在示範模式和測試用。由 3D 合成場景的真實答案產生「像模型輸出」的偵測框，
// 加上位置和大小的雜訊、漏偵測（被球網遮住時漏得更多）、偶爾的誤偵測。純函式，不碰 DOM。
//
// 這樣網站的整條自動流程（自動校正、鏡頭角度、分球、進球判定、相機錄影）可以在「已知答案」下驗證。
// 它不是偵測模型：通過這裡的測試，不代表真的模型在實拍影片上也找得到。

import { truthAt } from './synth3d.js';
import { mulberry32, randNormal } from './prng.js';

export const SIMDET_DEFAULTS = {
  ballPos: 0.07, // 球心位置的雜訊（球徑的幾倍）
  ballSize: 0.06, // 球框大小的雜訊（比例）
  ballMiss: 0.1,
  netMiss: 0.65, // 球在網子裡時漏偵測的機率
  rimPos: 0.015, // 籃框框邊的雜訊（框寬的幾倍）
  rimMiss: 0.05,
  boardPos: 0.025,
  boardMiss: 0.12,
  falsePerFrame: 0.15, // 每幀平均幾個誤偵測（隨機位置的低信心小框，靜止的）
};

/**
 * @param {object} plan makeScene3d 的結果
 * @param {object} [opts]
 * @returns {(frame:number, t:number) => {cls:string, x:number, y:number, w:number, h:number, conf:number}[]}
 *   同一幀呼叫幾次都得到同樣的結果（依幀號決定亂數）
 */
export function createSimDetector(plan, opts = {}) {
  const o = { ...SIMDET_DEFAULTS, ...opts };
  const seed = (o.seed != null ? o.seed : plan.seed) >>> 0;
  // 固定的誤偵測位置（像牆上的圓形標誌）
  const r0 = mulberry32(seed ^ 0x5bd1e995);
  const fakes = [];
  for (let i = 0; i < 3; i++) fakes.push({ x: r0() * plan.width, y: r0() * plan.height * 0.8, s: 12 + r0() * 20 });
  return (frame, t) => {
    const rng = mulberry32((seed * 2654435761 + frame * 40503) >>> 0);
    const tr = truthAt(plan, t);
    const out = [];
    for (const b of tr.balls) {
      const miss = b.inNet ? o.netMiss : o.ballMiss;
      if (rng() < miss) continue;
      const d = b.w;
      const s = d * (1 + randNormal(rng) * o.ballSize);
      out.push({ cls: 'ball', x: b.x + randNormal(rng) * o.ballPos * d, y: b.y + randNormal(rng) * o.ballPos * d, w: s, h: s, conf: 0.4 + rng() * 0.5 });
    }
    for (const [list, cls, pos, miss] of [[tr.rims, 'rim', o.rimPos, o.rimMiss], [tr.boards, 'backboard', o.boardPos, o.boardMiss]]) {
      for (const b of list) {
        if (rng() < miss) continue;
        const w = b.x1 - b.x0;
        const n = () => randNormal(rng) * pos * Math.max(w, 20);
        const x0 = Math.max(0, b.x0 + n());
        const x1 = Math.min(plan.width, b.x1 + n());
        const y0 = Math.max(0, b.y0 + n());
        const y1 = Math.min(plan.height, b.y1 + n());
        if (!(x1 > x0 && y1 > y0)) continue;
        out.push({ cls, x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0, conf: 0.5 + rng() * 0.45 });
      }
    }
    let k = o.falsePerFrame;
    while (k > 0 && rng() < k) {
      const fk = fakes[Math.floor(rng() * fakes.length)];
      out.push({ cls: 'ball', x: fk.x + randNormal(rng), y: fk.y + randNormal(rng), w: fk.s, h: fk.s, conf: 0.1 + rng() * 0.2 });
      k -= 1;
    }
    return out;
  };
}

/** 整段影片（每 stride 幀）的模擬偵測結果，格式和網站收集的偵測相同（多了 f、t）。 */
export function simulateDetections(plan, opts = {}) {
  const det = createSimDetector(plan, opts);
  const stride = opts.stride || 1;
  const out = [];
  for (let f = 0; f < plan.frameCount; f += stride) {
    const t = f / plan.fps;
    for (const d of det(f, t)) out.push({ f, t, ...d });
  }
  return out;
}
