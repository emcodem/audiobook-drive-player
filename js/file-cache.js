// IndexedDB-backed cache for downloaded audio, shared between the page
// (downloads into it) and the service worker (serves playback from it). Once
// a file is cached, drive-audio requests for it never need a Drive API call
// or an access token again — see the cache-first check in service-worker.js.
//
// Audio is stored in fixed-size CHUNKS (see CHUNK_SIZE) rather than as one
// single multi-hundred-MB-to-gigabyte Blob per book. Two real reasons for
// this, not just one:
//   1. Storing a single very large Blob in IndexedDB is a well-known weak
//      spot in browser storage implementations, Chromium on Android
//      included — smaller, uniform records are a much better-trodden path.
//   2. If a piece of a downloaded book's data is ever lost (storage
//      pressure, an OS-level clear, etc.), chunking means that's usually
//      detectable and fixable as "chunk 47 of 96 is missing" — a small,
//      cheap re-fetch — rather than the entire book silently reverting to
//      "not downloaded" with a full redownload as the only way back.
//
// Also holds a separate store for IN-PROGRESS downloads' chunk-count
// metadata (see downloader.js) — chunks already written to the main store
// during an incomplete download are left in place and simply reused by the
// next resume attempt, rather than needing their own separate holding area.
import { logDebug } from './debug-log.js';

const DB_NAME = 'adp-file-cache';
const META_STORE = 'files'; // one record per book: { fileId, chunkSize, chunkCount, size, mimeType, name, downloadedAt, chapters, thumbnailBlob }
const CHUNK_STORE = 'chunks'; // one record per chunk: { key: "<fileId>:<index>", fileId, index, blob }
const PARTIAL_META_STORE = 'partialMeta'; // in-progress download bookkeeping: { fileId, chunkCount, mimeType, name }
const DB_VERSION = 3;

export const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

function chunkKey(fileId, index) {
  return `${fileId}:${index}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: 'fileId' });
      if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE, { keyPath: 'key' });
      // Earlier versions had a single-blob 'files' store (v1) and a
      // single-blob 'partial' store (v2) — neither is compatible with the
      // chunked format, so anything left over from them is stale and gets
      // dropped rather than migrated (a book cached under the old format
      // needs re-downloading either way, same as any other data loss case
      // this app already handles via the "was downloaded before" ledger).
      if (event.oldVersion > 0 && event.oldVersion < DB_VERSION) {
        if (db.objectStoreNames.contains('partial')) db.deleteObjectStore('partial');
      }
      if (!db.objectStoreNames.contains(PARTIAL_META_STORE)) {
        db.createObjectStore(PARTIAL_META_STORE, { keyPath: 'fileId' });
      }
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

// ---- Book metadata (everything except the audio itself) ---------------
// Record: { fileId, chunkSize, chunkCount, size, mimeType, name,
//           downloadedAt, chapters, thumbnailBlob }.
export async function putCachedFile(record) {
  await putRecord(META_STORE, record);
}

export async function getCachedFile(fileId) {
  return getRecord(META_STORE, fileId);
}

export async function hasCachedFile(fileId) {
  return !!(await getCachedFile(fileId));
}

// Updates only the given fields of an already-cached record (e.g. re-
// fetched chapters/thumbnail) without touching its stored audio chunks at
// all. No-op (returns false) if the file isn't cached at all.
export async function updateCachedFileFields(fileId, updates) {
  const existing = await getCachedFile(fileId);
  if (!existing) return false;
  await putCachedFile({ ...existing, ...updates });
  return true;
}

export async function deleteCachedFile(fileId) {
  const meta = await getCachedFile(fileId);
  if (meta) await deleteChunks(fileId, meta.chunkCount);
  await deleteRecord(META_STORE, fileId);
}

// ---- Audio chunks -------------------------------------------------------

export async function getChunk(fileId, index) {
  return getRecord(CHUNK_STORE, chunkKey(fileId, index));
}

export async function putChunk(fileId, index, blob) {
  await putRecord(CHUNK_STORE, { key: chunkKey(fileId, index), fileId, index, blob });
}

export async function deleteChunks(fileId, chunkCount) {
  for (let i = 0; i < chunkCount; i++) {
    // eslint-disable-next-line no-await-in-loop
    await deleteRecord(CHUNK_STORE, chunkKey(fileId, i));
  }
}

// Assembles exactly the bytes in [start, end) from however many chunks that
// range spans, WITHOUT reading any chunk outside that span. Returns null if
// any needed chunk is missing (a partial/lost download) rather than
// silently returning incomplete data — callers treat that as "not
// available", the same as if nothing were cached at all.
export async function getCachedRange(fileId, start, end, chunkSize, mimeType) {
  const firstChunk = Math.floor(start / chunkSize);
  const lastChunk = Math.floor((end - 1) / chunkSize);
  const parts = [];
  for (let i = firstChunk; i <= lastChunk; i++) {
    // eslint-disable-next-line no-await-in-loop
    const record = await getChunk(fileId, i);
    if (!record) {
      logDebug(`file-cache: chunk ${i} for fileId=${fileId} is missing — treating range [${start},${end}) as unavailable.`);
      return null;
    }
    const chunkStart = i * chunkSize;
    const sliceStart = Math.max(0, start - chunkStart);
    const sliceEnd = Math.min(record.blob.size, end - chunkStart);
    parts.push(record.blob.slice(sliceStart, sliceEnd));
  }
  return new Blob(parts, { type: mimeType });
}

// A "byte source" (see mp4-chapters.js) reading directly from chunked
// storage — lets embedded-chapter parsing run against a downloaded book
// without ever assembling the whole file into memory as one Blob.
export function chunkedByteSource(fileId, chunkSize, totalSize, mimeType) {
  return {
    length: totalSize,
    async readRange(start, end) {
      const blob = await getCachedRange(fileId, start, end, chunkSize, mimeType);
      if (!blob) throw new Error(`missing chunk data for fileId=${fileId} range [${start},${end})`);
      return blob.arrayBuffer();
    },
  };
}

// ---- In-progress download bookkeeping -----------------------------------
// The chunks themselves are written straight to the main CHUNK_STORE as
// they arrive (see downloader.js) — this just tracks how many full chunks
// exist so far, so a resume knows where to pick back up. Record:
// { fileId, chunkCount, mimeType, name }.

export async function getPartialMeta(fileId) {
  return getRecord(PARTIAL_META_STORE, fileId);
}

export async function putPartialMeta(record) {
  await putRecord(PARTIAL_META_STORE, record);
}

export async function deletePartialMeta(fileId) {
  await deleteRecord(PARTIAL_META_STORE, fileId);
}

// Metadata for every cached file — used for a "manage downloads" view /
// total-size display. Deliberately excludes chunk data entirely (cheap to
// list even for a large library).
export async function listCachedFiles() {
  const db = await openDb();
  const result = await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).getAll();
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
