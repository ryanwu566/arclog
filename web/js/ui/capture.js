// 網站內錄影：開相機 → 引導框 → 預檢（找得到籃框、鏡頭角度幾級）→ 錄影＋邊錄邊偵測 → 停止 → 報告。
//
// iPhone Safari 的限制（查證結果寫在 docs/PLAN_AUTO.md 2.2）：
//   - 頁面切到背景、鎖定螢幕時相機會被暫停（track muted）：用 Wake Lock 讓螢幕不要自己關，被中斷時記下時段並提醒。
//   - 記憶體比桌機少：錄下來的影片每秒一段寫進 IndexedDB（recstore.js），不放在記憶體裡。
//   - 處理速度未知：即時偵測依裝置實際速度送幀（一次只有一幀在算），按停止時如果即時偵測不夠密，
//     再對錄好的影片補分析，並依量到的速度告訴使用者要等多久。
// 分析失敗時影片還在 IndexedDB 裡，首頁可以重新分析或下載。

import { $, show, clear, el, toast, download } from './dom.js';
import * as S from './session.js';
import { createDetector, loadManifest } from '../detect/client.js';
import { createSimulatedDetector } from '../detect/simulated.js';
import { letterbox } from '../core/yolo.js';
import { autoCalibrate } from '../core/autocal.js';
import { fitPose, gradeView } from '../core/viewangle.js';
import { makeScene3d, scene3dTruth } from '../core/synth3d.js';
import { createSyntheticCameraStream } from '../media/synth3d-source.js';
import { openVideoFile } from '../media/open.js';
import { nearestIndex } from '../media/source.js';
import { createRecording, appendChunk, updateRecording, getRecordingBlob, deleteRecording, isVolatile } from './recstore.js';
import { todayString } from '../core/history.js';

/** 即時偵測每秒至少要幾幀，停止後才可以直接出報告（不然要補分析）。 */
export const LIVE_MIN_FPS = 10;

const GRADE_TEXT = {
  A: 'A 接近側面',
  B: 'B 偏斜，角度誤差較大',
  C: 'C 太偏：只統計出手和命中',
  unknown: '還判斷不出來',
};

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      /* 有些瀏覽器問了會丟錯誤 */
    }
  }
  return '';
}

/** 瀏覽器測試用：?fakecam=theta:0,bg:1,w:640,h:360,seed:7 → 和 tests/make_camera_feed.mjs 產生的假相機畫面同一段劇本。 */
function fakecamPlan() {
  const q = new URLSearchParams(location.search).get('fakecam');
  if (!q) return null;
  const o = Object.fromEntries(q.split(',').map((kv) => kv.split(':')));
  return makeScene3d({
    seed: Number(o.seed || 7),
    width: Number(o.w || 640),
    height: Number(o.h || 360),
    fps: 30,
    camera: { thetaDeg: Number(o.theta || 0), dist: 9, camHeight: 1.6, pitchDeg: 3 },
    background: o.bg === '1',
  });
}

export function createCapture(app) {
  let st = null; // 這一次錄影的狀態

  const video = $('#capture-video');
  const overlay = $('#capture-overlay');

  function check(id, state, text) {
    const li = $(`#chk-${id}`);
    li.dataset.state = state;
    li.querySelector('.chk-text').textContent = text || '';
  }
  function setError(text, actions = []) {
    const box = $('#capture-error');
    clear(box);
    show(box, !!text);
    if (!text) return;
    box.append(el('p', { text }));
    if (actions.length) box.append(el('div', { class: 'btn-row' }, ...actions.map(([label, fn]) => el('button', { type: 'button', class: 'btn', text: label, onclick: fn }))));
  }

  function cameraErrorText(err) {
    const name = err && err.name;
    if (!window.isSecureContext) return '相機只能在 HTTPS 的網址使用。請用部署好的網址（https://…）打開。';
    if (name === 'NotAllowedError' || name === 'SecurityError') return '沒有相機權限。iPhone 請到「設定 → Safari → 相機」改成「允許」或「詢問」，再重新整理這個頁面（Safari 拒絕過一次之後，要重新整理才會再問）。';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return '找不到可以用的相機。';
    if (name === 'NotReadableError') return '相機被別的 App 佔用了，請關掉其他用到相機的 App 再試。';
    return `相機打不開：${(err && err.message) || err}`;
  }

  async function openCamera(opts) {
    if (opts.demo) {
      const cam = createSyntheticCameraStream(opts.demo);
      return { stream: cam.stream, plan: cam.plan, stopExtra: () => cam.stop(), demo: true };
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('這個瀏覽器不能用相機'), { name: 'NotFoundError' });
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    });
    return { stream, plan: fakecamPlan(), stopExtra: () => {}, demo: false };
  }

  async function getDetector(plan) {
    if (plan && new URLSearchParams(location.search).get('simdet') !== '0') return createSimulatedDetector(plan);
    const manifest = await loadManifest();
    const want = new URLSearchParams(location.search).get('model');
    const model = manifest.models.find((m) => m.id === want) || manifest.models.find((m) => m.id === manifest.default);
    const d = await createDetector({
      model,
      forceWasm: new URLSearchParams(location.search).get('backend') === 'wasm',
      onProgress: (p) => check('model', 'wait', p.stage === 'download' && p.total ? `下載中 ${Math.round((100 * p.loaded) / p.total)}%` : '載入中…'),
    });
    d.modelId = model.id;
    d.rimBox = model.rimBox || 'rim';
    return d;
  }

  // ── 取一幀送去偵測 ──
  function grab(s) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const { width: W, height: H } = s.detector.input;
    if (!s.lb || s.lbW !== vw || s.lbH !== vh) {
      s.lb = letterbox(vw, vh, W, H);
      s.lbW = vw;
      s.lbH = vh;
      s.canvas.width = W;
      s.canvas.height = H;
    }
    const ctx = s.ctx;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(video, s.lb.padX, s.lb.padY, s.lb.newW, s.lb.newH);
    return ctx.getImageData(0, 0, W, H).data.buffer;
  }

  /**
   * 等相機出下一幀（requestVideoFrameCallback：Chrome、Safari 15.4 起）。沒有這個 API 時大約每 1/30 秒一次。
   * 一定要等：偵測比相機快時，同一幀會被重複偵測，球看起來像停住了。
   */
  function nextFrame(s) {
    return new Promise((resolve) => {
      if (typeof video.requestVideoFrameCallback === 'function') {
        let done = false;
        const id = video.requestVideoFrameCallback((now, meta) => {
          done = true;
          resolve(meta);
        });
        // 相機被暫停（iPhone 切到背景）時不會有新的幀：不要永遠等下去
        setTimeout(() => {
          if (!done) {
            try {
              video.cancelVideoFrameCallback(id);
            } catch {
              /* 已經取消了 */
            }
            resolve(null);
          }
        }, 1000);
      } else {
        const wait = Math.max(0, 1000 / 30 - (performance.now() - (s.lastGrab || 0)));
        setTimeout(() => resolve(null), wait);
      }
    });
  }

  async function detectOnce(s) {
    const meta = await nextFrame(s);
    if (meta && meta.presentedFrames != null && meta.presentedFrames === s.lastPresented) return null;
    if (meta) s.lastPresented = meta.presentedFrames;
    s.lastGrab = performance.now();
    const buf = grab(s);
    if (!buf) return null;
    const tw = (performance.now() - s.t0) / 1000; // 牆上時間（從開始錄算起；預檢時是負的或從開相機算）
    const out = await s.detector.detect(buf, s.lb);
    return { ...out, tw };
  }

  // ── 預檢：找籃框、判斷鏡頭角度 ──
  async function preflightLoop(s) {
    while (s.phase === 'preflight' && !s.closed) {
      const t = performance.now();
      let r = null;
      try {
        r = await detectOnce(s);
      } catch (err) {
        check('model', 'bad', `偵測失敗：${err.message || err}`);
        await new Promise((res) => setTimeout(res, 800));
        continue;
      }
      if (r) {
        const tt = (performance.now() - s.tStart) / 1000;
        for (const d of r.dets) s.pre.push({ ...d, t: tt, f: s.pre.length });
        // 只留最近 4 秒
        s.pre = s.pre.filter((d) => d.t > tt - 4);
        updatePreflight(s);
      }
      const wait = Math.max(0, 200 - (performance.now() - t));
      await new Promise((res) => setTimeout(res, wait));
    }
  }

  function updatePreflight(s) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const portrait = vw && vh && vw < vh;
    show($('#capture-rotate'), !!portrait);
    if (portrait) check('camera', 'warn', '請橫拿手機');
    else check('camera', 'ok', `${vw}×${vh}`);
    const hasRim = s.detector.classes && s.detector.classes.rim != null;
    if (!hasRim) {
      if (s.taps.length < 2) check('hoop', 'warn', s.taps.length ? '再點一下籃框的另一端' : '這個模型還不會找籃框：請在畫面上點籃框的兩端');
      else check('hoop', 'ok', '已標出籃框（點兩下）');
      check('angle', 'wait', '錄完之後由球的大小變化估計');
      s.ready = !portrait && s.taps.length >= 2;
    } else {
      const cal = autoCalibrate(s.pre, { minCount: 4, rimBox: s.detector.rimBox || 'rim' });
      s.cal = cal.ok ? cal : null;
      if (!cal.ok) {
        check('hoop', 'warn', '還沒看到籃框：把籃框和籃板放進黃色框裡');
        check('angle', 'wait', '');
      } else if (!cal.stable) {
        check('hoop', 'warn', '籃框的位置在晃動：手機要固定在腳架上');
      } else {
        check('hoop', 'ok', '找到籃框');
      }
      // 鏡頭角度：推算相機位置要 0.5 秒左右，每 2 秒算一次就好
      if (cal.ok && cal.board && performance.now() - (s.poseAt || 0) > 2000) {
        s.poseAt = performance.now();
        const pose = fitPose(cal.rim.box, cal.board.box, { width: vw, height: vh, rimBox: cal.rimBox });
        s.grade = pose.devDeg != null ? gradeView(pose.devDeg, pose.devRange) : null;
      } else if (cal.ok && !cal.board) {
        s.grade = null;
        check('angle', 'warn', '看不到籃板：整個籃板都要入鏡，才能判斷鏡頭角度');
      }
      if (s.grade) check('angle', s.grade.grade === 'A' ? 'ok' : s.grade.grade === 'B' ? 'warn' : 'bad', `${GRADE_TEXT[s.grade.grade]}（偏約 ${Math.round(s.grade.devDeg)} 度）`);
      s.ready = !portrait && !!cal.ok && cal.stable;
    }
    $('#capture-start').disabled = !s.ready;
    drawOverlay(s);
  }

  function drawOverlay(s) {
    const r = overlay.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (overlay.width !== Math.round(r.width * dpr)) {
      overlay.width = Math.round(r.width * dpr);
      overlay.height = Math.round(r.height * dpr);
    }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw) return;
    // object-fit: contain 的換算
    const k = Math.min(overlay.width / vw, overlay.height / vh);
    const ox = (overlay.width - vw * k) / 2;
    const oy = (overlay.height - vh * k) / 2;
    s.toScreen = { k, ox, oy, dpr };
    ctx.lineWidth = 2 * dpr;
    if (s.cal && s.cal.rim) {
      const b = s.cal.rim.box;
      ctx.strokeStyle = s.cal.stable ? '#5ee28a' : '#ffd84a';
      ctx.strokeRect(ox + b.x0 * k, oy + b.y0 * k, (b.x1 - b.x0) * k, (b.y1 - b.y0) * k);
    }
    if (s.cal && s.cal.board) {
      const b = s.cal.board.box;
      ctx.strokeStyle = 'rgba(120,200,255,0.9)';
      ctx.strokeRect(ox + b.x0 * k, oy + b.y0 * k, (b.x1 - b.x0) * k, (b.y1 - b.y0) * k);
    }
    for (const p of s.taps) {
      ctx.fillStyle = '#1c5cab';
      ctx.beginPath();
      ctx.arc(ox + p.x * k, oy + p.y * k, 6 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 沒有籃框類別的模型：在預覽上點兩下籃框
  $('#capture-stage').addEventListener('pointerdown', (e) => {
    const s = st;
    if (!s || s.phase !== 'preflight' || !s.toScreen || (s.detector.classes && s.detector.classes.rim != null)) return;
    const r = overlay.getBoundingClientRect();
    const { k, ox, oy, dpr } = s.toScreen;
    const x = ((e.clientX - r.left) * dpr - ox) / k;
    const y = ((e.clientY - r.top) * dpr - oy) / k;
    if (x < 0 || y < 0 || x > video.videoWidth || y > video.videoHeight) return;
    if (s.taps.length >= 2) s.taps = [];
    s.taps.push({ x, y });
    updatePreflight(s);
  });

  // ── 錄影 ──
  async function startRecording() {
    const s = st;
    if (!s || !s.ready || s.phase !== 'preflight') return;
    const mime = pickMime();
    if (mime === null) {
      setError('這個瀏覽器不能錄影（沒有 MediaRecorder）。可以用手機的相機 App 錄好，再回到首頁「上傳練投影片」。');
      return;
    }
    s.phase = 'recording';
    s.mime = mime || 'video/webm';
    s.recId = await createRecording({ mime: s.mime, width: video.videoWidth, height: video.videoHeight, demo: !!s.demo, plan: s.plan ? { seed: s.plan.seed } : null });
    if (await isVolatile()) toast('這個瀏覽器不能把錄影存在裝置上：頁面關掉之前請不要離開。', 6000);
    s.seq = 0;
    s.writes = [];
    s.recorder = new MediaRecorder(s.stream, mime ? { mimeType: mime } : undefined);
    s.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) s.writes.push(appendChunk(s.recId, s.seq++, e.data));
    };
    s.recorder.start(1000);
    s.t0 = performance.now();
    s.live = [];
    s.liveFrames = 0;
    s.gaps = [];
    $('#capture-stage').classList.add('recording');
    $('#view-capture').classList.add('recording');
    show($('#capture-rec'), true);
    show($('#capture-start'), false);
    show($('#capture-stop'), true);
    $('#capture-hint').textContent = '錄影中。投完按「停止」。請不要切換 App 或鎖定螢幕（iPhone 會暫停相機）。';
    try {
      s.wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null;
    } catch {
      s.wakeLock = null;
    }
    s.timer = setInterval(() => {
      const sec = Math.floor((performance.now() - s.t0) / 1000);
      $('#capture-time').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
      const fps = s.liveFrames / Math.max(1, (performance.now() - s.t0) / 1000);
      const cnt = $('#capture-count');
      show(cnt, true);
      cnt.textContent = `即時偵測每秒 ${fps.toFixed(0)} 幀`;
    }, 500);
    liveLoop(s);
  }

  async function liveLoop(s) {
    while (s.phase === 'recording' && !s.closed) {
      let r = null;
      try {
        r = await detectOnce(s);
      } catch (err) {
        s.liveError = String(err.message || err);
        await new Promise((res) => setTimeout(res, 300));
        continue;
      }
      if (r) {
        s.liveFrames++;
        // 模擬偵測器（示範、瀏覽器測試）：用條碼讀到的合成時間，才對得上真實答案
        const t = r.frame != null && s.plan ? r.frame / s.plan.fps : r.tw;
        for (const d of r.dets) s.live.push({ ...d, t, tw: r.tw, f: s.liveFrames });
      }
      await new Promise((res) => setTimeout(res, 0));
    }
  }

  function onVisibility() {
    const s = st;
    if (!s || s.phase !== 'recording') return;
    const tw = (performance.now() - s.t0) / 1000;
    if (document.hidden) s.gaps.push({ from: tw, to: null });
    else {
      const g = s.gaps[s.gaps.length - 1];
      if (g && g.to == null) g.to = tw;
      toast('剛剛離開了這個頁面：那段時間相機可能被暫停，那幾球可能沒有記到。', 6000);
      if (s.wakeLock === null && navigator.wakeLock) navigator.wakeLock.request('screen').then((w) => (s.wakeLock = w)).catch(() => {});
    }
  }
  document.addEventListener('visibilitychange', onVisibility);

  async function stopRecording() {
    const s = st;
    if (!s || s.phase !== 'recording') return;
    s.phase = 'stopping';
    clearInterval(s.timer);
    const seconds = (performance.now() - s.t0) / 1000;
    $('#capture-hint').textContent = '收尾中…';
    await new Promise((res) => {
      s.recorder.onstop = res;
      try {
        s.recorder.stop();
      } catch {
        res();
      }
    });
    await Promise.allSettled(s.writes);
    await updateRecording(s.recId, { status: 'recorded', seconds, gaps: s.gaps });
    try {
      if (s.wakeLock) await s.wakeLock.release();
    } catch {
      /* 已經釋放了 */
    }
    const liveFps = s.liveFrames / Math.max(seconds, 0.001);
    const dets = s.live;
    const detector = s.detector;
    const taps = s.taps.length >= 2 ? orderTaps(s.taps) : null;
    const plan = s.plan;
    const demo = s.demo;
    const recId = s.recId;
    const gaps = s.gaps;
    teardown(false);
    await analyzeRecording({ recId, dets, liveFps, detector, taps, plan, demo, seconds, gaps });
  }

  function orderTaps(t) {
    const [a, b] = t[0].x <= t[1].x ? [t[0], t[1]] : [t[1], t[0]];
    return { front: a, back: b };
  }

  /** 錄完之後：開錄好的影片（疊圖用）、即時偵測夠密就直接分析，不夠就補掃一次。 */
  async function analyzeRecording(o) {
    let source = null;
    try {
      const got = await getRecordingBlob(o.recId);
      if (got && got.blob.size) {
        const ext = got.rec.mime && got.rec.mime.includes('mp4') ? 'mp4' : 'webm';
        const file = new File([got.blob], `arclog_${todayString()}.${ext}`, { type: got.rec.mime || 'video/webm', lastModified: Date.now() });
        source = await openVideoFile(file, {});
      }
    } catch (err) {
      source = null;
      console.warn('錄好的影片打不開（只影響疊圖）', err);
    }
    const info = source
      ? { name: source.name, size: source.size, width: source.width, height: source.height, fps: source.fps, frameCount: source.frameCount, duration: source.duration, codec: source.codec, rotation: source.rotation, timeSource: source.timeSource, engine: source.engine, perspective: true }
      : { name: `錄影 ${todayString()}`, width: video.videoWidth || 1280, height: video.videoHeight || 720, fps: 30, frameCount: 0, duration: o.seconds, perspective: true };
    const session = S.createSession({ mode: o.demo || o.plan ? 'demo' : 'video', info, truth: o.plan ? scene3dTruth(o.plan) : null });
    session.level = 'persp';
    session.displayName = o.demo || o.plan ? '示範錄影' : `錄影 ${new Date().toLocaleTimeString().slice(0, 5)}`;
    session.recordingId = o.recId;
    session.gaps = o.gaps;
    // 錄影時的偵測點對應到錄好的影片的幀（疊圖、修正用）
    const mapFrames = (dets) => {
      if (!source) return dets;
      return dets.map((d) => ({ ...d, f: nearestIndex(source.frameTimes, d.tw != null ? d.tw : d.t) }));
    };
    const pseudoSource = source || { width: info.width, height: info.height, fps: 30, frameCount: 0, frameTimes: new Float64Array(0), name: info.name, getFrame: async () => { throw new Error('沒有影片'); }, scan: async () => ({ frames: 0, cancelled: false }), dispose() {} };
    app.source = pseudoSource;
    app.session = session;
    let res;
    if (o.liveFps >= LIVE_MIN_FPS || !source) {
      if (o.liveFps < LIVE_MIN_FPS) toast(`即時偵測每秒只有 ${o.liveFps.toFixed(1)} 幀，錄好的影片又打不開，結果可能漏球。`, 6000);
      res = await app.autoflow.run(pseudoSource, session, { liveDets: mapFrames(o.dets), detector: o.detector, hoopPoints: o.taps, title: '分析錄影' });
    } else {
      // 即時偵測跟不上：對錄好的影片補掃一次（偵測器沿用，已經載入好了）
      res = await app.autoflow.run(source, session, { detector: o.detector, hoopPoints: o.taps, title: `即時偵測每秒只有 ${o.liveFps.toFixed(1)} 幀，正在補分析錄影` });
    }
    if (!o.detector.simulated) o.detector.dispose();
    await updateRecording(o.recId, { status: res && res.ok ? 'done' : 'failed' }).catch(() => {});
  }

  function teardown(disposeDetector = true) {
    const s = st;
    if (!s) return;
    s.closed = true;
    s.phase = 'closed';
    clearInterval(s.timer);
    try {
      if (s.recorder && s.recorder.state !== 'inactive') s.recorder.stop();
    } catch {
      /* 已經停了 */
    }
    if (s.stream) for (const tr of s.stream.getTracks()) tr.stop();
    if (s.stopExtra) s.stopExtra();
    if (disposeDetector && s.detector && !s.detector.simulated) s.detector.dispose();
    try {
      if (s.wakeLock) s.wakeLock.release();
    } catch {
      /* 已經釋放了 */
    }
    video.srcObject = null;
    $('#capture-stage').classList.remove('recording');
    $('#view-capture').classList.remove('recording');
    st = null;
  }

  $('#capture-start').addEventListener('click', startRecording);
  $('#capture-stop').addEventListener('click', stopRecording);
  $('#capture-cancel').addEventListener('click', () => {
    if (st && st.phase === 'recording') {
      stopRecording();
      return;
    }
    app.go('home');
  });

  return {
    /** 開始：opts.demo＝示範錄影（合成畫面當相機，不用權限）。 */
    async enter(opts = {}) {
      teardown();
      app.go('capture');
      setError(null);
      for (const id of ['camera', 'model', 'hoop', 'angle']) check(id, 'wait', '');
      show($('#capture-rec'), false);
      show($('#capture-count'), false);
      show($('#capture-start'), true);
      show($('#capture-stop'), false);
      $('#capture-start').disabled = true;
      $('#capture-hint').textContent = '橫拿手機放在腳架上，整個籃框、籃板和投籃的人都要入鏡。架好之後不要再動手機。';
      const s = { phase: 'opening', taps: [], pre: [], tStart: performance.now(), t0: performance.now(), canvas: document.createElement('canvas'), closed: false };
      s.ctx = s.canvas.getContext('2d', { willReadFrequently: true });
      st = s;
      try {
        check('camera', 'wait', '開啟中…');
        const cam = await openCamera(opts);
        if (s.closed) {
          for (const tr of cam.stream.getTracks()) tr.stop();
          cam.stopExtra();
          return;
        }
        Object.assign(s, { stream: cam.stream, plan: cam.plan, stopExtra: cam.stopExtra, demo: cam.demo });
        video.srcObject = cam.stream;
        await video.play().catch(() => {});
        for (const tr of cam.stream.getVideoTracks()) {
          tr.onmute = () => {
            if (s.phase === 'recording') s.gaps.push({ from: (performance.now() - s.t0) / 1000, to: null, mute: true });
          };
          tr.onunmute = () => {
            const g = s.gaps && s.gaps[s.gaps.length - 1];
            if (g && g.to == null) g.to = (performance.now() - s.t0) / 1000;
          };
        }
        await new Promise((res) => {
          if (video.videoWidth) res();
          else video.onloadedmetadata = () => res();
          setTimeout(res, 3000);
        });
        check('camera', 'ok', `${video.videoWidth}×${video.videoHeight}`);
      } catch (err) {
        check('camera', 'bad', '打不開');
        setError(cameraErrorText(err), [['回首頁', () => app.go('home')]]);
        return;
      }
      try {
        check('model', 'wait', '載入中…');
        s.detector = await getDetector(s.plan);
        if (s.closed) return;
        check('model', 'ok', s.detector.simulated ? '模擬（示範用，不是真的模型）' : s.detector.backend === 'webgpu' ? 'WebGPU' : 'WASM');
      } catch (err) {
        check('model', 'bad', '載入失敗');
        setError(`偵測模型載入失敗：${err.message || err}。可以用手機的相機 App 錄好，再回到首頁「上傳練投影片」。`, [['回首頁', () => app.go('home')]]);
        return;
      }
      s.phase = 'preflight';
      preflightLoop(s);
    },
    leave() {
      if (st && st.phase === 'recording') {
        // 被切走（例如按了返回）：先把錄到的存好，不要丟
        stopRecording();
        return;
      }
      teardown();
    },
    /** 首頁的「重新分析」：用存下來的錄影從頭補掃。 */
    async reanalyze(id) {
      try {
        const manifestDet = await getDetector(null);
        await analyzeRecording({ recId: id, dets: [], liveFps: 0, detector: manifestDet, taps: null, plan: null, demo: false, seconds: 0, gaps: [] });
      } catch (err) {
        toast(`重新分析失敗：${err.message || err}`, 6000);
      }
    },
    async download(id) {
      const got = await getRecordingBlob(id);
      if (!got) {
        toast('找不到這段錄影');
        return;
      }
      download(`arclog_錄影_${got.rec.createdAt.slice(0, 10)}.${got.rec.mime && got.rec.mime.includes('mp4') ? 'mp4' : 'webm'}`, got.blob);
    },
    remove: (id) => deleteRecording(id),
    get state() {
      return st;
    },
  };
}
