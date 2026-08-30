// IndexedDB-backed cache for full audio file blobs, shared between the page
// (downloads into it) and the service worker (serves playback from it). Once
// a file is cached, drive-audio requests for it never need a Drive API call
// or an access token again — see the cache-first check in service-worker.js.
const DB_NAME = 'adp-file-cache';
const STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'fileId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Full record: { fileId, blob, mimeType, size, name, downloadedAt }.
export async function putCachedFile(record) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getCachedFile(fileId) {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(fileId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function hasCachedFile(fileId) {
  return !!(await getCachedFile(fileId));
}

// Updates only the given fields of an already-cached record (e.g. re-
// fetched chapters/thumbnail) without touching its existing (potentially
// huge) audio blob — a plain putCachedFile would need the whole record
// re-supplied, including the blob, so this reads-merges-writes instead.
// No-op (returns false) if the file isn't cached at all.
export async function updateCachedFileFields(fileId, updates) {
  const existing = await getCachedFile(fileId);
  if (!existing) return false;
  await putCachedFile({ ...existing, ...updates });
  return true;
}

export async function deleteCachedFile(fileId) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(fileId);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// Metadata for every cached file (still loads each blob into memory as part
// of the IndexedDB read, but doesn't copy it — fine for a library-sized list
// of audiobooks). Used for a "manage downloads" view / total-size display.
export async function listCachedFiles() {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result.map(({ fileId, mimeType, size, name, downloadedAt }) => ({
    fileId,
    mimeType,
    size,
    name,
    downloadedAt,
  }));
}
