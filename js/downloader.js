// Downloads a book's full audio file once (requires a valid access token,
// same as any other Drive call) and stores it in the local blob cache so
// playback afterward never needs the network or a token again — see the
// cache-first check in service-worker.js. Also fetches the chapter sidecar
// and cover thumbnail at the same time and caches those too (see chapters.js
// and thumbnails.js for the read side), so a downloaded book is genuinely
// usable with no network at all — not just the audio.
import { getAccessToken } from './auth.js';
import { putCachedFile, deleteCachedFile, hasCachedFile, getCachedFile, updateCachedFileFields } from './file-cache.js';
import { fetchChapters } from './chapters.js';
import { parseChaptersFromByteSource, blobByteSource } from './mp4-chapters.js';
import { markDownloaded, unmarkDownloaded } from './storage.js';

export { hasCachedFile } from './file-cache.js';

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

export async function downloadBook(book, onProgress) {
  const token = getAccessToken();
  if (!token) throw new Error('Sign in first');

  const fileId = book.audioFileId;
  const mimeType = book.audioMimeType || 'audio/mp4';
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);

  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }

  const blob = new Blob(chunks, { type: mimeType });

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
  markDownloaded(fileId);
}

export async function removeDownload(fileId) {
  await deleteCachedFile(fileId);
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
