// 籃框座標系：把畫面上的像素座標換成「以籃框為基準」的座標。
// 純函式，不碰 DOM。Python 對應檔：arclog/geometry.py

import { RIM_DIAMETER_M, BALL_DIAMETER_M, FOCAL_RATIO } from './constants.js';

/**
 * 由使用者點的籃框前緣、後緣建立座標系。
 *
 *   u 軸：前緣 → 後緣（球飛行的方向），前緣 u=0、後緣 u=1
 *   v 軸：垂直籃框平面往上，籃框平面 v=0
 *   長度單位：籃框內徑（45 公分）
 *
 * level = 'persp'：以兩點連線當水平，但先扣掉「籃框因為透視看起來是斜的」那一部分（實拍影片的預設）。
 *                  籃框是一個水平的圓，從側面偏下方看是一個橢圓；只要籃框不在畫面正中央，
 *                  橢圓最左和最右兩點離鏡頭的距離就不一樣，連線在畫面上會斜幾度。
 *                  這個傾斜可以由籃框在畫面上的位置和鏡頭焦距算出來：tan τ = xn·yn / (1 + xn²)，
 *                  xn、yn 是籃框中心離畫面中心的距離除以焦距。扣掉之後剩下的才是手機沒放平的歪斜。
 *                  需要 opts.width、opts.height（影片的像素大小）；沒給就當成 'rim'。
 *                  焦距假設為畫面長邊的 FOCAL_RATIO 倍（手機 1 倍鏡頭），可用 opts.focal 指定。
 * level = 'rim'  ：直接以兩點連線當水平（合成畫面沒有透視，用這個）
 * level = 'image'：以畫面水平當水平（手機已用水平儀放平時用），兩點取平均高度
 *
 * @param {{x:number,y:number}} front 籃框前緣（靠近投籃者）
 * @param {{x:number,y:number}} back  籃框後緣（靠近籃板）
 * @param {{level?: 'persp'|'rim'|'image', width?: number, height?: number, focal?: number}} [opts]
 */
export function makeHoopFrame(front, back, opts = {}) {
  let level = opts.level === 'image' ? 'image' : opts.level === 'persp' ? 'persp' : 'rim';
  if (level === 'persp' && !(opts.width > 0 && opts.height > 0)) level = 'rim';
  const dx = back.x - front.x;
  const dy = back.y - front.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (!(dist > 1e-6)) return null;
  // 兩點連線相對畫面水平的夾角（度），純粹給使用者看歪了多少
  const tiltDeg = (Math.atan2(-dy * Math.sign(dx || 1), Math.abs(dx)) * 180) / Math.PI;

  let ox, oy, ux, uy, len;
  let perspDeg = 0;
  let focal = null;
  if (level === 'persp') {
    focal = opts.focal > 0 ? opts.focal : FOCAL_RATIO;
    const f = focal * Math.max(opts.width, opts.height);
    const cx = (front.x + back.x) / 2;
    const cy = (front.y + back.y) / 2;
    const xn = (cx - opts.width / 2) / f;
    const yn = (opts.height / 2 - cy) / f;
    // 透視造成的傾斜：正值代表畫面上右端比較高
    const tanTau = (xn * yn) / (1 + xn * xn);
    const cosTau = 1 / Math.sqrt(1 + tanTau * tanTau);
    const sinTau = tanTau * cosTau;
    perspDeg = (Math.atan(tanTau) * 180) / Math.PI;
    // 把兩點連線的方向轉回去，得到真正的水平方向
    ux = (dx * cosTau - dy * sinTau) / dist;
    uy = (dx * sinTau + dy * cosTau) / dist;
    // 橢圓最左最右兩點的間距比「投籃平面上的籃框直徑」寬 1/cos α 倍（α 是籃框偏離光軸的角度）
    len = (dist * cosTau) / Math.sqrt(1 + xn * xn);
    // 籃框中心（兩點的中點）在 u = 0.5、v = 0
    ox = cx - 0.5 * len * ux;
    oy = cy - 0.5 * len * uy;
  } else if (level === 'image') {
    if (!(Math.abs(dx) > 1e-6)) return null;
    ox = front.x;
    oy = (front.y + back.y) / 2;
    ux = dx > 0 ? 1 : -1;
    uy = 0;
    len = Math.abs(dx);
  } else {
    ox = front.x;
    oy = front.y;
    ux = dx / dist;
    uy = dy / dist;
    len = dist;
  }
  // v 軸取垂直 u、而且在畫面上朝上（y 變小）的那一個方向
  let vx = uy;
  let vy = -ux;
  if (vy > 0 || (vy === 0 && vx > 0)) {
    vx = -vx;
    vy = -vy;
  }
  return {
    level,
    ox, oy, ux, uy, vx, vy,
    len, // 籃框內徑在畫面上的像素長度
    pxPerM: len / RIM_DIAMETER_M,
    ballDiameterPx: (len / RIM_DIAMETER_M) * BALL_DIAMETER_M,
    tiltDeg,
    perspDeg, // level='persp' 時扣掉的透視傾斜（度）；其他基準為 0
    focal, // level='persp' 時用的焦距（畫面長邊的幾倍）；其他基準為 null
  };
}

/** 像素座標 → 籃框座標 [u, v] */
export function toHoop(frame, x, y) {
  const px = x - frame.ox;
  const py = y - frame.oy;
  return [
    (px * frame.ux + py * frame.uy) / frame.len,
    (px * frame.vx + py * frame.vy) / frame.len,
  ];
}

/** 籃框座標 → 像素座標 [x, y] */
export function toImage(frame, u, v) {
  const a = u * frame.len;
  const b = v * frame.len;
  return [
    frame.ox + a * frame.ux + b * frame.vx,
    frame.oy + a * frame.uy + b * frame.vy,
  ];
}
