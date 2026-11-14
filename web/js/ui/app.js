// ArcLog 主程式：切換畫面、載入影片／示範／CSV，把各個畫面串起來。
//
// 網址參數（測試與除錯用）
//   ?engine=video   強制用 <video> 退路引擎
//   ?backend=wasm   自動偵測不使用 WebGPU
//   ?model=<id>     自動分析用 models/manifest.json 裡的哪個模型
//   ?simdet=0       示範的合成畫面也用真的模型（預設用模擬偵測器）
//   ?fakecam=...    瀏覽器測試用：假相機播的是哪一段合成畫面（見 capture.js）

import { $, el, clear, show, toast, confirmDialog, readFileText } from './dom.js';
import * as S from './session.js';
import { createWork } from './work.js';
import { createAuto } from './auto.js';
import { createReportView } from './report-view.js';
import { createHistoryView } from './history-view.js';
import { createAutoFlow } from './autoflow.js';
import { createCapture } from './capture.js';
import { loadDraft, clearDraft } from './storage.js';
import { listRecordings, deleteRecording } from './recstore.js';
import { openVideoFile } from '../media/open.js';
import { createSyntheticSource } from '../media/synth-source.js';
import { createSynthetic3dSource } from '../media/synth3d-source.js';
import { parseCsv } from '../core/csv.js';
import { displayName } from './names.js';

const VIEWS = ['home', 'work', 'auto', 'analyze', 'capture', 'report', 'history'];

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
    if (app.view === 'capture' && view !== 'capture') capture.leave();
    if (app.pendingTaps && view !== 'work') {
      const p = app.pendingTaps;
      app.pendingTaps = null;
      p.resolve(null);
    }
    if (view === 'report' && !app.session) view = 'home';
    app.view = view;
    for (const v of VIEWS) show($(`#view-${v}`), v === view);
    show($('#nav-home'), view !== 'home');
    show($('#demo-banner'), !!app.session && app.session.mode === 'demo' && view !== 'home' && view !== 'history');
    $('#topbar-title').textContent = view === 'home' || view === 'history' || view === 'capture' || !app.session ? '' : app.session.mode === 'demo' ? '合成示範' : app.session.displayName || displayName(app.session.info || { name: app.session.videoName });
    window.scrollTo(0, 0);

    if (view === 'work') {
      app.work.refresh({ step: opts.step, frame: opts.frame });
      if (opts.draftMade != null) app.work.setDraftMade(opts.draftMade);
    } else if (view === 'auto') auto.enter(app.session, app.source);
    else if (view === 'report') report.enter(app.session, app.source, { notices: opts.notices });
    else if (view === 'history') history.enter();
    else if (view === 'home') {
      closeSource();
      refreshPending();
    }
  },

  /** 改用手動標記（自動分析失敗，或使用者想自己標）。 */
  async openManual(session, source) {
    if (!source) return;
    app.source = source;
    app.session = session;
    await app.work.open(session, source, { step: 'calibrate' });
    app.go('work');
  },

  /**
   * 請使用者在畫面上點兩下籃框（模型沒有籃框類別，或自動找不到籃框）。
   * 用手動校正的畫面，按「繼續自動分析」時把兩點交回來；使用者離開就回傳 null。
   */
  async askHoopTaps(session, source, message) {
    app.source = source;
    app.session = session;
    await app.work.open(session, source, { step: 'calibrate', tapsFor: 'auto', message });
    app.go('work');
    return new Promise((resolve) => {
      app.pendingTaps = {
        resolve: (pts) => {
          app.work.endTaps();
          resolve(pts);
        },
      };
    });
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
const autoflow = createAutoFlow(app);
const capture = createCapture(app);
app.autoflow = autoflow;
app.capture = capture;

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
  autoflow.cancel();
}

/** 首頁：有沒有還沒分析完的錄影（分析失敗、頁面當掉時影片還在這台裝置上）。 */
async function refreshPending() {
  const box = $('#home-pending');
  let list = [];
  try {
    list = await listRecordings();
  } catch {
    list = [];
  }
  // 分析完成的錄影：回到首頁就刪掉（報告和紀錄已經存好了；影片只是給那次報告的疊圖用）
  for (const r of list.filter((x) => x.status === 'done')) deleteRecording(r.id).catch(() => {});
  // 正在錄的那一段不算（另一個分頁可能正在錄）：超過 10 分鐘還是 recording 的才當成中斷的錄影
  const pending = list.filter((r) => r.status === 'recorded' || r.status === 'failed' || (r.status === 'recording' && Date.now() - Date.parse(r.createdAt) > 10 * 60 * 1000));
  clear(box);
  show(box, pending.length > 0);
  if (!pending.length) return;
  const r = pending[0];
  box.append(
    el('p', { text: `這台裝置上有 ${pending.length} 段錄影還沒分析完（最近一段：${new Date(r.createdAt).toLocaleString()}，約 ${Math.round(r.seconds || 0)} 秒）。影片沒有遺失。` }),
    el(
      'div',
      { class: 'btn-row' },
      el('button', { type: 'button', class: 'btn btn-primary', text: '重新分析', onclick: () => capture.reanalyze(r.id) }),
      el('button', { type: 'button', class: 'btn', text: '下載影片', onclick: () => capture.download(r.id) }),
      el('button', { type: 'button', class: 'btn btn-danger', text: '刪除', onclick: () => capture.remove(r.id).then(refreshPending) }),
    ),
  );
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

// ── 上傳影片：自動分析 ──
async function openFile(file) {
  setHomeError('');
  setStatus(`正在開啟 ${file.name}…`);
  closeSource();
  try {
    const engine = params.get('engine') === 'video' ? 'video' : params.get('engine') === 'codec' ? 'codec' : 'auto';
    const source = await openVideoFile(file, { engine, onProgress: (t) => setStatus(`${file.name}：${t}`) });
    setStatus('');
    return source;
  } catch (err) {
    setStatus('');
    setHomeError(err.message || String(err));
    return null;
  }
}

function sessionFor(source, file) {
  const session = S.createSession({ mode: 'video', info: infoOf(source) });
  if (file && file.lastModified) {
    const d = new Date(file.lastModified);
    if (!Number.isNaN(d.getTime())) {
      session.date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      session.displayName = displayName(session.info, d);
    }
  }
  return session;
}

async function uploadVideo(file) {
  const source = await openFile(file);
  if (!source) return;
  const session = sessionFor(source, file);
  app.source = source;
  app.session = session;
  await autoflow.run(source, session, { title: '分析影片' });
}

// ── 手動標記一支影片（原本的半自動流程）──
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
  if (file) uploadVideo(file);
});
$('#file-video-manual').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) loadVideo(file);
});

// ── 示範（自動流程）──
async function startDemoAuto() {
  setHomeError('');
  closeSource();
  const source = createSynthetic3dSource({ view: $('#demo-view').value, background: $('#demo-background').checked });
  const session = S.createSession({ mode: 'demo', info: { ...infoOf(source), perspective: true }, truth: source.truth });
  session.level = 'persp';
  app.source = source;
  app.session = session;
  await autoflow.run(source, session, { title: '分析示範影片' });
}
$('#btn-demo-auto').addEventListener('click', startDemoAuto);
$('#btn-capture').addEventListener('click', () => capture.enter({}));
$('#btn-demo-capture').addEventListener('click', () => capture.enter({ demo: { view: $('#demo-view').value, background: $('#demo-background').checked } }));

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
  else uploadVideo(file);
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
  if (app.view === 'work' && app.pendingTaps) {
    app.go('home');
    return;
  }
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
