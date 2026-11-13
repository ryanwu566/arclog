// 練習統計與白話摘要。純函式，不碰 DOM。
// 數值部分的 Python 對應檔：arclog/stats.py

import { IDEAL_ENTRY_DEG } from './constants.js';

export function mean(xs) {
  if (!xs.length) return null;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}

/** 樣本標準差（除以 n−1）。少於 2 筆回傳 null。 */
export function sampleStd(xs) {
  const n = xs.length;
  if (n < 2) return null;
  const m = mean(xs);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    s += d * d;
  }
  return Math.sqrt(s / (n - 1));
}

function block(shots) {
  const attempts = shots.length;
  let makes = 0;
  const angles = [];
  for (const s of shots) {
    if (s.made) makes++;
    if (typeof s.angle === 'number' && Number.isFinite(s.angle)) angles.push(s.angle);
  }
  return {
    attempts,
    makes,
    pct: attempts ? (makes / attempts) * 100 : null,
    angleMean: mean(angles),
    angleStd: sampleStd(angles),
  };
}

/**
 * 整理一次練習的統計。
 * 前半 = 前 floor(n/2) 球，後半 = 其餘（球數是奇數時後半多一球）。
 * @param {{angle:number, made:boolean}[]} shots 依出手順序
 */
export function summarize(shots) {
  const n = shots.length;
  const nFirst = Math.floor(n / 2);
  return {
    ...block(shots),
    first: block(shots.slice(0, nFirst)),
    second: block(shots.slice(nFirst)),
  };
}

const f1 = (x) => (Math.floor(Math.abs(x) * 10 + 0.5) / 10).toFixed(1);
const f0 = (x) => String(Math.floor(x + 0.5));

/**
 * 用固定規則把統計寫成兩三句白話。只描述數據，不給技術指導。
 * @returns {string[]} 每個元素一句
 */
export function plainSummary(stats) {
  const out = [];
  if (!stats.attempts) return ['還沒有任何出手紀錄。'];
  out.push(`這次共出手 ${stats.attempts} 球，進 ${stats.makes} 球，命中率 ${f0(stats.pct)}%。`);

  if (stats.angleMean != null) {
    const diff = stats.angleMean - IDEAL_ENTRY_DEG;
    let s = `入框角度平均 ${f1(stats.angleMean)} 度，`;
    if (Math.abs(diff) < 0.5) s += `和 ${IDEAL_ENTRY_DEG} 度參考線相差不到 0.5 度`;
    else s += `比 ${IDEAL_ENTRY_DEG} 度參考線${diff > 0 ? '高' : '低'} ${f1(diff)} 度`;
    if (stats.angleStd != null) s += `；每球之間的標準差是 ${f1(stats.angleStd)} 度。`;
    else s += '。';
    out.push(s);
  }

  const a = stats.first;
  const b = stats.second;
  if (stats.attempts >= 6 && a.angleMean != null && b.angleMean != null) {
    const d = b.angleMean - a.angleMean;
    let s;
    if (Math.abs(d) < 0.5) {
      s = `前半和後半的平均角度相近（${f1(a.angleMean)} 度和 ${f1(b.angleMean)} 度）`;
    } else {
      s = `後半的平均角度比前半${d > 0 ? '高' : '低'} ${f1(d)} 度（${f1(a.angleMean)} 度 → ${f1(b.angleMean)} 度）`;
    }
    const pa = f0(a.pct);
    const pb = f0(b.pct);
    s += pa === pb ? `，命中率都是 ${pa}%。` : `，命中率由 ${pa}% 變為 ${pb}%。`;
    out.push(s);
  }
  return out;
}
