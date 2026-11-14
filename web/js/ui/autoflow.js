// 自動分析的畫面：上傳的影片、示範、錄完補分析都走這裡。
//   載入偵測模型 → （模型沒有籃框類別時，請使用者點兩下籃框）→ 逐幀偵測 → 自動校正、判斷鏡頭角度、分球 → 報告
// 任何一步失敗都要說清楚原因，並給「改用手動標記」的出路，不能卡住。

import { $, show, clear, el, toast } from './dom.js';
import * as S from './session.js';
import { createDetector, loadManifest } from '../detect/client.js';
import { createSimulatedDetector } from '../detect/simulated.js';
import { scanSource, strideFor, detectorHasRim, analyze, shotsFromResult, autoSummary } from './pipeline.js';

const fmtTime = (s) => (!Number.isFinite(s) ? '' : s < 60 ? `${Math.max(1, Math.ceil(s))} 秒` : `${Math.ceil(s / 60)} 分鐘`);

/** 給使用者看的失敗原因。 */
export function reasonText(reason) {
  switch (reason) {
    case 'no_rim':
      return '畫面裡找不到籃框。';
    case 'rim_unstable':
      return '籃框的位置一直在變（手機可能在動，或籃框被擋住了）。';
    case 'no_hoop':
      return '籃框的位置不對，建立不了座標。';
    default:
      return '分析失敗。';
  }
}

export function createAutoFlow(app) {
  let abort = null;
  let manifest = null;

  function stage(text, detail = '') {
    $('#analyze-stage').textContent = text;
    $('#analyze-detail').textContent = detail;
  }
  function setError(text, actions = []) {
    const box = $('#analyze-error');
    clear(box);
    show(box, !!text);
    show($('#analyze-progress'), !text);
    if (!text) return;
    box.append(el('p', { text }));
    box.append(el('div', { class: 'btn-row' }, ...actions.map(([label, fn, primary]) => el('button', { type: 'button', class: `btn${primary ? ' btn-primary' : ''}`, text: label, onclick: fn }))));
  }

  /** 選模型：網址 ?model=<id> 可以指定，否則用清單的預設。 */
  async function pickModel() {
    if (!manifest) manifest = await loadManifest();
    const want = new URLSearchParams(location.search).get('model');
    return manifest.models.find((m) => m.id === want) || manifest.models.find((m) => m.id === manifest.default) || manifest.models[0];
  }

  /** 示範的合成畫面用模擬偵測器（網址加 ?simdet=0 改用真的模型，測試用）。 */
  async function getDetector(source, signal) {
    if (source.synthetic3d && new URLSearchParams(location.search).get('simdet') !== '0') return createSimulatedDetector(source.plan3d);
    const model = await pickModel();
    const bar = $('#analyze-bar');
    const det = await createDetector({
      model,
      forceWasm: new URLSearchParams(location.search).get('backend') === 'wasm',
      onProgress: (p) => {
        if (signal.aborted) return;
        if (p.stage === 'download' && p.total) {
          bar.max = p.total;
          bar.value = p.loaded;
          stage(`下載偵測模型… ${(p.loaded / 1e6).toFixed(1)} / ${(p.total / 1e6).toFixed(1)} MB`, '第一次使用要下載，之後會快很多。');
        } else {
          bar.removeAttribute('value');
          stage('載入偵測模型…');
        }
      },
    });
    det.modelId = model.id;
    det.rimBox = model.rimBox || 'rim';
    return det;
  }

  /**
   * 分析一個影格來源。
   * @param {object} source FrameSource
   * @param {object} session
   * @param {{liveDets?:object[], liveStride?:number, title?:string, hoopPoints?:object}} [opts]
   *   liveDets：錄影時已經即時偵測過的結果（夠密的話就不重新掃整支影片）
   */
  async function run(source, session, opts = {}) {
    if (abort) abort.abort();
    abort = new AbortController();
    const signal = abort.signal;
    app.go('analyze');
    $('#analyze-title').textContent = opts.title || '分析中';
    setError(null);
    const bar = $('#analyze-bar');
    bar.removeAttribute('value');
    stage('準備中…');

    let detector = opts.detector || null;
    try {
      if (!detector) detector = await getDetector(source, signal);
    } catch (err) {
      setError(`偵測模型載入失敗：${err.message || err}。這次沒辦法自動分析。`, [
        ['改用手動標記', () => app.openManual(session, source), true],
        ['再試一次', () => run(source, session, opts)],
      ]);
      return null;
    }
    if (signal.aborted) return null;

    // 模型找不到籃框：先請使用者點兩下（之後的偵測和分析照樣自動）
    let hoopPoints = opts.hoopPoints || null;
    if (!hoopPoints && !detectorHasRim(detector)) {
      stage('這個偵測模型還不會找籃框，請在畫面上點兩下籃框。');
      hoopPoints = await app.askHoopTaps(session, source, '目前的偵測模型還不會自動找籃框（要等三類別模型訓練好）。請在畫面上點籃框的前緣和後緣，其他步驟會自動完成。');
      if (!hoopPoints) {
        app.go('home');
        return null;
      }
      app.go('analyze');
    }

    // 逐幀偵測（錄影時即時偵測夠密，就不用再掃）
    let dets = opts.liveDets || null;
    if (!dets) {
      const stride = strideFor(source.fps, 20);
      stage('逐幀偵測中…');
      let scan;
      try {
        scan = await scanSource({
          source,
          detector,
          stride,
          signal,
          onProgress: ({ done, total, rate, left }) => {
            bar.max = total;
            bar.value = done;
            stage(`逐幀偵測中… ${done} / ${total} 幀`, `${detector.backend === 'simulated' ? '模擬偵測器（示範用）' : detector.backend === 'webgpu' ? 'WebGPU' : 'WASM'}，每秒約 ${rate.toFixed(1)} 幀${done > 5 ? `，大約還要 ${fmtTime(left)}` : ''}。請讓這個頁面保持在前景。`);
          },
        });
      } catch (err) {
        if (!opts.detector) detector.dispose();
        if (signal.aborted) return null;
        setError(`偵測到一半失敗了：${err.message || err}。`, [
          ['改用手動標記', () => app.openManual(session, source), true],
          ['再試一次', () => run(source, session, opts)],
        ]);
        return null;
      }
      if (scan.cancelled || signal.aborted) {
        if (!opts.detector) detector.dispose();
        return null;
      }
      dets = scan.dets;
      session.autoRun = { frames: scan.frames, seconds: scan.seconds, msPerFrame: scan.msPerFrame, backend: detector.backend, model: detector.modelId || 'simulated' };
    }
    if (!opts.detector) detector.dispose();

    stage('自動找籃框、判斷鏡頭角度、分球…');
    await new Promise((r) => setTimeout(r, 0));
    let res = analyze(dets, source, { hoopPoints, rimBox: detector.rimBox, drag: session.drag });
    if (!res.ok && (res.reason === 'no_rim' || res.reason === 'rim_unstable' || res.reason === 'no_hoop')) {
      // 有籃框類別但這次找不到：退回點兩下
      const pts = await app.askHoopTaps(session, source, `${reasonText(res.reason)}請在畫面上點籃框的前緣和後緣，其他步驟會自動完成。`);
      if (!pts) {
        app.go('home');
        return null;
      }
      hoopPoints = pts;
      app.go('analyze');
      res = analyze(dets, source, { hoopPoints, rimBox: detector.rimBox, drag: session.drag });
    }
    window.__arclogLastAnalysis = res;
    if (!res.ok) {
      setError(`${reasonText(res.reason)}可以改用手動標記。`, [['改用手動標記', () => app.openManual(session, source), true]]);
      return null;
    }
    S.setAutoResult(session, shotsFromResult(res), autoSummary(res, { hoopFromTaps: !!hoopPoints, detections: dets.length, rimBox: res.cal && res.cal.rim ? res.cal.rim.box : null, gaps: session.gaps || [] }), res.points);
    session.liveDets = dets; // 修正時重新分析用
    if (!res.shots.length) {
      setError('沒有找到投籃。可能是球太小、太模糊，或鏡頭沒拍到整條弧線和籃框。', [
        ['改用手動標記', () => app.openManual(session, source), true],
        ['回首頁', () => app.go('home')],
      ]);
      return res;
    }
    toast(`找到 ${res.shots.length} 球`);
    app.go('report');
    return res;
  }

  $('#analyze-cancel').addEventListener('click', () => {
    if (abort) abort.abort();
    toast('已取消');
    app.go('home');
  });

  return {
    run,
    cancel() {
      if (abort) abort.abort();
    },
  };
}
