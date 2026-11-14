// 針孔相機：把球場的 3D 座標投影到畫面上。純函式，不碰 DOM。
//
// 世界座標（公尺）和 tools/camera_study.mjs 相同：
//   x 沿投籃方向（籃框中心 x = 0，出手點約 x = −4.2，籃板正面 x = 0.375）
//   y 朝上（地板 y = 0，籃框 y = 3.05）
//   z 橫向；偏角 0 度（正側面）時相機在 z > 0 那一側
//
// 偏角 θ（thetaDeg）：相機繞著「出手點和籃框的中間」轉離正側面幾度。
//   正＝往籃框後方（底線那一側），負＝往投籃者後方；±90 度＝正前方／正後方。
// 投影公式和 camera_study.mjs 的 project 一樣（那支模擬是這次門檻的根據），只是畫面大小可以設定。

export const RIM_Y = 3.05;
export const RIM_R = 0.225; // 籃框內半徑
export const BOARD = { x0: 0.375, x1: 0.405, y0: 2.9, y1: 3.95, z0: -0.9, z1: 0.9 }; // 籃板（FIBA：1.8 × 1.05 公尺，下緣 2.90）
export const SHOOT_X = -4.2; // 罰球線附近的出手位置
export const MID_X = SHOOT_X / 2;

/**
 * 建立相機。
 * @param {object} o
 * @param {number} [o.width=1280] @param {number} [o.height=720]
 * @param {number} [o.focalRatio=0.8] 焦距是畫面長邊的幾倍（手機 1 倍鏡頭錄影約 0.8）
 * @param {number} [o.thetaDeg=0] 偏離正側面幾度
 * @param {number} [o.dist=8] 相機到「出手點和籃框中間」那一點的水平距離
 * @param {number} [o.camHeight=1.4] 鏡頭高度
 * @param {number} [o.pitchDeg=0] 往上仰幾度
 * @param {number} [o.rollDeg=0] 手機左右歪幾度
 * @param {number} [o.aimX] 鏡頭水平對準的 x（預設 MID_X）
 */
export function makeCamera(o = {}) {
  const width = o.width || 1280;
  const height = o.height || 720;
  const theta = o.thetaDeg || 0;
  const dist = o.dist != null ? o.dist : 8;
  const t = (theta * Math.PI) / 180;
  const aimX = o.aimX != null ? o.aimX : MID_X;
  return {
    width,
    height,
    f: (o.focalRatio || 0.8) * Math.max(width, height),
    thetaDeg: theta,
    along: aimX + dist * Math.sin(t),
    z: dist * Math.cos(t),
    camHeight: o.camHeight != null ? o.camHeight : 1.4,
    yawDeg: -theta,
    pitchDeg: o.pitchDeg || 0,
    rollDeg: o.rollDeg || 0,
  };
}

/** 3D → 畫面。回傳 {x, y, depth}；depth ≤ 0 代表在相機後面。 */
export function project(cam, X, Y, Z) {
  const yaw = (cam.yawDeg * Math.PI) / 180;
  const pitch = (cam.pitchDeg * Math.PI) / 180;
  const dx = X - cam.along;
  const dy = Y - cam.camHeight;
  const dz = Z - cam.z;
  const x1 = dx * Math.cos(yaw) + dz * Math.sin(yaw);
  const z1 = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
  const y2 = dy * Math.cos(pitch) + z1 * Math.sin(pitch);
  const z2 = -dy * Math.sin(pitch) + z1 * Math.cos(pitch);
  const depth = -z2;
  let px = (cam.f * x1) / depth;
  let py = (-cam.f * y2) / depth;
  if (cam.rollDeg) {
    const r = (cam.rollDeg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    [px, py] = [px * c - py * s, px * s + py * c];
  }
  return { x: px + cam.width / 2, y: py + cam.height / 2, depth };
}

/** 一群 3D 點投影後的外接框；有點在相機後面時回傳 null。 */
export function projectBox(cam, pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let depth = 0;
  for (const [X, Y, Z] of pts) {
    const p = project(cam, X, Y, Z);
    if (!(p.depth > 0.05)) return null;
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
    depth += p.depth;
  }
  return { x0, y0, x1, y1, depth: depth / pts.length };
}

/** 籃框鐵圈（外緣）的外接框。cx, cz 是籃框中心；tube 是鐵條半徑。 */
export function rimBox(cam, cx = 0, cz = 0, tube = 0.009) {
  const pts = [];
  const R = RIM_R + 2 * tube;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * 2 * Math.PI;
    for (const dy of [-tube, tube]) pts.push([cx + R * Math.cos(a), RIM_Y + dy, cz + R * Math.sin(a)]);
  }
  return projectBox(cam, pts);
}

/** 籃板（含厚度）的外接框。 */
export function boardBox(cam, b = BOARD) {
  const pts = [];
  for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) pts.push([x, y, z]);
  return projectBox(cam, pts);
}

/** 球（半徑 r）在畫面上的圓心和半徑（像素）。 */
export function projectBall(cam, X, Y, Z, r = 0.12) {
  const c = project(cam, X, Y, Z);
  if (!(c.depth > 0.05)) return null;
  return { x: c.x, y: c.y, r: (cam.f * r) / c.depth, depth: c.depth };
}
