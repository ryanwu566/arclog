// 報告畫面：四個數字、每球角度的散點圖、前後半比較、白話摘要、每一球的表格，以及各種匯出。

import { $, el, clear, show, toast, download, safeName, madeMark } from './dom.js';
import * as S from './session.js';
import { buildReport, fmt1, signed1, fmtPct } from '../core/report.js';
import { shotsToCsv } from '../core/csv.js';
import { makeRecord, upsertRecord, todayString } from '../core/history.js';
import { scatterChart, reportSvg } from './charts.js';
import { loadHistory, saveHistory } from './storage.js';

const MADE_BY = {
  net: '過框後被球網拖慢',
  net_hidden: '過框後被球網擋住，之後在網子下面出現',
  rim_in: '在框上彈了之後從籃框裡掉下去',
  freefall: '過框後照自由落體往下掉（從籃框旁邊或後面經過）',
  bounce: '碰框後彈出',
  short: '明顯偏短',
  outside: '落在籃框外面',
  geometry: '過框後看不清楚，依過框位置判斷',
  count: '依球有沒有落進籃框判斷',
};

/** 鏡頭角度等級的說明（數字來自模擬，docs/EVAL.md 4.4）。 */
export function gradeNotice(auto) {
  if (!auto) return null;
  const dev = auto.devDeg != null ? Math.round(auto.devDeg) : null;
  const range = auto.devRange ? `${Math.round(auto.devRange[0])} 到 ${Math.round(auto.devRange[1])} 度` : null;
  const how = auto.viewSource === 'ballsize' ? '（由球在飛行中變大變小粗估，看不到籃板時只能這樣估）' : auto.viewSource === 'board' ? '（由籃框和籃板的位置推算）' : '';
  switch (auto.grade) {
    case 'A':
      return { grade: 'A', title: '鏡頭接近側面', text: `偏離側面約 ${dev} 度${range ? `（可能是 ${range}）` : ''}${how}。入框角度已經自動修正偏角和透視。這是模擬裡最準的擺法，但實拍的準確度還沒有驗證過。` };
    case 'B':
      return { grade: 'B', title: '鏡頭偏斜：角度誤差較大', text: `偏離側面約 ${dev} 度${range ? `（可能是 ${range}）` : ''}${how}。越斜，任何一點誤差（例如從側翼投、球左右偏）都會被放大：模擬裡偏 30 到 60 度時，角度可能差到 2 到 4 度。看整體趨勢可以，單一球的數字不要太在意。下次把手機往側面移。` };
    case 'C':
      return { grade: 'C', title: '這個角度量不到入框角度', text: `鏡頭偏離側面約 ${dev} 度${how}，幾乎在投籃者正後方或正前方。從這裡看，球的弧線在畫面上幾乎是上下直線，算不出可信的入框角度，所以這份報告只有出手數和命中率。想看角度，請把手機架到側面。` };
    default:
      return { grade: 'unknown', title: '判斷不出鏡頭角度', text: '畫面裡看不到籃板、球也太少，判斷不出鏡頭偏了多少。入框角度是假設從側面拍算的；如果不是從側面拍，角度不可信。' };
  }
}

/** 把 SVG 轉成 PNG（報告圖片用）。 */
export async function svgToPng(svg, width, height) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    if (typeof img.decode === 'function') await img.decode();
    else await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('報告圖片產生失敗')); });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    return await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('報告圖片產生失敗'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 提示框是整個頁面共用的一個；捲動頁面，或在圖表以外的地方按一下，就收起來
let hideCurrentTip = null;
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => hideCurrentTip && hideCurrentTip(), { passive: true });
  document.addEventListener('pointerdown', (e) => {
    if (hideCurrentTip && !(e.target instanceof Element && e.target.closest('.chart'))) hideCurrentTip();
  });
}

/** 圖表的提示框：滑鼠移到（或手指按到）最近的點，顯示那一球的數字。 */
function attachTip(container, chart, describe) {
  const tip = $('#chart-tip');
  const svg = container.querySelector('svg');
  const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ring.setAttribute('r', '9');
  ring.setAttribute('fill', 'none');
  ring.setAttribute('stroke', '#0b0b0b');
  ring.setAttribute('stroke-width', '2');
  ring.style.display = 'none';
  svg.append(ring);
  const hide = () => {
    tip.hidden = true;
    ring.style.display = 'none';
  };
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const k = chart.width / rect.width;
    const x = (e.clientX - rect.left) * k;
    const y = (e.clientY - rect.top) * k;
    let best = null;
    let bestD = Infinity;
    for (const p of chart.points) {
      // 以水平距離為主：使用者瞄準的是「第幾球」，不必剛好按在點上
      const d = Math.abs(p.x - x) + Math.abs(p.y - y) * 0.25;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best || Math.abs(best.x - x) > Math.max(24 * k, chart.width / Math.max(chart.points.length, 1))) {
      hide();
      return;
    }
    ring.setAttribute('cx', String(best.x));
    ring.setAttribute('cy', String(best.y));
    ring.style.display = '';
    clear(tip);
    const [strong, rest] = describe(best);
    tip.append(el('b', { text: strong }), rest);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const px = rect.left + best.x / k;
    const py = rect.top + best.y / k;
    tip.style.left = `${Math.max(6, Math.min(window.innerWidth - tw - 6, px - tw / 2))}px`;
    tip.style.top = `${Math.max(6, py - 44)}px`;
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  // 滑鼠移開就收起來；手指按完之後留著，才來得及看
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
  hideCurrentTip = hide;
  hide();
}

export function createReportView(app) {
  let session = null;
  let report = null;
  let source = null;
  let extraNotices = [];

  function persist() {
    if (!session || session.mode === 'demo') return;
    const shots = S.reportShots(session);
    if (!shots.length) return;
    const rec = makeRecord({
      id: session.id,
      player: session.player,
      date: session.date,
      note: session.note,
      videoName: session.info ? session.info.name : session.videoName || '',
      shots,
    });
    const cur = loadHistory();
    const res = saveHistory(upsertRecord(cur.list, rec));
    const saved = $('#report-saved');
    if (res.persisted) saved.textContent = '這次練習已經存進這台裝置的歷次紀錄。';
    else if (res.ok) saved.textContent = '這個瀏覽器目前不能保存資料（可能是無痕模式）：關掉分頁後紀錄就不見了，需要的話請先匯出 CSV。';
    else saved.textContent = '存不進這台裝置（空間可能滿了）：關掉分頁後紀錄就不見了，需要的話請先匯出 CSV。';
  }

  /** 最上面的結論：命中率、角度平均、穩定度、前後半差異，再來是鏡頭角度等級的說明。 */
  function renderConclusion() {
    const st = report.stats;
    const box = $('#report-conclusion');
    clear(box);
    const noAngle = st.angleMean == null;
    const auto = session.auto;
    const c = auto && auto.grade === 'C';
    const rough = auto && (auto.grade === 'B' || auto.grade === 'unknown');
    const stat = (label, value, sub, flag, size) => el('div', { class: `big-stat${size ? ` ${size}` : ''}` }, el('div', { class: 'label', text: label }), el('div', { class: 'value' }, value, flag ? el('span', { class: 'rough', text: flag }) : null), el('div', { class: 'sub', text: sub || ' ' }));
    const f = st.first;
    const g = st.second;
    let half = '球數太少，不比較前後半';
    if (st.attempts >= 4) {
      const parts = [];
      if (f.pct != null && g.pct != null) parts.push(`命中率 ${fmtPct(f.pct)} → ${fmtPct(g.pct)}`);
      if (f.angleMean != null && g.angleMean != null) parts.push(`角度 ${fmt1(f.angleMean)}° → ${fmt1(g.angleMean)}°`);
      half = parts.join('，') || '—';
    }
    box.append(
      el(
        'div',
        { class: 'conclusion-main' },
        stat('命中率', fmtPct(st.pct), st.attempts ? `${st.makes} / ${st.attempts} 球` : '還沒有出手'),
        c ? stat('入框角度', '—', '這個鏡頭角度量不到') : stat('平均入框角度', noAngle ? '—' : `${fmt1(st.angleMean)}°`, noAngle ? '' : `參考線 45°`, rough ? '誤差較大' : ''),
        c ? stat('出手', String(st.attempts), `進 ${st.makes} 球`) : stat('穩定度（標準差）', st.angleStd != null ? `${fmt1(st.angleStd)}°` : '—', st.angleStd != null ? '越小代表每球越一致' : '至少要 2 球', rough ? '誤差較大' : ''),
        stat('前半 → 後半', st.attempts >= 4 ? (f.pct != null && g.pct != null ? `${fmtPct(f.pct)} → ${fmtPct(g.pct)}` : '—') : '—', half, '', 'small'),
      ),
    );
    const vn = $('#report-view-notice');
    clear(vn);
    const gn = gradeNotice(auto);
    if (gn) {
      vn.append(el('div', { class: `notice${gn.grade === 'A' ? '' : ' notice-warn'}`, id: 'report-grade', dataset: { grade: gn.grade } }, el('p', { class: 'conclusion-line' }, el('span', { class: `grade-badge grade-${gn.grade}`, text: gn.grade === 'unknown' ? '?' : gn.grade }), gn.title), el('p', { text: gn.text })));
    }
    if (auto) {
      if (auto.uncertain) vn.append(el('div', { class: 'notice', text: `有 ${auto.uncertain} 球的進球判定比較沒把握（下面標了「？」），請點開那一球看疊圖確認。` }));
      if ((auto.notes || []).includes('gravity_mismatch')) vn.append(el('div', { class: 'notice notice-warn', text: '從軌跡檢查相機位置時對不太上（量到的重力和實際差很多），可能是籃框或籃板偵測得不準。角度請當參考。' }));
      if ((auto.notes || []).includes('rim_unstable')) vn.append(el('div', { class: 'notice notice-warn', text: '籃框的位置在錄影中有變動（手機可能被碰到）。' }));
      if (auto.hoopFromTaps) vn.append(el('div', { class: 'notice', text: '籃框位置是你點的（目前的偵測模型還不會找籃框）。' }));
      const gaps = (auto.gaps || []).filter((x) => x.to == null || x.to - x.from > 0.5);
      if (gaps.length) vn.append(el('div', { class: 'notice notice-warn', text: `錄影中有 ${gaps.length} 段被中斷（切到別的 App 或鎖定螢幕時 iPhone 會暫停相機），那段時間投的球沒有記到。` }));
    }
    if (session.autoRun && session.autoRun.backend === 'simulated') vn.append(el('div', { class: 'notice', text: '示範用的是模擬偵測器（由合成畫面的真實答案加上雜訊），不是真的偵測模型。' }));
  }

  // ── 每一球（點開看疊圖、修正） ──
  let openShot = null;
  async function drawThumb(canvas, shot) {
    const w = 640;
    const h = Math.round((w * (source.height || 720)) / (source.width || 1280));
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext('2d');
    const f = shot.auto && shot.auto.fCross != null ? shot.auto.fCross : shot.points && shot.points.length ? shot.points[shot.points.length - 1].frame : 0;
    try {
      const fr = await source.getFrame(f);
      c.drawImage(fr.image, 0, 0, w, h);
    } catch {
      c.fillStyle = '#141615';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#fff';
      c.font = '16px sans-serif';
      c.fillText('（沒有影片畫面）', 16, 28);
    }
    const k = w / source.width;
    c.save();
    c.scale(k, k);
    const u = 1 / k;
    const curve = shot.auto && shot.auto.curve;
    const line = (pts, color, width) => {
      c.beginPath();
      pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
      c.lineJoin = c.lineCap = 'round';
      c.strokeStyle = 'rgba(0,0,0,0.75)';
      c.lineWidth = (width + 2.4) * u;
      c.stroke();
      c.strokeStyle = color;
      c.lineWidth = width * u;
      c.stroke();
    };
    if (curve && curve.length > 1) line(curve, '#ffd84a', 2.4);
    for (const p of shot.points || []) {
      c.beginPath();
      c.arc(p.x, p.y, 3.4 * u, 0, Math.PI * 2);
      c.fillStyle = 'rgba(0,0,0,0.8)';
      c.fill();
      c.beginPath();
      c.arc(p.x, p.y, 2.1 * u, 0, Math.PI * 2);
      c.fillStyle = '#fff';
      c.fill();
    }
    const hp = session.hoopPoints;
    if (hp && hp.front && hp.back) line([[hp.front.x, hp.front.y], [hp.back.x, hp.back.y]], '#ffffff', 1.6);
    c.restore();
  }

  function renderShotCards() {
    const list = $('#report-shot-cards');
    clear(list);
    const shots = session.shots.filter((x) => typeof x.angle === 'number' || (x.angle === null && S.isFixedAuto(x)));
    shots.forEach((shot, i) => {
      const uncertain = shot.auto && shot.auto.uncertain && !shot.auto.corrected;
      const open = openShot === shot.id;
      const card = el('li', { class: 'shot-card', dataset: { id: String(shot.id) } });
      const row = el(
        'button',
        { type: 'button', class: 'shot-row', 'aria-expanded': String(open), onclick: () => { openShot = open ? null : shot.id; renderShotCards(); } },
        el('span', { class: 'shot-n', text: `#${i + 1}` }),
        el('span', {}, el('span', { class: 'shot-angle', text: typeof shot.angle === 'number' ? `${shot.angle.toFixed(1)}°` : '角度 —' }), ' ', el('span', { class: 'res' }, madeMark(shot.made), shot.made ? '進球' : '沒進'), uncertain ? el('span', { class: 'shot-flag', text: ' ？不確定' }) : null),
        el('span', { class: 'hint', text: open ? '收起' : '看軌跡' }),
      );
      card.append(row);
      if (open) {
        const canvas = el('canvas', { 'aria-label': `第 ${i + 1} 球的軌跡疊圖` });
        const by = shot.auto ? MADE_BY[shot.auto.madeBy] || '' : '手動標記';
        const canFix = hasSource && shot.points && shot.points.length >= 2;
        card.append(
          el(
            'div',
            { class: 'shot-detail' },
            canvas,
            el('p', { class: 'hint', text: `${shot.made ? '進球' : '沒進'}：${by}${uncertain ? '（不確定）' : ''}。黃線是擬合的軌跡，白點是偵測到的球。` }),
            el(
              'div',
              { class: 'btn-row' },
              el('button', { type: 'button', class: 'btn', text: shot.made ? '改成沒進' : '改成進球', onclick: () => { S.setMade(session, shot.id, !shot.made); render(); } }),
              canFix ? el('button', { type: 'button', class: 'btn', text: '修正（重新標點）', onclick: () => fixShot(shot) }) : null,
              el('button', { type: 'button', class: 'btn btn-danger', text: '刪除這球', onclick: () => { S.deleteShot(session, shot.id); openShot = null; render(); } }),
            ),
          ),
        );
        if (hasSource) drawThumb(canvas, shot);
        else canvas.remove();
      }
      list.append(card);
    });
    show($('#report-shots-card'), shots.length > 0);
  }

  async function fixShot(shot) {
    const first = shot.points[0].frame;
    S.editShot(session, shot.id);
    await app.work.open(session, source, { step: 'mark', frame: first });
    app.go('work', { step: 'mark', frame: first, draftMade: shot.made });
    toast('已把這一球的點放到畫面上：拖曳或重新點，調整好再按「儲存這球」');
  }

  let hasSource = false;

  function render() {
    const shots = S.reportShots(session);
    const truth = S.truthForShots(session);
    report = buildReport({
      shots,
      truth,
      player: session.player,
      date: session.date,
      videoName: session.info ? session.info.name : '',
      demo: session.mode === 'demo',
    });
    window.__arclogReport = report;

    renderConclusion();

    // 提醒
    const notices = $('#report-notices');
    clear(notices);
    for (const text of extraNotices) notices.append(el('div', { class: 'notice notice-warn', text }));
    if (session.mode === 'demo') {
      notices.append(el('div', { class: 'notice', text: '這是合成示範的報告。真實角度是已知的，所以下面多列出真實角度和誤差。' }));
    }

    // 四個數字
    const tiles = $('#report-tiles');
    clear(tiles);
    for (const t of report.tiles) {
      tiles.append(el('div', { class: 'tile' }, el('div', { class: 'tile-label', text: t.label }), el('div', { class: 'tile-value', text: t.value }), el('div', { class: 'tile-sub', text: t.sub || ' ' })));
    }

    // 散點圖：寬度跟著容器走，手機上字才不會太小
    const box = $('#report-chart');
    show(box.closest('.card'), report.stats.angleMean != null);
    const width = Math.max(300, Math.min(760, Math.round(box.clientWidth || 360)));
    const chart = scatterChart({ rows: report.rows, width, height: Math.round(Math.max(230, Math.min(360, width * 0.56))), firstCount: report.firstCount, fontSize: width < 460 ? 11 : 12 });
    box.innerHTML = chart.svg; // 這段 SVG 是 charts.js 產生的，裡面只有數字和固定的文字
    attachTip(box, chart, (p) => [`${p.angle.toFixed(1)}°`, `第 ${p.n} 球 · ${p.made ? '進球' : '沒進'}`]);

    // 前半／後半
    show($('#report-halves-card'), !!report.halves);
    const halves = $('#report-halves');
    clear(halves);
    if (report.halves) {
      halves.append(
        el('caption', { text: `前半是前 ${report.stats.first.attempts} 球，後半是後 ${report.stats.second.attempts} 球。` }),
        el('thead', {}, el('tr', {}, el('th', { text: '' }), el('th', { class: 'num', text: '前半' }), el('th', { class: 'num', text: '後半' }), el('th', { class: 'num', text: '變化' }))),
        el('tbody', {}, ...report.halves.map((r) => el('tr', {}, el('th', { scope: 'row', text: r.label }), el('td', { class: 'num', text: r.first }), el('td', { class: 'num', text: r.second }), el('td', { class: 'num', text: r.delta })))),
      );
    }

    // 摘要
    const summary = $('#report-summary');
    clear(summary);
    for (const line of report.summary) summary.append(el('p', { text: line }));

    // 每一球
    const rows = $('#report-rows');
    clear(rows);
    const demo = !!report.demoStats;
    rows.append(
      el('thead', {}, el('tr', {}, el('th', { class: 'num', text: '球序' }), el('th', { class: 'num', text: '入框角度' }), el('th', { text: '結果' }), demo ? el('th', { class: 'num', text: '真實角度' }) : null, demo ? el('th', { class: 'num', text: '誤差' }) : null)),
      el(
        'tbody',
        {},
        ...report.rows.map((r) =>
          el(
            'tr',
            {},
            el('td', { class: 'num', text: String(r.n) }),
            el('td', { class: 'num', text: typeof r.angle === 'number' ? `${r.angle.toFixed(1)}°` : '—' }),
            el('td', {}, el('span', { class: 'res' }, madeMark(r.made), r.made ? '進球' : '沒進')),
            demo ? el('td', { class: 'num', text: r.trueAngle != null ? `${fmt1(r.trueAngle)}°` : '—' }) : null,
            demo ? el('td', { class: 'num', text: r.error != null ? `${signed1(r.error)}°` : '—' }) : null,
          ),
        ),
      ),
    );
    const note = $('#report-demo-note');
    show(note, demo && report.demoStats.mae != null);
    if (demo && report.demoStats.mae != null) {
      const d = report.demoStats;
      note.textContent = `和真實角度比較：平均差 ${fmt1(d.mae)} 度、最多差 ${fmt1(d.maxErr)} 度；進球判定 ${d.madeCorrect}/${d.madeTotal} 球和合成畫面的結果相同。合成畫面和估計方法用的是同一套物理，所以這只反映標記與偵測的誤差，不代表實拍的準確度。`;
    }

    renderShotCards();

    // 匯出按鈕
    show($('#report-bundle'), hasSource && S.canExportBundle(session));
    $('#report-back').textContent = session.auto ? '回首頁' : hasSource ? '回去修改' : session.mode === 'history' ? '回歷次紀錄' : '回首頁';
    const cli = $('#report-cli');
    const hoop = hasSource && session.mode === 'video' ? session.hoopPoints : null;
    show(cli, !!(hoop && hoop.front && hoop.back));
    if (hoop && hoop.front && hoop.back) {
      const r = (v) => Math.round(v * 10) / 10;
      const vert = session.level === 'vertical' && hoop.top && hoop.bottom ? ` --vertical ${r(hoop.top.x)},${r(hoop.top.y)},${r(hoop.bottom.x)},${r(hoop.bottom.y)}` : '';
      $('#report-cli-cmd').textContent = `python tools/analyze.py "影片的路徑\\${session.info.name}" --hoop ${r(hoop.front.x)},${r(hoop.front.y)},${r(hoop.back.x)},${r(hoop.back.y)} --level ${session.level}${vert}`;
    }
    $('#report-saved').textContent = session.mode === 'demo' ? '示範的結果不會存進歷次紀錄。' : '';
    persist();
  }

  const baseName = () => {
    const parts = ['arclog', safeName(session.player), session.date || todayString()].filter(Boolean);
    if (session.mode === 'demo') parts.push('示範');
    return parts.join('_');
  };

  $('#report-player').addEventListener('input', (e) => {
    session.player = e.target.value.trim().slice(0, 40);
    report.player = session.player;
    persist();
    app.onSessionChanged();
  });
  $('#report-date').addEventListener('change', (e) => {
    if (e.target.value) {
      session.date = e.target.value;
      report.date = session.date;
      persist();
      app.onSessionChanged();
    }
  });
  $('#report-csv').addEventListener('click', () => {
    const shots = S.reportShots(session);
    if (!shots.length) return;
    // 開頭加 BOM，Excel 開起來中文才不會亂碼
    download(`${baseName()}.csv`, new Blob(['﻿', shotsToCsv(shots)], { type: 'text/csv;charset=utf-8' }));
    toast(`已匯出 ${shots.length} 球的 CSV`);
  });
  $('#report-image').addEventListener('click', async () => {
    const btn = $('#report-image');
    btn.disabled = true;
    try {
      const { svg, width, height } = reportSvg(report);
      const blob = await svgToPng(svg, width, height);
      const file = typeof File === 'function' ? new File([blob], `${baseName()}.png`, { type: 'image/png' }) : null;
      // 手機上優先用系統的分享選單（可以直接存到相簿或傳給別人）
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
        try {
          await navigator.share({ files: [file], title: 'ArcLog 練投報告' });
          return;
        } catch (err) {
          if (err && err.name === 'AbortError') return;
        }
      }
      download(`${baseName()}.png`, blob);
      toast('已匯出報告圖片');
    } catch (err) {
      toast(`報告圖片產生失敗：${err.message || err}`);
    } finally {
      btn.disabled = false;
    }
  });
  $('#report-bundle').addEventListener('click', () => app.work.exportBundle());
  $('#report-history').addEventListener('click', () => app.go('history'));
  $('#report-back').addEventListener('click', () => {
    if (session.auto) app.go('home');
    else if (source && session.mode !== 'csv' && session.mode !== 'history') app.go('work', { step: 'mark' });
    else app.go(session.mode === 'history' ? 'history' : 'home');
  });
  $('#report-cli-copy').addEventListener('click', async () => {
    const text = $('#report-cli-cmd').textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast('已複製');
    } catch {
      toast('複製失敗，請手動選取文字');
    }
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!session || $('#view-report').hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  return {
    enter(nextSession, nextSource, opts = {}) {
      session = nextSession;
      source = nextSource;
      hasSource = !!source && session.mode !== 'csv' && session.mode !== 'history' && source.frameCount > 0;
      openShot = null;
      extraNotices = opts.notices || [];
      $('#report-player').value = session.player || '';
      $('#report-date').value = session.date || todayString();
      render();
    },
    get report() {
      return report;
    },
  };
}
