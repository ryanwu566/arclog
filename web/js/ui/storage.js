// 本機儲存。所有讀寫都包在 try/catch 裡：
// 無痕模式、空間滿了、瀏覽器擋掉儲存的時候，頁面照樣可以用，只是資料留不到下次。

import { parseStored } from '../core/history.js';

const KEY_HISTORY = 'arclog.history.v1';
const KEY_DRAFT = 'arclog.draft.v1';
const KEY_PREFS = 'arclog.prefs.v1';

/**
 * @param {Storage|null} storage 通常是 window.localStorage；拿不到就傳 null
 */
export function createStore(storage) {
  const memory = new Map();
  let persistent = false;
  if (storage) {
    try {
      const probe = '__arclog_probe__';
      storage.setItem(probe, '1');
      storage.removeItem(probe);
      persistent = true;
    } catch {
      persistent = false;
    }
  }
  return {
    /** 資料會不會留到下次開啟。 */
    get persistent() {
      return persistent;
    },
    get(key) {
      if (memory.has(key)) return memory.get(key);
      if (!persistent) return null;
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    /** @returns {{ok:boolean, persisted:boolean, error:string|null}} */
    set(key, value) {
      if (persistent) {
        try {
          storage.setItem(key, value);
          memory.delete(key);
          return { ok: true, persisted: true, error: null };
        } catch (err) {
          // 寫不進去（多半是空間滿了）：先留在記憶體裡，這次開著的時候還看得到
          memory.set(key, value);
          return { ok: false, persisted: false, error: String(err && err.name ? err.name : err) };
        }
      }
      memory.set(key, value);
      return { ok: true, persisted: false, error: null };
    },
    remove(key) {
      memory.delete(key);
      if (!persistent) return;
      try {
        storage.removeItem(key);
      } catch {
        /* 刪不掉就算了 */
      }
    },
  };
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null; // 有些瀏覽器在擋掉 Cookie 時，連讀取 localStorage 這個屬性都會丟例外
  }
}

export const store = createStore(typeof window !== 'undefined' ? browserStorage() : null);

export function loadHistory(s = store) {
  const parsed = parseStored(s.get(KEY_HISTORY));
  return { ...parsed, persistent: s.persistent };
}

export function saveHistory(list, s = store) {
  return s.set(KEY_HISTORY, JSON.stringify(list));
}

// ── 還沒完成的標記（避免不小心重新整理就全部不見）──
// 依影片分開存，保留最近 4 支；key 由檔名、大小、幀數、解析度組成。
const DRAFT_KEEP = 4;

function readDrafts(s) {
  try {
    const d = JSON.parse(s.get(KEY_DRAFT) || 'null');
    return d && Array.isArray(d.drafts) ? d.drafts.filter((x) => x && typeof x === 'object' && x.key) : [];
  } catch {
    return [];
  }
}

export function loadDraft(key, s = store) {
  return readDrafts(s).find((d) => d.key === key) || null;
}

export function saveDraft(draft, s = store) {
  const rest = readDrafts(s).filter((d) => d.key !== draft.key);
  return s.set(KEY_DRAFT, JSON.stringify({ drafts: [draft, ...rest].slice(0, DRAFT_KEEP) }));
}

export function clearDraft(key, s = store) {
  const rest = readDrafts(s).filter((d) => d.key !== key);
  if (rest.length) s.set(KEY_DRAFT, JSON.stringify({ drafts: rest }));
  else s.remove(KEY_DRAFT);
}

export function loadPrefs(s = store) {
  try {
    const p = JSON.parse(s.get(KEY_PREFS) || '{}');
    return p && typeof p === 'object' ? p : {};
  } catch {
    return {};
  }
}
export function savePrefs(prefs, s = store) {
  return s.set(KEY_PREFS, JSON.stringify(prefs));
}
