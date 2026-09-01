// Downloads a book's full audio file once (requires a valid access token,
// same as any other Drive call) and stores it in the local chunked cache so
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
  putChunk,
  deleteChunks,
  getPartialMeta,
  putPartialMeta,
  deletePartialMeta,
  chunkedByteSource,
  CHUNK_SIZE,
} from './file-cache.js';
import { fetchChapters } from './chapters.js';
import { parseChaptersFromByteSource } from './mp4-chapters.js';
import { markDownloaded, unmarkDownloaded } from './storage.js';
import { logDebug } from './debug-log.js';

export { hasCachedFile } from './file-cache.js';

// Prefers the sidecar (it can hold manually-curated chapters that don't
// necessarily match the file's embedded ones), but falls back to parsing
// chapters directly out of the audio file itself — see mp4-chapters.js —
// when there's no sidecar or it came back empty.
async function resolveChapters(chaptersFileId, byteSource) {
  const sidecar = await fetchChapters(chaptersFileId);
  if (sidecar) return sidecar.chapters;
  const embedded = await parseChaptersFromByteSource(byteSource);
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

// Consumes exactly `n` bytes from the front of a pending-bytes buffer
// (an array of Uint8Arrays plus a running length), splitting a piece across
// the boundary if needed. Used to cut the incoming stream at exact
// CHUNK_SIZE boundaries regardless of how the underlying network chunks
// happen to arrive.
function takeBytes(pending, n) {
  const out = [];
  let remaining = n;
  while (remaining > 0) {
    const piece = pending.parts[0];
    if (piece.length <= remaining) {
      out.push(piece);
      remaining -= piece.length;
      pending.parts.shift();
    } else {
      out.push(piece.subarray(0, remaining));
      pending.parts[0] = piece.subarray(remaining);
      remaining = 0;
    }
  }
  pending.len -= n;
  return out;
}

// Downloads a book's audio in fixed-size chunks (see file-cache.js's
// CHUNK_SIZE), resuming from however many complete chunks are already
// stored if a previous attempt didn't finish, rather than starting over
// from byte zero. Only whole, confirmed chunks are ever persisted — the
// tail end of a failed attempt (less than one chunk's worth) is simply
// re-fetched next time, which is a far smaller loss than restarting the
// entire download.
export async function downloadBook(book, onProgress) {
  const token = getAccessToken();
  if (!token) throw new Error('Sign in first');

  const fileId = book.audioFileId;
  const mimeType = book.audioMimeType || 'audio/mp4';

  const existingPartial = await getPartialMeta(fileId);
  let chunkCount = existingPartial ? existingPartial.chunkCount : 0;
  let confirmedBytes = chunkCount * CHUNK_SIZE;
  const resuming = confirmedBytes > 0;
  if (resuming) {
    logDebug(`download: resuming "${book.name}" from chunk ${chunkCount} (${confirmedBytes} bytes already saved).`);
  }

  const headers = { Authorization: `Bearer ${token}` };
  if (resuming) headers.Range = `bytes=${confirmedBytes}-`;

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers });

  // A stale/invalid resume point (e.g. the file changed) gets a 416, whose
  // body is not valid audio content — clear the bad resume point and let
  // the next attempt (this one aborts here) start over cleanly via a fresh,
  // Range-less request.
  if (res.status === 416) {
    logDebug(`download: resume point for "${book.name}" was rejected (416) — clearing it; the next attempt will start over.`);
    await deleteChunks(fileId, chunkCount);
    await deletePartialMeta(fileId);
    throw new Error('Resume point rejected by server — please try downloading again');
  }
  if (resuming && res.status === 200) {
    // Server ignored the Range header and sent the full file again —
    // appending this on top of what we already saved would duplicate
    // content, so discard the stale chunks and treat this as fresh.
    logDebug(`download: server ignored the Range request for "${book.name}" (got 200, not 206) — discarding saved chunks and starting over.`);
    await deleteChunks(fileId, chunkCount);
    await deletePartialMeta(fileId);
    chunkCount = 0;
    confirmedBytes = 0;
  } else if (!res.ok && res.status !== 206) {
    throw new Error(`Download failed (${res.status})`);
  }

  let total;
  const contentRange = res.headers.get('Content-Range');
  if (contentRange && contentRange.includes('/')) {
    total = Number(contentRange.split('/')[1]) || 0;
  } else {
    total = confirmedBytes + (Number(res.headers.get('Content-Length')) || 0);
  }

  const reader = res.body.getReader();
  const pending = { parts: [], len: 0 };

  async function flushFullChunks() {
    while (pending.len >= CHUNK_SIZE) {
      const bytes = takeBytes(pending, CHUNK_SIZE);
      // eslint-disable-next-line no-await-in-loop
      await putChunk(fileId, chunkCount, new Blob(bytes, { type: mimeType }));
      chunkCount++;
      confirmedBytes += CHUNK_SIZE;
      // eslint-disable-next-line no-await-in-loop
      await putPartialMeta({ fileId, chunkCount, mimeType, name: book.name });
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.parts.push(value);
      pending.len += value.length;
      if (onProgress) onProgress(confirmedBytes + pending.len, total);
      if (pending.len >= CHUNK_SIZE) await flushFullChunks();
    }
  } catch (err) {
    logDebug(`download: "${book.name}" failed mid-stream — ${chunkCount} whole chunk(s) already saved and will be resumed from next time.`);
    throw err;
  }

  // Whatever's left (less than one full chunk) is the final, possibly
  // smaller chunk — only written now that the stream has genuinely ended.
  if (pending.len > 0) {
    await putChunk(fileId, chunkCount, new Blob(pending.parts, { type: mimeType }));
    chunkCount++;
    confirmedBytes += pending.len;
    pending.parts = [];
    pending.len = 0;
  }

  const byteSource = chunkedByteSource(fileId, CHUNK_SIZE, confirmedBytes, mimeType);
  const [chapters, thumbnailBlob] = await Promise.all([
    resolveChapters(book.chaptersFileId, byteSource),
    fetchThumbnailBlob(fileId, token),
  ]);

  await putCachedFile({
    fileId,
    chunkSize: CHUNK_SIZE,
    chunkCount,
    size: confirmedBytes,
    mimeType,
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
  await deletePartialMeta(fileId);
  markDownloaded(fileId);
}

export async function removeDownload(fileId) {
  await deleteCachedFile(fileId);
  const partial = await getPartialMeta(fileId);
  if (partial) {
    await deleteChunks(fileId, partial.chunkCount);
    await deletePartialMeta(fileId);
  }
  unmarkDownloaded(fileId);
}

// Re-fetches just the chapter sidecar and cover thumbnail for a book that's
// already downloaded, without touching its (potentially gigabytes-large)
// cached audio chunks — for when metadata capture failed at download time
// (no sign-in yet, a token that expired partway through a long download,
// etc.) and re-downloading the whole audio file again would be wasteful.
export async function refreshMetadata(book) {
  const token = getAccessToken();
  if (!token) throw new Error('Sign in first');

  const existing = await getCachedFile(book.audioFileId);
  if (!existing) throw new Error('This book is not downloaded');

  const byteSource = chunkedByteSource(book.audioFileId, existing.chunkSize, existing.size, existing.mimeType);
  const [chapters, thumbnailBlob] = await Promise.all([
    resolveChapters(book.chaptersFileId, byteSource),
    fetchThumbnailBlob(book.audioFileId, token),
  ]);

  await updateCachedFileFields(book.audioFileId, {
    chapters: chapters || null,
    thumbnailBlob: thumbnailBlob || null,
  });
}
