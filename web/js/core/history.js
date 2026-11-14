// 歷次紀錄：一次練習存成一筆，資料只放在使用者自己的瀏覽器裡。
// 這個檔案是純函式（不碰 localStorage，也不碰 DOM），實際讀寫在 web/js/ui/storage.js。

import { summarize } from './stats.js';

export const HISTORY_FORMAT = 'arclog-history';
export const HISTORY_VERSION = 1;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 今天的日期（使用者當地時間）YYYY-MM-DD。 */
export function todayString(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** 檢查一筆紀錄；回傳整理過的紀錄，格式不對回傳 null。 */
export function normalizeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  if (typeof r.id !== 'string' || !r.id) return null;
  if (!Array.isArray(r.shots)) return null;
  const shots = [];
  for (const s of r.shots) {
    if (!s || typeof s.made !== 'boolean') return null;
    // 角度可以是 null：自動模式偏角太大（C 級）時只記進或沒進
    if (s.angle === null) {
      shots.push({ angle: null, made: s.made });
      continue;
    }
    const a = Number(s.angle);
    if (!Number.isFinite(a) || a <= 0 || a >= 90) return null;
    shots.push({ angle: a, made: s.made });
  }
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id: r.id.slice(0, 80),
    savedAt: typeof r.savedAt === 'string' && !Number.isNaN(Date.parse(r.savedAt)) ? r.savedAt : new Date(0).toISOString(),
    date: typeof r.date === 'string' && DATE_RE.test(r.date) ? r.date : '1970-01-01',
    player: str(r.player, 40),
    note: str(r.note, 200),
    videoName: str(r.videoName, 200),
    source: ['manual', 'auto', 'mixed', 'csv'].includes(r.source) ? r.source : 'manual',
    shots,
  };
}

/**
 * 由目前的練習建立一筆紀錄。
 * @param {{id:string, player?:string, date?:string, note?:string, videoName?:string,
 *          shots:{angle:number, made:boolean, source?:string}[]}} session
 */
export function makeRecord(session, now = new Date()) {
  const kinds = new Set(session.shots.map((s) => s.source || 'manual'));
  let source = 'manual';
  if (kinds.size === 1) source = [...kinds][0] === 'auto' ? 'auto' : [...kinds][0] === 'csv' ? 'csv' : 'manual';
  else if (kinds.size > 1) source = 'mixed';
  return normalizeRecord({
    id: session.id,
    savedAt: now.toISOString(),
    date: session.date || todayString(now),
    player: session.player || '',
    note: session.note || '',
    videoName: session.videoName || '',
    source,
    shots: session.shots.map((s) => ({ angle: s.angle, made: !!s.made })),
  });
}

/** 新增或更新一筆（依 id）。回傳新的陣列，不改動原本的。 */
export function upsertRecord(list, record) {
  const out = list.filter((r) => r.id !== record.id);
  out.push(record);
  return sortRecords(out);
}

export function removeRecord(list, id) {
  return list.filter((r) => r.id !== id);
}

/** 依練習日期（新到舊）排序；同一天的依儲存時間。 */
export function sortRecords(list) {
  return list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}

/** 紀錄裡出現過的球員姓名（不含空白），依字母排序。 */
export function playerNames(list) {
  return [...new Set(list.map((r) => r.player).filter((p) => p))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

/**
 * 趨勢圖用的資料：每次練習一個點，由舊到新。
 * @param {object[]} list
 * @param {{player?: string|null}} [opts] player 有給就只看那個人；空字串代表「沒填姓名」的紀錄
 */
export function trendPoints(list, opts = {}) {
  const want = opts.player;
  const rows = list.filter((r) => (want == null ? true : r.player === want) && r.shots.length > 0);
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.savedAt < b.savedAt ? -1 : a.savedAt > b.savedAt ? 1 : 0));
  return rows.map((r) => {
    const s = summarize(r.shots);
    return { id: r.id, date: r.date, player: r.player, attempts: s.attempts, makes: s.makes, pct: s.pct, angleMean: s.angleMean, angleStd: s.angleStd };
  });
}

/** 匯出備份用的物件。 */
export function exportBackup(list, now = new Date()) {
  return {
    format: HISTORY_FORMAT,
    version: HISTORY_VERSION,
    exportedAt: now.toISOString(),
    sessions: sortRecords(list),
  };
}

/**
 * 匯入備份，和現有的紀錄合併：同一個 id 留儲存時間比較新的那一筆。
 * @returns {{list:object[], added:number, updated:number, unchanged:number, invalid:number, error:string|null}}
 */
export function importBackup(data, existing) {
  const res = { list: existing, added: 0, updated: 0, unchanged: 0, invalid: 0, error: null };
  if (!data || typeof data !== 'object' || data.format !== HISTORY_FORMAT) {
    res.error = '這不是 ArcLog 的備份檔';
    return res;
  }
  if (data.version !== HISTORY_VERSION) {
    res.error = `不支援的備份版本：${data.version}`;
    return res;
  }
  if (!Array.isArray(data.sessions)) {
    res.error = '備份檔裡沒有紀錄';
    return res;
  }
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const raw of data.sessions) {
    const rec = normalizeRecord(raw);
    if (!rec) {
      res.invalid++;
      continue;
    }
    const cur = byId.get(rec.id);
    if (!cur) {
      byId.set(rec.id, rec);
      res.added++;
    } else if (rec.savedAt > cur.savedAt) {
      byId.set(rec.id, rec);
      res.updated++;
    } else res.unchanged++;
  }
  res.list = sortRecords([...byId.values()]);
  return res;
}

/** 讀取存檔內容（可能是壞掉的 JSON 或舊格式）；壞掉的單筆會被略過。 */
export function parseStored(text) {
  if (!text) return { list: [], dropped: 0 };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { list: [], dropped: 0, corrupt: true };
  }
  const arr = Array.isArray(data) ? data : data && Array.isArray(data.sessions) ? data.sessions : null;
  if (!arr) return { list: [], dropped: 0, corrupt: true };
  const list = [];
  let dropped = 0;
  for (const raw of arr) {
    const rec = normalizeRecord(raw);
    if (rec) list.push(rec);
    else dropped++;
  }
  return { list: sortRecords(list), dropped };
}
