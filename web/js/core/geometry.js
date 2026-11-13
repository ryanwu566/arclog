// 籃框座標系：把畫面上的像素座標換成「以籃框為基準」的座標。
// 純函式，不碰 DOM。Python 對應檔：arclog/geometry.py

import { RIM_DIAMETER_M, BALL_DIAMETER_M } from './constants.js';

/**
 * 由使用者點的籃框前緣、後緣建立座標系。
 *
 *   u 軸：前緣 → 後緣（球飛行的方向），前緣 u=0、後緣 u=1
 *   v 軸：垂直籃框平面往上，籃框平面 v=0
 *   長度單位：籃框內徑（45 公分）
 *
 * level = 'rim'  ：以兩點連線當水平（可以抵銷手機沒放平造成的歪斜）
 * level = 'image'：以畫面水平當水平（手機已用水平儀放平時用），兩點取平均高度
 *
 * @param {{x:number,y:number}} front 籃框前緣（靠近投籃者）
 * @param {{x:number,y:number}} back  籃框後緣（靠近籃板）
 * @param {{level?: 'rim'|'image'}} [opts]
 */
export function makeHoopFrame(front, back, opts = {}) {
  const level = opts.level === 'image' ? 'image' : 'rim';
  const dx = back.x - front.x;
  const dy = back.y - front.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (!(dist > 1e-6)) return null;
  // 兩點連線相對畫面水平的夾角（度），純粹給使用者看歪了多少
  const tiltDeg = (Math.atan2(-dy * Math.sign(dx || 1), Math.abs(dx)) * 180) / Math.PI;

  let ox, oy, ux, uy, len;
  if (level === 'image') {
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
