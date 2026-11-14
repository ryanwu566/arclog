// 圖表：產生 SVG 字串。這個檔案不碰 DOM，所以同一份圖可以放在網頁上，也可以直接畫進匯出的報告圖片。
//
// 配色與畫法的依據：
//   - 進球／沒進用藍 #2a78d6／橘 #eb6834。這一對在色覺辨認障礙的模擬下仍然分得開
//     （常見的綠／紅在綠色弱模擬下幾乎一樣，沒有採用），而且另外用形狀區分：實心圓＝進球、叉＝沒進。
//   - 格線是實線細線、顏色退到背景；只有 45 度參考線用虛線，因為它是門檻不是格線。
//   - 文字一律用文字色，不跟著資料的顏色走。
//   - 不在每個點旁邊標數字；數值在下方表格和提示框裡都看得到。

export const CHART_COLORS = {
  surface: '#fcfcfb',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  make: '#2a78d6',
  miss: '#eb6834',
  series: '#2a78d6',
};

export const CHART_FONT = "system-ui, -apple-system, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
const n2 = (x) => Math.round(x * 100) / 100;

/** 取「好看的」刻度：回傳 {min, max, step}。 */
function niceScale(lo, hi, targetTicks = 5) {
  const span = Math.max(hi - lo, 1e-9);
  const raw = span / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

function ticksOf(scale) {
  const out = [];
  for (let v = scale.min; v <= scale.max + scale.step * 1e-6; v += scale.step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** 進球＝實心圓；沒進＝叉。兩者外面都有一圈背景色，疊在線上或彼此重疊時仍然看得清楚。 */
function markSvg(x, y, made, c, r = 5) {
  if (made) {
    return `<circle cx="${n2(x)}" cy="${n2(y)}" r="${r}" fill="${c.make}" stroke="${c.surface}" stroke-width="2"/>`;
  }
  const d = r * 0.92;
  const path = `M${n2(x - d)} ${n2(y - d)}L${n2(x + d)} ${n2(y + d)}M${n2(x - d)} ${n2(y + d)}L${n2(x + d)} ${n2(y - d)}`;
  const sw = Math.max(2.2, r * 0.5);
  return (
    `<path d="${path}" stroke="${c.surface}" stroke-width="${n2(sw + 3.6)}" stroke-linecap="round" fill="none"/>` +
    `<path d="${path}" stroke="${c.miss}" stroke-width="${n2(sw)}" stroke-linecap="round" fill="none"/>`
  );
}

/**
 * 每球入框角度的散點圖。
 *
 * @param {object} p
 * @param {{n:number, angle:number, made:boolean}[]} p.rows
 * @param {number} [p.width=640]
 * @param {number} [p.height=320]
 * @param {number} [p.firstCount] 前半有幾球；有給而且球數夠就畫出前後半的分界
 * @param {number} [p.reference=45]
 * @param {object} [p.colors]
 * @param {number} [p.fontSize=12]
 * @returns {{inner:string, svg:string, width:number, height:number,
 *            points:{n:number, x:number, y:number, angle:number, made:boolean}[]}}
 *          inner 是不含最外層 <svg> 的內容，可以用 <g transform> 嵌進別的 SVG
 */
export function scatterChart(p) {
  const c = { ...CHART_COLORS, ...(p.colors || {}) };
  const W = p.width || 640;
  const H = p.height || 320;
  const fs = p.fontSize || 12;
  const ref = p.reference != null ? p.reference : 45;
  const rows = p.rows || [];
  const n = rows.length;
  const padL = fs * 3.4;
  const padR = fs * 1.2;
  const padT = fs * 3.2;
  const padB = fs * 3.2;
  const pw = W - padL - padR;
  const ph = H - padT - padB;

  let lo = ref;
  let hi = ref;
  for (const r of rows) {
    if (typeof r.angle !== 'number') continue; // 沒有角度的球（鏡頭偏角太大）不畫點
    if (r.angle < lo) lo = r.angle;
    if (r.angle > hi) hi = r.angle;
  }
  if (hi - lo < 8) {
    const mid = (hi + lo) / 2;
    lo = mid - 4;
    hi = mid + 4;
  }
  const scale = niceScale(lo - 1.5, hi + 1.5, 4);
  const yOf = (v) => padT + ph * (1 - (v - scale.min) / (scale.max - scale.min));
  const band = pw / Math.max(n, 1);
  // 資料點的大小跟著字級走（匯出的大圖字比較大），點很多的時候縮小一點
  const markR = Math.max(3.6, fs * 0.42) * (n > 40 ? 0.72 : 1);
  const xOf = (i) => padL + band * (i + 0.5);

  const out = [];
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${c.surface}"/>`);

  // 圖例（形狀＋顏色＋文字）
  const ly = fs * 1.35;
  let lx = padL;
  const keyR = Math.max(4.5, fs * 0.4);
  out.push(markSvg(lx + keyR, ly - fs * 0.35, true, c, keyR));
  out.push(`<text x="${n2(lx + keyR * 2 + fs * 0.45)}" y="${n2(ly)}" font-size="${fs}" fill="${c.ink2}">進球</text>`);
  lx += keyR * 2 + fs * 3.4;
  out.push(markSvg(lx + keyR, ly - fs * 0.35, false, c, keyR));
  out.push(`<text x="${n2(lx + keyR * 2 + fs * 0.45)}" y="${n2(ly)}" font-size="${fs}" fill="${c.ink2}">沒進</text>`);

  // 水平格線與 y 軸刻度
  for (const v of ticksOf(scale)) {
    const y = yOf(v);
    out.push(`<line x1="${padL}" y1="${n2(y)}" x2="${W - padR}" y2="${n2(y)}" stroke="${c.grid}" stroke-width="1"/>`);
    out.push(`<text x="${n2(padL - 6)}" y="${n2(y + fs * 0.35)}" font-size="${fs}" fill="${c.muted}" text-anchor="end" style="font-variant-numeric:tabular-nums">${v}°</text>`);
  }
  out.push(`<line x1="${padL}" y1="${n2(padT + ph)}" x2="${W - padR}" y2="${n2(padT + ph)}" stroke="${c.axis}" stroke-width="1"/>`);

  // 前半／後半的分界
  const split = p.firstCount;
  if (n >= 4 && split > 0 && split < n) {
    const x = padL + band * split;
    out.push(`<line x1="${n2(x)}" y1="${n2(padT - fs * 0.2)}" x2="${n2(x)}" y2="${n2(padT + ph)}" stroke="${c.axis}" stroke-width="1"/>`);
    out.push(`<text x="${n2(x - 6)}" y="${n2(padT - fs * 0.55)}" font-size="${fs * 0.92}" fill="${c.muted}" text-anchor="end">前半</text>`);
    out.push(`<text x="${n2(x + 6)}" y="${n2(padT - fs * 0.55)}" font-size="${fs * 0.92}" fill="${c.muted}">後半</text>`);
  }

  // 45 度參考線（門檻，所以用虛線）與標籤
  const ry = yOf(ref);
  out.push(`<line x1="${padL}" y1="${n2(ry)}" x2="${W - padR}" y2="${n2(ry)}" stroke="${c.ink2}" stroke-width="1.5" stroke-dasharray="6 5"/>`);
  const refLabel = `${ref}° 參考線`;
  const refLabelW = textWidth(refLabel, fs);
  out.push(`<text x="${n2(W - padR)}" y="${n2(ly)}" font-size="${fs}" fill="${c.ink2}" text-anchor="end">${refLabel}</text>`);
  const kx = W - padR - refLabelW - fs * 0.5;
  out.push(`<line x1="${n2(kx - fs * 1.7)}" y1="${n2(ly - fs * 0.35)}" x2="${n2(kx)}" y2="${n2(ly - fs * 0.35)}" stroke="${c.ink2}" stroke-width="1.5" stroke-dasharray="6 5"/>`);

  // x 軸刻度：最多約 10 個標籤
  const every = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i++) {
    if (i % every !== 0 && i !== n - 1) continue;
    if (i === n - 1 && (n - 1) % every !== 0 && n - 1 - Math.floor((n - 1) / every) * every < every * 0.6) continue;
    out.push(`<text x="${n2(xOf(i))}" y="${n2(padT + ph + fs * 1.45)}" font-size="${fs}" fill="${c.muted}" text-anchor="middle" style="font-variant-numeric:tabular-nums">${rows[i].n}</text>`);
  }
  out.push(`<text x="${n2(padL + pw / 2)}" y="${n2(H - fs * 0.45)}" font-size="${fs}" fill="${c.muted}" text-anchor="middle">球序</text>`);

  // 資料點
  const points = [];
  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (typeof r.angle !== 'number') continue;
    const x = xOf(i);
    const y = yOf(r.angle);
    points.push({ n: r.n, x, y, angle: r.angle, made: r.made });
    out.push(markSvg(x, y, r.made, c, markR));
  }
  if (!n) {
    out.push(`<text x="${n2(padL + pw / 2)}" y="${n2(padT + ph / 2)}" font-size="${fs * 1.1}" fill="${c.muted}" text-anchor="middle">還沒有資料</text>`);
  }

  const inner = out.join('');
  const label = n ? `每球入框角度散點圖，共 ${n} 球，虛線是 ${ref} 度參考線` : '每球入框角度散點圖（沒有資料）';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}" font-family="${esc(CHART_FONT)}">${inner}</svg>`;
  return { inner, svg, width: W, height: H, points };
}

/**
 * 單一數列的趨勢折線圖（歷次紀錄用）。
 *
 * @param {object} p
 * @param {{label:string, value:number|null}[]} p.points 由舊到新
 * @param {string} p.title 圖的標題（只有一個數列，所以不需要圖例）
 * @param {(v:number) => string} [p.format]
 * @param {number} [p.reference] 水平參考線
 * @param {string} [p.referenceLabel]
 * @param {[number, number]} [p.domain] 固定的 y 軸範圍
 * @param {number} [p.width=640]
 * @param {number} [p.height=220]
 * @param {number} [p.fontSize=12]
 */
export function trendChart(p) {
  const c = { ...CHART_COLORS, ...(p.colors || {}) };
  const W = p.width || 640;
  const H = p.height || 220;
  const fs = p.fontSize || 12;
  const fmt = p.format || ((v) => f1(v));
  const pts = (p.points || []).map((d, i) => ({ ...d, i })).filter((d) => d.value != null && Number.isFinite(d.value));
  const total = (p.points || []).length;
  const padL = fs * 3.6;
  const padR = fs * 3.8;
  const padT = fs * 2.6;
  const padB = fs * 2.4;
  const pw = W - padL - padR;
  const ph = H - padT - padB;

  let lo = p.reference != null ? p.reference : Infinity;
  let hi = p.reference != null ? p.reference : -Infinity;
  for (const d of pts) {
    if (d.value < lo) lo = d.value;
    if (d.value > hi) hi = d.value;
  }
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  let scale;
  if (p.domain) scale = niceScale(p.domain[0], p.domain[1], 4);
  else {
    if (hi - lo < 4) {
      const mid = (hi + lo) / 2;
      lo = mid - 2;
      hi = mid + 2;
    }
    scale = niceScale(lo - (hi - lo) * 0.12, hi + (hi - lo) * 0.12, 4);
  }
  const yOf = (v) => padT + ph * (1 - (v - scale.min) / (scale.max - scale.min));
  const xOf = (i) => (total <= 1 ? padL + pw / 2 : padL + (pw * i) / (total - 1));

  const out = [];
  out.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="${c.surface}"/>`);
  out.push(`<text x="${padL}" y="${n2(fs * 1.35)}" font-size="${fs * 1.05}" font-weight="600" fill="${c.ink}">${esc(p.title || '')}</text>`);
  for (const v of ticksOf(scale)) {
    const y = yOf(v);
    out.push(`<line x1="${padL}" y1="${n2(y)}" x2="${W - padR}" y2="${n2(y)}" stroke="${c.grid}" stroke-width="1"/>`);
    out.push(`<text x="${n2(padL - 6)}" y="${n2(y + fs * 0.35)}" font-size="${fs}" fill="${c.muted}" text-anchor="end" style="font-variant-numeric:tabular-nums">${esc(fmt(v))}</text>`);
  }
  out.push(`<line x1="${padL}" y1="${n2(padT + ph)}" x2="${W - padR}" y2="${n2(padT + ph)}" stroke="${c.axis}" stroke-width="1"/>`);
  if (p.reference != null) {
    const y = yOf(p.reference);
    out.push(`<line x1="${padL}" y1="${n2(y)}" x2="${W - padR}" y2="${n2(y)}" stroke="${c.ink2}" stroke-width="1.5" stroke-dasharray="6 5"/>`);
    if (p.referenceLabel) {
      out.push(`<text x="${n2(W - padR + 5)}" y="${n2(y + fs * 0.35)}" font-size="${fs * 0.92}" fill="${c.ink2}">${esc(p.referenceLabel)}</text>`);
    }
  }
  // x 軸標籤：頭、尾，中間視空間抽樣
  const maxLabels = Math.max(2, Math.floor(pw / (fs * 4.2)));
  const every = Math.max(1, Math.ceil(total / maxLabels));
  for (let i = 0; i < total; i++) {
    if (i % every !== 0 && i !== total - 1) continue;
    if (i === total - 1 && i % every !== 0 && i - Math.floor(i / every) * every < every * 0.7) continue;
    const anchor = total > 1 && i === 0 ? 'start' : total > 1 && i === total - 1 ? 'end' : 'middle';
    out.push(`<text x="${n2(xOf(i))}" y="${n2(padT + ph + fs * 1.45)}" font-size="${fs}" fill="${c.muted}" text-anchor="${anchor}" style="font-variant-numeric:tabular-nums">${esc(p.points[i].label)}</text>`);
  }
  if (pts.length > 1) {
    const d = pts.map((q, k) => `${k ? 'L' : 'M'}${n2(xOf(q.i))} ${n2(yOf(q.value))}`).join('');
    out.push(`<path d="${d}" fill="none" stroke="${c.series}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  const points = [];
  for (const q of pts) {
    const x = xOf(q.i);
    const y = yOf(q.value);
    points.push({ i: q.i, x, y, value: q.value, label: q.label });
    out.push(`<circle cx="${n2(x)}" cy="${n2(y)}" r="4.5" fill="${c.series}" stroke="${c.surface}" stroke-width="2"/>`);
  }
  // 只標最後一個點的數值
  if (pts.length) {
    const last = pts[pts.length - 1];
    const refY = p.reference != null ? yOf(p.reference) : null;
    let ty = yOf(last.value) + fs * 0.35;
    if (refY != null && p.referenceLabel && Math.abs(ty - (refY + fs * 0.35)) < fs * 1.1) ty += ty <= refY + fs * 0.35 ? -fs * 1.1 : fs * 1.1;
    out.push(`<text x="${n2(xOf(last.i) + 9)}" y="${n2(ty)}" font-size="${fs}" font-weight="600" fill="${c.ink}">${esc(fmt(last.value))}</text>`);
  } else {
    out.push(`<text x="${n2(padL + pw / 2)}" y="${n2(padT + ph / 2)}" font-size="${fs * 1.05}" fill="${c.muted}" text-anchor="middle">還沒有資料</text>`);
  }

  const inner = out.join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${p.title || '趨勢圖'}，共 ${pts.length} 次練習`)}" font-family="${esc(CHART_FONT)}">${inner}</svg>`;
  return { inner, svg, width: W, height: H, points };
}

/** 估計一段文字畫出來的寬度（中日韓字當作一個字寬，其他約半個字寬）。 */
export function textWidth(text, fontSize) {
  let w = 0;
  for (const ch of String(text)) w += /[⺀-鿿豈-﫿＀-￯　-〿]/.test(ch) ? 1 : 0.56;
  return w * fontSize;
}

/** 依寬度把文字斷成多行（中文可以在任何字之間斷行）。 */
export function wrapText(text, fontSize, maxWidth) {
  const lines = [];
  let cur = '';
  for (const ch of String(text)) {
    if (cur && textWidth(cur + ch, fontSize) > maxWidth) {
      // 標點不放在行首
      if (/[，。、；：！？）」』％%°]/.test(ch)) {
        cur += ch;
        continue;
      }
      lines.push(cur);
      cur = ch;
    } else cur += ch;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * 匯出用的整張報告（SVG）。之後由 report-image.js 轉成 PNG。
 * @param {object} report buildReport 的結果
 * @param {{width?: number}} [opts]
 * @returns {{svg:string, width:number, height:number}}
 */
export function reportSvg(report, opts = {}) {
  const c = CHART_COLORS;
  const W = opts.width || 1080;
  const M = 56;
  const inner = W - M * 2;
  const out = [];
  let y = 0;

  // 標題列
  y += 86;
  out.push(`<text x="${M}" y="${y}" font-size="46" font-weight="700" fill="${c.ink}">練投報告</text>`);
  out.push(`<text x="${W - M}" y="${y}" font-size="26" font-weight="600" fill="${c.muted}" text-anchor="end">ArcLog</text>`);
  y += 46;
  const who = [report.player || null, report.date || null].filter(Boolean).join('　');
  if (who) out.push(`<text x="${M}" y="${y}" font-size="28" fill="${c.ink2}">${esc(who)}</text>`);
  if (report.demo) {
    const label = '合成示範（非真實數據）';
    const bw = textWidth(label, 24) + 36;
    out.push(`<rect x="${W - M - bw}" y="${y - 30}" width="${bw}" height="42" rx="21" fill="none" stroke="${c.ink2}" stroke-width="2"/>`);
    out.push(`<text x="${W - M - bw / 2}" y="${y}" font-size="24" fill="${c.ink2}" text-anchor="middle">${label}</text>`);
  }
  y += 34;
  out.push(`<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${c.grid}" stroke-width="2"/>`);

  // 四個數字
  y += 36;
  const gap = 20;
  const tw = (inner - gap * 3) / 4;
  report.tiles.forEach((t, i) => {
    const x = M + i * (tw + gap);
    out.push(`<rect x="${n2(x)}" y="${y}" width="${n2(tw)}" height="168" rx="16" fill="#ffffff" stroke="${c.grid}" stroke-width="2"/>`);
    out.push(`<text x="${n2(x + 20)}" y="${y + 42}" font-size="23" fill="${c.ink2}">${esc(t.label)}</text>`);
    out.push(`<text x="${n2(x + 20)}" y="${y + 104}" font-size="52" font-weight="600" fill="${c.ink}">${esc(t.value)}</text>`);
    const sub = wrapText(t.sub || '', 19, tw - 36)[0] || '';
    out.push(`<text x="${n2(x + 20)}" y="${y + 142}" font-size="19" fill="${c.muted}">${esc(sub)}</text>`);
  });
  y += 168;

  // 散點圖
  y += 44;
  out.push(`<text x="${M}" y="${y}" font-size="28" font-weight="600" fill="${c.ink}">每一球的入框角度</text>`);
  y += 18;
  const chart = scatterChart({ rows: report.rows, width: inner, height: 470, firstCount: report.firstCount, fontSize: 22 });
  out.push(`<g transform="translate(${M} ${y})">${chart.inner}</g>`);
  y += 470;

  // 前半／後半
  if (report.halves) {
    y += 50;
    out.push(`<text x="${M}" y="${y}" font-size="28" font-weight="600" fill="${c.ink}">前半和後半</text>`);
    y += 14;
    const cols = [M + 20, M + inner * 0.42, M + inner * 0.6, M + inner * 0.78];
    y += 40;
    ['', '前半', '後半', '變化'].forEach((h, i) => {
      if (h) out.push(`<text x="${n2(cols[i])}" y="${y}" font-size="22" fill="${c.muted}">${h}</text>`);
    });
    y += 14;
    out.push(`<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${c.grid}" stroke-width="2"/>`);
    for (const r of report.halves) {
      y += 46;
      out.push(`<text x="${n2(cols[0])}" y="${y}" font-size="25" fill="${c.ink2}">${esc(r.label)}</text>`);
      out.push(`<text x="${n2(cols[1])}" y="${y}" font-size="25" fill="${c.ink}" style="font-variant-numeric:tabular-nums">${esc(r.first)}</text>`);
      out.push(`<text x="${n2(cols[2])}" y="${y}" font-size="25" fill="${c.ink}" style="font-variant-numeric:tabular-nums">${esc(r.second)}</text>`);
      out.push(`<text x="${n2(cols[3])}" y="${y}" font-size="25" fill="${c.ink2}" style="font-variant-numeric:tabular-nums">${esc(r.delta)}</text>`);
      y += 16;
      out.push(`<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${c.grid}" stroke-width="1"/>`);
    }
  }

  // 白話摘要
  y += 56;
  out.push(`<text x="${M}" y="${y}" font-size="28" font-weight="600" fill="${c.ink}">摘要</text>`);
  y += 12;
  for (const sentence of report.summary) {
    for (const line of wrapText(sentence, 26, inner)) {
      y += 40;
      out.push(`<text x="${M}" y="${y}" font-size="26" fill="${c.ink2}">${esc(line)}</text>`);
    }
    y += 8;
  }

  // 示範模式：和真實角度的差
  if (report.demoStats && report.demoStats.mae != null) {
    y += 44;
    const d = report.demoStats;
    const text = `示範的真實角度已知：估計值平均差 ${f1(d.mae)} 度、最多差 ${f1(d.maxErr)} 度；進球判定 ${d.madeCorrect}/${d.madeTotal} 球相同。這只反映標記與偵測的誤差，不代表實拍的準確度。`;
    for (const line of wrapText(text, 22, inner)) {
      out.push(`<text x="${M}" y="${y}" font-size="22" fill="${c.muted}">${esc(line)}</text>`);
      y += 34;
    }
  }

  // 頁尾
  y += 40;
  out.push(`<line x1="${M}" y1="${y}" x2="${W - M}" y2="${y}" stroke="${c.grid}" stroke-width="2"/>`);
  y += 38;
  const foot = '單支手機側拍估計的入框角度，進球與否由使用者確認。僅供練習參考。';
  out.push(`<text x="${M}" y="${y}" font-size="20" fill="${c.muted}">${foot}</text>`);
  y += 44;

  const H = Math.ceil(y);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${esc(CHART_FONT)}">` +
    `<rect x="0" y="0" width="${W}" height="${H}" fill="#f9f9f7"/>${out.join('')}</svg>`;
  return { svg, width: W, height: H };
}
