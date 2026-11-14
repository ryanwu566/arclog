// 歷次紀錄：列出存在這台裝置的每一次練習、看趨勢、匯出與匯入備份。

import { $, el, clear, show, toast, confirmDialog, download, readFileText } from './dom.js';
import { summarize } from '../core/stats.js';
import { removeRecord, playerNames, trendPoints, exportBackup, importBackup, todayString } from '../core/history.js';
import { fmt1, fmtPct } from '../core/report.js';
import { trendChart } from './charts.js';
import { loadHistory, saveHistory } from './storage.js';

const SOURCE_TEXT = { manual: '手動標記', auto: '自動偵測', mixed: '手動＋自動', csv: '匯入 CSV' };

export function createHistoryView(app) {
  let list = [];
  let player = null; // null = 全部

  function reload() {
    const res = loadHistory();
    list = res.list;
    const notices = $('#history-notices');
    clear(notices);
    if (!res.persistent) {
      notices.append(el('div', { class: 'notice notice-warn', text: '這個瀏覽器目前不能保存資料（可能是無痕模式，或儲存功能被關掉）。紀錄只會留到關掉分頁為止。' }));
    }
    if (res.corrupt) notices.append(el('div', { class: 'notice notice-warn', text: '之前存的紀錄讀不出來（檔案損壞），已經略過。' }));
    if (res.dropped) notices.append(el('div', { class: 'notice notice-warn', text: `有 ${res.dropped} 筆紀錄的格式不對，已經略過。` }));
  }

  function save(next) {
    const res = saveHistory(next);
    list = next;
    if (!res.ok) toast('存不進這台裝置（空間可能滿了）。請先匯出備份。');
    else if (!res.persisted) toast('這個瀏覽器不能保存資料，關掉分頁後紀錄就不見了。');
    return res;
  }

  function render() {
    // 球員篩選
    const names = playerNames(list);
    const sel = $('#history-player');
    clear(sel);
    sel.append(el('option', { value: '', text: `全部（${list.length} 次）` }));
    for (const n of names) sel.append(el('option', { value: `p:${n}`, text: n }));
    if (player != null && !names.includes(player)) player = null;
    sel.value = player == null ? '' : `p:${player}`;
    show($('#history-filter-wrap'), names.length > 0);

    const rows = list.filter((r) => player == null || r.player === player);
    show($('#history-empty'), list.length === 0);

    // 趨勢圖：命中率和平均角度各一張（兩個量的單位不同，不放在同一張圖上）
    const trends = $('#history-trends');
    clear(trends);
    const pts = trendPoints(list, { player });
    if (pts.length >= 2) {
      const width = Math.max(300, Math.min(520, Math.round((trends.clientWidth || 360) / (window.innerWidth >= 620 ? 2 : 1)) - 18));
      const label = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
      const charts = [
        trendChart({ title: '命中率', points: pts.map((p) => ({ label: label(p.date), value: p.pct })), format: (v) => `${Math.round(v)}%`, domain: [0, 100], width, height: 200, fontSize: 11 }),
        trendChart({ title: '平均入框角度', points: pts.map((p) => ({ label: label(p.date), value: p.angleMean })), format: (v) => `${(Math.round(v * 10) / 10).toFixed(1)}°`, reference: 45, referenceLabel: '45°', width, height: 200, fontSize: 11 }),
      ];
      for (const c of charts) {
        const box = el('div', { class: 'card chart' });
        box.innerHTML = c.svg; // charts.js 產生的 SVG，內容只有數字、日期和固定文字
        trends.append(box);
      }
    } else if (list.length) {
      trends.append(el('p', { class: 'hint', text: '有兩次以上的練習紀錄後，這裡會畫出命中率和平均角度的趨勢。' }));
    }

    const ol = $('#history-list');
    clear(ol);
    for (const r of rows) {
      const s = summarize(r.shots);
      const main = el(
        'button',
        { type: 'button', class: 'session-main', onclick: () => app.openRecord(r) },
        el('span', { class: 'session-title', text: `${r.date}　${r.player || '（沒有填姓名）'}` }),
        el('span', { class: 'session-meta', text: `${s.attempts} 球 · 命中率 ${fmtPct(s.pct)} · 平均 ${fmt1(s.angleMean)}° · ${SOURCE_TEXT[r.source] || ''}` }),
      );
      const del = el('button', {
        type: 'button', class: 'mini-btn', text: '刪除', 'aria-label': `刪除 ${r.date} 的紀錄`,
        onclick: async () => {
          if (!(await confirmDialog({ title: '刪除這次紀錄？', message: `${r.date} ${r.player || ''}（${s.attempts} 球）。刪除後無法復原。`, okText: '刪除', danger: true }))) return;
          save(removeRecord(list, r.id));
          render();
        },
      });
      ol.append(el('li', { class: 'session-row' }, main, del));
    }
    $('#history-export').disabled = list.length === 0;
    $('#history-clear').disabled = list.length === 0;
  }

  $('#history-player').addEventListener('change', (e) => {
    player = e.target.value ? e.target.value.slice(2) : null;
    render();
  });
  $('#history-export').addEventListener('click', () => {
    download(`arclog_備份_${todayString()}.json`, JSON.stringify(exportBackup(list), null, 1), 'application/json');
    toast(`已匯出 ${list.length} 次紀錄的備份`);
  });
  $('#file-backup').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await readFileText(file));
    } catch {
      toast('這個檔案不是 JSON，沒辦法匯入');
      return;
    }
    const res = importBackup(data, list);
    if (res.error) {
      toast(res.error);
      return;
    }
    save(res.list);
    render();
    toast(`匯入完成：新增 ${res.added} 次、更新 ${res.updated} 次${res.invalid ? `、略過 ${res.invalid} 筆格式不對的` : ''}`);
  });
  $('#history-clear').addEventListener('click', async () => {
    if (!(await confirmDialog({ title: '清除全部紀錄？', message: `這台裝置上的 ${list.length} 次紀錄都會刪除，無法復原。建議先匯出備份。`, okText: '全部清除', danger: true }))) return;
    save([]);
    render();
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if ($('#view-history').hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  return {
    enter() {
      reload();
      render();
    },
  };
}
