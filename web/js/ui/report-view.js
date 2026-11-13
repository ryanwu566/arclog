// 報告畫面：四個數字、每球角度的散點圖、前後半比較、白話摘要、每一球的表格，以及各種匯出。

import { $, el, clear, show, toast, download, safeName, madeMark } from './dom.js';
import * as S from './session.js';
import { buildReport, fmt1, signed1 } from '../core/report.js';
import { shotsToCsv } from '../core/csv.js';
import { makeRecord, upsertRecord, todayString } from '../core/history.js';
import { scatterChart, reportSvg } from './charts.js';
import { loadHistory, saveHistory } from './storage.js';

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
            el('td', { class: 'num', text: `${r.angle.toFixed(1)}°` }),
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

    // 匯出按鈕
    const hasSource = !!source && session.mode !== 'csv' && session.mode !== 'history';
    show($('#report-bundle'), hasSource && S.canExportBundle(session));
    $('#report-back').textContent = hasSource ? '回去修改' : session.mode === 'history' ? '回歷次紀錄' : '回首頁';
    const cli = $('#report-cli');
    const hoop = hasSource && session.mode === 'video' ? session.hoopPoints : null;
    show(cli, !!(hoop && hoop.front && hoop.back));
    if (hoop && hoop.front && hoop.back) {
      const r = (v) => Math.round(v * 10) / 10;
      $('#report-cli-cmd').textContent = `python tools/analyze.py "影片的路徑\\${session.info.name}" --hoop ${r(hoop.front.x)},${r(hoop.front.y)},${r(hoop.back.x)},${r(hoop.back.y)} --level ${session.level}`;
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
    if (source && session.mode !== 'csv' && session.mode !== 'history') app.go('work', { step: 'mark' });
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
