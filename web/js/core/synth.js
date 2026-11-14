// 合成示範的物理：用拋體運動（含空氣阻力）產生一段「練投」，每一球都有已知的真實入框角度。
// 純函式，不碰 DOM、不畫圖（畫圖在 web/js/demo/scene.js）。
//
// 世界座標（公尺）：原點在籃框前緣、籃框平面高度；X 朝籃板方向、Y 朝上。
// 所以前緣 (0, 0)、後緣 (0.45, 0)、地板 Y = −3.05。
//
// 注意：合成資料和估計器用的是同一個物理模型，所以示範模式的誤差只反映標記與偵測的雜訊，
// 不代表實拍的準確度。

import {
  RIM_DIAMETER_M,
  BALL_DIAMETER_M,
  DRAG_K_PER_M,
  BALL_RADIUS_RIM,
} from './constants.js';
import { mulberry32, randNormal } from './prng.js';

export const GRAVITY = 9.81;
export const RIM_HEIGHT_M = 3.05;
const BALL_R = BALL_DIAMETER_M / 2;
const SIM_DT = 1 / 480;

/** 一步 RK4（dt 可以是負的，用來往回積分）。state = [x, y, vx, vy] */
function rk4(st, dt, k) {
  const f = (s) => {
    const v = Math.sqrt(s[2] * s[2] + s[3] * s[3]);
    return [s[2], s[3], -k * v * s[2], -GRAVITY - k * v * s[3]];
  };
  const add = (s, d, h) => [s[0] + d[0] * h, s[1] + d[1] * h, s[2] + d[2] * h, s[3] + d[3] * h];
  const k1 = f(st);
  const k2 = f(add(st, k1, dt / 2));
  const k3 = f(add(st, k2, dt / 2));
  const k4 = f(add(st, k3, dt));
  return [
    st[0] + (dt * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])) / 6,
    st[1] + (dt * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])) / 6,
    st[2] + (dt * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])) / 6,
    st[3] + (dt * (k1[3] + 2 * k2[3] + 2 * k3[3] + k4[3])) / 6,
  ];
}

/**
 * 由「過框狀態」往回積分到出手點。
 * @returns {{states:number[][], T:number}} states[i] 是過框前 i·SIM_DT 秒的狀態；T 是飛行時間
 */
function backwardFlight(crossX, angleDeg, speed, releaseX, k) {
  const th = (angleDeg * Math.PI) / 180;
  let st = [crossX, 0, speed * Math.cos(th), -speed * Math.sin(th)];
  const states = [st];
  for (let i = 0; i < 4000; i++) {
    const nx = rk4(st, -SIM_DT, k);
    states.push(nx);
    if (nx[0] <= releaseX) {
      const f = (st[0] - releaseX) / (st[0] - nx[0]);
      return { states, T: (i + f) * SIM_DT, yAtRelease: st[1] + (nx[1] - st[1]) * f };
    }
    st = nx;
  }
  return null;
}

/**
 * 設計一球：指定入框角度、過框位置、出手點，解出需要的速度。
 * @param {{angleDeg:number, crossX:number, releaseX:number, releaseY:number, dragK?:number}} spec
 *        長度單位公尺；releaseY 相對籃框平面（出手點比籃框低所以是負的）
 */
export function designFlight(spec) {
  const k = spec.dragK != null ? spec.dragK : DRAG_K_PER_M;
  let lo = 2.5;
  let hi = 16;
  let flight = null;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    const f = backwardFlight(spec.crossX, spec.angleDeg, mid, spec.releaseX, k);
    if (!f) {
      lo = mid;
      continue;
    }
    flight = f;
    if (f.yAtRelease > spec.releaseY) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-9) break;
  }
  if (!flight) return null;
  return { ...spec, dragK: k, T: flight.T, states: flight.states };
}

/** 飛行中（出手後 tau 秒，0 ≤ tau ≤ T）的狀態 [x, y, vx, vy]。 */
export function flightState(flight, tau) {
  const back = (flight.T - tau) / SIM_DT; // 距離過框還有幾步
  const n = flight.states.length - 1;
  const b = back < 0 ? 0 : back > n ? n : back;
  const i = Math.min(n - 1, Math.floor(b));
  const f = b - i;
  const s0 = flight.states[i];
  const s1 = flight.states[i + 1];
  return [
    s0[0] + (s1[0] - s0[0]) * f,
    s0[1] + (s1[1] - s0[1]) * f,
    s0[2] + (s1[2] - s0[2]) * f,
    s0[3] + (s1[3] - s0[3]) * f,
  ];
}

// ── 過框之後的簡易物理（只為了畫面看起來合理，不影響「真實角度」） ──────────

const BOARD_X = RIM_DIAMETER_M + 0.15;
const BOARD_Y0 = -0.15;
const BOARD_Y1 = 0.9;
const FLOOR_Y = -RIM_HEIGHT_M;

function collide(st) {
  let hit = false;
  for (const px of [0, RIM_DIAMETER_M]) {
    const dx = st[0] - px;
    const dy = st[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < BALL_R && d > 1e-9) {
      const nx = dx / d;
      const ny = dy / d;
      const vn = st[2] * nx + st[3] * ny;
      if (vn < 0) {
        st[2] -= 1.55 * vn * nx;
        st[3] -= 1.55 * vn * ny;
        hit = true;
      }
      st[0] = px + nx * BALL_R;
      st[1] = ny * BALL_R;
    }
  }
  if (st[0] + BALL_R > BOARD_X && st[0] < BOARD_X && st[1] > BOARD_Y0 && st[1] < BOARD_Y1 && st[2] > 0) {
    st[2] = -0.65 * st[2];
    st[0] = BOARD_X - BALL_R;
    hit = true;
  }
  if (st[1] - BALL_R < FLOOR_Y && st[3] < 0) {
    st[3] = -0.7 * st[3];
    st[2] *= 0.9;
    st[1] = FLOOR_Y + BALL_R;
    hit = true;
  }
  return hit;
}

function inNet(st) {
  return st[0] > 0.04 && st[0] < RIM_DIAMETER_M - 0.04 && st[1] < -0.02 && st[1] > -0.42;
}

/** 球第一次碰到框或籃板的時間（出手後秒數）；沒碰到就回傳 null。 */
function firstContact(flight) {
  const steps = Math.floor(flight.T / SIM_DT);
  for (let i = 0; i <= steps; i++) {
    const s = flightState(flight, i * SIM_DT);
    for (const px of [0, RIM_DIAMETER_M]) {
      const dx = s[0] - px;
      if (dx * dx + s[1] * s[1] < BALL_R * BALL_R) return i * SIM_DT;
    }
    if (s[0] + BALL_R > BOARD_X && s[1] > BOARD_Y0 && s[1] < BOARD_Y1) return i * SIM_DT;
  }
  return null;
}

/**
 * 從某個狀態開始模擬碰撞、球網、落地。
 * @returns {{states:number[][], made:boolean}} states 每 SIM_DT 一筆；
 *          made = 球有沒有由上往下穿過籃框並掉進球網
 */
function simulateAfter(start, duration, k) {
  const states = [start.slice()];
  let st = start.slice();
  // 球心由上往下通過籃框平面、而且在前後緣之間，才算進了框（球網也才會作用在球上）
  let entered = start[1] <= 1e-9 && start[1] > -0.05 && start[3] < 0 && start[0] > 0 && start[0] < RIM_DIAMETER_M;
  let made = false;
  const steps = Math.ceil(duration / SIM_DT);
  for (let i = 0; i < steps; i++) {
    const prevY = st[1];
    st = rk4(st, SIM_DT, k);
    if (!entered && prevY > 0 && st[1] <= 0 && st[0] > 0 && st[0] < RIM_DIAMETER_M) entered = true;
    if (entered && inNet(st)) {
      // 球網：把球往網子中間帶，並把速度拖慢
      st[0] += (RIM_DIAMETER_M / 2 - st[0]) * Math.min(1, 16 * SIM_DT);
      st[2] *= 1 - 25 * SIM_DT;
      st[3] *= 1 - 7 * SIM_DT;
      if (st[1] < -0.3) made = true;
    }
    collide(st);
    // 進框後又彈出來（很少見）就不算
    if (entered && !made && st[1] > 0.05) entered = false;
    states.push(st.slice());
  }
  return { states, made };
}

// ── 示範劇本 ────────────────────────────────────────────────────────────────

/** 示範的 10 球：目標入框角度（度）和結果。順序會用種子打亂。 */
const DEMO_SHOTS = [
  { angle: 45.0, kind: 'make' },
  { angle: 47.5, kind: 'make' },
  { angle: 43.0, kind: 'make' },
  { angle: 50.5, kind: 'make' },
  { angle: 41.0, kind: 'short' },
  { angle: 46.0, kind: 'make' },
  { angle: 38.5, kind: 'long' },
  { angle: 44.0, kind: 'make' },
  { angle: 52.5, kind: 'short' },
  { angle: 40.0, kind: 'long' },
];

/**
 * 產生一段合成練投的劇本。
 *
 * @param {object} [opts]
 * @param {number} [opts.seed=20261113]
 * @param {number} [opts.shots=10]
 * @param {number} [opts.fps=30]
 * @param {number} [opts.width=1280]
 * @param {number} [opts.height=720]
 * @param {number} [opts.pxPerM=150]
 * @param {number} [opts.floorMarginM=0.3] 地板線以下還看得到多少（公尺）
 * @param {boolean} [opts.mirror=false] true = 投籃者在畫面右邊
 * @param {number} [opts.rollDeg=0] 相機歪斜角度（測試用）
 * @param {number} [opts.dragK] 預設用 DRAG_K_PER_M；0 = 純拋物線
 * @param {{angle:number, kind:'make'|'short'|'long'}[]} [opts.script] 自訂每球
 */
export function makeDemoPlan(opts = {}) {
  const o = {
    seed: 20261113,
    shots: 10,
    fps: 30,
    width: 1280,
    height: 720,
    pxPerM: 150,
    floorMarginM: 0.3,
    mirror: false,
    rollDeg: 0,
    hold: 0.4,
    post: 0.75,
    fade: 0.2,
    gap: 0.25,
    ...opts,
  };
  const dragK = o.dragK != null ? o.dragK : DRAG_K_PER_M;
  const rng = mulberry32(o.seed);

  // 劇本：預設用 DEMO_SHOTS，依種子打亂並加一點點隨機，讓真實角度不是整數
  let script = o.script ? o.script.slice() : [];
  if (!o.script) {
    const base = DEMO_SHOTS.slice();
    for (let i = base.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = base[i];
      base[i] = base[j];
      base[j] = tmp;
    }
    for (let i = 0; i < o.shots; i++) {
      const b = base[i % base.length];
      script.push({ angle: b.angle + (rng() - 0.5) * 1.6, kind: b.kind });
    }
  }

  const shots = [];
  let t = 0.3;
  for (let i = 0; i < script.length; i++) {
    const sc = script[i];
    const sinA = Math.sin((sc.angle * Math.PI) / 180);
    // 過框位置 s：進球落在「不碰框」的範圍內，偏短/偏長則明顯落在框外
    let s;
    if (sc.s != null) s = sc.s;
    else if (sc.kind === 'make') {
      const lo = Math.max(0.46, BALL_RADIUS_RIM / sinA + 0.04);
      s = lo + rng() * (0.69 - lo);
    } else if (sc.kind === 'short') s = -0.38 + rng() * 0.3;
    else s = 1.08 + rng() * 0.22;
    // 出手點：投籃者站在固定位置，每球只有一點點差異
    const releaseX = sc.releaseX != null ? sc.releaseX : -(3.88 + rng() * 0.1);
    const releaseY = sc.releaseY != null ? sc.releaseY : -(0.76 + rng() * 0.12);
    // 進球與否以碰撞模擬的結果為準（畫面上看到什麼就是什麼）。
    // 劇本想要「沒進」但模擬結果彈進去了，就把落點再往外挪一點重試。
    let flight = null;
    let handover = 0;
    let sim = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      flight = designFlight({ angleDeg: sc.angle, crossX: s * RIM_DIAMETER_M, releaseX, releaseY, dragK });
      if (!flight) break;
      const contact = firstContact(flight);
      handover = contact != null ? contact : flight.T;
      sim = simulateAfter(flightState(flight, handover), o.post + o.fade, dragK);
      if (sc.s != null || sim.made === (sc.kind === 'make')) break;
      if (sc.kind === 'short') s -= 0.08;
      else if (sc.kind === 'long') s += 0.08;
      else s += (0.56 - s) * 0.5;
    }
    if (!flight) continue;
    const after = sim.states;
    const tRelease = t + o.hold;
    shots.push({
      index: i,
      kind: sc.kind,
      made: sim.made,
      angleDeg: sc.angle, // 真實入框角度（未受碰撞影響的軌跡在籃框平面的切線）
      crossS: s,
      flight,
      tAppear: t,
      tRelease,
      tCross: tRelease + flight.T,
      tHandover: tRelease + handover,
      tFadeStart: tRelease + handover + o.post,
      tGone: tRelease + handover + o.post + o.fade,
      after,
      spin: -(2 + rng() * 1.5) * 2 * Math.PI, // 後旋，弧度/秒
    });
    t = tRelease + handover + o.post + o.fade + o.gap;
  }

  const duration = t + 0.3;
  const frameCount = Math.round(duration * o.fps);
  // 籃框前緣在畫面上的位置：讓整條拋物線和地板都入鏡
  const originPx = {
    x: o.mirror ? o.width - (o.width * 0.735) : o.width * 0.735,
    y: o.height - (RIM_HEIGHT_M + o.floorMarginM) * o.pxPerM,
  };
  const roll = (o.rollDeg * Math.PI) / 180;
  return {
    seed: o.seed,
    fps: o.fps,
    width: o.width,
    height: o.height,
    pxPerM: o.pxPerM,
    mirror: !!o.mirror,
    rollDeg: o.rollDeg,
    dragK,
    originPx,
    cosR: Math.cos(roll),
    sinR: Math.sin(roll),
    duration,
    frameCount,
    shots,
  };
}

/** 世界座標（公尺）→ 畫面像素。 */
export function worldToPx(plan, X, Y) {
  const sx = (plan.mirror ? -X : X) * plan.pxPerM;
  const sy = -Y * plan.pxPerM;
  return {
    x: plan.originPx.x + sx * plan.cosR - sy * plan.sinR,
    y: plan.originPx.y + sx * plan.sinR + sy * plan.cosR,
  };
}

/** 第 i 幀的時間（秒）。合成畫面是固定幀率。 */
export function frameTime(plan, i) {
  return i / plan.fps;
}

/**
 * 某個時間點球的狀態。
 * @returns {null | {shot:number, phase:'held'|'flight'|'after', X:number, Y:number,
 *   vx:number, vy:number, alpha:number, x:number, y:number, spin:number}}
 *   null 代表畫面上沒有球
 */
export function ballAt(plan, t) {
  for (let i = 0; i < plan.shots.length; i++) {
    const sh = plan.shots[i];
    if (t < sh.tAppear || t >= sh.tGone) continue;
    let st;
    let phase;
    if (t < sh.tRelease) {
      st = flightState(sh.flight, 0);
      st = [st[0], st[1], 0, 0];
      phase = 'held';
    } else if (t < sh.tHandover) {
      st = flightState(sh.flight, t - sh.tRelease);
      phase = 'flight';
    } else {
      const b = (t - sh.tHandover) / SIM_DT;
      const n = sh.after.length - 1;
      const k = Math.min(n - 1, Math.floor(b));
      const f = Math.min(1, b - k);
      const s0 = sh.after[k];
      const s1 = sh.after[k + 1];
      st = [
        s0[0] + (s1[0] - s0[0]) * f,
        s0[1] + (s1[1] - s0[1]) * f,
        s0[2] + (s1[2] - s0[2]) * f,
        s0[3] + (s1[3] - s0[3]) * f,
      ];
      phase = 'after';
    }
    const alpha = t < sh.tFadeStart ? 1 : Math.max(0, 1 - (t - sh.tFadeStart) / (sh.tGone - sh.tFadeStart));
    const p = worldToPx(plan, st[0], st[1]);
    return {
      shot: i,
      phase,
      X: st[0],
      Y: st[1],
      vx: st[2],
      vy: st[3],
      alpha,
      x: p.x,
      y: p.y,
      spin: phase === 'held' ? 0 : sh.spin * (t - sh.tRelease),
    };
  }
  return null;
}

/** 籃框前緣、後緣在畫面上的真實位置（示範模式「幫我點」和測試用）。 */
export function hoopPx(plan) {
  return { front: worldToPx(plan, 0, 0), back: worldToPx(plan, RIM_DIAMETER_M, 0) };
}

/**
 * 一條鉛直參考線（籃板正面的中線，從籃板下緣往上到接近上緣）在畫面上的兩端。
 * 示範模式選「垂直參考線」時，「幫我點」用它。合成畫面沒有透視、沒有歪，所以這條線在畫面上是正的。
 */
export function verticalPx(plan) {
  const x = BOARD_X + 0.02;
  return { top: worldToPx(plan, x, BOARD_Y1 - 0.05), bottom: worldToPx(plan, x, BOARD_Y0 + 0.05) };
}

/** 每一球的真實答案。 */
export function planTruth(plan) {
  return plan.shots.map((sh, i) => ({
    shot: i + 1,
    angleDeg: sh.angleDeg,
    crossS: sh.crossS,
    made: sh.made,
    tRelease: sh.tRelease,
    tCross: sh.tCross,
  }));
}

/**
 * 模擬使用者在一球的飛行途中點幾個球心（給測試和合成標註包用）。
 * @returns {{frame:number, t:number, x:number, y:number}[]}
 */
export function simulateClicks(plan, shotIndex, opts = {}) {
  const o = { count: 6, noisePx: 1.5, seed: 7, ...opts };
  const sh = plan.shots[shotIndex];
  const rng = mulberry32(o.seed + shotIndex * 101);
  const f0 = Math.ceil((sh.tRelease + 0.04) * plan.fps);
  const f1 = Math.floor((Math.min(sh.tCross, sh.tHandover) - 0.03) * plan.fps);
  const out = [];
  for (let i = 0; i < o.count; i++) {
    const frame = Math.round(f0 + ((f1 - f0) * i) / (o.count - 1));
    if (out.length && out[out.length - 1].frame === frame) continue;
    const t = frameTime(plan, frame);
    const b = ballAt(plan, t);
    if (!b) continue;
    out.push({
      frame,
      t,
      x: b.x + randNormal(rng) * o.noisePx,
      y: b.y + randNormal(rng) * o.noisePx,
    });
  }
  return out;
}
