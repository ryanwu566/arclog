// 一次練習的狀態與操作（校正、標記、每一球、復原、標註包）。
// 這個檔案不碰 DOM，所以可以在 Node 裡測試；畫面只負責呼叫這裡的函式再重畫。

import { DRAG_K_RIM, MIN_MANUAL_POINTS, roundAngle } from '../core/constants.js';
import { makeHoopFrame, toHoop } from '../core/geometry.js';
import { analyzeShot, judgeMake } from '../core/shot.js';
import { interpolateShot } from '../core/interp.js';
import { buildBundle } from '../core/bundle.js';
import { todayString } from '../core/history.js';

const UNDO_LIMIT = 60;
let counter = 0;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * @param {object} o
 * @param {'video'|'demo'|'csv'|'history'} o.mode
 * @param {object} [o.info] 影片資訊（name, size, width, height, fps, frameCount, duration, codec, rotation, timeSource, engine）
 * @param {object[]} [o.truth] 示範模式每一球的真實答案
 */
export function createSession(o) {
  return {
    id: newId('s'),
    mode: o.mode,
    info: o.info || null,
    // 籃框前緣、後緣；top、bottom 是「垂直參考線」基準才用到的鉛直線兩端
    hoopPoints: emptyHoopPoints(),
    // 水平基準：實拍影片用「籃框連線並修正透視」；示範模式的合成畫面沒有透視，直接用籃框連線
    level: o.mode === 'demo' ? 'rim' : 'persp',
    drag: true,
    shots: [],
    draft: [],
    noBall: [],
    player: '',
    date: o.date || todayString(),
    note: '',
    truth: o.truth || null,
    undo: [],
    nextShotId: 1,
    // 自動分析的摘要（鏡頭角度等級、偏角、模式）；手動標記的練習是 null
    auto: null,
  };
}

/**
 * 自動分析的球：角度是在「投籃平面」上算的（或偏角太大時沒有角度），校正改了也不重算，
 * 除非使用者按「修正」重新標點（那時會變成手動標記的球）。
 */
export function isFixedAuto(shot) {
  return shot.source === 'auto' && !!shot.auto && !!shot.auto.mode;
}

/** 放進自動分析的結果（pipeline.js 的 shotsFromResult、autoSummary）。 */
export function setAutoResult(s, shots, summary, hoopPoints) {
  remember(s);
  s.shots = shots.map((x, i) => ({ ...x, id: i + 1 }));
  s.nextShotId = s.shots.length + 1;
  s.auto = summary;
  if (hoopPoints && hoopPoints.front && hoopPoints.back) s.hoopPoints = { ...emptyHoopPoints(), front: { ...hoopPoints.front }, back: { ...hoopPoints.back } };
}

// ── 復原 ──
const snapshot = (s) =>
  JSON.stringify({ hoopPoints: s.hoopPoints, level: s.level, shots: s.shots, draft: s.draft, noBall: s.noBall, nextShotId: s.nextShotId });

/** 在會改動資料的操作之前呼叫，記下目前的狀態。 */
export function remember(s) {
  s.undo.push(snapshot(s));
  if (s.undo.length > UNDO_LIMIT) s.undo.shift();
}

/** 回到上一步。沒有可以復原的就回傳 false。 */
export function undo(s) {
  const snap = s.undo.pop();
  if (!snap) return false;
  Object.assign(s, JSON.parse(snap));
  return true;
}

// ── 校正 ──
function emptyHoopPoints() {
  return { front: null, back: null, top: null, bottom: null };
}

// 修正透視（和垂直參考線的籃框比例）要知道畫面大小。只有實拍影片才給：
// 示範模式的合成畫面沒有透視，不給的話 'persp' 會自動當成 'rim'，'vertical' 也不扣比例，結果才是對的。
// 3D 合成示範和相機錄影也有透視（info.perspective）。
const dims = (s) => ((s.mode === 'video' || (s.info && s.info.perspective)) && s.info ? { width: s.info.width, height: s.info.height } : {});

export function hoopFrame(s) {
  const { front, back, top, bottom } = s.hoopPoints;
  if (!front || !back) return null;
  return makeHoopFrame(front, back, { level: s.level, ...dims(s), vertical: top && bottom ? { top, bottom } : null });
}

export const LEVELS = ['persp', 'vertical', 'rim', 'image'];

/** 「垂直參考線」比籃框寬度的幾倍還短就提醒（籃板側邊點完整約是 2.3 倍）。 */
export const VERTICAL_MIN_RATIO = 1.5;
/** 垂直參考線和籃框（扣掉透視後）推算的手機歪斜差超過幾度就提醒。 */
export const VERTICAL_AGREE_DEG = 2;

/**
 * 校正時下一個要點的點：先點籃框 'front'、'back'；水平基準是「垂直參考線」時再點 'top'、'bottom'。
 * 都點好了回傳 null。
 */
export function nextCalPoint(s) {
  const hp = s.hoopPoints;
  if (!hp.front) return 'front';
  if (!hp.back) return 'back';
  if (s.level === 'vertical') {
    if (!hp.top) return 'top';
    if (!hp.bottom) return 'bottom';
  }
  return null;
}

/**
 * 點都點了卻建立不了座標系的原因：'rim'＝籃框兩點太接近；'vertical'＝垂直參考線兩點太接近或不是鉛直的線。
 * 還沒點完或沒有問題時回傳 null。
 */
export function calibrationProblem(s) {
  if (nextCalPoint(s) || hoopFrame(s)) return null;
  const { front, back } = s.hoopPoints;
  if (s.level === 'vertical' && makeHoopFrame(front, back, { level: 'rim' })) return 'vertical';
  return 'rim';
}

/**
 * 校正後的傾斜資訊（度）。
 *   raw：籃框兩點連線相對畫面水平斜幾度。
 *   level='persp'：persp 是透視造成的部分，residual 是「扣掉透視之後還剩幾度」——
 *                  那一部分才是手機沒放平、鏡頭有仰角，或兩點沒點在同樣高度造成的。
 *   level='vertical'：vert 是由垂直參考線換算的手機歪斜；rimRoll 是同一件事由籃框（扣掉透視）推算的值，
 *                  兩個是獨立的估計，差很多代表有一邊點錯了或參考線不是鉛直的（沒有畫面大小時為 null）。
 */
export function hoopSkew(s) {
  const hoop = hoopFrame(s);
  if (!hoop) return null;
  const out = { raw: hoop.tiltDeg, persp: hoop.perspDeg, residual: hoop.tiltDeg - hoop.perspDeg, level: hoop.level, vert: hoop.vertDeg, rimRoll: null };
  if (hoop.level === 'vertical') {
    const p = makeHoopFrame(s.hoopPoints.front, s.hoopPoints.back, { level: 'persp', ...dims(s) });
    if (p && p.level === 'persp') out.rimRoll = p.tiltDeg - p.perspDeg;
  }
  return out;
}

const dragK = (s) => (s.drag ? DRAG_K_RIM : 0);

/** 校正有沒有問題；回傳給使用者看的提醒。 */
export function hoopWarnings(s) {
  const out = [];
  const hoop = hoopFrame(s);
  if (!hoop) return out;
  if (hoop.len < 30) out.push(`籃框在畫面上只有 ${Math.round(hoop.len)} 像素寬，角度會比較不準。建議鏡頭近一點，或用解析度高一點的影片。`);
  const skew = hoop.tiltDeg - hoop.perspDeg;
  if (hoop.level === 'persp') {
    if (Math.abs(skew) > 3) out.push(`扣掉透視之後，兩點連線還歪了 ${Math.abs(skew).toFixed(1)} 度。可能是手機沒放平、鏡頭往上仰，或兩點沒有點在籃框同樣的高度。角度可能會差到 1 度左右。`);
  } else if (hoop.level === 'vertical') {
    const { top, bottom } = s.hoopPoints;
    const vlen = Math.hypot(top.x - bottom.x, top.y - bottom.y);
    if (vlen < VERTICAL_MIN_RATIO * hoop.len) out.push(`垂直參考線只有 ${Math.round(vlen)} 像素長，點的誤差影響會比較大。請在同一條邊上把兩點點得遠一點（例如籃板側邊的上下兩端）。`);
    const sk = hoopSkew(s);
    if (sk.rimRoll != null && Math.abs(sk.rimRoll - sk.vert) > VERTICAL_AGREE_DEG) {
      out.push(`垂直參考線和籃框推算的水平差了 ${Math.abs(sk.rimRoll - sk.vert).toFixed(1)} 度，可能有一邊點歪了。請放大確認：參考線是真的鉛直的邊（籃板側邊、立柱，不要用斜的支架），兩端點在同一條邊上；籃框兩點點在同樣的高度。不是用 1 倍鏡頭拍的影片也會差 1 到 2 度，這時以垂直參考線為準。`);
    }
  } else if (Math.abs(hoop.tiltDeg) > 4) {
    out.push(`兩點連線歪了 ${Math.abs(hoop.tiltDeg).toFixed(1)} 度。請確認兩點是不是都點在籃框的同一個高度，或手機有沒有放平。`);
  }
  if (s.info && hoop.len > s.info.width * 0.5) out.push('籃框寬度超過半個畫面，請確認點的是籃框的前緣和後緣。');
  return out.concat(calibrationSanity(s));
}

/**
 * 點的位置明顯不合理時的提醒（看示意圖重點）：
 *   兩點幾乎上下對齊（籃框前後緣應該左右排列）、兩點高度差很多、點在畫面最下面（多半是地板）、
 *   垂直參考線歪很多（不是鉛直的邊）、自動找到的籃框和點的位置差很遠。
 */
export function calibrationSanity(s) {
  const out = [];
  const { front, back, top, bottom } = s.hoopPoints;
  if (!front || !back) return out;
  const dx = back.x - front.x;
  const dy = back.y - front.y;
  const W = s.info && s.info.width ? s.info.width : null;
  const H = s.info && s.info.height ? s.info.height : null;
  if (Math.abs(dy) > Math.abs(dx)) out.push('兩點幾乎是上下排列的。籃框的前緣和後緣應該是左右兩端（看上面的示意圖），請重新點。');
  else if (Math.abs(dx) > 1 && Math.abs(dy) / Math.abs(dx) > Math.tan((15 * Math.PI) / 180)) out.push(`兩點的高度差了 ${Math.round(Math.abs(dy))} 像素（連線斜了 ${Math.round((Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI)} 度）。前緣和後緣要點在籃框鐵圈同一個高度，不要點到球網。`);
  if (H && Math.min(front.y, back.y) > 0.8 * H) out.push('這兩點在畫面最下面，看起來像是點到地板了。籃框在 3.05 公尺高，通常在畫面上半部。');
  if (W && Math.abs(dx) < Math.max(6, 0.008 * W)) out.push('兩點太接近了，請放大畫面再點籃框的兩端。');
  if (s.level === 'vertical' && top && bottom) {
    const tilt = (Math.atan2(Math.abs(top.x - bottom.x), Math.abs(top.y - bottom.y) || 1e-9) * 180) / Math.PI;
    if (tilt > 10) out.push(`垂直參考線歪了 ${Math.round(tilt)} 度，不像是鉛直的邊。請選籃板側邊或籃架立柱，不要用斜的支架。`);
  }
  if (s.auto && s.auto.rimBox) {
    const b = s.auto.rimBox;
    const cx = (front.x + back.x) / 2;
    const cy = (front.y + back.y) / 2;
    const w = b.x1 - b.x0;
    if (Math.abs(cx - (b.x0 + b.x1) / 2) > w || Math.abs(cy - (b.y0 + b.y1) / 2) > w) out.push('點的位置和自動找到的籃框差很遠，請確認點的是你投的那個籃框。');
  }
  return out;
}

/** which：'front'、'back'（籃框），或 'top'、'bottom'（垂直參考線）。 */
export function setHoopPoint(s, which, pos) {
  remember(s);
  s.hoopPoints = { ...s.hoopPoints, [which]: { x: pos.x, y: pos.y } };
  reanalyzeAll(s);
}

/** 重新點：籃框和垂直參考線一起清掉。 */
export function resetHoop(s) {
  remember(s);
  s.hoopPoints = emptyHoopPoints();
}

export function setLevel(s, level) {
  if (s.level === level) return;
  remember(s);
  s.level = LEVELS.includes(level) ? level : 'persp';
  reanalyzeAll(s);
}

// ── 分析 ──
function analyzePoints(s, points) {
  const hoop = hoopFrame(s);
  if (!hoop) return { ok: false, reason: 'no_hoop' };
  const pts = points.map((p) => {
    const [u, v] = toHoop(hoop, p.x, p.y);
    return { u, v, t: p.t };
  });
  return analyzeShot(pts, { dragK: dragK(s) });
}

function applyAnalysis(shot, res) {
  shot.angle = roundAngle(res.angleRaw);
  shot.angleRaw = res.angleRaw;
  shot.crossS = res.crossS;
  shot.zone = res.zone;
  shot.madeSuggested = res.made;
  shot.analysis = { model: res.model, flip: res.flip, apex: res.apex, rms: res.rms, monotonic: res.monotonic };
}

/** 校正改了之後，每一球重新算一次（進球與否保留使用者確認過的結果）。 */
export function reanalyzeAll(s) {
  for (const shot of s.shots) {
    if (isFixedAuto(shot)) continue;
    if (!shot.points || shot.points.length < 3) continue;
    const res = analyzePoints(s, shot.points);
    if (res.ok) applyAnalysis(shot, res);
    else shot.analysis = null;
  }
}

// ── 正在標的這一球 ──
/** 加一個球心。同一幀已經有點就取代。 */
export function addDraftPoint(s, p) {
  remember(s);
  const pt = { frame: p.frame, t: p.t, x: p.x, y: p.y };
  s.draft = s.draft.filter((q) => q.frame !== p.frame).concat([pt]).sort((a, b) => a.frame - b.frame);
}

/** 拖曳時即時更新位置（不記復原點）；放開時 commit=true 才記。 */
export function moveDraftPoint(s, frame, pos, commit) {
  if (commit) {
    // 拖曳開始前的狀態已經不在了，所以把「拖曳前」近似成目前這一筆的前一個快照
    s.undo.push(s._dragSnap || snapshot(s));
    if (s.undo.length > UNDO_LIMIT) s.undo.shift();
    s._dragSnap = null;
  } else if (!s._dragSnap) {
    s._dragSnap = snapshot(s);
  }
  const q = s.draft.find((d) => d.frame === frame);
  if (q) {
    q.x = pos.x;
    q.y = pos.y;
  }
}

export function clearDraft(s) {
  if (!s.draft.length) return;
  remember(s);
  s.draft = [];
}

/**
 * 目前這一球的即時分析。
 * @returns {{count:number, enough:boolean, result:object|null, reason:string|null}}
 */
export function draftStatus(s) {
  const count = s.draft.length;
  const enough = count >= MIN_MANUAL_POINTS;
  if (count < 3) return { count, enough, result: null, reason: null };
  const res = analyzePoints(s, s.draft);
  if (!res.ok) return { count, enough, result: null, reason: res.reason };
  return { count, enough, result: res, reason: null };
}

/** 給使用者看的失敗原因。 */
export function reasonText(reason) {
  switch (reason) {
    case 'no_hoop':
      return '還沒有校正籃框。';
    case 'not_arc':
      return '這些點連起來不像投籃的拋物線（開口朝上）。請檢查有沒有點錯。';
    case 'no_crossing':
      return '這條軌跡的最高點沒有超過籃框，算不出入框角度。請檢查點的位置和籃框校正。';
    case 'no_motion':
      return '這些點的水平位置幾乎一樣。請在球飛行途中的不同位置點。';
    case 'degenerate':
      return '這些點不夠分散，沒辦法擬合。請多點幾個不同的位置。';
    case 'too_few_points':
      return '點太少了。';
    default:
      return '算不出來，請檢查點的位置。';
  }
}

/** 把正在標的這一球存起來。made 沒給就用建議值。 */
export function saveDraftShot(s, made) {
  const st = draftStatus(s);
  if (!st.enough || !st.result) return { ok: false, reason: st.reason || 'too_few_points' };
  remember(s);
  const shot = { id: s.nextShotId++, source: 'manual', points: s.draft.map((p) => ({ ...p })), made: made == null ? st.result.made : !!made };
  applyAnalysis(shot, st.result);
  s.shots.push(shot);
  s.draft = [];
  sortShots(s);
  return { ok: true, shot };
}

function sortShots(s) {
  s.shots.sort((a, b) => {
    const fa = a.points && a.points.length ? a.points[0].frame : Infinity;
    const fb = b.points && b.points.length ? b.points[0].frame : Infinity;
    return fa - fb || a.id - b.id;
  });
}

export function deleteShot(s, id) {
  remember(s);
  s.shots = s.shots.filter((x) => x.id !== id);
}

export function setMade(s, id, made) {
  const shot = s.shots.find((x) => x.id === id);
  if (!shot || shot.made === made) return;
  remember(s);
  shot.made = !!made;
  if (shot.auto) shot.auto.corrected = true;
}

/** 把存好的一球拿回來重新調整（點太多時抽樣成最多 8 個）。 */
export function editShot(s, id) {
  const shot = s.shots.find((x) => x.id === id);
  if (!shot || !shot.points || !shot.points.length) return false;
  remember(s);
  let pts = shot.points;
  if (pts.length > 8) {
    const pick = [];
    for (let i = 0; i < 8; i++) pick.push(pts[Math.round((i * (pts.length - 1)) / 7)]);
    pts = pick.filter((p, i) => i === 0 || p.frame !== pick[i - 1].frame);
  }
  s.draft = pts.map((p) => ({ frame: p.frame, t: p.t, x: p.x, y: p.y }));
  s.shots = s.shots.filter((x) => x.id !== id);
  return true;
}

/**
 * 加入自動偵測並經使用者接受的球。和已有的球時間重疊的會被略過。
 * @param {object[]} found findShots 回傳的 shots
 * @returns {number} 實際加入幾球
 */
export function addAutoShots(s, found) {
  if (!found.length) return 0;
  remember(s);
  let added = 0;
  for (const f of found) {
    const f0 = f.fStart;
    const f1 = f.fEnd;
    const clash = s.shots.some((x) => x.points && x.points.length && x.points[0].frame <= f1 && x.points[x.points.length - 1].frame >= f0);
    if (clash) continue;
    s.shots.push({
      id: s.nextShotId++,
      source: 'auto',
      points: f.points.map((p) => ({ frame: p.f, t: p.t, x: p.x, y: p.y })),
      made: !!f.made,
      madeSuggested: f.madeGeometry,
      zone: f.zone,
      angle: f.angle,
      angleRaw: f.angleRaw,
      crossS: f.crossS,
      analysis: { model: f.model, flip: f.flip, apex: f.apex, rms: f.rms, monotonic: true },
      auto: { madeBy: f.madeBy, evidence: f.evidence, fCross: f.fCross },
    });
    added++;
  }
  sortShots(s);
  return added;
}

// ── 沒有球的片段 ──
export function addNoBall(s, from, to) {
  const a = Math.min(from, to);
  const b = Math.max(from, to);
  remember(s);
  s.noBall = s.noBall.concat([{ from: a, to: b }]).sort((x, y) => x.from - y.from);
}
export function removeNoBall(s, index) {
  remember(s);
  s.noBall = s.noBall.filter((_, i) => i !== index);
}

// ── 給報告和匯出用 ──
/** 依出手順序的 [{angle, made, source}]。自動分析偏角太大（C 級）的球沒有角度（angle 是 null）。 */
export function reportShots(s) {
  return s.shots
    .filter((x) => typeof x.angle === 'number' || (x.angle === null && isFixedAuto(x)))
    .map((x) => ({ angle: x.angle, made: !!x.made, source: x.source }));
}

/** 示範模式：每一球對應的真實答案（對不到的是 null）。 */
export function truthForShots(s) {
  if (!s.truth) return null;
  return s.shots
    .filter((x) => typeof x.angle === 'number' || (x.angle === null && isFixedAuto(x)))
    .map((x) => {
      // 自動分析的球用過框時間對；手動的用標記點的中間時間
      if (x.auto && x.auto.tCross != null) return s.truth.find((t) => Math.abs(t.tCross - x.auto.tCross) < 0.35) || null;
      if (!x.points || !x.points.length) return null;
      const mid = (x.points[0].t + x.points[x.points.length - 1].t) / 2;
      return s.truth.find((t) => mid >= t.tRelease - 0.15 && mid <= t.tCross + 0.15) || null;
    });
}

/** 這一球從第一個點到最後一個點之間每一幀的球心（手點加內插）；沒辦法算就回傳 null。 */
export function shotFrames(s, shot, frameTimes) {
  const hoop = hoopFrame(s);
  if (!hoop || !shot.analysis || !shot.points || shot.points.length < 2) return null;
  const frames = interpolateShot(shot.points, frameTimes, hoop, shot.analysis);
  if (shot.source === 'auto') for (const f of frames) if (f.src === 'manual') f.src = 'auto';
  return frames;
}

/** 有沒有可以匯出成標註包的內容。 */
export function canExportBundle(s) {
  return !!hoopFrame(s) && s.shots.some((x) => x.points && x.points.length >= 2 && x.analysis);
}

/** 建立標註包（給 training/build_dataset.py 用）。 */
export function sessionBundle(s, frameTimes, opts = {}) {
  const hoop = hoopFrame(s);
  if (!hoop) return null;
  const shots = [];
  for (const shot of s.shots) {
    const frames = shotFrames(s, shot, frameTimes);
    if (!frames) continue;
    shots.push({ id: shots.length + 1, source: shot.source, made: !!shot.made, angleDeg: shot.angle, crossS: shot.crossS, frames });
  }
  const hp = s.hoopPoints;
  return buildBundle({
    video: { ...s.info, fps: s.info.fps, duration: s.info.duration },
    frameTimes,
    hoopPoints: { front: hp.front, back: hp.back, level: s.level, ...(hoop.level === 'vertical' ? { vertical: { top: hp.top, bottom: hp.bottom } } : {}) },
    hoop,
    shots,
    noBall: s.noBall,
    synthetic: s.mode === 'demo',
    createdAt: opts.createdAt,
  });
}

// ── 草稿（存在本機，避免重新整理後全部不見）──
export function draftKey(info) {
  return info ? `${info.name}|${info.size ?? ''}|${info.frameCount}|${info.width}x${info.height}` : '';
}

export function serializeDraft(s) {
  return {
    key: draftKey(s.info),
    id: s.id,
    savedAt: new Date().toISOString(),
    hoopPoints: s.hoopPoints,
    level: s.level,
    shots: s.shots.map((x) => (isFixedAuto(x) ? { ...x, analysis: null } : { id: x.id, source: x.source, points: x.points, made: x.made, auto: x.auto || null })),
    auto: s.auto,
    draft: s.draft,
    noBall: s.noBall,
    player: s.player,
    date: s.date,
    nextShotId: s.nextShotId,
  };
}

/** 這次練習有沒有值得暫存的內容。 */
export function hasContent(s) {
  return !!(s.hoopPoints.front || s.hoopPoints.back || s.shots.length || s.draft.length || s.noBall.length);
}

/** 把存下來的草稿套回去。回傳成功還原了幾球。 */
export function restoreDraft(s, d) {
  if (!d || d.key !== draftKey(s.info)) return 0;
  if (typeof d.id === 'string' && d.id) s.id = d.id; // 同一次練習沿用同一個代號，歷次紀錄才不會重複
  s.hoopPoints = { ...emptyHoopPoints(), ...(d.hoopPoints || {}) };
  if (LEVELS.includes(d.level)) s.level = d.level;
  s.draft = Array.isArray(d.draft) ? d.draft : [];
  s.noBall = Array.isArray(d.noBall) ? d.noBall : [];
  s.player = typeof d.player === 'string' ? d.player : '';
  if (typeof d.date === 'string') s.date = d.date;
  s.shots = [];
  if (d.auto && typeof d.auto === 'object') s.auto = d.auto;
  for (const x of Array.isArray(d.shots) ? d.shots : []) {
    if (isFixedAuto(x) && typeof x.made === 'boolean' && (x.angle === null || typeof x.angle === 'number')) {
      s.shots.push({ ...x, points: Array.isArray(x.points) ? x.points : [] });
      continue;
    }
    if (!Array.isArray(x.points) || x.points.length < 3) continue;
    const res = analyzePoints(s, x.points);
    if (!res.ok) continue;
    const shot = { id: x.id, source: x.source === 'auto' ? 'auto' : 'manual', points: x.points, made: !!x.made };
    if (x.auto) shot.auto = x.auto;
    applyAnalysis(shot, res);
    s.shots.push(shot);
  }
  s.nextShotId = Math.max(d.nextShotId || 1, ...s.shots.map((x) => x.id + 1), 1);
  sortShots(s);
  s.undo = [];
  return s.shots.length;
}

export { judgeMake };
