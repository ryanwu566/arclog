// ArcLog 主程式：切換畫面、載入影片／示範／CSV，把各個畫面串起來。
//
// 網址參數（測試與除錯用）
//   ?engine=video   強制用 <video> 退路引擎
//   ?backend=wasm   自動偵測不使用 WebGPU

import { $, el, clear, show, toast, confirmDialog, readFileText } from './dom.js';
import * as S from './session.js';
import { createWork } from './work.js';
import { createAuto } from './auto.js';
import { createReportView } from './report-view.js';
import { createHistoryView } from './history-view.js';
import { loadDraft, clearDraft } from './storage.js';
import { openVideoFile } from '../media/open.js';
import { createSyntheticSource } from '../media/synth-source.js';
import { parseCsv } from '../core/csv.js';

const VIEWS = ['home', 'work', 'auto', 'report', 'history'];
const params = new URLSearchParams(location.search);

const app = {
  session: null,
  source: null,
  view: 'home',
  work: null,

  /** 切換畫面。 */
  go(view, opts = {}) {
    if (!VIEWS.includes(view)) return;
    if ((view === 'work' || view === 'auto') && !app.source) view = 'home';
    if (view === 'report' && !app.session) view = 'home';
    app.view = view;
    for (const v of VIEWS) show($(`#view-${v}`), v === view);
    show($('#nav-home'), view !== 'home');
    show($('#demo-banner'), !!app.session && app.session.mode === 'demo' && view !== 'home' && view !== 'history');
    $('#topbar-title').textContent = view === 'home' || view === 'history' || !app.session ? '' : app.session.mode === 'demo' ? '合成示範' : (app.session.info && app.session.info.name) || app.session.videoName || '';
    window.scrollTo(0, 0);

    if (view === 'work') {
      app.work.refresh({ step: opts.step, frame: opts.frame });
      if (opts.draftMade != null) app.work.setDraftMade(opts.draftMade);
    } else if (view === 'auto') auto.enter(app.session, app.source);
    else if (view === 'report') report.enter(app.session, app.source, { notices: opts.notices });
    else if (view === 'history') history.enter();
    else if (view === 'home') closeSource();
  },

  onSessionChanged() {
    /* 目前不需要做什麼；保留給之後的擴充 */
  },

  /** 由歷次紀錄開啟一次練習的報告。 */
  openRecord(record) {
    closeSource();
    const session = S.createSession({ mode: 'history', date: record.date });
    session.id = record.id;
    session.player = record.player;
    session.note = record.note;
    session.videoName = record.videoName;
    session.shots = record.shots.map((s, i) => ({ id: i + 1, source: record.source === 'csv' ? 'csv' : 'manual', angle: s.angle, made: s.made }));
    app.session = session;
    app.go('report');
  },
};
window.__arclog = app; // 測試和除錯用

app.work = createWork(app);
const auto = createAuto(app);
const report = createReportView(app);
const history = createHistoryView(app);

function closeSource() {
  if (app.source) {
    try {
      app.source.dispose();
    } catch {
      /* 關不掉也沒關係 */
    }
  }
  app.source = null;
  app.session = null;
  app.work.close();
  auto.reset();
}

function setStatus(text) {
  $('#home-status').textContent = text || '';
}
function setHomeError(text) {
  const box = $('#home-error');
  box.textContent = text || '';
  show(box, !!text);
}

function infoOf(source) {
  return {
    name: source.name,
    size: source.size,
    width: source.width,
    height: source.height,
    fps: source.fps,
    frameCount: source.frameCount,
    duration: source.duration,
    codec: source.codec,
    rotation: source.rotation,
    timeSource: source.timeSource,
    engine: source.engine,
  };
}

// ── 載入影片 ──
async function loadVideo(file) {
  setHomeError('');
  setStatus(`正在開啟 ${file.name}…`);
  closeSource();
  let source;
  try {
    const engine = params.get('engine') === 'video' ? 'video' : params.get('engine') === 'codec' ? 'codec' : 'auto';
    source = await openVideoFile(file, { engine, onProgress: (t) => setStatus(`${file.name}：${t}`) });
  } catch (err) {
    setStatus('');
    setHomeError(err.message || String(err));
    return;
  }
  setStatus('');
  const session = S.createSession({ mode: 'video', info: infoOf(source) });
  if (file.lastModified) {
    // 預設用影片檔的日期當作練習日期
    const d = new Date(file.lastModified);
    if (!Number.isNaN(d.getTime())) session.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  let restored = 0;
  const draft = loadDraft(S.draftKey(session.info));
  if (draft && ((draft.shots && draft.shots.length) || (draft.hoopPoints && draft.hoopPoints.front))) {
    const n = draft.shots ? draft.shots.length : 0;
    const yes = await confirmDialog({
      title: '接續上次的標記？',
      message: `這支影片上次標到一半${n ? `（已記錄 ${n} 球）` : '（已校正籃框）'}。要接續，還是重新開始？`,
      okText: '接續',
      cancelText: '重新開始',
    });
    if (yes) restored = S.restoreDraft(session, draft) + (S.hoopFrame(session) ? 1 : 0);
    else clearDraft(S.draftKey(session.info));
  }
  app.source = source;
  app.session = session;
  await app.work.open(session, source, { step: restored ? 'mark' : 'calibrate' });
  app.go('work');
}

$('#file-video').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) loadVideo(file);
});

// 也可以把影片拖進頁面
document.addEventListener('dragover', (e) => {
  if (app.view === 'home') e.preventDefault();
});
document.addEventListener('drop', (e) => {
  if (app.view !== 'home') return;
  e.preventDefault();
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  if (/\.csv$/i.test(file.name)) loadCsv(file);
  else loadVideo(file);
});

// ── 示範模式 ──
$('#btn-demo').addEventListener('click', async () => {
  setHomeError('');
  closeSource();
  const source = createSyntheticSource({});
  const session = S.createSession({ mode: 'demo', info: infoOf(source), truth: source.truth });
  app.source = source;
  app.session = session;
  await app.work.open(session, source, { step: 'calibrate' });
  app.go('work');
});

// ── 匯入 CSV ──
async function loadCsv(file) {
  setHomeError('');
  let text;
  try {
    text = await readFileText(file);
  } catch {
    setHomeError('讀不到這個檔案。');
    return;
  }
  const res = parseCsv(text);
  if (!res.shots.length) {
    setHomeError(`這個 CSV 裡沒有可以用的資料。${res.warnings.slice(0, 3).join('；')}　格式應該是三欄：球序, 入框角度, 是否進球。`);
    return;
  }
  closeSource();
  const session = S.createSession({ mode: 'csv' });
  session.videoName = file.name;
  session.shots = res.shots.map((s, i) => ({ id: i + 1, source: 'csv', angle: Math.floor(s.angle * 10 + 0.5) / 10, made: s.made }));
  if (file.lastModified) {
    const d = new Date(file.lastModified);
    if (!Number.isNaN(d.getTime())) session.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  app.session = session;
  const notices = [`這份報告來自匯入的 CSV（${file.name}），共 ${res.shots.length} 球。`];
  if (res.warnings.length) notices.push(`有 ${res.warnings.length} 列沒有匯入：${res.warnings.slice(0, 4).join('；')}${res.warnings.length > 4 ? '…' : ''}`);
  app.go('report', { notices });
}
$('#file-csv').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) loadCsv(file);
});

$('#btn-history').addEventListener('click', () => app.go('history'));

// ── 左上角的返回 ──
$('#nav-home').addEventListener('click', () => {
  if (app.view === 'auto') app.go('work', { step: 'mark' });
  else if (app.view === 'report' && app.source) app.go('work', { step: 'mark' });
  else if (app.view === 'report' && app.session && app.session.mode === 'history') app.go('history');
  else {
    if (app.view === 'work' && app.session && app.session.mode === 'video' && (app.session.shots.length || app.session.draft.length)) {
      toast('標記已暫存在這台裝置；下次載入同一支影片可以接續');
    }
    app.go('home');
  }
});

// 沒接住的錯誤：告訴使用者，而不是讓頁面默默壞掉
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason && e.reason.message ? e.reason.message : String(e.reason);
  console.error('unhandled', e.reason);
  toast(`發生錯誤：${msg}`, 6000);
});

app.go('home');
