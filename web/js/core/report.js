// 報告的資料：把一次練習整理成畫面和匯出圖片共用的內容。純函式，不碰 DOM。

import { IDEAL_ENTRY_DEG } from './constants.js';
import { summarize, plainSummary } from './stats.js';

const round1 = (x) => Math.floor(x * 10 + 0.5) / 10;
/** 帶正負號、小數一位（-0.04 這種會顯示成 0.0，不帶負號）。 */
export function signed1(x) {
  const r = Math.round(Math.abs(x) * 10) / 10;
  if (r === 0) return '0.0';
  return (x > 0 ? '+' : '−') + r.toFixed(1);
}
/** 帶正負號的整數。 */
export function signed0(x) {
  const r = Math.floor(Math.abs(x) + 0.5);
  if (r === 0) return '0';
  return (x > 0 ? '+' : '−') + r;
}
export const fmt1 = (x) => (x == null ? '—' : round1(x).toFixed(1));
export const fmtPct = (x) => (x == null ? '—' : `${Math.floor(x + 0.5)}%`);

/**
 * @param {object} p
 * @param {{angle:number, made:boolean, source?:string}[]} p.shots 依出手順序
 * @param {{angleDeg:number, made:boolean}[]} [p.truth] 示範模式每一球的真實答案（和 shots 一一對應，可為 null）
 * @param {string} [p.player]
 * @param {string} [p.date]
 * @param {string} [p.videoName]
 * @param {boolean} [p.demo]
 */
export function buildReport(p) {
  const shots = p.shots || [];
  const stats = summarize(shots);
  const rows = shots.map((s, i) => {
    const row = { n: i + 1, angle: s.angle, made: !!s.made, source: s.source || 'manual' };
    const t = p.truth ? p.truth[i] : null;
    if (t) {
      row.trueAngle = t.angleDeg;
      row.error = s.angle - t.angleDeg;
      row.trueMade = t.made;
    }
    return row;
  });

  let demo = null;
  if (p.truth) {
    const errs = rows.filter((r) => r.error != null).map((r) => Math.abs(r.error));
    const madeOk = rows.filter((r) => r.trueMade != null && r.trueMade === r.made).length;
    const madeN = rows.filter((r) => r.trueMade != null).length;
    demo = {
      n: errs.length,
      mae: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null,
      maxErr: errs.length ? Math.max(...errs) : null,
      madeCorrect: madeOk,
      madeTotal: madeN,
    };
  }

  const diff = stats.angleMean != null ? stats.angleMean - IDEAL_ENTRY_DEG : null;
  const both = (x, y) => x != null && y != null;
  const f = stats.first;
  const g = stats.second;
  const halves =
    stats.attempts >= 4
      ? [
          { label: '命中率', first: fmtPct(f.pct), second: fmtPct(g.pct), delta: both(f.pct, g.pct) ? `${signed0(g.pct - f.pct)} 個百分點` : '—' },
          { label: '平均入框角度', first: `${fmt1(f.angleMean)}°`, second: `${fmt1(g.angleMean)}°`, delta: both(f.angleMean, g.angleMean) ? `${signed1(g.angleMean - f.angleMean)}°` : '—' },
          {
            label: '角度標準差',
            first: f.angleStd != null ? `${fmt1(f.angleStd)}°` : '—',
            second: g.angleStd != null ? `${fmt1(g.angleStd)}°` : '—',
            delta: both(f.angleStd, g.angleStd) ? `${signed1(g.angleStd - f.angleStd)}°` : '—',
          },
        ]
      : null;

  return {
    player: p.player || '',
    date: p.date || '',
    videoName: p.videoName || '',
    demo: !!p.demo,
    stats,
    tiles: [
      { label: '出手數', value: String(stats.attempts), sub: stats.attempts ? `進 ${stats.makes} 球` : '' },
      { label: '命中率', value: fmtPct(stats.pct), sub: stats.attempts ? `${stats.makes} / ${stats.attempts}` : '' },
      {
        label: '平均入框角度',
        value: stats.angleMean != null ? `${fmt1(stats.angleMean)}°` : '—',
        sub: diff == null ? '' : Math.abs(diff) < 0.05 ? `和 ${IDEAL_ENTRY_DEG}° 參考線相同` : `比 ${IDEAL_ENTRY_DEG}° 參考線${diff > 0 ? '高' : '低'} ${fmt1(Math.abs(diff))}°`,
      },
      { label: '角度標準差', value: stats.angleStd != null ? `${fmt1(stats.angleStd)}°` : '—', sub: stats.angleStd != null ? '每球之間的差異' : '至少要 2 球' },
    ],
    summary: plainSummary(stats),
    halves,
    firstCount: stats.first.attempts,
    rows,
    demoStats: demo,
  };
}
