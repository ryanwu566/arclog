// 退路的影格引擎：<video> 元素 ＋ requestVideoFrameCallback。
//
// 只有在 WebCodecs 不能用、或解不開這支影片的編碼時才會用到。
// <video> 的 seek 規格上不保證逐幀準確，所以這裡盡量補強：
//   1. 每一幀的時間戳仍然由影片檔讀出來（解封裝不需要 WebCodecs）；讀不到才用估計的固定幀率。
//   2. seek 到「那一幀時間區間的中點」，不踩在邊界上。
//   3. 先註冊 requestVideoFrameCallback 再設 currentTime，用它回報的 mediaTime 核對是不是要的那一幀。
//      seek 落在同一幀時回呼不會來，所以要有逾時。
//   4. 每次 seek 完把畫面複製到自己的畫布，後面的繪圖都用這份複本。

import { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } from '../../vendor/mediabunny-1.65.2/mediabunny.min.mjs';
import { SourceError, describeTiming, nearestIndex, serialQueue, clampIndex } from './source.js';

const once = (target, type, timeoutMs) =>
  new Promise((resolve, reject) => {
    let timer = null;
    const done = (fn, arg) => {
      target.removeEventListener(type, onOk);
      target.removeEventListener('error', onErr);
      if (timer) clearTimeout(timer);
      fn(arg);
    };
    const onOk = (e) => done(resolve, e);
    const onErr = () => done(reject, new Error('media error'));
    target.addEventListener(type, onOk);
    target.addEventListener('error', onErr);
    if (timeoutMs) timer = setTimeout(() => done(reject, new Error(`等不到 ${type}`)), timeoutMs);
  });

const nextPaint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** 試著從影片檔讀出每一幀的時間戳；失敗回傳 null。 */
async function readContainerTimes(file) {
  let input = null;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const raw = [];
    const packets = new EncodedPacketSink(track);
    for await (const p of packets.packets(undefined, undefined, { metadataOnly: true })) {
      if (p.timestamp >= 0) raw.push(p.timestamp);
    }
    raw.sort((a, b) => a - b);
    const times = [];
    for (const t of raw) if (!times.length || t - times[times.length - 1] > 1e-6) times.push(t);
    let codec = null;
    let rotation = 0;
    try {
      codec = await track.getCodec();
      rotation = await track.getRotation();
    } catch {
      /* 沒有也沒關係 */
    }
    return times.length >= 2 ? { times: Float64Array.from(times), codec, rotation } : null;
  } catch {
    return null;
  } finally {
    if (input) input.dispose();
  }
}

/** 播一小段，用 requestVideoFrameCallback 量出幀間隔的中位數。量不到回傳 null。 */
async function measureFps(video) {
  if (!video.requestVideoFrameCallback) return null;
  const stamps = [];
  let active = true;
  const tick = (now, meta) => {
    if (!active) return;
    stamps.push(meta.mediaTime);
    if (stamps.length < 24) video.requestVideoFrameCallback(tick);
  };
  video.requestVideoFrameCallback(tick);
  try {
    await video.play();
  } catch {
    active = false;
    return null;
  }
  const t0 = performance.now();
  while (stamps.length < 24 && performance.now() - t0 < 1500 && !video.ended) {
    await new Promise((r) => setTimeout(r, 40));
  }
  active = false;
  video.pause();
  const dts = [];
  for (let i = 1; i < stamps.length; i++) {
    const d = stamps[i] - stamps[i - 1];
    if (d > 1e-4) dts.push(d);
  }
  if (dts.length < 5) return null;
  dts.sort((a, b) => a - b);
  return 1 / dts[dts.length >> 1];
}

/**
 * @param {File|Blob} file
 * @param {{onProgress?: (text:string) => void}} [opts]
 * @returns {Promise<object>} FrameSource
 */
export async function openVideoElementSource(file, opts = {}) {
  const say = opts.onProgress || (() => {});
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  const cleanup = () => {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  };

  say('載入影片…');
  video.src = url;
  try {
    await once(video, 'loadedmetadata', 15000);
  } catch (err) {
    cleanup();
    throw new SourceError('cannot_play', '這個瀏覽器播不了這支影片', String(err.message || err));
  }
  if (!video.videoWidth || !video.videoHeight || !Number.isFinite(video.duration) || video.duration <= 0) {
    cleanup();
    throw new SourceError('cannot_play', '這個瀏覽器播不了這支影片（讀不到畫面大小或長度）');
  }

  // iPhone 的 Safari 要播過一下才會真的把畫面解出來
  try {
    await video.play();
    video.pause();
  } catch {
    /* 不能自動播放就算了，seek 通常還是可以 */
  }

  const warnings = [];
  let frameTimes;
  let timeSource = 'container';
  let codec = null;
  let rotation = 0;
  say('讀取每一幀的時間戳…');
  const meta = await readContainerTimes(file);
  if (meta) {
    frameTimes = meta.times;
    codec = meta.codec;
    rotation = meta.rotation;
  } else {
    say('估計幀率…');
    timeSource = 'estimated';
    let fps = await measureFps(video);
    if (!fps) {
      fps = 30;
      warnings.push('讀不到這支影片的幀率，先當成每秒 30 幀。逐幀前進可能會跳幀或重複。');
    } else {
      warnings.push(`這支影片讀不到每一幀的時間戳，以估計的每秒 ${fps.toFixed(2)} 幀處理。`);
    }
    const count = Math.max(2, Math.floor(video.duration * fps));
    frameTimes = new Float64Array(count);
    for (let i = 0; i < count; i++) frameTimes[i] = i / fps;
  }
  const timing = describeTiming(frameTimes);
  if (timing.vfr) warnings.push('這支影片是可變幀率：每一幀的間隔不固定。');
  warnings.push('這個瀏覽器只能用相容模式逐幀定位，畫面偶爾可能和幀號差一幀；建議改用新版 Chrome 或 Safari。');

  const width = video.videoWidth;
  const height = video.videoHeight;
  const copy = document.createElement('canvas');
  copy.width = width;
  copy.height = height;
  const cctx = copy.getContext('2d');
  const hasRvfc = typeof video.requestVideoFrameCallback === 'function';
  let offset = 0; // 瀏覽器的時間軸減掉影片檔的時間戳
  let shown = -1;
  let confirmed = -1; // 最近一次由 requestVideoFrameCallback 確認過、目前畫面上的幀號

  const midTime = (i) => {
    const t0 = frameTimes[i];
    const t1 = i + 1 < frameTimes.length ? frameTimes[i + 1] : t0 + 1 / timing.fps;
    const t = t0 + (t1 - t0) * 0.5 + offset;
    return Math.max(0, Math.min(t, video.duration));
  };

  /** seek 到某個時間並等畫面出來；回傳 requestVideoFrameCallback 回報的 mediaTime（沒有就是 null）。 */
  const seekAndWait = async (target) => {
    let presented = null;
    let handle = null;
    if (hasRvfc) {
      handle = video.requestVideoFrameCallback((now, m) => {
        presented = m.mediaTime;
      });
    }
    if (Math.abs(video.currentTime - target) > 1e-6) {
      const seeked = once(video, 'seeked', 8000);
      video.currentTime = target;
      await seeked;
    }
    const t0 = performance.now();
    while (presented === null && hasRvfc && performance.now() - t0 < 300) {
      await new Promise((r) => setTimeout(r, 8));
    }
    if (presented === null) {
      if (handle !== null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      await nextPaint();
    }
    return presented;
  };

  const show = async (i) => {
    let mediaTime = await seekAndWait(midTime(i));
    // 回呼沒來代表畫面沒有換（seek 落在目前這一幀裡），所以沿用上一次確認過的幀號
    let actual = mediaTime !== null && timeSource === 'container' ? nearestIndex(frameTimes, mediaTime - offset) : confirmed;
    if (actual < 0 || timeSource !== 'container' || !hasRvfc) actual = i; // 沒辦法核對時只能相信 seek
    if (actual !== i && timeSource === 'container' && hasRvfc) {
      // 沒落在要的那一幀：往目標幀的時間區間裡再靠一點重試一次
      const t0 = frameTimes[i] + offset;
      const t1 = (i + 1 < frameTimes.length ? frameTimes[i + 1] : frameTimes[i] + 1 / timing.fps) + offset;
      const nudge = actual < i ? t0 + (t1 - t0) * 0.85 : t0 + (t1 - t0) * 0.15;
      mediaTime = await seekAndWait(Math.max(0, Math.min(nudge, video.duration)));
      if (mediaTime !== null) actual = nearestIndex(frameTimes, mediaTime - offset);
    }
    cctx.drawImage(video, 0, 0, width, height);
    shown = actual;
    confirmed = actual;
    return actual;
  };

  // 校準時間軸：有些檔案第一幀的時間不是 0
  try {
    const m0 = await seekAndWait(Math.min(0.5 / timing.fps, video.duration / 2));
    if (m0 !== null && timeSource === 'container') {
      const guess = m0 - frameTimes[0];
      if (Math.abs(guess) > 1e-4 && Math.abs(guess) < 5) offset = guess;
    }
    await show(0);
  } catch (err) {
    cleanup();
    throw new SourceError('cannot_play', '這個瀏覽器沒辦法定位到影片的畫面', String(err.message || err));
  }

  const queue = serialQueue();
  let disposed = false;

  return {
    engine: 'video',
    name: file.name || 'video',
    size: file.size ?? null,
    width,
    height,
    frameCount: frameTimes.length,
    frameTimes,
    fps: timing.fps,
    duration: video.duration,
    timeSource,
    codec,
    rotation,
    warnings,
    vfr: timing.vfr,

    getFrame(i) {
      return queue(async () => {
        if (disposed) throw new SourceError('disposed', '影片已經關閉');
        const k = clampIndex(i, frameTimes.length);
        const actual = shown === k ? k : await show(k);
        return { index: actual, time: frameTimes[actual], image: copy };
      });
    },

    async scan({ from = 0, to = frameTimes.length - 1, stride = 1, signal, onFrame }) {
      let frames = 0;
      const step = Math.max(1, stride | 0);
      for (let i = Math.max(0, from); i <= Math.min(to, frameTimes.length - 1); i += step) {
        if (signal && signal.aborted) return { frames, cancelled: true };
        const actual = await queue(() => show(i));
        await onFrame({
          index: actual,
          time: frameTimes[actual],
          draw: (c, dx, dy, dw, dh) => c.drawImage(copy, dx, dy, dw, dh),
        });
        frames++;
      }
      return { frames, cancelled: false };
    },

    dispose() {
      disposed = true;
      cleanup();
    },
  };
}
