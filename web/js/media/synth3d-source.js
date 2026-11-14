// 示範模式（自動流程）的影格來源：3D 合成場景，可以選鏡頭角度、背景要不要有別人在投籃。
// 和 synth-source.js（正側面的 2D 示範，給手動標記流程用）實作同一個 FrameSource 介面。

import { makeScene3d, scene3dTruth, rimClickTruth } from '../core/synth3d.js';
import { createScene3dRenderer } from '../demo/scene3d.js';
import { clampIndex } from './source.js';

function domCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** 示範的三種擺法：θ 是相機繞出手點和籃框中間轉的角度（camera3d.js）。 */
export const DEMO_VIEWS = {
  side: { thetaDeg: 0, label: '側面' },
  oblique: { thetaDeg: -38, label: '斜後方約 45 度' },
  behind: { thetaDeg: -90, label: '投籃者正後方' },
};

/**
 * @param {{view?:'side'|'oblique'|'behind', background?:boolean, seed?:number, width?:number, height?:number}} [o]
 * @returns FrameSource，另外多了 plan3d、truth（每一球的真實答案）、synthetic3d=true
 */
export function createSynthetic3dSource(o = {}) {
  const view = DEMO_VIEWS[o.view] || DEMO_VIEWS.side;
  const plan = makeScene3d({
    seed: o.seed || 20261114,
    width: o.width || 1280,
    height: o.height || 720,
    camera: { thetaDeg: view.thetaDeg, dist: 9, camHeight: 1.6, pitchDeg: 3 },
    background: o.background !== false,
  });
  const renderer = createScene3dRenderer(plan);
  const canvas = domCanvas(plan.width, plan.height);
  const ctx = canvas.getContext('2d');
  const frameTimes = new Float64Array(plan.frameCount);
  for (let i = 0; i < plan.frameCount; i++) frameTimes[i] = i / plan.fps;
  let shown = -1;
  const render = (i) => {
    if (shown !== i) {
      renderer.draw(ctx, frameTimes[i], i);
      shown = i;
    }
  };
  const truth = scene3dTruth(plan).map((t) => ({ shot: t.shot, kind: t.kind, angleDeg: t.angleDeg, made: t.made, tRelease: t.tRelease, tCross: t.tCross, crossS: t.crossS }));
  return {
    engine: 'synthetic',
    name: `合成示範（${view.label}${o.background !== false ? '、背景有別人投籃' : ''}）`,
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
    synthetic3d: true,
    view: o.view || 'side',
    plan3d: plan,
    truth,
    // 「幫我點」：鐵圈內緣橢圓的最左、最右兩點（左邊靠近投籃者時就是前緣）
    hoopTruth: (() => {
      const c = rimClickTruth(plan);
      return c ? { front: c.left, back: c.right } : null;
    })(),
    renderer,
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
        await onFrame({ index: i, time: frameTimes[i], draw: (c, dx, dy, dw, dh) => c.drawImage(canvas, dx, dy, dw, dh) });
        frames++;
        if (frames % 8 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      return { frames, cancelled: false };
    },
    dispose() {},
  };
}

/**
 * 示範錄影用的「假相機」：把 3D 合成場景依真實時間畫到一張畫布上，再用 captureStream 變成影片串流，
 * 後面的錄影和即時分析就和真的相機走同一條路（不用要相機權限）。
 * @returns {{stream:MediaStream, plan:object, stop():void, startedAt:number}}
 */
export function createSyntheticCameraStream(o = {}) {
  const view = DEMO_VIEWS[o.view] || DEMO_VIEWS.side;
  const plan = makeScene3d({
    seed: o.seed || 20261115,
    width: 1280,
    height: 720,
    camera: { thetaDeg: view.thetaDeg, dist: 9, camHeight: 1.6, pitchDeg: 3 },
    background: o.background !== false,
  });
  const renderer = createScene3dRenderer(plan);
  const canvas = domCanvas(plan.width, plan.height);
  const ctx = canvas.getContext('2d');
  const t0 = performance.now();
  let raf = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const t = (performance.now() - t0) / 1000;
    // 劇本播完就從頭再播（示範錄影可以錄很久）
    const tt = t % plan.duration;
    const f = Math.floor(tt * plan.fps);
    renderer.draw(ctx, f / plan.fps, f);
    raf = requestAnimationFrame(tick);
  };
  tick();
  const stream = canvas.captureStream(plan.fps);
  return {
    stream,
    plan,
    canvas,
    startedAt: t0,
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      for (const tr of stream.getTracks()) tr.stop();
    },
  };
}
