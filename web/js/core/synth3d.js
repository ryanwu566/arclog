// 3D 合成練投：用來驗證自動模式（自動校正、鏡頭角度、分球、進球判定）。純函式，不碰 DOM。
//
// 座標和 camera3d.js 相同（籃框中心 (0, 3.05, 0)、出手點約 x = −4.2、籃板正面 x = 0.375）。
// 物理：含空氣阻力的拋體；籃框鐵圈當成圓環做碰撞；籃板、地板反彈；球網把穿過籃框的球拖慢並往中間拉。
// 碰撞和球網只是讓畫面「看起來合理」的簡化模型，不是真實的接觸力學。
//
// 和 synth.js（正側面的 2D 示範）一樣：合成資料和估計器用同一個拋體模型，
// 所以這裡驗證的是「程式照設計在運作」，不是實拍準確度。

import { DRAG_K_PER_M, BALL_DIAMETER_M } from './constants.js';
import { designFlight, flightState, GRAVITY } from './synth.js';
import { mulberry32 } from './prng.js';
import { RIM_Y, RIM_R, BOARD, SHOOT_X, makeCamera, projectBall, rimBox, boardBox } from './camera3d.js';

export const BALL_R = BALL_DIAMETER_M / 2;
const TUBE = 0.009; // 鐵條半徑
const RIM_TUBE_R = RIM_R + TUBE; // 鐵條中心到籃框中心
const NET_DEPTH = 0.42;
const DT = 1 / 480;

/** 一步 RK4（只有重力和空氣阻力）。s = [x, y, z, vx, vy, vz] */
function rk4(s, dt, k) {
  const f = (q) => {
    const v = Math.hypot(q[3], q[4], q[5]);
    return [q[3], q[4], q[5], -k * v * q[3], -GRAVITY - k * v * q[4], -k * v * q[5]];
  };
  const add = (q, d, h) => q.map((x, i) => x + d[i] * h);
  const k1 = f(s);
  const k2 = f(add(s, k1, dt / 2));
  const k3 = f(add(s, k2, dt / 2));
  const k4 = f(add(s, k3, dt));
  return s.map((x, i) => x + (dt * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])) / 6);
}

/** 以法向量 n 反彈（e 是法向的恢復係數，mu 是切向保留比例）。 */
function bounce(s, nx, ny, nz, e, mu) {
  const vn = s[3] * nx + s[4] * ny + s[5] * nz;
  if (vn >= 0) return false;
  const tx = s[3] - vn * nx;
  const ty = s[4] - vn * ny;
  const tz = s[5] - vn * nz;
  s[3] = mu * tx - e * vn * nx;
  s[4] = mu * ty - e * vn * ny;
  s[5] = mu * tz - e * vn * nz;
  return true;
}

/** 碰撞：籃框鐵圈、籃板、地板。hoop 是籃框中心 {x, z}（別的籃框用）。回傳有沒有碰到框或板。 */
function collide(s, hoop) {
  let hit = false;
  // 鐵圈：球心到鐵條中心圓的最近點
  const dx = s[0] - hoop.x;
  const dz = s[2] - hoop.z;
  const rh = Math.hypot(dx, dz) || 1e-9;
  const px = hoop.x + (RIM_TUBE_R * dx) / rh;
  const pz = hoop.z + (RIM_TUBE_R * dz) / rh;
  const ex = s[0] - px;
  const ey = s[1] - RIM_Y;
  const ez = s[2] - pz;
  const d = Math.hypot(ex, ey, ez);
  if (d < BALL_R + TUBE && d > 1e-9) {
    if (bounce(s, ex / d, ey / d, ez / d, 0.55, 0.85)) hit = true;
    const push = (BALL_R + TUBE) / d;
    s[0] = px + ex * push;
    s[1] = RIM_Y + ey * push;
    s[2] = pz + ez * push;
  }
  // 籃板正面（只算我們的籃框；別的籃框的籃板方向不同，簡化成不碰）
  if (hoop.board && s[0] + BALL_R > BOARD.x0 && s[0] < BOARD.x0 + 0.05 && s[1] > BOARD.y0 && s[1] < BOARD.y1 && s[2] > BOARD.z0 && s[2] < BOARD.z1 && s[3] > 0) {
    bounce(s, -1, 0, 0, 0.6, 0.9);
    s[0] = BOARD.x0 - BALL_R;
    hit = true;
  }
  if (s[1] < BALL_R && s[4] < 0) {
    bounce(s, 0, 1, 0, 0.72, 0.85);
    s[1] = BALL_R;
  }
  return hit;
}

/**
 * 從出手狀態往後模擬（碰撞、球網、落地）。
 * @returns {{states:number[][], made:boolean, contact:number|null, tCross:number|null, entered:boolean}}
 *   states 每 DT 一筆 [x,y,z,vx,vy,vz,inNet(0/1)]；contact＝第一次碰到框或板的時間
 */
function simulate(start, duration, k, hoop) {
  let s = start.slice();
  const states = [[...s, 0]];
  let entered = false;
  let made = false;
  let contact = null;
  let tCross = null;
  const steps = Math.ceil(duration / DT);
  for (let i = 1; i <= steps; i++) {
    const prevY = s[1];
    s = rk4(s, DT, k);
    const rh = Math.hypot(s[0] - hoop.x, s[2] - hoop.z);
    if (prevY > RIM_Y && s[1] <= RIM_Y && tCross == null && s[4] < 0) tCross = i * DT;
    if (!entered && prevY > RIM_Y && s[1] <= RIM_Y && rh < RIM_R) entered = true;
    let inNet = 0;
    if (entered && s[1] < RIM_Y && s[1] > RIM_Y - NET_DEPTH && rh < RIM_R + 0.02) {
      // 球網：水平往籃框中間拉、速度拖慢
      inNet = 1;
      const pull = Math.min(1, 14 * DT);
      s[0] += (hoop.x - s[0]) * pull;
      s[2] += (hoop.z - s[2]) * pull;
      s[3] *= 1 - 24 * DT;
      s[5] *= 1 - 24 * DT;
      s[4] *= 1 - 7 * DT;
      if (s[1] < RIM_Y - 0.32) made = true;
    }
    if (collide(s, hoop) && contact == null) contact = i * DT;
    // 進框後又被彈出來就不算
    if (entered && !made && s[1] > RIM_Y + 0.06) entered = false;
    states.push([...s, inNet]);
  }
  return { states, made, contact, tCross, entered };
}

function stateAt(states, tau) {
  const b = Math.max(0, tau / DT);
  const n = states.length - 1;
  const i = Math.min(n - 1, Math.floor(b));
  const f = Math.min(1, b - i);
  const a = states[i];
  const c = states[i + 1];
  return a.map((x, j) => x + (c[j] - x) * f);
}

/**
 * 設計一球。
 * @param {object} sp
 * @param {number} sp.angle 目標入框角度（度；未受碰撞影響的軌跡）
 * @param {number} sp.s 過框位置（沿投籃方向，0 前緣、1 後緣，以籃框內徑為單位）
 * @param {number} [sp.z=0] 過框時的橫向偏移（公尺；+ 往偏角 0 度的相機那一側）
 * @param {{x:number, y:number, z:number}} sp.release 出手點
 * @param {{x:number, z:number, board?:boolean}} [sp.hoop] 投哪一個籃框（預設我們的）
 * @param {number} [sp.dirSign=1] 投籃方向：+1 沿 +x
 */
export function designShot3d(sp, k = DRAG_K_PER_M, after = 1.6) {
  const hoop = sp.hoop || { x: 0, z: 0, board: true };
  const dir = sp.dir || [1, 0]; // 籃框的「投籃方向」（水平單位向量，x 和 z）
  // 過框點：籃框中心往投籃方向 (s − 0.5)·直徑，再往橫向 z
  const off = (sp.s - 0.5) * 2 * RIM_R;
  const lat = [-dir[1], dir[0]]; // 橫向（dir 轉 90 度）
  const cross = [hoop.x + off * dir[0] + (sp.z || 0) * lat[0], hoop.z + off * dir[1] + (sp.z || 0) * lat[1]];
  const R = sp.release;
  const hx = cross[0] - R.x;
  const hz = cross[1] - R.z;
  const D = Math.hypot(hx, hz);
  const flight = designFlight({ angleDeg: sp.angle, crossX: D, releaseX: 0, releaseY: R.y - RIM_Y, dragK: k });
  if (!flight) return null;
  const st = flightState(flight, 0);
  const ux = hx / D;
  const uz = hz / D;
  const start = [R.x, R.y, R.z, st[2] * ux, st[3], st[2] * uz];
  const sim = simulate(start, flight.T + after, k, hoop);
  return { ...sp, hoop, T: flight.T, start, sim, crossPt: cross };
}

// ── 劇本 ────────────────────────────────────────────────────────────────

/**
 * 每一種球的過框參數。結果（進或沒進）以碰撞模擬為準，不是依這張表。
 *   swish 空心、rimin 擦前框進、rimout 打後框彈出、short 麵包球（太短）、long 太長打板、
 *   side 從籃框旁邊經過（側拍看起來像穿過籃框；z 往相機那一側）、behind 從籃框後面經過（離相機遠的那一側）、
 *   offset 進球但左右偏 8 到 10 公分（球心不在投籃平面上）
 */
export const KINDS = {
  swish: (r) => ({ s: 0.5 + (r() - 0.5) * 0.14, z: (r() - 0.5) * 0.05 }),
  rimin: (r) => ({ s: 0.36 + r() * 0.03, z: 0.09 + r() * 0.03 }),
  rimout: (r) => ({ s: 0.93 + r() * 0.05, z: (r() - 0.5) * 0.04 }),
  short: (r) => ({ s: -0.9 + r() * 0.3, z: (r() - 0.5) * 0.1 }),
  long: (r) => ({ s: 1.25 + r() * 0.1, z: (r() - 0.5) * 0.1 }),
  offset: (r) => ({ s: 0.5 + (r() - 0.5) * 0.06, z: (r() < 0.5 ? -1 : 1) * (0.08 + r() * 0.02) }),
  side: (r) => ({ s: 0.45 + r() * 0.1, z: 0.42 + r() * 0.08 }),
  behind: (r) => ({ s: 0.45 + r() * 0.1, z: -(0.42 + r() * 0.08) }),
};

export const DEFAULT_SCRIPT = ['swish', 'rimout', 'swish', 'short', 'rimin', 'side', 'swish', 'behind', 'long', 'swish'];

/**
 * 產生一段 3D 合成練投。
 * @param {object} [o]
 * @param {number} [o.seed]
 * @param {string[]} [o.script] 每一球的種類（KINDS 的鍵）
 * @param {number} [o.fps=30] @param {number} [o.width=1280] @param {number} [o.height=720]
 * @param {object} [o.camera] makeCamera 的參數（thetaDeg、dist、camHeight、pitchDeg…）
 * @param {boolean} [o.background=false] 背景有另一個籃框、另一個人在投籃、有人運球和傳球
 * @param {number} [o.shotYawDeg=0] 投籃方向和籃板的垂直線差幾度（從側翼投）
 */
export function makeScene3d(o = {}) {
  const seed = o.seed != null ? o.seed : 20261114;
  const rng = mulberry32(seed);
  const fps = o.fps || 30;
  const width = o.width || 1280;
  const height = o.height || 720;
  const cam = makeCamera({ width, height, ...(o.camera || {}) });
  const k = o.dragK != null ? o.dragK : DRAG_K_PER_M;
  const script = o.script || DEFAULT_SCRIPT;
  const hold = 0.5;

  const shots = [];
  let t = 0.6;
  for (let i = 0; i < script.length; i++) {
    const kind = script[i];
    const p = KINDS[kind](rng);
    const angle = 41 + rng() * 10;
    // shotYawDeg：投籃方向和籃板不垂直（例如從 45 度角投），出手點繞籃框中心轉這麼多度
    const sy = ((o.shotYawDeg || 0) * Math.PI) / 180;
    const rx = SHOOT_X + (rng() - 0.5) * 0.12;
    const rz = (rng() - 0.5) * 0.1;
    const release = { x: rx * Math.cos(sy) - rz * Math.sin(sy), y: 2.15 + rng() * 0.12, z: -rx * Math.sin(sy) + rz * Math.cos(sy) };
    // 投籃方向：由出手點水平指向籃框中心
    const rn = Math.hypot(release.x, release.z);
    const shot = designShot3d({ angle, s: p.s, z: p.z, release, dir: [-release.x / rn, -release.z / rn] }, k);
    if (!shot) continue;
    const tRelease = t + hold;
    const end = shot.sim.contact != null ? shot.sim.contact : shot.T;
    const tGone = tRelease + Math.min(shot.T + 1.4, end + 1.1);
    shots.push({
      index: shots.length,
      kind,
      owner: 'me',
      angleDeg: trueEntryAngle(shot),
      designAngle: angle,
      crossS: p.s,
      crossZ: p.z,
      made: shot.sim.made,
      contact: shot.sim.contact != null,
      tAppear: t,
      tRelease,
      tCross: tRelease + shot.T,
      tGone,
      shot,
    });
    t = tGone + 0.5 + rng() * 0.3;
  }
  const duration = t + 0.4;

  // 背景：另一個籃框（在我們籃框的後方、偏一邊），有人在投；還有運球和傳球的人
  const others = [];
  let otherHoop = null;
  if (o.background) {
    otherHoop = { x: 3.0, z: -13, board: false, dir: [0, -1] };
    for (let tt = 0.9; tt < duration - 2; tt += 2.6 + rng() * 0.6) {
      const kind = rng() < 0.6 ? 'swish' : 'rimout';
      const p = KINDS[kind](rng);
      const release = { x: otherHoop.x + (rng() - 0.5) * 0.2, y: 2.2, z: otherHoop.z + 4.6 };
      const shot = designShot3d({ angle: 42 + rng() * 8, s: p.s, z: p.z, release, hoop: otherHoop, dir: otherHoop.dir }, k);
      if (shot) others.push({ kind: 'othershot', tRelease: tt, tGone: tt + shot.T + 1.0, shot });
    }
    // 運球：在投籃者後面一點，球在地板和腰之間上下
    others.push({ kind: 'dribble', x0: -6.2, z0: -2.5, tFrom: 0, tTo: duration });
    // 傳球：兩個人之間來回，最高點低於籃框
    others.push({ kind: 'pass', a: { x: -8.5, y: 1.3, z: -4 }, b: { x: -4.5, y: 1.3, z: -6 }, period: 3.2, tFrom: 0.4, tTo: duration });
  }

  return {
    kind: 'scene3d',
    seed,
    fps,
    width,
    height,
    cam,
    dragK: k,
    duration,
    frameCount: Math.round(duration * fps),
    shots,
    others,
    otherHoop,
  };
}

/**
 * 真實入框角度：designFlight 是由「過框時的角度」往回積分到出手點解出來的，
 * 所以未受碰撞影響的軌跡在籃框平面的角度就是設計值（速度都在同一個鉛直平面裡，橫向速度不改變這個角度）。
 */
function trueEntryAngle(shot) {
  return shot.angle;
}

/** 某一時間點畫面上所有球的 3D 狀態。 */
export function ballsAt(plan, t) {
  const out = [];
  for (const sh of plan.shots) {
    if (t < sh.tAppear || t >= sh.tGone) continue;
    if (t < sh.tRelease) {
      const r = sh.shot.start;
      out.push({ owner: 'me', shot: sh.index, phase: 'held', X: r[0] - 0.08, Y: r[1] - 0.12, Z: r[2], inNet: false });
    } else {
      const s = stateAt(sh.shot.sim.states, t - sh.tRelease);
      const fade = sh.tGone - t < 0.15;
      out.push({ owner: 'me', shot: sh.index, phase: t < sh.tCross ? 'flight' : 'after', X: s[0], Y: s[1], Z: s[2], vx: s[3], vy: s[4], vz: s[5], inNet: s[6] > 0.5, fade });
    }
  }
  for (const ob of plan.others) {
    if (ob.kind === 'othershot') {
      if (t < ob.tRelease - 0.4 || t >= ob.tGone) continue;
      const s = t < ob.tRelease ? ob.shot.start : stateAt(ob.shot.sim.states, t - ob.tRelease);
      out.push({ owner: 'other', phase: 'other', X: s[0], Y: s[1], Z: s[2], inNet: s[6] > 0.5 });
    } else if (ob.kind === 'dribble') {
      const ph = (t % 0.55) / 0.55;
      const y = BALL_R + (1 - Math.abs(2 * ph - 1)) ** 0.8 * 0.85;
      out.push({ owner: 'other', phase: 'dribble', X: ob.x0 + 0.6 * Math.sin(t * 0.7), Y: y, Z: ob.z0, inNet: false });
    } else if (ob.kind === 'pass') {
      const ph = ((t - ob.tFrom) % ob.period) / ob.period;
      if (ph > 0.35) continue; // 球在手上的時間不畫（拿在手上看起來像靜止的球，不是這裡要測的）
      const f = ph / 0.35;
      const back = Math.floor((t - ob.tFrom) / ob.period) % 2 === 1;
      const [a, b] = back ? [ob.b, ob.a] : [ob.a, ob.b];
      out.push({ owner: 'other', phase: 'pass', X: a.x + (b.x - a.x) * f, Y: a.y + (b.y - a.y) * f + 0.5 * Math.sin(Math.PI * f), Z: a.z + (b.z - a.z) * f, inNet: false });
    }
  }
  return out;
}

/**
 * 某一幀的真實偵測答案（模擬偵測器和測試用）：畫面上的球、籃框、籃板外接框（像素）。
 * 出了畫面的不列；球被別的東西遮住的情況這裡不處理（模擬偵測器另外加漏偵測）。
 */
export function truthAt(plan, t) {
  const cam = plan.cam;
  const inside = (b) => b && b.x1 > 0 && b.y1 > 0 && b.x0 < cam.width && b.y0 < cam.height;
  const balls = [];
  for (const b of ballsAt(plan, t)) {
    const p = projectBall(cam, b.X, b.Y, b.Z, BALL_R);
    if (!p) continue;
    const box = { x0: p.x - p.r, y0: p.y - p.r, x1: p.x + p.r, y1: p.y + p.r };
    if (!inside(box)) continue;
    balls.push({ ...b, x: p.x, y: p.y, w: 2 * p.r, h: 2 * p.r, depth: p.depth });
  }
  const rims = [];
  const boards = [];
  const rb = rimBox(cam, 0, 0);
  if (inside(rb)) rims.push({ ...rb, ours: true });
  const bb = boardBox(cam);
  if (inside(bb)) boards.push({ ...bb, ours: true });
  if (plan.otherHoop) {
    const ob = rimBox(cam, plan.otherHoop.x, plan.otherHoop.z);
    if (inside(ob)) rims.push({ ...ob, ours: false });
  }
  return { balls, rims, boards };
}

/** 每一球的真實答案（只有自己投的球）。 */
export function scene3dTruth(plan) {
  return plan.shots.map((s, i) => ({
    shot: i + 1,
    kind: s.kind,
    angleDeg: s.angleDeg,
    made: s.made,
    contact: s.contact,
    crossS: s.crossS,
    tRelease: s.tRelease,
    tCross: s.tCross,
  }));
}

/** 籃框前緣、後緣在畫面上的真實位置（「點兩下籃框」的測試用）：鐵圈內緣橢圓最左、最右兩點。 */
export function rimClickTruth(plan) {
  const cam = plan.cam;
  let left = null;
  let right = null;
  for (let i = 0; i < 720; i++) {
    const a = (i / 720) * 2 * Math.PI;
    const p = projectBall(cam, RIM_R * Math.cos(a), RIM_Y, RIM_R * Math.sin(a), 0);
    if (!p) continue;
    if (!left || p.x < left.x) left = p;
    if (!right || p.x > right.x) right = p;
  }
  return left && right ? { left: { x: left.x, y: left.y }, right: { x: right.x, y: right.y } } : null;
}
