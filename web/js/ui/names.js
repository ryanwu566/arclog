// 給使用者看的影片名稱。純函式，不碰 DOM（可以在 Node 裡測試）。

/**
 * 標題列顯示的名稱。iPhone 給的檔名常常是 IMG_1234.MOV、一長串英數字（UUID）或 trim.xxxx，
 * 對使用者沒有意義、又很長：這種就顯示「影片」加日期時間。其他名稱太長時截短。
 * @param {{name?:string}|null} info
 * @param {Date} [when] 影片的時間（檔案的修改時間）
 */
export function displayName(info, when) {
  const name = info && info.name ? String(info.name) : '';
  const base = name.replace(/\.[^.]+$/, '');
  const junk =
    !base ||
    /^(IMG|VID|MOV|PXL|RPReplay|trim|video|FullSizeRender)([_\-. ]?[\w-]*)?$/i.test(base) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(base) ||
    /^[0-9A-F]{12,}$/i.test(base.replace(/[-_]/g, ''));
  if (!junk) return base.length > 28 ? `${base.slice(0, 26)}…` : base;
  if (when instanceof Date && !Number.isNaN(when.getTime())) {
    const p = (n) => String(n).padStart(2, '0');
    return `影片 ${when.getMonth() + 1}/${when.getDate()} ${p(when.getHours())}:${p(when.getMinutes())}`;
  }
  return '影片';
}
