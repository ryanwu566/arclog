// 畫面用的小工具。使用者或檔案提供的文字一律用 textContent 放進頁面，不用 innerHTML。

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * 建立元素。attrs 的 class、text、dataset、on* 有特別處理，其餘當成屬性。
 * children 可以是元素或字串（字串會變成文字節點）。
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function show(node, on = true) {
  node.hidden = !on;
}

let toastTimer = null;
/** 畫面下方短暫出現的訊息。 */
export function toast(message, ms = 3200) {
  const box = $('#toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, ms);
}

/** 確認對話框。回傳 Promise<boolean>。 */
export function confirmDialog({ title, message, okText = '確定', cancelText = '取消', danger = false }) {
  const dlg = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-text').textContent = message;
  const ok = $('#dialog-ok');
  ok.textContent = okText;
  ok.classList.toggle('btn-danger', danger);
  ok.classList.toggle('btn-primary', !danger);
  $('#dialog-cancel').textContent = cancelText;
  if (typeof dlg.showModal !== 'function') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) => {
    dlg.returnValue = 'cancel';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

/** 下載一個檔案（Blob 或文字）。 */
export function download(filename, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  // 讓測試和除錯看得到最後匯出了什麼
  window.__arclogLastDownload = { filename, size: blob.size, type: blob.type, blob };
}

export function readFileText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/** 秒 → 「1:23.45」 */
export function fmtTime(sec) {
  if (!Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/** 檔名裡不能用的字換掉。 */
export function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

/** 小小的進球／沒進記號（和圖表一致：實心圓＝進球、叉＝沒進）。 */
export function madeMark(made) {
  return el('span', { class: `mk ${made ? 'mk-make' : 'mk-miss'}`, 'aria-hidden': 'true' });
}
