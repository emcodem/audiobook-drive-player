import { getStoredToken } from './js/token-store.js';
import { getCachedFile } from './js/file-cache.js';

// This service worker proxies Google Drive's byte-range media requests
// (handleDriveMedia below) with the user's OAuth token attached, UNLESS the
// file has been downloaded for offline use (js/downloader.js), in which case
// it's served straight from the local blob cache — no token, no network,
// no re-auth prompt. It does not cache the app shell. Every other request is
// left alone (no respondWith call) and goes straight to the network, so app
// updates are never masked by a stale cache.
let memoryToken = null;
const sizeCache = new Map();

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Remove any app-shell caches created by older versions of this worker
  // (earlier builds of this app cached the app shell; this clears that out).
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'ADP_TOKEN') {
    memoryToken = { token: data.token, expiresAt: data.expiresAt };
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const match = url.pathname.match(/\/drive-(?:audio|video)\/([^/]+)$/);
  if (!match) return;

  const mime = url.searchParams.get('mime') || 'audio/mp4';
  event.respondWith(handleDriveMedia(match[1], event.request, mime));
});

async function getToken() {
  if (memoryToken && memoryToken.expiresAt > Date.now()) return memoryToken.token;
  const stored = await getStoredToken();
  if (stored && stored.expiresAt > Date.now()) {
    memoryToken = stored;
    return stored.token;
  }
  return null;
}

async function getFileSize(fileId, token) {
  if (sizeCache.has(fileId)) return sizeCache.get(fileId);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const size = Number(data.size);
  if (!Number.isFinite(size)) return null;
  sizeCache.set(fileId, size);
  return size;
}

function parseRange(rangeHeader, total) {
  if (!rangeHeader) return null;
  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
  return { start, end };
}

// Shared by both /drive-audio/ (the <audio> element) and /drive-video/ (the
// optional clip <video> element) — same proxying need either way: the
// element's own Range requests drive seeking, we forward them to Drive and
// hand back the exact same byte range. We compute Content-Range from a size
// we fetched ourselves rather than trusting Drive's response headers, since
// CORS may not expose Content-Range/Content-Length on every response — but
// the response body itself is always readable once the preflight succeeds.
async function handleDriveMedia(fileId, request, mime) {
  const cached = await getCachedFile(fileId);
  if (cached && cached.blob) {
    return respondFromCachedBlob(cached.blob, request, cached.mimeType || mime);
  }

  const token = await getToken();
  if (!token) return new Response('No access token available', { status: 401 });

  const total = await getFileSize(fileId, token);
  if (total == null) return new Response('Could not determine file size', { status: 502 });

  const range = parseRange(request.headers.get('Range'), total);
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;

  let driveResponse;
  try {
    driveResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` },
    });
  } catch {
    return new Response('Upstream fetch failed', { status: 502 });
  }

  if (driveResponse.status === 401 || driveResponse.status === 403) {
    return new Response('Token expired or invalid', { status: 401 });
  }
  if (!driveResponse.ok) {
    return new Response('Drive error', { status: driveResponse.status });
  }

  const status = range ? 206 : 200;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mime,
    'Content-Length': String(end - start + 1),
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

  return new Response(driveResponse.body, { status, headers });
}

// Same Range-handling contract as handleDriveMedia's network path above, but
// sliced straight out of a locally cached Blob — no fetch, no token check.
function respondFromCachedBlob(blob, request, mime) {
  const total = blob.size;
  const range = parseRange(request.headers.get('Range'), total);
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;

  const status = range ? 206 : 200;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': mime,
    'Content-Length': String(end - start + 1),
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

  return new Response(blob.slice(start, end + 1, mime), { status, headers });
}
