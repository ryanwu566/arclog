// 自動偵測的畫面：載入模型 → 逐幀偵測（有進度、可取消）→ 串成軌跡 → 每一球一張確認卡。
// 任何一步失敗都會留下說明，並讓使用者回到半自動標記，不會卡住。

import { $, el, clear, show, toast, madeMark } from './dom.js';
import * as S from './session.js';
import { createDetector, loadManifest, webgpuLikely } from '../detect/client.js';
import { letterbox } from '../core/yolo.js';
import { findShots } from '../core/track.js';
import { toImage } from '../core/geometry.js';
import { sampleArc } from '../core/shot.js';
import { DRAG_K_RIM } from '../core/constants.js';

const BY_TEXT = {
  geometry: '依過框位置判斷',
  net: '過框後球出現在球網的位置',
  bounce: '過框後球又彈起來',
};

/** 給使用者看的運算方式：WebGPU，或 WASM 加上用了幾個執行緒（1 個代表多執行緒沒有啟用，會慢很多）。 */
function backendLabel(backend, threads) {
  if (backend === 'webgpu') return 'WebGPU';
  return `WASM（${threads > 1 ? `${threads} 個執行緒` : '單執行緒'}）`;
}

export function createAuto(app) {
  let session = null;
  let source = null;
  let manifest = null;
  let customFile = null;
  let abort = null;
  let found = []; // [{shot, state: 'pending'|'accepted'|'removed', made}]
  let lastRun = null;

  const params = new URLSearchParams(location.search);
  if (params.get('backend') === 'wasm') $('#auto-force-wasm').checked = true;

  function showOnly(which) {
    show($('#auto-setup'), which === 'setup');
    show($('#auto-progress'), which === 'progress');
    show($('#auto-results'), which === 'results');
  }

  function setError(text) {
    const box = $('#auto-error');
    clear(box);
    if (!text) {
      show(box, false);
      return;
    }
    box.append(
      el('p', { text }),
      el(
        'div',
        { class: 'btn-row' },
        el('button', { type: 'button', class: 'btn btn-primary', text: '改用半自動標記', onclick: () => app.go('work', { step: 'mark' }) }),
        el('button', { type: 'button', class: 'btn', text: '再試一次', onclick: () => { setError(null); showOnly('setup'); } }),
      ),
    );
    show(box, true);
  }

  async function fillModels() {
    const sel = $('#auto-model');
    clear(sel);
    try {
      if (!manifest) manifest = await loadManifest();
      for (const m of manifest.models) sel.append(el('option', { value: m.id, text: m.label }));
      sel.value = manifest.default;
    } catch (err) {
      manifest = null;
      sel.append(el('option', { value: '', text: '（讀不到模型清單）' }));
    }
    if (customFile) {
      sel.append(el('option', { value: '__file__', text: `自己載入的：${customFile.name}` }));
      sel.value = '__file__';
    }
    describeModel();
  }

  function describeModel() {
    const id = $('#auto-model').value;
    const note = $('#auto-model-note');
    if (id === '__file__') {
      note.textContent = '使用你載入的 ONNX 檔。單一類別的模型會用類別 0；80 類的 COCO 模型會用 sports ball。';
      return;
    }
    const m = manifest && manifest.models.find((x) => x.id === id);
    if (!m) {
      note.textContent = '讀不到模型清單，自動偵測可能無法使用。你仍然可以用半自動標記。';
      return;
    }
    const gpu = webgpuLikely() && !$('#auto-force-wasm').checked;
    note.textContent = `${m.note || ''}　檔案 ${(m.bytes / 1e6).toFixed(1)} MB，第一次使用會下載${gpu ? '；這台裝置會先試 WebGPU。' : '；這台裝置會用 WASM（比較慢）。'}`;
  }

  $('#auto-model').addEventListener('change', describeModel);
  $('#auto-force-wasm').addEventListener('change', describeModel);
  $('#file-onnx').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    customFile = f;
    fillModels();
    toast(`已選擇 ${f.name}`);
  });

  // ── 偵測 ──
  async function run() {
    setError(null);
    const hoop = S.hoopFrame(session);
    if (!hoop) {
      setError('請先完成籃框校正。');
      return;
    }
    const modelId = $('#auto-model').value;
    const model = modelId === '__file__' ? null : manifest && manifest.models.find((m) => m.id === modelId);
    if (!model && !customFile) {
      setError('沒有可以用的偵測模型（讀不到模型清單）。');
      return;
    }
    abort = new AbortController();
    const signal = abort.signal;
    showOnly('progress');
    const stage = $('#auto-stage');
    const bar = $('#auto-bar');
    const detail = $('#auto-detail');
    bar.removeAttribute('value');
    stage.textContent = '載入偵測模型…';
    detail.textContent = '';

    let detector = null;
    const t0 = performance.now();
    try {
      detector = await createDetector({
        model,
        file: model ? null : customFile,
        forceWasm: $('#auto-force-wasm').checked,
        onProgress: (p) => {
          const name = p.backend === 'webgpu' ? 'WebGPU' : 'WASM';
          if (p.stage === 'download' && p.total) {
            bar.max = p.total;
            bar.value = p.loaded;
            stage.textContent = `下載偵測模型… ${(p.loaded / 1e6).toFixed(1)} / ${(p.total / 1e6).toFixed(1)} MB`;
          } else {
            bar.removeAttribute('value');
            stage.textContent = p.stage === 'runtime' ? `啟動推論引擎（${name}）…` : p.stage === 'session' ? `載入模型（${name}）…` : `準備中（${name}）…`;
          }
        },
      });
    } catch (err) {
      showOnly('setup');
      setError(`${err.message || err}。自動偵測這次用不了，你可以改用半自動標記。`);
      return;
    }
    if (signal.aborted) {
      detector.dispose();
      showOnly('setup');
      return;
    }

    const { width: W, height: H } = detector.input;
    const lb = letterbox(source.width, source.height, W, H);
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';

    const from = $('#auto-range').value === 'from' ? app.work.index : 0;
    const to = source.frameCount - 1;
    // 標準：每秒至少 20 幀（30fps 的影片每幀都看，60fps 的每 3 幀看一幀）；精細：每秒最多 60 幀
    const stride = $('#auto-density').value === 'fine' ? Math.max(1, Math.round(source.fps / 60)) : Math.max(1, Math.floor(source.fps / 20 + 1e-6));
    const total = Math.ceil((to - from + 1) / stride);
    const detections = [];
    let done = 0;
    let inferMs = 0;
    let failure = null;
    let wake = null;
    const backendName = backendLabel(detector.backend, detector.info.threads);
    bar.max = total;
    bar.value = 0;
    const tScan = performance.now();
    const progress = () => {
      bar.value = done;
      const elapsed = (performance.now() - tScan) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const left = rate > 0 ? (total - done) / rate : 0;
      stage.textContent = `逐幀偵測中… ${done} / ${total} 幀`;
      detail.textContent = `${backendName}，每秒約 ${rate.toFixed(1)} 幀${done > 5 ? `，大約還要 ${left < 60 ? `${Math.ceil(left)} 秒` : `${Math.ceil(left / 60)} 分鐘`}` : ''}。請讓這個頁面保持在前景。`;
    };
    progress();

    let scanResult;
    try {
      scanResult = await source.scan({
        from,
        to,
        stride,
        signal,
        onFrame: async ({ index, time, draw }) => {
          if (failure) throw failure;
          ctx.fillStyle = 'rgb(114,114,114)';
          ctx.fillRect(0, 0, W, H);
          draw(ctx, lb.padX, lb.padY, lb.newW, lb.newH);
          const data = ctx.getImageData(0, 0, W, H);
          // 最多同時有兩幀在等結果：解碼和推論可以重疊，又不會把記憶體塞爆
          while (detector.pending >= 2 && !failure) {
            await new Promise((r) => {
              wake = r;
            });
          }
          if (failure) throw failure;
          detector
            .detect(data.data.buffer, lb)
            .then(({ dets, ms }) => {
              for (const d of dets) detections.push({ f: index, t: time, x: d.x, y: d.y, w: d.w, h: d.h, conf: d.conf });
              inferMs += ms;
            })
            .catch((err) => {
              failure = failure || err;
            })
            .finally(() => {
              done++;
              if (done % 3 === 0 || done === total) progress();
              if (wake) {
                const w = wake;
                wake = null;
                w();
              }
            });
        },
      });
      while (detector.pending > 0 && !failure) {
        await new Promise((r) => {
          wake = r;
        });
      }
      if (failure) throw failure;
    } catch (err) {
      detector.dispose();
      abort = null;
      showOnly('setup');
      if (signal.aborted) {
        toast('已取消偵測');
        return;
      }
      setError(`偵測到一半失敗了：${err.message || err}。可以勾選「不使用 WebGPU」再試一次，或改用半自動標記。`);
      return;
    }
    detector.dispose();
    abort = null;
    if (scanResult.cancelled || signal.aborted) {
      showOnly('setup');
      toast('已取消偵測');
      return;
    }

    stage.textContent = '把偵測到的球串成軌跡…';
    await new Promise((r) => setTimeout(r, 0));
    const result = findShots(detections, hoop, { dragK: session.drag ? DRAG_K_RIM : 0 });
    lastRun = {
      backend: detector.backend,
      threads: detector.info.threads,
      attempts: detector.attempts,
      frames: done,
      stride,
      seconds: (performance.now() - t0) / 1000,
      msPerFrame: done ? inferMs / done : 0,
      detections: detections.length,
      stats: result.stats,
      model: model ? model.id : customFile.name,
      shots: result.shots.length,
    };
    window.__arclogLastAuto = lastRun;
    found = result.shots.map((shot) => ({ shot, state: 'pending', made: shot.made }));
    await showResults();
  }

  // ── 確認卡 ──
  async function drawThumb(canvas, shot, hoop) {
    const w = 480;
    const h = Math.round((w * source.height) / source.width);
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext('2d');
    try {
      const fr = await source.getFrame(shot.fCross);
      c.drawImage(fr.image, 0, 0, w, h);
    } catch {
      c.fillStyle = '#141615';
      c.fillRect(0, 0, w, h);
    }
    const k = w / source.width;
    c.save();
    c.scale(k, k);
    const u = 1 / k;
    const both = (color, width) => {
      c.lineJoin = c.lineCap = 'round';
      c.strokeStyle = 'rgba(0,0,0,0.75)';
      c.lineWidth = (width + 2.2) * u;
      c.stroke();
      c.strokeStyle = color;
      c.lineWidth = width * u;
      c.stroke();
    };
    // 籃框
    c.beginPath();
    c.moveTo(session.hoopPoints.front.x, session.hoopPoints.front.y);
    c.lineTo(session.hoopPoints.back.x, session.hoopPoints.back.y);
    both('#ffffff', 1.6);
    // 軌跡：由第一個偵測點到過框點
    const us = shot.points.map((p) => ((p.x - hoop.ox) * hoop.ux + (p.y - hoop.oy) * hoop.uy) / hoop.len);
    const cross = shot.flip ? 1 - shot.crossS : shot.crossS;
    const curve = sampleArc(shot, shot.flip ? Math.max(...us) : Math.min(...us), cross, 56);
    c.beginPath();
    curve.forEach((q, i) => {
      const [x, y] = toImage(hoop, q.u, q.v);
      if (i) c.lineTo(x, y);
      else c.moveTo(x, y);
    });
    both('#ffd84a', 2.2);
    for (const p of shot.points) {
      c.beginPath();
      c.arc(p.x, p.y, 3.2 * u, 0, Math.PI * 2);
      c.fillStyle = 'rgba(0,0,0,0.8)';
      c.fill();
      c.beginPath();
      c.arc(p.x, p.y, 2 * u, 0, Math.PI * 2);
      c.fillStyle = '#ffffff';
      c.fill();
    }
    c.restore();
  }

  function renderCard(item, n, hoop) {
    const { shot } = item;
    const canvas = el('canvas', { 'aria-label': `第 ${n} 球的軌跡疊圖` });
    const made = item.made;
    const toggle = el(
      'div',
      { class: 'made-toggle', role: 'radiogroup', 'aria-label': '這球有沒有進' },
      ...[true, false].map((v) =>
        el(
          'button',
          {
            type: 'button', class: 'made-btn', role: 'radio', 'aria-checked': String(made === v),
            onclick: () => {
              item.made = v;
              if (item.state === 'accepted' && item.id != null) S.setMade(session, item.id, v);
              rerender();
            },
          },
          madeMark(v),
          v ? '進球' : '沒進',
        ),
      ),
    );
    const accepted = item.state === 'accepted';
    const li = el(
      'li',
      { class: `auto-card${accepted ? ' accepted' : ''}`, dataset: { n: String(n) } },
      canvas,
      el(
        'div',
        { class: 'auto-body' },
        el(
          'div',
          { class: 'auto-top' },
          el('div', { class: 'auto-title' }, el('span', { class: 'shot-n', text: `#${n}` }), el('strong', { text: `${shot.angle.toFixed(1)}°` })),
          toggle,
        ),
        el('p', { class: 'hint', text: `${BY_TEXT[shot.madeBy] || ''}；用了 ${shot.points.length} 個偵測點。` }),
        el(
          'div',
          { class: 'btn-row' },
          accepted
            ? el('span', { class: 'badge badge-ok', text: '已加入' })
            : el('button', { type: 'button', class: 'btn btn-primary', text: '接受', onclick: () => { accept(item); rerender(); } }),
          el('button', { type: 'button', class: 'btn', text: '修正', onclick: () => fix(item) }),
          el('button', { type: 'button', class: 'btn', text: '刪除', onclick: () => { remove(item); rerender(); } }),
        ),
      ),
    );
    drawThumb(canvas, shot, hoop);
    return li;
  }

  function accept(item) {
    if (item.state === 'accepted') return;
    const before = new Set(session.shots.map((x) => x.id));
    const added = S.addAutoShots(session, [{ ...item.shot, made: item.made }]);
    if (!added) {
      toast('這一球和已經記錄的球時間重疊，沒有加入');
      item.state = 'removed';
      return;
    }
    const fresh = session.shots.find((x) => !before.has(x.id));
    item.id = fresh ? fresh.id : null;
    item.state = 'accepted';
    app.onSessionChanged();
  }

  function remove(item) {
    if (item.state === 'accepted' && item.id != null) {
      S.deleteShot(session, item.id);
      app.onSessionChanged();
    }
    item.state = 'removed';
  }

  /** 修正：把這一球的偵測點拿到標記畫面，讓使用者調整後再存。 */
  function fix(item) {
    if (item.state !== 'accepted') accept(item);
    if (item.state !== 'accepted' || item.id == null) return;
    const first = item.shot.fStart;
    S.editShot(session, item.id);
    item.state = 'removed';
    app.go('work', { step: 'mark', frame: first, draftMade: item.made });
    toast('已把這一球的點放到畫面上：拖曳或重新點，調整好再按「儲存這球」');
  }

  function rerender() {
    const hoop = S.hoopFrame(session);
    const list = $('#auto-cards');
    clear(list);
    const visible = found.filter((x) => x.state !== 'removed');
    visible.forEach((item, i) => list.append(renderCard(item, i + 1, hoop)));
    const pendingCount = visible.filter((x) => x.state === 'pending').length;
    $('#auto-summary').textContent = visible.length ? `找到 ${visible.length} 球，請逐一確認` : '沒有留下任何一球';
    const all = $('#auto-accept-all');
    all.disabled = false;
    all.textContent = pendingCount ? `全部接受（${pendingCount} 球）` : '完成，回到標記';
  }

  async function showResults() {
    showOnly('results');
    const r = lastRun;
    $('#auto-stats').textContent =
      `${backendLabel(r.backend, r.threads)}，處理 ${r.frames} 幀、花了 ${r.seconds < 90 ? `${Math.round(r.seconds)} 秒` : `${(r.seconds / 60).toFixed(1)} 分鐘`}；` +
      `偵測到 ${r.detections} 個球的位置，其中 ${r.stats.static} 個是靜止不動的。`;
    if (!found.length) {
      showOnly('setup');
      const why = r.detections < 5
        ? '模型在這支影片裡幾乎沒有偵測到球。可能是球在畫面上太小、太模糊，或這個模型還不認得這種畫面。'
        : `模型偵測到 ${r.detections} 個球的位置，但沒有一組符合「最高點高於籃框、下降時靠近籃框」的投籃軌跡。請確認籃框校正是否正確。`;
      setError(`沒有找到投籃。${why}`);
      return;
    }
    rerender();
  }

  $('#auto-start').addEventListener('click', run);
  $('#auto-rerun').addEventListener('click', () => {
    showOnly('setup');
    setError(null);
  });
  $('#auto-cancel').addEventListener('click', () => {
    if (abort) abort.abort();
    $('#auto-stage').textContent = '取消中…';
  });
  $('#auto-back').addEventListener('click', () => {
    if (abort) abort.abort();
    app.go('work', { step: 'mark' });
  });
  $('#auto-accept-all').addEventListener('click', () => {
    for (const item of found) if (item.state === 'pending') accept(item);
    const n = found.filter((x) => x.state === 'accepted').length;
    app.go('work', { step: 'mark' });
    if (n) toast(`已加入 ${n} 球，可以直接看報告`);
  });

  return {
    async enter(nextSession, nextSource) {
      session = nextSession;
      source = nextSource;
      setError(null);
      await fillModels();
      if (!found.length || found.every((x) => x.state === 'removed')) showOnly('setup');
      else {
        showOnly('results');
        rerender();
      }
    },
    /** 換了一支影片：清掉上一次的結果。 */
    reset() {
      if (abort) abort.abort();
      found = [];
      lastRun = null;
      showOnly('setup');
      setError(null);
    },
    run,
  };
}
