// 示範模式的影格來源：畫面是即時畫出來的，每一球都有已知的真實角度。

import { makeDemoPlan, planTruth, frameTime, hoopPx, verticalPx } from '../core/synth.js';
import { createSceneRenderer } from '../demo/scene.js';
import { clampIndex } from './source.js';

function domCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * @param {object} [planOpts] makeDemoPlan 的參數
 * @returns FrameSource，另外多了 plan、truth、hoopTruth、verticalTruth 四個示範模式專用的欄位
 */
export function createSyntheticSource(planOpts = {}) {
  const plan = makeDemoPlan(planOpts);
  const renderer = createSceneRenderer(plan, domCanvas);
  const canvas = domCanvas(plan.width, plan.height);
  const ctx = canvas.getContext('2d');
  const frameTimes = new Float64Array(plan.frameCount);
  for (let i = 0; i < plan.frameCount; i++) frameTimes[i] = frameTime(plan, i);
  let shown = -1;

  const render = (i) => {
    if (shown !== i) {
      renderer.draw(ctx, frameTimes[i]);
      shown = i;
    }
  };

  return {
    engine: 'synthetic',
    name: '合成示範',
    size: null,
    width: plan.width,
    height: plan.height,
    frameCount: plan.frameCount,
    frameTimes,
    fps: plan.fps,
    duration: plan.frameCount / plan.fps,
    timeSource: 'synthetic',
    codec: null,
    rotation: 0,
    warnings: [],
    synthetic: true,
    plan,
    truth: planTruth(plan),
    hoopTruth: hoopPx(plan),
    verticalTruth: verticalPx(plan), // 籃板的一條鉛直邊（「垂直參考線」基準的「幫我點」用）

    async getFrame(i) {
      const k = clampIndex(i, plan.frameCount);
      render(k);
      return { index: k, time: frameTimes[k], image: canvas };
    },

    async scan({ from = 0, to = plan.frameCount - 1, stride = 1, signal, onFrame }) {
      let frames = 0;
      for (let i = Math.max(0, from); i <= Math.min(to, plan.frameCount - 1); i += stride) {
        if (signal && signal.aborted) return { frames, cancelled: true };
        render(i);
        await onFrame({
          index: i,
          time: frameTimes[i],
          draw: (c, dx, dy, dw, dh) => c.drawImage(canvas, dx, dy, dw, dh),
        });
        frames++;
        // 讓出執行緒，介面才不會卡住
        if (frames % 8 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      return { frames, cancelled: false };
    },

    dispose() {},
  };
}
