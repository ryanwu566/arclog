// 錄影的暫存：MediaRecorder 每秒給一段，馬上寫進 IndexedDB（不是放在記憶體裡）。
// 分析失敗、頁面當掉、重新整理之後，影片都還在這台裝置上，首頁可以重新分析或下載。
// 影片只存在這台裝置的瀏覽器裡，不會上傳。
//
// IndexedDB 不能用（無痕模式、空間滿了、被設定擋住）時改存在記憶體：錄影還是可以分析，
// 但頁面關掉就沒了，畫面會提醒。

const DB_NAME = 'arclog-recordings';
const DB_VERSION = 1;

let dbPromise = null;
const memory = { recs: new Map(), chunks: new Map() };
let usingMemory = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') throw new Error('no indexedDB');
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('recs')) db.createObjectStore('recs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['id', 'seq'] });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        usingMemory = true;
        resolve(null);
      };
      req.onblocked = () => {
        usingMemory = true;
        resolve(null);
      };
    } catch {
      usingMemory = true;
      resolve(null);
    }
  });
  return dbPromise;
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error || new Error('IndexedDB 寫入失敗'));
    t.onabort = () => reject(t.error || new Error('IndexedDB 寫入被中止（空間可能不夠）'));
    out = fn(t);
  });
}

function reqValue(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** 目前是不是只能存在記憶體裡（頁面關掉就沒了）。 */
export async function isVolatile() {
  await openDb();
  return usingMemory;
}

/** 開始一段錄影。回傳 id。 */
export async function createRecording(meta) {
  const id = `rec-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const rec = { id, createdAt: new Date().toISOString(), status: 'recording', seconds: 0, chunks: 0, bytes: 0, ...meta };
  const db = await openDb();
  if (!db) {
    memory.recs.set(id, rec);
    return id;
  }
  try {
    await tx(db, ['recs'], 'readwrite', (t) => t.objectStore('recs').put(rec));
  } catch {
    usingMemory = true;
    memory.recs.set(id, rec);
  }
  return id;
}

/** 寫入一段（依序號）。寫不進去時改存記憶體，並回傳 false 讓畫面提醒。 */
export async function appendChunk(id, seq, blob) {
  const db = await openDb();
  if (!db || memory.recs.has(id)) {
    memory.chunks.set(`${id}:${seq}`, blob);
    const r = memory.recs.get(id);
    if (r) {
      r.chunks = Math.max(r.chunks, seq + 1);
      r.bytes += blob.size;
    }
    return !db ? false : true;
  }
  try {
    await tx(db, ['chunks', 'recs'], 'readwrite', (t) => {
      t.objectStore('chunks').put({ id, seq, blob });
      const rs = t.objectStore('recs');
      const g = rs.get(id);
      g.onsuccess = () => {
        const r = g.result;
        if (r) {
          r.chunks = Math.max(r.chunks || 0, seq + 1);
          r.bytes = (r.bytes || 0) + blob.size;
          rs.put(r);
        }
      };
    });
    return true;
  } catch {
    memory.chunks.set(`${id}:${seq}`, blob);
    return false;
  }
}

/** 更新錄影的資訊（長度、狀態：'recording'、'recorded'、'done'、'failed'）。 */
export async function updateRecording(id, patch) {
  const db = await openDb();
  if (!db || memory.recs.has(id)) {
    const r = memory.recs.get(id);
    if (r) Object.assign(r, patch);
    return;
  }
  await tx(db, ['recs'], 'readwrite', (t) => {
    const rs = t.objectStore('recs');
    const g = rs.get(id);
    g.onsuccess = () => {
      if (g.result) rs.put({ ...g.result, ...patch });
    };
  });
}

/** 整段錄影接回一個 Blob。 */
export async function getRecordingBlob(id) {
  const db = await openDb();
  let rec;
  const parts = [];
  if (!db || memory.recs.has(id)) {
    rec = memory.recs.get(id);
    for (let i = 0; i < (rec ? rec.chunks : 0); i++) {
      const b = memory.chunks.get(`${id}:${i}`);
      if (b) parts.push(b);
    }
  } else {
    rec = await tx(db, ['recs'], 'readonly', (t) => reqValue(t.objectStore('recs').get(id))).then((p) => p);
    const all = await new Promise((resolve, reject) => {
      const t = db.transaction(['chunks'], 'readonly');
      const range = IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
      const r = t.objectStore('chunks').getAll(range);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    all.sort((a, b) => a.seq - b.seq);
    for (const c of all) parts.push(c.blob);
    // 寫進 IndexedDB 失敗、暫存在記憶體的那幾段也要接回來
    for (let i = 0; i < (rec ? rec.chunks : 0); i++) {
      const b = memory.chunks.get(`${id}:${i}`);
      if (b && !all.some((c) => c.seq === i)) parts.splice(i, 0, b);
    }
  }
  if (!rec) return null;
  return { blob: new Blob(parts, { type: rec.mime || 'video/webm' }), rec };
}

/** 所有錄影的資訊（新的在前）。 */
export async function listRecordings() {
  const db = await openDb();
  let list = [...memory.recs.values()];
  if (db) {
    try {
      const fromDb = await new Promise((resolve, reject) => {
        const t = db.transaction(['recs'], 'readonly');
        const r = t.objectStore('recs').getAll();
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      list = list.concat(fromDb);
    } catch {
      /* 讀不到就只列記憶體裡的 */
    }
  }
  return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function deleteRecording(id) {
  memory.recs.delete(id);
  for (const k of [...memory.chunks.keys()]) if (k.startsWith(`${id}:`)) memory.chunks.delete(k);
  const db = await openDb();
  if (!db) return;
  await tx(db, ['recs', 'chunks'], 'readwrite', (t) => {
    t.objectStore('recs').delete(id);
    t.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
  });
}
