// 主要的影格引擎：Mediabunny 解封裝 ＋ WebCodecs 解碼。
//
// 為什麼不用 <video> 的 currentTime：規格不保證 seek 逐幀準確，Safari 還有 seek 後畫到上一幀的老問題。
// 這裡每一幀的時間戳直接讀自影片檔，要第幾幀就解第幾幀，可變幀率和帶旋轉的影片也正確。

import {
  Input,
  BlobSource,
  ALL_FORMATS,
  VideoSampleSink,
  EncodedPacketSink,
} from '../../vendor/mediabunny-1.65.2/mediabunny.min.mjs';
import { SourceError, describeTiming, nearestIndex, serialQueue, clampIndex, makeCanvas } from './source.js';

/** 暫存解碼後畫面用的記憶體上限（位元組）。 */
const CACHE_BYTES = 160 * 1024 * 1024;
/** 往前跳超過這麼多幀就重新定位，不要一路解過去。 */
const MAX_FORWARD = 90;

/**
 * @param {File|Blob} file
 * @param {{onProgress?: (text:string) => void}} [opts]
 * @returns {Promise<object>} FrameSource
 */
export async function openCodecSource(file, opts = {}) {
  const say = opts.onProgress || (() => {});
  if (typeof VideoDecoder === 'undefined') {
    throw new SourceError('no_webcodecs', '這個瀏覽器不支援 WebCodecs');
  }

  say('讀取影片資訊…');
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  let track;
  try {
    track = await input.getPrimaryVideoTrack();
  } catch (err) {
    input.dispose();
    throw new SourceError('unreadable', '看不懂這個檔案的格式', String(err && err.message ? err.message : err));
  }
  if (!track) {
    input.dispose();
    throw new SourceError('no_video_track', '這個檔案裡沒有影片');
  }

  const fail = (code, message, detail) => {
    input.dispose();
    return new SourceError(code, message, detail);
  };

  let codec = null;
  let width = 0;
  let height = 0;
  let rotation = 0;
  try {
    codec = await track.getCodec();
    width = await track.getDisplayWidth();
    height = await track.getDisplayHeight();
    rotation = await track.getRotation();
  } catch (err) {
    throw fail('unreadable', '讀不到影片的基本資訊', String(err));
  }
  let decodable = false;
  try {
    decodable = await track.canDecode();
  } catch {
    decodable = false;
  }
  if (!decodable) {
    throw fail('cannot_decode', `這台裝置的瀏覽器解不開這種影片編碼（${codec || '未知'}）`, codec);
  }

  // 每一幀的時間戳：只讀封包的中繼資料，不必解碼。負的時間戳是不會顯示的前置幀，略過。
  say('讀取每一幀的時間戳…');
  const raw = [];
  try {
    const packets = new EncodedPacketSink(track);
    for await (const p of packets.packets(undefined, undefined, { metadataOnly: true })) {
      if (p.timestamp >= 0) raw.push(p.timestamp);
    }
  } catch (err) {
    throw fail('unreadable', '讀取影片的時間戳時失敗', String(err));
  }
  raw.sort((a, b) => a - b);
  const times = [];
  for (const t of raw) {
    if (!times.length || t - times[times.length - 1] > 1e-6) times.push(t);
  }
  if (times.length < 2) throw fail('too_short', '影片太短，至少要有兩幀');
  const frameTimes = Float64Array.from(times);
  const timing = describeTiming(frameTimes);

  // 實際解一幀確認真的解得開（有些瀏覽器會說支援，解碼時才失敗）
  say('測試解碼…');
  const sink = new VideoSampleSink(track);
  let first;
  try {
    first = await sink.getSample(frameTimes[0]);
  } catch (err) {
    throw fail('cannot_decode', `影片解碼失敗（${codec || '未知編碼'}）`, String(err));
  }
  if (!first) throw fail('cannot_decode', `影片解碼失敗（${codec || '未知編碼'}）`);
  width = first.displayWidth || width;
  height = first.displayHeight || height;

  const frameBytes = width * height * 4;
  const capacity = Math.max(4, Math.min(24, Math.floor(CACHE_BYTES / frameBytes)));
  const back = Math.min(6, capacity - 2);
  const cache = new Map(); // 幀號 → ImageBitmap；Map 會記住放進去的順序
  const scratch = makeCanvas(width, height);
  const sctx = scratch.getContext('2d');
  let pinned = -1; // 最近一次交出去的幀，不可以被清掉

  const toBitmap = async (sample) => {
    sctx.clearRect(0, 0, width, height);
    sample.draw(sctx, 0, 0, width, height);
    if (typeof scratch.transferToImageBitmap === 'function') return scratch.transferToImageBitmap();
    return createImageBitmap(scratch);
  };
  const store = (index, bitmap) => {
    const old = cache.get(index);
    if (old) {
      cache.delete(index);
      if (old !== bitmap && old.close) old.close();
    }
    cache.set(index, bitmap);
    for (const key of cache.keys()) {
      if (cache.size <= capacity) break;
      if (key === pinned || key === index) continue;
      const bmp = cache.get(key);
      cache.delete(key);
      if (bmp.close) bmp.close();
    }
  };
  store(0, await toBitmap(first));
  first.close();

  let iter = null; // 目前往前解碼的迭代器
  let iterNext = -1; // 迭代器下一個會吐出來的幀號
  const closeIter = async () => {
    if (iter) {
      const it = iter;
      iter = null;
      iterNext = -1;
      try {
        await it.return();
      } catch {
        /* 關閉失敗不影響後面 */
      }
    }
  };

  const decodeTo = async (i) => {
    if (!iter || i < iterNext || i > iterNext + MAX_FORWARD) {
      await closeIter();
      const start = Math.max(0, i - back);
      iter = sink.samples(frameTimes[start]);
      iterNext = start;
    }
    while (iter && iterNext <= i) {
      const step = await iter.next();
      if (step.done) {
        iter = null;
        iterNext = -1;
        break;
      }
      const sample = step.value;
      const index = nearestIndex(frameTimes, sample.timestamp);
      try {
        if (index >= i - back) store(index, await toBitmap(sample));
      } finally {
        sample.close();
      }
      iterNext = index + 1;
    }
  };

  const queue = serialQueue();
  let disposed = false;
  const warnings = [];
  if (timing.vfr) warnings.push('這支影片是可變幀率：每一幀的間隔不固定。逐幀與角度計算不受影響。');

  return {
    engine: 'codec',
    name: file.name || 'video',
    size: file.size ?? null,
    width,
    height,
    frameCount: frameTimes.length,
    frameTimes,
    fps: timing.fps,
    duration: frameTimes[frameTimes.length - 1] + 1 / timing.fps,
    timeSource: 'container',
    codec,
    rotation,
    warnings,
    vfr: timing.vfr,

    getFrame(i) {
      return queue(async () => {
        if (disposed) throw new SourceError('disposed', '影片已經關閉');
        const k = clampIndex(i, frameTimes.length);
        if (!cache.has(k)) await decodeTo(k);
        let image = cache.get(k);
        if (!image) {
          // 循序解碼沒有拿到（例如檔案中間有壞掉的地方）：單獨定位一次
          const sample = await sink.getSample(frameTimes[k]);
          if (!sample) throw new SourceError('decode_failed', `第 ${k + 1} 幀解不出來`);
          try {
            store(k, await toBitmap(sample));
          } finally {
            sample.close();
          }
          image = cache.get(k);
        }
        pinned = k;
        return { index: k, time: frameTimes[k], image };
      });
    },

    async scan({ from = 0, to = frameTimes.length - 1, stride = 1, signal, onFrame }) {
      const a = Math.max(0, from);
      const b = Math.min(to, frameTimes.length - 1);
      const step = Math.max(1, stride | 0);
      const wanted = [];
      for (let i = a; i <= b; i += step) wanted.push(i);
      // 用另一個解碼器循序走過去，不會打斷畫面上正在看的那一幀
      const scanSink = new VideoSampleSink(track);
      let n = 0;
      let frames = 0;
      let cancelled = false;
      for await (const sample of scanSink.samplesAtTimestamps(wanted.map((i) => frameTimes[i]))) {
        const index = wanted[n++];
        if (!sample) continue;
        try {
          if (signal && signal.aborted) {
            cancelled = true;
            break;
          }
          await onFrame({
            index,
            time: frameTimes[index],
            draw: (c, dx, dy, dw, dh) => sample.draw(c, dx, dy, dw, dh),
          });
          frames++;
        } finally {
          sample.close();
        }
      }
      return { frames, cancelled };
    },

    dispose() {
      disposed = true;
      closeIter();
      for (const bmp of cache.values()) if (bmp.close) bmp.close();
      cache.clear();
      input.dispose();
    },
  };
}
