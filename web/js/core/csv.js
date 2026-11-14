// CSV 匯出與匯入。格式固定三欄：球序, 入框角度, 是否進球
// 純函式，不碰 DOM。Python 對應檔：arclog/csvio.py（tools/analyze.py 輸出同一格式）

export const CSV_HEADER = ['球序', '入框角度', '是否進球'];

const YES = new Set(['是', '1', 'true', 'y', 'yes', '進', '進球', '有進', 'made', 'make', 'o', '○', '✓']);
const NO = new Set(['否', '0', 'false', 'n', 'no', '沒進', '未進', '不進', 'miss', 'missed', 'x', '✕', '×']);

/**
 * @param {{angle:number|null, made:boolean}[]} shots angle 是 null 時那一格留空
 * @returns {string} CSV 文字（不含 BOM；存檔時由呼叫端加上，Excel 才不會亂碼）
 */
export function shotsToCsv(shots) {
  const lines = [CSV_HEADER.join(',')];
  shots.forEach((s, i) => {
    // 鏡頭角度太偏時（自動模式的 C 級）沒有入框角度，這一格留空
    const a = s.angle == null ? '' : Number(s.angle).toFixed(1);
    lines.push(`${i + 1},${a},${s.made ? '是' : '否'}`);
  });
  return lines.join('\r\n') + '\r\n';
}

function splitLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// 數字只接受一般的十進位寫法（JS 的 Number() 和 Python 的 float() 對奇怪字串的判斷不一樣）
const NUM_RE = /^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)$/;
function toNumber(s) {
  return typeof s === 'string' && NUM_RE.test(s) ? Number(s) : NaN;
}

function parseMade(text) {
  const k = String(text).trim().toLowerCase();
  if (YES.has(k)) return true;
  if (NO.has(k)) return false;
  return null;
}

/**
 * 解析 CSV。盡量寬鬆：容許 BOM、不同換行、Tab 或分號分隔、英文表頭、沒有表頭。
 * @param {string} text
 * @returns {{shots:{angle:number, made:boolean}[], warnings:string[]}}
 */
export function parseCsv(text) {
  const warnings = [];
  let src = String(text);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const lines = src.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (!lines.length) return { shots: [], warnings: ['檔案是空的'] };

  const first = lines[0];
  const delim = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  let rows = lines.map((l) => splitLine(l, delim));

  // 表頭：第一列的角度欄不是數字就當作表頭
  let col = { order: 0, angle: 1, made: 2 };
  const head = rows[0];
  const looksNumeric = (s) => Number.isFinite(toNumber(s));
  const hasHeader = !head.some((c, i) => i <= 2 && looksNumeric(c));
  if (hasHeader) {
    const find = (re) => head.findIndex((h) => re.test(h));
    const a = find(/角度|angle|entry/i);
    const m = find(/進球|命中|made|make|result/i);
    const o = find(/球序|序|shot|#|no\.?$|index/i);
    if (a >= 0 && m >= 0) col = { order: o, angle: a, made: m };
    rows = rows.slice(1);
  }

  const parsed = [];
  rows.forEach((r, i) => {
    const lineNo = i + 1 + (hasHeader ? 1 : 0);
    const cell = r[col.angle];
    let angle = toNumber(cell);
    const made = parseMade(r[col.made] ?? '');
    const blank = typeof cell === 'string' && cell.trim() === '';
    if (blank) {
      angle = null; // 角度留空：這一球只有進或沒進（自動模式偏角太大時）
    } else if (!Number.isFinite(angle) || angle <= 0 || angle >= 90) {
      warnings.push(`第 ${lineNo} 列的入框角度看不懂，已略過`);
      return;
    }
    if (made === null) {
      warnings.push(`第 ${lineNo} 列的是否進球看不懂，已略過`);
      return;
    }
    const order = col.order >= 0 ? toNumber(r[col.order]) : NaN;
    parsed.push({ order: Number.isFinite(order) ? order : null, seq: i, angle, made });
  });

  if (parsed.length && parsed.every((p) => p.order !== null)) {
    parsed.sort((a, b) => a.order - b.order || a.seq - b.seq);
  }
  return { shots: parsed.map((p) => ({ angle: p.angle, made: p.made })), warnings };
}
