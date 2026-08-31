// Downloads a book's full audio file once (requires a valid access token,
// same as any other Drive call) and stores it in the local blob cache so
// playback afterward never needs the network or a token again — see the
// cache-first check in service-worker.js. Also fetches the chapter sidecar
// and cover thumbnail at the same time and caches those too (see chapters.js
// and thumbnails.js for the read side), so a downloaded book is genuinely
// usable with no network at all — not just the audio.
import { getAccessToken } from './auth.js';
import {
  putCachedFile,
  deleteCachedFile,
  hasCachedFile,
  getCachedFile,
  updateCachedFileFields,
  getPartialDownload,
  putPartialDownload,
  deletePartialDownload,
} from './file-cache.js';
import { fetchChapters } from './chapters.js';
import { parseChaptersFromByteSource, blobByteSource } from './mp4-chapters.js';
import { markDownloaded, unmarkDownloaded } from './storage.js';
import { logDebug } from './debug-log.js';

export { hasCachedFile } from './file-cache.js';

// Partial progress is flushed to IndexedDB (see file-cache.js's PARTIAL_STORE)
// every this many bytes, rather than after every small chunk — frequent tiny
// writes would add overhead for no real benefit, since the whole point is
// surviving a *network failure*, not every single read().
const FLUSH_THRESHOLD = 20 * 1024 * 1024; // 20MB

// Prefers the sidecar (it can hold manually-curated chapters that don't
// necessarily match the file's embedded ones), but falls back to parsing
// chapters directly out of the audio file itself — see mp4-chapters.js —
// when there's no sidecar or it came back empty. Runs against the local
// blob, so this costs no extra network call.
async function resolveChapters(chaptersFileId, blob) {
  const sidecar = await fetchChapters(chaptersFileId);
  if (sidecar) return sidecar.chapters;
  const embedded = await parseChaptersFromByteSource(blobByteSource(blob));
  return embedded ? embedded.chapters : null;
}

// Best-effort: a book with no chapter sidecar, or a thumbnail fetch that
// fails for any reason, shouldn't block the download — the audio itself is
// the part that matters most, and both of these degrade gracefully (no
// chapter list / a placeholder cover) if unavailable.
async function fetchThumbnailBlob(fileId, token) {
  try {
    const metaRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) return null;
    const { thumbnailLink } = await metaRes.json();
    if (!thumbnailLink) return null;
    const imgRes = await fetch(thumbnailLink);
    if (!imgRes.ok) return null;
    return await imgRes.blob();
  } catch {
    return null;
  }
}

// Downloads a book's audio, resuming from whatever's already been saved if a
// previous attempt didn't finish (network error, backgrounding, etc.) rather
// than starting over from byte zero. Progress beyond what's already on disk
// is periodically flushed to IndexedDB as it comes in (see FLUSH_THRESHOLD)
// and — critically — flushed one more time in a `finally` if anything goes
// wrong, so a failure never loses more than the last partial chunk still
// sitting only in memory.
export async function downloadBook(book, onProgress) {
  const token = getAccessToken();
  if (!token) throw new Error('Sign in first');

  const fileId = book.audioFileId;
  const mimeType = book.audioMimeType || 'audio/mp4';

  const existingPartial = await getPartialDownload(fileId);
  let savedBlob = existingPartial ? existingPartial.blob : new Blob([], { type: mimeType });
  const resuming = savedBlob.size > 0;
  if (resuming) {
    logDebug(`download: resuming "${book.name}" from ${savedBlob.size} bytes already saved.`);
  }

  const headers = { Authorization: `Bearer ${token}` };
  if (resuming) headers.Range = `bytes=${savedBlob.size}-`;

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers });

  // A stale/invalid resume point (e.g. the file changed) gets a 416, whose
  // body is not valid audio content — clear the bad resume point and let
  // the next attempt (this one aborts here) start over cleanly via a fresh,
  // Range-less request.
  if (res.status === 416) {
    logDebug(`download: resume point for "${book.name}" was rejected (416) — clearing it; the next attempt will start over.`);
    await deletePartialDownload(fileId);
    throw new Error('Resume point rejected by server — please try downloading again');
  }
  if (resuming && res.status === 200) {
    // Server ignored the Range header and sent the full file again —
    // appending this on top of what we already saved would duplicate
    // content, so discard the stale partial and treat this as fresh.
    logDebug(`download: server ignored the Range request for "${book.name}" (got 200, not 206) — discarding the partial and starting over.`);
    savedBlob = new Blob([], { type: mimeType });
  } else if (!res.ok && res.status !== 206) {
    throw new Error(`Download failed (${res.status})`);
  }

  let total;
  const contentRange = res.headers.get('Content-Range');
  if (contentRange && contentRange.includes('/')) {
    total = Number(contentRange.split('/')[1]) || 0;
  } else {
    total = savedBlob.size + (Number(res.headers.get('Content-Length')) || 0);
  }

  const reader = res.body.getReader();
  let pendingChunks = [];
  let pendingBytes = 0;

  async function flush() {
    if (!pendingChunks.length) return;
    savedBlob = new Blob([savedBlob, ...pendingChunks], { type: mimeType });
    pendingChunks = [];
    pendingBytes = 0;
    await putPartialDownload({ fileId, blob: savedBlob, mimeType, name: book.name });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pendingChunks.push(value);
      pendingBytes += value.length;
      if (onProgress) onProgress(savedBlob.size + pendingBytes, total);
      if (pendingBytes >= FLUSH_THRESHOLD) await flush();
    }
    await flush();
  } catch (err) {
    await flush(); // preserve whatever arrived before the failure, for next time's resume
    throw err;
  }

  const blob = savedBlob;

  const [chapters, thumbnailBlob] = await Promise.all([
    resolveChapters(book.chaptersFileId, blob),
    fetchThumbnailBlob(fileId, token),
  ]);

  await putCachedFile({
    fileId,
    blob,
    mimeType,
    size: blob.size,
    name: book.name,
    downloadedAt: Date.now(),
    // Stored even when null/absent (no sidecar, no embedded chapters found,
    // no thumbnail) so the cache record is authoritative — the read side
    // (chapters.js/thumbnails.js) trusts "this book is downloaded" to mean
    // "don't bother checking further for this", rather than treating a
    // missing value as "not fetched yet".
    chapters: chapters || null,
    thumbnailBlob: thumbnailBlob || null,
  });
  await deletePartialDownload(fileId);
  markDownloaded(fileId);
}

export async function removeDownload(fileId) {
  await deleteCachedFile(fileId);
  await deletePartialDownload(fileId);
  unmarkDownloaded(fileId);
}

// Re-fetches just the chapter sidecar and cover thumbnail for a book that's
// already downloaded, without touching its (potentially gigabytes-large)
// cached audio blob — for when metadata capture failed at download time
// (no sign-in yet, a token that expired partway through a long download,
// etc.) and re-downloading the whole audio file again would be wasteful.
export async function refreshMetadata(book) {
  const token = getAccessToken();
  if (!token) throw new Error('Sign in first');

  const existing = await getCachedFile(book.audioFileId);
  if (!existing) throw new Error('This book is not downloaded');

  const [chapters, thumbnailBlob] = await Promise.all([
    resolveChapters(book.chaptersFileId, existing.blob),
    fetchThumbnailBlob(book.audioFileId, token),
  ]);

  await updateCachedFileFields(book.audioFileId, {
    chapters: chapters || null,
    thumbnailBlob: thumbnailBlob || null,
  });
}
