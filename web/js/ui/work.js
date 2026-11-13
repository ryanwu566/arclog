// 校正與標記的畫面：逐幀前進後退、時間軸、點籃框、點球心、每一球的清單。
// 資料的改動都在 session.js，這裡只負責把操作接起來並重畫。

import { $, $$, el, clear, show, toast, confirmDialog, download, fmtTime, safeName, madeMark } from './dom.js';
import { createFrameView } from './frame-view.js';
import * as S from './session.js';
import { toImage } from '../core/geometry.js';
import { sampleArc } from '../core/shot.js';
import { MIN_MANUAL_POINTS } from '../core/constants.js';
import { saveDraft as storeDraft, clearDraft as dropDraft } from './storage.js';

const ZONE_TEXT = {
  clean: '落點在框的中間，依位置判斷會進',
  rim: '落點靠近框緣，可能碰框，請看畫面確認',
  short: '落點偏短（在前緣之前），依位置判斷沒進',
  long: '落點偏長（超過後緣），依位置判斷沒進',
};

/**
 * @param {object} app 主程式提供的介面：{ go(view), onSessionChanged() }
 */
export function createWork(app) {
  const view = createFrameView({
    stage: $('#stage'),
    canvas: $('#stage-canvas'),
    loupe: $('#loupe'),
    onTap: (p) => onTap(p),
    onDrag: (id, p, done) => onDrag(id, p, done),
    onZoom: (z) => show($('#zoom-reset'), z > 1.01),
  });

  let session = null;
  let source = null;
  let step = 'calibrate';
  let index = 0; // 畫面上目前這一幀
  let target = 0; // 最後一次要求的幀（連按時用它累加）
  let busy = false;
  let pending = null;
  let draftMade = null; // 使用者對「正在標的這一球」選的進球與否；null = 還沒選，用建議值
  let noBallStart = null;
  let selectedShot = null;
  let framesCache = new Map(); // 球的 id → 每一幀的球心（疊圖用）

  // ── 逐幀定位 ──
  async function goto(i) {
    if (!source) return;
    target = Math.max(0, Math.min(source.frameCount - 1, Math.round(i)));
    pending = target;
    if (busy) return;
    busy = true;
    try {
      while (pending !== null) {
        const k = pending;
        pending = null;
        const fr = await source.getFrame(k);
        index = fr.index;
        view.setFrame(fr.image);
        updateTransport();
      }
    } catch (err) {
      const box = $('#stage-status');
      box.textContent = `這一幀讀不出來：${err.message || err}`;
      show(box, true);
    } finally {
      busy = false;
    }
  }

  function updateTransport() {
    $('#scrub').value = String(index);
    const t = source.frameTimes[index];
    $('#frame-label').textContent = `第 ${index + 1} / ${source.frameCount} 幀 · ${fmtTime(t)}`;
    show($('#stage-status'), false);
    refreshDraftPanel();
    view.render();
  }

  // 按住按鈕連續前進／後退
  for (const btn of $$('[data-jump]')) {
    const jump = Number(btn.dataset.jump);
    let timer = null;
    let repeat = null;
    const stop = () => {
      clearTimeout(timer);
      clearInterval(repeat);
      timer = repeat = null;
    };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      goto(target + jump);
      stop();
      timer = setTimeout(() => {
        repeat = setInterval(() => goto(target + jump), 80);
      }, 380);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) btn.addEventListener(type, stop);
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goto(target + jump);
      }
    });
  }
  $('#scrub').addEventListener('input', (e) => goto(Number(e.target.value)));
  $('#zoom-in').addEventListener('click', () => view.zoomBy(1.6));
  $('#zoom-out').addEventListener('click', () => view.zoomBy(1 / 1.6));
  $('#zoom-reset').addEventListener('click', () => view.resetZoom());

  document.addEventListener('keydown', (e) => {
    if (!session || $('#view-work').hidden) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === '.') {
      e.preventDefault();
      goto(target + (e.shiftKey ? 10 : 1));
    } else if (e.key === 'ArrowLeft' || e.key === ',') {
      e.preventDefault();
      goto(target - (e.shiftKey ? 10 : 1));
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      doUndo();
    }
  });

  // ── 點畫面 ──
  function onTap(p) {
    if (!session) return;
    if (step === 'calibrate') {
      const hp = session.hoopPoints;
      if (!hp.front) S.setHoopPoint(session, 'front', p);
      else if (!hp.back) S.setHoopPoint(session, 'back', p);
      else return; // 兩點都有了：要改就拖曳或按「重新點」
      changed();
    } else if (step === 'mark') {
      if (!S.hoopFrame(session)) {
        toast('請先完成籃框校正');
        return;
      }
      S.addDraftPoint(session, { frame: index, t: source.frameTimes[index], x: p.x, y: p.y });
      draftMade = null;
      changed();
      const adv = Number($('#auto-advance').value) || 0;
      if (adv > 0 && index + adv < source.frameCount) goto(index + adv);
    }
  }

  function onDrag(id, p, done) {
    if (!session) return;
    if (step === 'calibrate' && (id === 'front' || id === 'back')) {
      if (done) S.setHoopPoint(session, id, p);
      else session.hoopPoints = { ...session.hoopPoints, [id]: { x: p.x, y: p.y } };
    } else if (step === 'mark' && typeof id === 'number') {
      S.moveDraftPoint(session, id, p, done);
    }
    if (done) changed();
    else {
      refreshCalibratePanel();
      view.render();
    }
  }

  view.setHandles(() => {
    if (!session) return [];
    if (step === 'calibrate') {
      // 兩點都點好之後才能拖曳。手機上籃框的兩端只隔十幾個像素，
      // 如果第一個點可以拖，要點第二個點時會變成把第一個點拖走。
      const { front, back } = session.hoopPoints;
      if (!front || !back) return [];
      return [{ id: 'front', ...front }, { id: 'back', ...back }];
    }
    // 標記時只能拖「目前這一幀」的點，免得誤碰別幀的點
    return session.draft.filter((d) => d.frame === index).map((d) => ({ id: d.frame, x: d.x, y: d.y }));
  });

  // ── 疊圖 ──
  function strokeBoth(ctx, u, color, width) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = (width + 2.2) * u;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = width * u;
    ctx.stroke();
  }
  function dot(ctx, u, x, y, r, color) {
    ctx.beginPath();
    ctx.arc(x, y, (r + 1.6) * u, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.8)';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r * u, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
  function label(ctx, u, x, y, text) {
    ctx.font = `600 ${12 * u}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3 * u;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  }
  function drawCurve(ctx, u, hoop, analysis, uFrom, uTo, color, width) {
    const pts = sampleArc(analysis, uFrom, uTo, 56);
    ctx.beginPath();
    pts.forEach((q, i) => {
      const [x, y] = toImage(hoop, q.u, q.v);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    strokeBoth(ctx, u, color, width);
  }

  view.setOverlay((ctx, { u, loupe }) => {
    if (!session) return;
    const hp = session.hoopPoints;
    const hoop = S.hoopFrame(session);
    // 籃框
    if (hp.front && hp.back) {
      ctx.beginPath();
      ctx.moveTo(hp.front.x, hp.front.y);
      ctx.lineTo(hp.back.x, hp.back.y);
      strokeBoth(ctx, u, '#ffffff', step === 'calibrate' ? 2 : 1.4);
    }
    if (step === 'calibrate' || loupe) {
      // 兩個點在手機上靠得很近，所以文字各往外側擺，才不會疊在一起
      const frontOnLeft = !hp.back || !hp.front || hp.front.x <= hp.back.x;
      const put = (p, text, toLeft) => {
        dot(ctx, u, p.x, p.y, 5, '#ffd84a');
        if (loupe) return;
        ctx.textAlign = toLeft ? 'right' : 'left';
        label(ctx, u, p.x + (toLeft ? -10 : 10) * u, p.y - 13 * u, text);
        ctx.textAlign = 'left';
      };
      if (hp.front) put(hp.front, '前緣', frontOnLeft);
      if (hp.back) put(hp.back, '後緣', !frontOnLeft);
    }
    if (step !== 'mark' || !hoop) return;

    // 已經存好的球：目前這一幀在它的飛行範圍附近時，畫出軌跡
    for (const shot of session.shots) {
      if (!shot.points || !shot.points.length || !shot.analysis) continue;
      const f0 = shot.points[0].frame;
      const f1 = shot.points[shot.points.length - 1].frame;
      // 只在目前這一幀落在這球的飛行範圍附近時才畫，標下一球時畫面才不會亂
      if (index < f0 - 3 || index > f1 + 12) continue;
      const color = shot.made ? '#5aa2f0' : '#ff8a57';
      const us = shot.points.map((p) => ((p.x - hoop.ox) * hoop.ux + (p.y - hoop.oy) * hoop.uy) / hoop.len);
      const cross = shot.analysis.flip ? 1 - shot.crossS : shot.crossS;
      drawCurve(ctx, u, hoop, shot.analysis, shot.analysis.flip ? Math.max(...us) : Math.min(...us), cross, color, 1.6);
      for (const p of shot.points) dot(ctx, u, p.x, p.y, shot.source === 'auto' ? 2 : 3, color);
      drawPredicted(ctx, u, shot, hoop);
    }

    // 正在標的這一球
    const st = S.draftStatus(session);
    if (st.result) {
      const us = session.draft.map((p) => ((p.x - hoop.ox) * hoop.ux + (p.y - hoop.oy) * hoop.uy) / hoop.len);
      const cross = st.result.flip ? 1 - st.result.crossS : st.result.crossS;
      drawCurve(ctx, u, hoop, st.result, st.result.flip ? Math.max(...us) : Math.min(...us), cross, '#ffd84a', 2);
      const [cx, cy] = toImage(hoop, cross, 0);
      dot(ctx, u, cx, cy, 4, '#ffffff');
      drawPredicted(ctx, u, { points: session.draft, analysis: st.result, id: 'draft' }, hoop);
    }
    session.draft.forEach((p, i) => {
      const here = p.frame === index;
      dot(ctx, u, p.x, p.y, here ? 5.5 : 4, here ? '#ffd84a' : '#f2b705');
      if (!loupe) label(ctx, u, p.x + 8 * u, p.y - 10 * u, String(i + 1));
    });
  });

  /** 在目前這一幀，畫出「依擬合結果，球應該在這裡」的圓圈：圓圈套在球上就代表擬合和內插都對。 */
  function drawPredicted(ctx, u, shot, hoop) {
    if (!shot.points || shot.points.length < 2) return;
    const f0 = shot.points[0].frame;
    const f1 = shot.points[shot.points.length - 1].frame;
    if (index < f0 || index > f1) return;
    let frames = framesCache.get(shot.id);
    if (!frames || shot.id === 'draft') {
      frames = S.shotFrames(session, shot, source.frameTimes);
      if (shot.id !== 'draft') framesCache.set(shot.id, frames);
    }
    const fr = frames && frames.find((f) => f.frame === index);
    if (!fr) return;
    ctx.beginPath();
    ctx.arc(fr.x, fr.y, hoop.ballDiameterPx / 2, 0, Math.PI * 2);
    ctx.setLineDash([5 * u, 4 * u]);
    strokeBoth(ctx, u, '#ffffff', 1.3);
    ctx.setLineDash([]);
  }

  // ── 面板 ──
  function refreshCalibratePanel() {
    if (!session) return;
    const hp = session.hoopPoints;
    const hoop = S.hoopFrame(session);
    $('#cal-next').textContent = !hp.front
      ? '現在請點：籃框前緣（靠近投籃者）'
      : !hp.back
        ? '現在請點：籃框後緣（靠近籃板）'
        : hoop
          ? '兩點都點好了。位置不準可以直接拖曳調整。'
          : '兩點太接近了，請重新點。';
    show($('#cal-facts'), !!hoop);
    if (hoop) {
      $('#cal-width').textContent = `${Math.round(hoop.len)} 像素`;
      $('#cal-ball').textContent = `${Math.round(hoop.ballDiameterPx)} 像素`;
      const skew = S.hoopSkew(session);
      $('#cal-tilt').textContent =
        skew.level === 'persp'
          ? `${Math.abs(skew.raw).toFixed(1)}°（透視約 ${Math.abs(skew.persp).toFixed(1)}°，扣掉後剩 ${Math.abs(skew.residual).toFixed(1)}°）`
          : `${Math.abs(skew.raw).toFixed(1)}°`;
    }
    const box = $('#cal-warnings');
    clear(box);
    for (const w of S.hoopWarnings(session)) box.append(el('div', { class: 'notice notice-warn', text: w }));
    $('#cal-done').disabled = !hoop;
    for (const r of $$('input[name="level"]')) r.checked = r.value === session.level;
    view.setGuide(step === 'mark' && hoop ? hoop.ballDiameterPx : 0);
  }

  function refreshDraftPanel() {
    if (!session || step !== 'mark') return;
    const st = S.draftStatus(session);
    $('#draft-title').textContent = `第 ${session.shots.length + 1} 球`;
    $('#draft-count').textContent = st.count
      ? `已點 ${st.count} 個球心${st.count < MIN_MANUAL_POINTS ? `（至少 ${MIN_MANUAL_POINTS} 個）` : ''}`
      : '還沒有點';
    const note = $('#draft-note');
    note.textContent = '';
    show($('#draft-result'), !!st.result);
    if (st.result) {
      $('#draft-angle').textContent = `${st.result.angleDeg.toFixed(1)}°`;
      const made = draftMade == null ? st.result.made : draftMade;
      for (const b of $$('#draft-box .made-btn')) b.setAttribute('aria-checked', String((b.dataset.made === '1') === made));
      let text = ZONE_TEXT[st.result.zone] || '';
      if (!st.result.monotonic) text = '這幾個點的先後順序和水平位置對不上，請檢查有沒有點到別顆球。';
      note.textContent = `${text}${st.enough ? '' : `　再點 ${MIN_MANUAL_POINTS - st.count} 個就可以儲存。`}`;
    } else if (st.reason) {
      note.textContent = S.reasonText(st.reason);
    } else if (st.count > 0) {
      note.textContent = `再點 ${Math.max(1, 3 - st.count)} 個球心就會開始畫出軌跡。`;
    }
    $('#btn-save-shot').disabled = !(st.enough && st.result);
    $('#btn-clear-draft').disabled = st.count === 0;
    $('#btn-undo').disabled = session.undo.length === 0;
  }

  function refreshShotList() {
    if (!session) return;
    const list = $('#shot-list');
    clear(list);
    session.shots.forEach((shot, i) => {
      const jump = () => {
        selectedShot = shot.id;
        if (shot.points && shot.points.length) goto(shot.points[0].frame);
        refreshShotList();
      };
      const main = el(
        'button',
        { type: 'button', class: 'shot-main', onclick: jump, 'aria-label': `第 ${i + 1} 球，${shot.angle.toFixed(1)} 度，${shot.made ? '進球' : '沒進'}。按下跳到這一球。` },
        el('span', { class: 'shot-n', text: `#${i + 1}` }),
        el('span', { class: 'shot-angle', text: `${shot.angle.toFixed(1)}°` }),
        el('span', { class: 'shot-tag' }, madeMark(shot.made), shot.made ? '進球' : '沒進'),
        shot.source === 'auto' ? el('span', { class: 'badge', text: '自動' }) : null,
      );
      const actions = el(
        'div',
        { class: 'shot-actions' },
        el('button', {
          type: 'button', class: 'mini-btn', text: shot.made ? '改成沒進' : '改成進球',
          onclick: () => {
            S.setMade(session, shot.id, !shot.made);
            changed();
          },
        }),
        shot.points && shot.points.length
          ? el('button', {
              type: 'button', class: 'mini-btn', text: '重標',
              'aria-label': `重新調整第 ${i + 1} 球的點`,
              onclick: async () => {
                if (session.draft.length && !(await confirmDialog({ title: '重新標這一球？', message: '正在標的那一球還沒儲存，會被取代。', okText: '取代' }))) return;
                const first = shot.points[0].frame;
                S.editShot(session, shot.id);
                draftMade = shot.made;
                changed();
                goto(first);
              },
            })
          : null,
        el('button', {
          type: 'button', class: 'mini-btn', text: '刪除', 'aria-label': `刪除第 ${i + 1} 球`,
          onclick: () => {
            S.deleteShot(session, shot.id);
            changed();
            toast('已刪除，按「復原」可以拿回來');
          },
        }),
      );
      list.append(el('li', { class: `shot-row${shot.id === selectedShot ? ' current' : ''}` }, main, actions));
    });
    $('#shot-count').textContent = String(session.shots.length);
    $('#btn-to-report').disabled = session.shots.length === 0;
    $('#btn-export-bundle').disabled = !S.canExportBundle(session);
    $$('.step[data-step="report"]')[0].disabled = session.shots.length === 0;

    // 時間軸上的記號
    const marks = $('#scrub-marks');
    clear(marks);
    const n = Math.max(1, source.frameCount - 1);
    for (const shot of session.shots) {
      if (!shot.points || !shot.points.length) continue;
      const a = shot.points[0].frame / n;
      const b = shot.points[shot.points.length - 1].frame / n;
      marks.append(el('i', { class: shot.made ? '' : 'miss', style: `left:${(a * 100).toFixed(3)}%;width:${Math.max(0.3, (b - a) * 100).toFixed(3)}%` }));
    }
    for (const r of session.noBall) {
      marks.append(el('i', { class: 'noball', style: `left:${((r.from / n) * 100).toFixed(3)}%;width:${Math.max(0.3, ((r.to - r.from) / n) * 100).toFixed(3)}%` }));
    }

    const nb = $('#noball-list');
    clear(nb);
    session.noBall.forEach((r, i) => {
      nb.append(
        el(
          'li',
          { class: 'shot-row' },
          el('span', { class: 'shot-n', text: '無球' }),
          el('button', { type: 'button', class: 'shot-main', text: `第 ${r.from + 1}–${r.to + 1} 幀`, onclick: () => goto(r.from) }),
          el('button', {
            type: 'button', class: 'mini-btn', text: '刪除',
            onclick: () => {
              S.removeNoBall(session, i);
              changed();
            },
          }),
        ),
      );
    });
  }

  /** 資料改動之後：重畫、更新面板、存草稿。 */
  function changed() {
    framesCache = new Map();
    refreshCalibratePanel();
    refreshDraftPanel();
    refreshShotList();
    view.render();
    if (session.mode === 'video') {
      if (S.hasContent(session)) {
        const res = storeDraft(S.serializeDraft(session));
        if (!res.ok && !changed.warned) {
          changed.warned = true;
          toast('這台裝置的儲存空間寫不進去，重新整理後標記不會保留');
        }
      } else dropDraft(S.draftKey(session.info));
    }
    app.onSessionChanged();
  }

  function doUndo() {
    if (!session) return;
    if (S.undo(session)) {
      draftMade = null;
      changed();
    } else toast('沒有可以復原的步驟');
  }

  function setStep(next) {
    if (next === 'report') {
      if (!session.shots.length) return;
      app.go('report');
      return;
    }
    if (next === 'mark' && !S.hoopFrame(session)) {
      toast('請先點好籃框的前緣和後緣');
      return;
    }
    step = next;
    for (const b of $$('.step')) {
      if (b.dataset.step === step) b.setAttribute('aria-current', 'step');
      else b.removeAttribute('aria-current');
    }
    show($('#panel-calibrate'), step === 'calibrate');
    show($('#panel-mark'), step === 'mark');
    $('#stage-canvas').setAttribute('aria-label', step === 'calibrate' ? '影片畫面。點籃框的前緣和後緣。' : '影片畫面。在球心上點一下可以標記。');
    changed();
  }

  // ── 按鈕 ──
  for (const b of $$('.step')) b.addEventListener('click', () => setStep(b.dataset.step));
  $('#cal-done').addEventListener('click', () => setStep('mark'));
  $('#cal-reset').addEventListener('click', () => {
    S.resetHoop(session);
    changed();
  });
  $('#cal-demo').addEventListener('click', () => {
    if (!source.hoopTruth) return;
    S.setHoopPoint(session, 'front', source.hoopTruth.front);
    S.setHoopPoint(session, 'back', source.hoopTruth.back);
    changed();
  });
  for (const r of $$('input[name="level"]')) {
    r.addEventListener('change', () => {
      if (r.checked) {
        S.setLevel(session, r.value);
        changed();
      }
    });
  }
  for (const b of $$('#draft-box .made-btn')) {
    b.addEventListener('click', () => {
      draftMade = b.dataset.made === '1';
      refreshDraftPanel();
    });
  }
  $('#btn-undo').addEventListener('click', doUndo);
  $('#btn-clear-draft').addEventListener('click', () => {
    S.clearDraft(session);
    draftMade = null;
    changed();
  });
  $('#btn-save-shot').addEventListener('click', () => {
    const res = S.saveDraftShot(session, draftMade);
    if (!res.ok) {
      toast(S.reasonText(res.reason));
      return;
    }
    draftMade = null;
    selectedShot = res.shot.id;
    changed();
    toast(`第 ${session.shots.findIndex((x) => x.id === res.shot.id) + 1} 球已儲存：${res.shot.angle.toFixed(1)}°，${res.shot.made ? '進球' : '沒進'}`);
  });
  $('#btn-to-report').addEventListener('click', () => app.go('report'));
  $('#btn-auto').addEventListener('click', () => app.go('auto'));
  $('#noball-start').addEventListener('click', () => {
    noBallStart = index;
    $('#noball-end').disabled = false;
    toast(`從第 ${index + 1} 幀開始；移到這段的最後一幀再按「到這一幀結束」`);
  });
  $('#noball-end').addEventListener('click', () => {
    if (noBallStart == null) return;
    S.addNoBall(session, noBallStart, index);
    noBallStart = null;
    $('#noball-end').disabled = true;
    changed();
  });
  $('#btn-export-bundle').addEventListener('click', () => exportBundle());

  function exportBundle() {
    const bundle = S.sessionBundle(session, source.frameTimes);
    if (!bundle || !bundle.shots.length) {
      toast('還沒有可以匯出的標記');
      return false;
    }
    const base = safeName(String(session.info.name).replace(/\.[^.]+$/, '')) || 'arclog';
    download(`${base}.arclog.json`, JSON.stringify(bundle), 'application/json');
    toast(`已匯出標註包：${bundle.shots.length} 球`);
    return true;
  }

  return {
    /** 開始處理一個來源（影片或示範）。 */
    open(nextSession, nextSource, opts = {}) {
      session = nextSession;
      source = nextSource;
      index = target = 0;
      draftMade = null;
      selectedShot = null;
      noBallStart = null;
      framesCache = new Map();
      view.setSize(source.width, source.height);
      const scrub = $('#scrub');
      scrub.max = String(source.frameCount - 1);
      scrub.value = '0';
      // 點完自動前進幾幀：預設大約 1/6 秒，一球點 5、6 下剛好走完
      const sel = $('#auto-advance');
      clear(sel);
      const base = Math.max(1, Math.round(source.fps / 6));
      const choices = [...new Set([0, 1, Math.max(1, Math.round(base / 2)), base, base * 2])].sort((a, b) => a - b);
      for (const v of choices) sel.append(el('option', { value: String(v), text: v === 0 ? '不前進' : `${v} 幀` }));
      sel.value = String(base);
      show($('#cal-demo'), !!source.hoopTruth);
      const warn = $('#work-warnings');
      clear(warn);
      for (const w of source.warnings || []) warn.append(el('div', { class: 'notice', text: w }));
      if (source.width < source.height) warn.append(el('div', { class: 'notice notice-warn', text: '這支影片是直的。建議橫向拍攝，球和籃框在畫面上會比較大、角度比較準。' }));
      step = opts.step === 'mark' && S.hoopFrame(session) ? 'mark' : 'calibrate';
      setStep(step);
      return goto(opts.frame || 0);
    },
    close() {
      session = null;
      source = null;
    },
    /** 從別的畫面回來時重畫（例如自動偵測加了球）。 */
    refresh(opts = {}) {
      if (!session) return;
      if (opts.step) setStep(opts.step);
      else changed();
      view.resize();
      if (opts.frame != null) goto(opts.frame);
    },
    setDraftMade(v) {
      draftMade = v;
      refreshDraftPanel();
    },
    exportBundle,
    goto,
    get index() {
      return index;
    },
    get step() {
      return step;
    },
    view,
  };
}
