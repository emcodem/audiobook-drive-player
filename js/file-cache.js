// IndexedDB-backed cache for full audio file blobs, shared between the page
// (downloads into it) and the service worker (serves playback from it). Once
// a file is cached, drive-audio requests for it never need a Drive API call
// or an access token again — see the cache-first check in service-worker.js.
//
// Also holds a second store for IN-PROGRESS downloads (see downloader.js) —
// their partial bytes are flushed here periodically so a network failure
// partway through a large download doesn't mean starting over from byte
// zero; a retry resumes via an HTTP Range request from what's already saved.
import { logDebug } from './debug-log.js';

const DB_NAME = 'adp-file-cache';
const STORE = 'files';
const PARTIAL_STORE = 'partial';
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'fileId' });
      if (!db.objectStoreNames.contains(PARTIAL_STORE)) db.createObjectStore(PARTIAL_STORE, { keyPath: 'fileId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      logDebug(`file-cache: indexedDB.open failed: ${req.error}`);
      reject(req.error);
    };
    req.onblocked = () => {
      logDebug('file-cache: indexedDB.open is blocked by another open connection/tab.');
    };
  });
}

function putRecord(storeName, record) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(record);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

function getRecord(storeName, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => {
          db.close();
          resolve(req.result || null);
        };
        req.onerror = () => {
          db.close();
          reject(req.error);
        };
      })
  );
}

function deleteRecord(storeName, key) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

// Full record: { fileId, blob, mimeType, size, name, downloadedAt }.
export async function putCachedFile(record) {
  await putRecord(STORE, record);
}

export async function getCachedFile(fileId) {
  return getRecord(STORE, fileId);
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
  await deleteRecord(STORE, fileId);
}

// ---- In-progress download partial data ---------------------------------
// Record: { fileId, blob, mimeType, name }. blob is however many bytes have
// been received so far — downloader.js resumes from blob.size via Range.

export async function getPartialDownload(fileId) {
  return getRecord(PARTIAL_STORE, fileId);
}

export async function putPartialDownload(record) {
  await putRecord(PARTIAL_STORE, record);
}

export async function deletePartialDownload(fileId) {
  await deleteRecord(PARTIAL_STORE, fileId);
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
