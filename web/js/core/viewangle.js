// 自動判斷鏡頭角度：由籃框和籃板的偵測框推算相機的位置（偏離正側面幾度），並把畫面上的球換回投籃平面。純函式，不碰 DOM。
//
// 做法：針孔相機（焦距假設為畫面長邊的 FOCAL_RATIO 倍）。相機位置用三個數描述：
//   α（偏角）：從籃框看過去，相機偏離「投籃方向的正側面」幾度。0＝正側面；+90＝投籃者正後方；−90＝籃板後面。
//   h：鏡頭高度；ρ：相機到籃框中心的水平距離。
// 鏡頭方向（左右轉、上下仰）由「籃框在畫面上的位置」決定；手機歪斜當成 0（另外由水平基準處理）。
// 對每一組 (α, h) 解出讓籃框寬度對得上的 ρ，再比較預測和實際的籃板框、籃框高度，找最吻合的那一組。
// 籃板 1.8 × 1.05 公尺：正側面看是細長條，越轉向正面越寬，而且籃框和籃板中心的水平距離越小——
// 透視造成的變形也一起算進去了（只看寬高比的話，正側面時透視會讓籃板看起來寬到像轉了十幾度）。
//
// 偏角的不確定範圍：假設每個框邊的位置有「籃框寬的 5%」的誤差（BOX_SIGMA），列出吻合程度在最佳值附近（χ² 差 4 以內）的所有偏角。
// 這個誤差大小是假設，不是量出來的；實拍的偵測框誤差要等有實拍資料才知道（docs/EVAL.md）。

import { FOCAL_RATIO, RIM_DIAMETER_M, BALL_DIAMETER_M } from './constants.js';
import { RIM_Y, RIM_R, project, boardBox as projBoardBox, projectBox } from './camera3d.js';
import { makeHoopFrame } from './geometry.js';

export const BOX_SIGMA = 0.05;
const DEG = Math.PI / 180;

/**
 * 分級門檻（偏離正側面的度數）。依據是 tools/camera_study.mjs 第十四到十八段的模擬（docs/EVAL.md 4.4）。
 *   A：完整報告，自動修正偏角
 *   B：完整報告，標「誤差較大」
 *   C：只給出手數和命中率
 */
export const GRADE_LIMITS = { A: 30, B: 60 };

/** 讓相機在 C 點、看向 world 方向 d 時，d 剛好落在畫面像素 (u, v)：解出仰角和左右轉角（度）。 */
function aim(C, target, u, v, W, H, f) {
  const dx = target[0] - C[0];
  const dy = target[1] - C[1];
  const dz = target[2] - C[2];
  const xc = (u - W / 2) / f;
  const yc = -(v - H / 2) / f;
  const ew = Math.atan2(dy, Math.hypot(dx, dz));
  const g = (p) => Math.atan2(yc * Math.cos(p) + Math.sin(p), Math.hypot(xc, yc * Math.sin(p) - Math.cos(p))) - ew;
  let lo = -80 * DEG;
  let hi = 80 * DEG;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (g(m) > 0) hi = m;
    else lo = m;
  }
  const p = (lo + hi) / 2;
  const x1 = xc;
  const z1 = yc * Math.sin(p) - Math.cos(p);
  const yaw = Math.atan2(dz, dx) - Math.atan2(z1, x1);
  return { pitchDeg: p / DEG, yawDeg: yaw / DEG };
}

/** 偏角 α、高度 h、水平距離 rho 的相機，鏡頭方向讓籃框中心落在 (u, v)。 */
export function cameraAt(alphaDeg, h, rho, u, v, W, H, f) {
  const a = alphaDeg * DEG;
  const C = [-rho * Math.sin(a), h, rho * Math.cos(a)];
  const { pitchDeg, yawDeg } = aim(C, [0, RIM_Y, 0], u, v, W, H, f);
  return { width: W, height: H, f, along: C[0], camHeight: C[1], z: C[2], yawDeg, pitchDeg, rollDeg: 0, alphaDeg, rho };
}

/** 預測的籃框框（rimBox='rim+net' 時連球網一起）。 */
// 鐵圈外緣上取 48 個角度、上下兩圈（鐵條的粗細）就夠準（外接框的誤差約 0.2%），比 camera3d.rimBox 快很多
const RIM_PTS = (() => {
  const pts = [];
  const R = RIM_R + 2 * 0.009;
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * 2 * Math.PI;
    for (const dy of [-0.009, 0.009]) pts.push([R * Math.cos(a), RIM_Y + dy, R * Math.sin(a)]);
  }
  return pts;
})();

function predRim(cam, mode) {
  const b = projectBox(cam, RIM_PTS);
  if (!b || mode !== 'rim+net') return b;
  const pts = [];
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * 2 * Math.PI;
    pts.push([0.15 * Math.cos(a), RIM_Y - 0.42, 0.15 * Math.sin(a)]);
  }
  const n = projectBox(cam, pts);
  return n ? { x0: Math.min(b.x0, n.x0), y0: Math.min(b.y0, n.y0), x1: Math.max(b.x1, n.x1), y1: Math.max(b.y1, n.y1), depth: b.depth } : b;
}

/** 解出 ρ：讓預測的籃框寬度等於觀察到的寬度，並把鏡頭方向修正到預測框的中心對上觀察框的中心。 */
function solveCam(alpha, h, obs, W, H, f, mode) {
  const wObs = obs.x1 - obs.x0;
  const cx = (obs.x0 + obs.x1) / 2;
  const cy = (obs.y0 + obs.y1) / 2;
  let u = cx;
  let v = cy;
  let cam = null;
  let pred = null;
  // 初始範圍：針孔近似 ρ ≈ f·外徑／寬度，上下放寬
  const rho0 = (f * 0.486) / wObs;
  for (let iter = 0; iter < 2; iter++) {
    let lo = Math.max(0.5, rho0 * 0.5);
    let hi = rho0 * 1.8 + 1;
    for (let i = 0; i < 17; i++) {
      const m = Math.sqrt(lo * hi);
      const c = cameraAt(alpha, h, m, u, v, W, H, f);
      const b = predRim(c, mode);
      if (!b) {
        lo = m;
        continue;
      }
      if (b.x1 - b.x0 > wObs) lo = m;
      else hi = m;
    }
    cam = cameraAt(alpha, h, Math.sqrt(lo * hi), u, v, W, H, f);
    pred = predRim(cam, mode);
    if (!pred) return null;
    u += cx - (pred.x0 + pred.x1) / 2;
    v += cy - (pred.y0 + pred.y1) / 2;
  }
  return { cam, pred };
}

/** 觀察到的框邊有沒有貼著畫面邊緣（被裁掉了，不能拿來比）。 */
function edges(box, W, H, m = 4) {
  return {
    x0: box.x0 > m,
    x1: box.x1 < W - m,
    y0: box.y0 > m,
    y1: box.y1 < H - m,
  };
}

function chi2(cam, pred, rimObs, boardObs, boardOk, W, H) {
  const s = BOX_SIGMA * (rimObs.x1 - rimObs.x0);
  let c = 0;
  // 籃框的高度（扁平程度）：決定鏡頭高度
  const dh = (pred.y1 - pred.y0) - (rimObs.y1 - rimObs.y0);
  c += (dh / s) ** 2;
  if (boardObs) {
    const pb = projBoardBox(cam);
    if (!pb) return Infinity;
    for (const k of ['x0', 'x1', 'y0', 'y1']) {
      if (!boardOk[k]) continue;
      // 預測的邊如果超出畫面，和被裁掉的觀察值比沒有意義：裁到畫面裡再比
      const lim = k[0] === 'x' ? W : H;
      const p = Math.max(0, Math.min(lim, pb[k]));
      c += ((p - boardObs[k]) / s) ** 2;
    }
  }
  return c;
}

/**
 * 由籃框框（和籃板框）推算相機的位置。
 * @param {{x0,y0,x1,y1}} rimObs 籃框的穩定框（autocal.js）
 * @param {{x0,y0,x1,y1}|null} boardObs 籃板的穩定框；沒有就只能估鏡頭高度，偏角不知道
 * @param {{width:number, height:number, focalRatio?:number, rimBox?:'rim'|'rim+net'}} o
 * @returns {{ok:boolean, alphaDeg:number|null, devDeg:number|null, devRange:[number,number]|null,
 *            alphaRange:[number,number]|null, heightM:number, distM:number, pitchDeg:number, chi2:number, cam:object, profile:{alpha:number, chi2:number}[]}}
 *   devDeg＝|α|（偏離正側面的度數，0 到 90）；devRange 是它的不確定範圍
 */
export function fitPose(rimObs, boardObs, o) {
  const W = o.width;
  const H = o.height;
  const f = (o.focalRatio || FOCAL_RATIO) * Math.max(W, H);
  const mode = o.rimBox || 'rim';
  const boardOk = boardObs ? edges(boardObs, W, H) : null;
  const usable = boardOk ? Object.values(boardOk).filter(Boolean).length : 0;
  const hs = [];
  for (let h = 0.5; h <= 3.0001; h += 0.5) hs.push(h);
  const evalAt = (alpha, h) => {
    const r = solveCam(alpha, h, rimObs, W, H, f, mode);
    if (!r) return { c: Infinity };
    return { c: chi2(r.cam, r.pred, rimObs, usable >= 2 ? boardObs : null, boardOk, W, H), cam: r.cam };
  };
  // 粗掃：每個偏角取最好的鏡頭高度
  const profile = [];
  let best = { c: Infinity };
  for (let alpha = -88; alpha <= 88; alpha += 2) {
    let bh = { c: Infinity };
    for (const h of hs) {
      const r = evalAt(alpha, h);
      if (r.c < bh.c) bh = { ...r, alpha, h };
    }
    profile.push({ alpha, chi2: bh.c });
    if (bh.c < best.c) best = bh;
  }
  if (!Number.isFinite(best.c)) return { ok: false, alphaDeg: null, devDeg: null, devRange: null, alphaRange: null };
  // 細掃
  // 細掃：先只調高度，再一起微調
  for (let h = best.h - 0.45; h <= best.h + 0.4501; h += 0.05) {
    if (h < 0.2) continue;
    const r = evalAt(best.alpha, h);
    if (r.c < best.c) best = { ...r, alpha: best.alpha, h };
  }
  for (let alpha = best.alpha - 2; alpha <= best.alpha + 2; alpha += 0.5) {
    for (let h = best.h - 0.1; h <= best.h + 0.1001; h += 0.05) {
      if (h < 0.2) continue;
      const r = evalAt(alpha, h);
      if (r.c < best.c) best = { ...r, alpha, h };
    }
  }
  const cam = best.cam;
  const out = {
    ok: true,
    chi2: best.c,
    heightM: cam.camHeight,
    distM: cam.rho,
    pitchDeg: cam.pitchDeg,
    cam,
    profile,
    alphaDeg: null,
    devDeg: null,
    devRange: null,
    alphaRange: null,
  };
  if (usable < 2) return out; // 沒有籃板：偏角不知道
  const lim = best.c + 4;
  const near = profile.filter((p) => p.chi2 <= lim).map((p) => p.alpha);
  near.push(best.alpha);
  out.alphaDeg = best.alpha;
  out.alphaRange = [Math.min(...near), Math.max(...near)];
  const devs = near.map(Math.abs);
  out.devDeg = Math.abs(best.alpha);
  // 範圍跨過 0 時，最小偏差是 0
  out.devRange = [out.alphaRange[0] <= 0 && out.alphaRange[1] >= 0 ? 0 : Math.min(...devs), Math.max(...devs)];
  return out;
}

/** 畫面像素 → 相機發出的那條光線和投籃平面（z = 0，通過籃框中心、和籃板垂直）的交點。回傳 {X, Y, depth} 或 null。 */
export function toShotPlane(cam, x, y) {
  // 先在畫面座標（y 向下）把手機歪斜轉回來，再換成相機座標（y 向上）
  let ix = x - cam.width / 2;
  let iy = y - cam.height / 2;
  if (cam.rollDeg) {
    const r = -cam.rollDeg * DEG;
    [ix, iy] = [ix * Math.cos(r) - iy * Math.sin(r), ix * Math.sin(r) + iy * Math.cos(r)];
  }
  const px = ix / cam.f;
  const py = -iy / cam.f;
  const p = cam.pitchDeg * DEG;
  const dy = py * Math.cos(p) + Math.sin(p);
  const z1 = py * Math.sin(p) - Math.cos(p);
  const yaw = cam.yawDeg * DEG;
  // (dx + i dz) = (x1 + i z1)·e^{i yaw}
  const dx = px * Math.cos(yaw) - z1 * Math.sin(yaw);
  const dz = px * Math.sin(yaw) + z1 * Math.cos(yaw);
  if (!(Math.abs(dz) > 1e-9)) return null;
  const lam = -cam.z / dz;
  if (!(lam > 0)) return null;
  return { X: cam.along + lam * dx, Y: cam.camHeight + lam * dy, depth: lam };
}

/** 投籃平面座標換成「虛擬像素」時的比例：每公尺幾個虛擬像素。 */
export const PLANE_PX_PER_M = 200;

/**
 * 把偵測到的球換到投籃平面上，變成「從正側面、沒有透視地看」的虛擬畫面，
 * 之後的軌跡、角度、進球判定（track.js、autoshots.js）照原樣用。
 * 球框的大小也換成平面上的實際大小（公尺 × PLANE_PX_PER_M）。
 * @returns {{dets:object[], hoop:object}} hoop 是虛擬畫面上的籃框座標系（前緣 x = −0.225 公尺那一側）
 */
export function rectify(cam, dets) {
  const K = PLANE_PX_PER_M;
  const out = [];
  for (const d of dets) {
    const q = toShotPlane(cam, d.x, d.y);
    if (!q || q.depth > 200) continue;
    const s = (q.depth / cam.f) * K;
    out.push({ ...d, x: q.X * K, y: -q.Y * K, w: d.w * s, h: d.h * s, px: d.x, py: d.y });
  }
  const hoop = makeHoopFrame({ x: -RIM_R * K, y: -RIM_Y * K }, { x: RIM_R * K, y: -RIM_Y * K }, { level: 'rim' });
  return { dets: out, hoop };
}

/** 虛擬畫面上的點 → 原本的畫面（疊圖用）。 */
export function planeToImage(cam, x, y) {
  const p = project(cam, x / PLANE_PX_PER_M, -y / PLANE_PX_PER_M, 0);
  return p.depth > 0 ? [p.x, p.y] : null;
}

/**
 * 沒有籃板偵測時的粗估：由球在飛行中變大或變小（離鏡頭變近或變遠）估偏角。
 * 球框寬度 ∝ 1／深度。把每球「起點」和「靠近籃框」的深度比，和這段的橫向移動比較：tan α ≈ 深度變化／橫向移動。
 * @param {{points:{x:number, w?:number, h?:number}[]}[]} shots 每球的偵測點（要有框的寬高）
 * @param {object} hoop makeHoopFrame 的結果（籃框寬 len 像素）
 * @param {{width:number, height:number, focalRatio?:number}} o
 * @returns {{alphaDeg:number|null, devDeg:number|null, devRange:[number,number]|null, n:number}}
 */
export function alphaFromBallSize(shots, hoop, o) {
  const f = (o.focalRatio || FOCAL_RATIO) * Math.max(o.width, o.height);
  // 籃框所在的深度：籃框內徑 hoop.len 像素
  const dRim = (f * RIM_DIAMETER_M) / hoop.len;
  const est = [];
  for (const s of shots) {
    const pts = (s.points || []).filter((p) => p.w > 0);
    if (pts.length < 6) continue;
    const n = pts.length;
    const q = Math.max(2, Math.floor(n / 3));
    const first = pts.slice(0, q);
    const last = pts.slice(n - q);
    const size = (a) => a.reduce((acc, p) => acc + Math.max(p.w, p.h || 0), 0) / a.length;
    const xs = (a) => a.reduce((acc, p) => acc + p.x, 0) / a.length;
    // 靠近籃框那一段的深度用籃框的深度，起點的深度由球的大小比例推
    const ratio = size(last) / size(first); // 起點深度／終點深度
    const dStart = dRim * ratio;
    const lateral = (Math.abs(xs(last) - xs(first)) / hoop.len) * RIM_DIAMETER_M * ((dStart + dRim) / 2 / dRim);
    // 正：起點比籃框近（相機在投籃者後方那一側）
    est.push(Math.atan2(dRim - dStart, lateral) / DEG);
  }
  if (!est.length) return { alphaDeg: null, devDeg: null, devRange: null, n: 0 };
  est.sort((a, b) => a - b);
  const med = est[est.length >> 1];
  // 不確定範圍：球框大小每球 ±8%（模擬裡偵測框大小的雜訊）換算成的偏角差，加上球與球之間的差異
  const spread = est.length >= 3 ? est[est.length - 1] - est[0] : 30;
  const lo = Math.max(0, Math.abs(med) - Math.max(10, spread / 2));
  const hi = Math.min(90, Math.abs(med) + Math.max(10, spread / 2));
  void BALL_DIAMETER_M;
  return { alphaDeg: med, devDeg: Math.abs(med), devRange: [lo, hi], n: est.length };
}

/**
 * 依偏角分級。用不確定範圍的上限（保守）：範圍跨過門檻時，取比較差的那一級。
 * @param {number|null} devDeg
 * @param {[number, number]|null} devRange
 * @returns {{grade:'A'|'B'|'C'|'unknown', devDeg:number|null, devRange:[number,number]|null}}
 */
export function gradeView(devDeg, devRange, limits = GRADE_LIMITS) {
  if (devDeg == null) return { grade: 'unknown', devDeg: null, devRange: null };
  const hi = devRange ? devRange[1] : devDeg;
  const L = limits || GRADE_LIMITS;
  const grade = hi <= L.A ? 'A' : hi <= L.B ? 'B' : 'C';
  return { grade, devDeg, devRange };
}

/** 偏角修正（平行投影的近似）：tan(真實) = tan(量到) · cos θ。 */
export function correctForYaw(angleDeg, devDeg) {
  return Math.atan(Math.tan(angleDeg * DEG) * Math.cos(devDeg * DEG)) / DEG;
}
