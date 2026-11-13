// 開啟使用者選的影片：先試主要引擎（WebCodecs），不行再退到 <video>。

import { SourceError } from './source.js';
import { openCodecSource } from './codec-source.js';
import { openVideoElementSource } from './video-source.js';

/**
 * @param {File} file
 * @param {{engine?: 'auto'|'codec'|'video', onProgress?: (text:string) => void}} [opts]
 *        engine 可以強制指定（網址加 ?engine=video 測試退路時用）
 * @returns {Promise<object>} FrameSource；多一個 attempts 欄位記錄試過哪些引擎和失敗原因
 */
export async function openVideoFile(file, opts = {}) {
  const engine = opts.engine || 'auto';
  const attempts = [];
  if (engine !== 'video') {
    try {
      const src = await openCodecSource(file, opts);
      src.attempts = attempts;
      return src;
    } catch (err) {
      attempts.push({ engine: 'codec', code: err.code || 'error', message: err.message, detail: err.detail || null });
      if (engine === 'codec') throw describeFailure(file, attempts);
    }
  }
  try {
    const src = await openVideoElementSource(file, opts);
    src.attempts = attempts;
    return src;
  } catch (err) {
    attempts.push({ engine: 'video', code: err.code || 'error', message: err.message, detail: err.detail || null });
    throw describeFailure(file, attempts);
  }
}

/** 把失敗原因整理成使用者看得懂、而且知道下一步怎麼做的訊息。 */
function describeFailure(file, attempts) {
  const codecFail = attempts.find((a) => a.code === 'cannot_decode');
  const lines = [];
  if (codecFail) {
    lines.push(`${codecFail.message}。`);
    if (/hevc|hvc|h265/i.test(String(codecFail.detail || codecFail.message))) {
      lines.push('這通常是 iPhone 的「高效率」(HEVC) 影片。可以改用 Safari、換一台支援的裝置，或把 iPhone 的「設定 → 相機 → 格式」改成「最相容」後重錄。');
    }
  } else if (attempts.some((a) => a.code === 'no_video_track')) {
    lines.push('這個檔案裡沒有影片。');
  } else {
    lines.push('打不開這支影片。');
    lines.push('請確認它是手機錄的 MP4 或 MOV 檔。');
  }
  const err = new SourceError('open_failed', lines.join(''), attempts);
  err.attempts = attempts;
  return err;
}
