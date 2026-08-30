// Downloads a book's full audio file once (requires a valid access token,
// same as any other Drive call) and stores it in the local blob cache so
// playback afterward never needs the network or a token again — see the
// cache-first check in service-worker.js.
import { getAccessToken } from './auth.js';
import { putCachedFile, deleteCachedFile, hasCachedFile } from './file-cache.js';

export { hasCachedFile } from './file-cache.js';

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
  await putCachedFile({
    fileId,
    blob,
    mimeType,
    size: blob.size,
    name: book.name,
    downloadedAt: Date.now(),
  });
}

export async function removeDownload(fileId) {
  await deleteCachedFile(fileId);
}
