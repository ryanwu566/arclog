// 自動校正：由很多幀的籃框（和籃板）偵測框，找出穩定的籃框位置，換成「籃框前緣、後緣」兩點。純函式，不碰 DOM。
//
// 畫面裡可能不只一個籃框（隔壁場地），也可能有偵測不穩、手機在動的時候：
//   1. 依位置把籃框框分群（中心距離小於半個框寬就是同一個籃框）。
//   2. 每一群取四個邊的中位數當穩定值，並算離散程度（中位數絕對偏差，以框寬為單位）。
//   3. 依「出現次數 × 框寬」排序：我們這個籃框通常最近（最大）、最常被偵測到。
//      真正要投的是哪一個，之後還會用軌跡確認（autoshots.js 的 pickHoop）。

import { RIM_DIAMETER_M } from './constants.js';

/** 鐵圈外緣的直徑（公尺）：內徑 45 公分加兩邊鐵條（直徑約 1.6 到 2.0 公分）。偵測框框的是外緣。 */
export const RIM_OUTER_M = 0.486;

export const AUTOCAL_DEFAULTS = {
  joinFactor: 0.5, // 中心距離小於框寬的幾倍算同一群
  minCount: 5, // 至少幾幀有偵測到才算數
  stableSpread: 0.06, // 中心的離散程度（框寬為單位）小於這個值才算穩定
  rimBox: 'rim', // 'rim'＝只框鐵圈；'rim+net'＝連球網一起框
};

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mad(a, m) {
  return median(a.map((x) => Math.abs(x - m)));
}

/** 框的格式：{x0, y0, x1, y1}（像素）。偵測器輸出的 {x, y, w, h}（中心和寬高）用這個轉。 */
export function toBox(d) {
  return d.x0 != null ? d : { x0: d.x - d.w / 2, y0: d.y - d.h / 2, x1: d.x + d.w / 2, y1: d.y + d.h / 2, conf: d.conf, t: d.t };
}

/**
 * 把同一類的框依位置分群，回傳每一群的穩定值。
 * @param {{x0,y0,x1,y1,t?}[]} boxes
 * @returns {{box:{x0,y0,x1,y1}, count:number, spread:number, w:number, h:number, cx:number, cy:number, score:number, members:object[]}[]}
 *          依 score（出現次數 × 框寬）由大到小
 */
export function clusterBoxes(boxes, o = AUTOCAL_DEFAULTS) {
  const groups = [];
  for (const b0 of boxes) {
    const b = toBox(b0);
    const cx = (b.x0 + b.x1) / 2;
    const cy = (b.y0 + b.y1) / 2;
    const w = b.x1 - b.x0;
    if (!(w > 0)) continue;
    let best = null;
    let bestD = Infinity;
    for (const g of groups) {
      const d = Math.hypot(cx - g.cx, cy - g.cy);
      if (d < o.joinFactor * Math.max(w, g.w) && d < bestD) {
        best = g;
        bestD = d;
      }
    }
    if (best) {
      best.members.push(b);
      // 群的中心用累計平均追蹤（最後的穩定值用中位數另外算）
      const n = best.members.length;
      best.cx += (cx - best.cx) / n;
      best.cy += (cy - best.cy) / n;
      best.w += (w - best.w) / n;
    } else groups.push({ cx, cy, w, members: [b] });
  }
  const out = groups.map((g) => {
    const m = g.members;
    const box = {
      x0: median(m.map((b) => b.x0)),
      y0: median(m.map((b) => b.y0)),
      x1: median(m.map((b) => b.x1)),
      y1: median(m.map((b) => b.y1)),
    };
    const w = box.x1 - box.x0;
    const h = box.y1 - box.y0;
    const cxs = m.map((b) => (b.x0 + b.x1) / 2);
    const cys = m.map((b) => (b.y0 + b.y1) / 2);
    const ws = m.map((b) => b.x1 - b.x0);
    const cx = median(cxs);
    const cy = median(cys);
    const spread = m.length >= 2 ? (1.4826 * Math.max(mad(cxs, cx), mad(cys, cy), mad(ws, median(ws)))) / w : 1;
    return { box, count: m.length, spread, w, h, cx: (box.x0 + box.x1) / 2, cy: (box.y0 + box.y1) / 2, score: m.length * w, members: m };
  });
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 由籃框的穩定框推出「籃框前緣、後緣」兩點（給 makeHoopFrame 用）。
 * 框是鐵圈外緣，兩點取內緣：寬度乘上 內徑／外徑。
 * 高度：只框鐵圈時取框的中線；連球網一起框時，鐵圈在框的上緣，取上緣往下「鐵圈橢圓半高」的地方
 * （橢圓半高不知道，用框寬的 0.1 倍估：鏡頭比籃框低 1.5 公尺、距離 8 公尺時大約是這樣，差一點只會讓原點上下移一點）。
 * 左邊當前緣；球如果是由右往左飛，分析時會自動翻轉（analyzeShot 的 flip）。
 */
export function hoopPointsFromBox(box, rimBox = 'rim') {
  const w = box.x1 - box.x0;
  const cx = (box.x0 + box.x1) / 2;
  const y = rimBox === 'rim+net' ? box.y0 + 0.1 * w : (box.y0 + box.y1) / 2;
  const half = (w / 2) * (RIM_DIAMETER_M / RIM_OUTER_M);
  return { front: { x: cx - half, y }, back: { x: cx + half, y } };
}

/** 籃板裡面「最可能是這個籃框的」那一群：水平位置和籃框重疊或緊鄰、在籃框上方附近、而且比籃框大。 */
export function pickBoard(boardGroups, rim) {
  let best = null;
  let bestScore = -Infinity;
  for (const g of boardGroups) {
    const b = g.box;
    const overlapX = Math.min(b.x1, rim.box.x1 + rim.w) - Math.max(b.x0, rim.box.x0 - rim.w);
    if (!(overlapX > 0)) continue;
    // 籃框（3.05 公尺）在籃板下緣（2.90）和上緣（3.95）之間偏下：籃框中心要落在籃板高度範圍附近
    if (rim.cy < b.y0 - rim.w || rim.cy > b.y1 + rim.w) continue;
    if (!(g.h > 0.4 * rim.w)) continue;
    const score = g.count - Math.abs((b.x0 + b.x1) / 2 - rim.cx) / rim.w;
    if (score > bestScore) {
      bestScore = score;
      best = g;
    }
  }
  return best;
}

/**
 * 自動校正。
 * @param {{cls:string, x:number, y:number, w:number, h:number, conf:number, t?:number}[]} dets 很多幀的偵測（只看 rim、backboard）
 * @param {object} [opts] 覆寫 AUTOCAL_DEFAULTS
 * @returns {{ok:false, reason:'no_rim'|'too_few'|'unstable', candidates:object[]} |
 *           {ok:true, rim:object, board:object|null, points:{front, back}, candidates:object[], stable:boolean}}
 *   candidates：所有籃框群（給使用者選或用軌跡確認）
 */
export function autoCalibrate(dets, opts = {}) {
  const o = { ...AUTOCAL_DEFAULTS, ...opts };
  const rims = dets.filter((d) => d.cls === 'rim');
  if (!rims.length) return { ok: false, reason: 'no_rim', candidates: [] };
  const groups = clusterBoxes(rims, o).filter((g) => g.count >= Math.min(o.minCount, 2));
  if (!groups.length || groups[0].count < o.minCount) return { ok: false, reason: 'too_few', candidates: groups };
  const boards = clusterBoxes(dets.filter((d) => d.cls === 'backboard'), o);
  return calibrateWith(groups[0], boards, groups, o);
}

/** 用指定的籃框群建立校正（使用者在預覽時選了別的籃框，或軌跡確認後換一個）。 */
export function calibrateWith(rim, boardGroups, candidates, o = AUTOCAL_DEFAULTS) {
  const stable = rim.spread <= o.stableSpread;
  const board = pickBoard(boardGroups || [], rim);
  return {
    ok: true,
    stable,
    rim,
    board: board && board.count >= Math.min(o.minCount, 3) ? board : null,
    points: hoopPointsFromBox(rim.box, o.rimBox),
    candidates,
    rimBox: o.rimBox,
  };
}
