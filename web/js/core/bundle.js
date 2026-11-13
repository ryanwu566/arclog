// 標註包：把一支影片的標記結果整理成 JSON，給 training/build_dataset.py 轉成訓練資料。
// 純函式，不碰 DOM。Python 那邊由 arclog/bundle.py 讀取並檢查同一份格式。
//
// 格式（version 1）：
// {
//   format: "arclog-annotations", version: 1, createdAt, app,
//   video: { name, size, width, height, fps, frameCount, duration, codec, rotation,
//            timeSource, engine },      ← 也當作「是不是同一個檔案」的指紋
//   frameTimes: [每一幀的時間戳（秒）],
//   hoop: { front:{x,y}, back:{x,y}, level, rimDiameterM, pxPerM, tiltDeg },
//         level='persp' 時多兩欄：focal（假設的焦距，畫面長邊的幾倍）、perspDeg（扣掉的透視傾斜）
//   ball: { diameterM, diameterPx },   ← 由籃框比例推算
//   shots: [ { id, source, made, angleDeg, crossS,
//              frames: [ { f, t, x, y, src: "manual" | "interp" | "auto" } ] } ],
//   noBall: [ { from, to } ],          ← 使用者確認「畫面上沒有球」的幀範圍（含頭尾）
//   synthetic: true/false
// }

import { RIM_DIAMETER_M, BALL_DIAMETER_M } from './constants.js';

export const BUNDLE_FORMAT = 'arclog-annotations';
export const BUNDLE_VERSION = 1;

// 捨入到固定小數位；最後加 0 是為了把 -0 變成 0
const r3 = (x) => Math.round(x * 1000) / 1000 + 0;
const r6 = (x) => Math.round(x * 1e6) / 1e6 + 0;

/**
 * @param {object} p
 * @param {object} p.video 影片資訊（name, size, width, height, fps, frameCount, duration, ...）
 * @param {ArrayLike<number>} p.frameTimes
 * @param {{front:{x:number,y:number}, back:{x:number,y:number}, level:string}} p.hoopPoints
 * @param {object} p.hoop makeHoopFrame 的結果
 * @param {{id:number, source:string, made:boolean, angleDeg:number, crossS:number,
 *          frames:{frame:number, t:number, x:number, y:number, src:string}[]}[]} p.shots
 * @param {{from:number, to:number}[]} [p.noBall]
 * @param {boolean} [p.synthetic]
 * @param {string} [p.createdAt]
 * @param {string} [p.appVersion]
 */
export function buildBundle(p) {
  const times = new Array(p.frameTimes.length);
  for (let i = 0; i < times.length; i++) times[i] = r6(p.frameTimes[i]);
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: p.createdAt || new Date().toISOString(),
    app: { name: 'ArcLog', version: p.appVersion || '0.1.0' },
    synthetic: !!p.synthetic,
    video: {
      name: p.video.name,
      size: p.video.size ?? null,
      width: p.video.width,
      height: p.video.height,
      fps: r3(p.video.fps),
      frameCount: times.length,
      duration: r6(p.video.duration),
      codec: p.video.codec ?? null,
      rotation: p.video.rotation ?? 0,
      timeSource: p.video.timeSource,
      engine: p.video.engine ?? null,
    },
    frameTimes: times,
    hoop: {
      front: { x: r3(p.hoopPoints.front.x), y: r3(p.hoopPoints.front.y) },
      back: { x: r3(p.hoopPoints.back.x), y: r3(p.hoopPoints.back.y) },
      level: p.hoop.level,
      rimDiameterM: RIM_DIAMETER_M,
      pxPerM: r3(p.hoop.pxPerM),
      tiltDeg: r3(p.hoop.tiltDeg),
      ...(p.hoop.level === 'persp' ? { focal: p.hoop.focal, perspDeg: r3(p.hoop.perspDeg) } : {}),
    },
    ball: { diameterM: BALL_DIAMETER_M, diameterPx: r3(p.hoop.ballDiameterPx) },
    shots: p.shots.map((s) => ({
      id: s.id,
      source: s.source,
      made: !!s.made,
      angleDeg: s.angleDeg,
      crossS: s.crossS != null ? r3(s.crossS) : null,
      frames: s.frames.map((f) => ({ f: f.frame, t: r6(f.t), x: r3(f.x), y: r3(f.y), src: f.src })),
    })),
    noBall: (p.noBall || []).map((r) => ({ from: r.from, to: r.to })),
    notes:
      '座標是影片顯示方向（已套用旋轉）的像素，原點在左上角。src=manual 是手點的球心，' +
      'src=interp 是沿擬合軌跡內插（相鄰兩個手點之間假設水平速度固定），src=auto 是模型偵測後經使用者確認。',
  };
}

/**
 * 檢查標註包格式。回傳錯誤訊息陣列，空陣列代表沒問題。
 * @returns {string[]}
 */
export function validateBundle(b) {
  const errs = [];
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['不是 JSON 物件'];
  if (b.format !== BUNDLE_FORMAT) errs.push(`format 應為 ${BUNDLE_FORMAT}`);
  if (b.version !== BUNDLE_VERSION) errs.push(`不支援的 version：${b.version}`);
  const v = b.video;
  if (!v || !num(v.width) || !num(v.height) || !(v.width > 0) || !(v.height > 0)) {
    errs.push('video.width / video.height 不正確');
  }
  if (!Array.isArray(b.frameTimes) || !b.frameTimes.length) errs.push('缺少 frameTimes');
  else {
    for (let i = 1; i < b.frameTimes.length; i++) {
      if (!(b.frameTimes[i] > b.frameTimes[i - 1])) {
        errs.push(`frameTimes 在第 ${i} 幀沒有遞增`);
        break;
      }
    }
  }
  const h = b.hoop;
  if (!h || !h.front || !h.back || !num(h.front.x) || !num(h.front.y) || !num(h.back.x) || !num(h.back.y)) {
    errs.push('hoop.front / hoop.back 不正確');
  }
  if (!b.ball || !(b.ball.diameterPx > 0)) errs.push('ball.diameterPx 不正確');
  if (!Array.isArray(b.shots)) errs.push('缺少 shots');
  else {
    const n = Array.isArray(b.frameTimes) ? b.frameTimes.length : 0;
    b.shots.forEach((s, i) => {
      if (typeof s.made !== 'boolean') errs.push(`第 ${i + 1} 球缺少 made`);
      if (!Array.isArray(s.frames) || !s.frames.length) {
        errs.push(`第 ${i + 1} 球沒有 frames`);
        return;
      }
      let prev = -1;
      for (const f of s.frames) {
        if (!Number.isInteger(f.f) || f.f < 0 || f.f >= n) {
          errs.push(`第 ${i + 1} 球有超出範圍的幀號 ${f.f}`);
          break;
        }
        if (f.f <= prev) {
          errs.push(`第 ${i + 1} 球的幀號沒有遞增`);
          break;
        }
        prev = f.f;
        if (!num(f.x) || !num(f.y) || !num(f.t)) {
          errs.push(`第 ${i + 1} 球第 ${f.f} 幀的座標不正確`);
          break;
        }
        if (f.src !== 'manual' && f.src !== 'interp' && f.src !== 'auto') {
          errs.push(`第 ${i + 1} 球第 ${f.f} 幀的 src 不正確`);
          break;
        }
      }
    });
  }
  if (b.noBall != null) {
    if (!Array.isArray(b.noBall)) errs.push('noBall 應為陣列');
    else {
      for (const r of b.noBall) {
        if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from > r.to || r.from < 0) {
          errs.push('noBall 的範圍不正確');
          break;
        }
      }
    }
  }
  return errs;
}
