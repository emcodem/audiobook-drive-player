import { getStoredToken } from './js/token-store.js';
import { getCachedFile, getCachedRange } from './js/file-cache.js';
import { APP_VERSION } from './js/version.js';

// APP_VERSION (see version.js) is a statically imported dependency of this
// script, so the browser's byte-for-byte update check covers it too —
// bumping version.js is enough to make a new deploy detectable, without
// needing to also touch this file by hand every time.

// This service worker proxies Google Drive's byte-range media requests
// (handleDriveMedia below) with the user's OAuth token attached, UNLESS the
// file has been downloaded for offline use (js/downloader.js), in which case
// it's served straight from the local blob cache — no token, no network,
// no re-auth prompt.
//
// For every other same-origin request (the HTML page itself, and every
// same-origin JS/CSS/etc. it loads), this forces a network fetch that
// bypasses the browser's own HTTP cache — see the fetch handler below.
// GitHub Pages sets several minutes of Cache-Control on static files, and an
// installed PWA can go a long time between genuine reloads, so without this
// the browser could keep serving an old cached app.js/index.html/etc. even
// on a page load that otherwise looked "fresh" (new HTML, stale JS under
// it) — a more fundamental gap than just this worker script going stale,
// which APP_VERSION above handles separately.
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
  if (match) {
    const mime = url.searchParams.get('mime') || 'audio/mp4';
    event.respondWith(handleDriveMedia(match[1], event.request, mime));
    return;
  }

  // Everything else that's actually part of this app (not Google's own
  // accounts.google.com/apis.google.com scripts, left to their own normal
  // caching) — always re-fetch from network, ignoring whatever cached copy
  // the browser's HTTP cache thinks is still valid.
  if (url.origin === self.location.origin) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }));
  }
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

// Wraps fetch() with a hard timeout via AbortController — a dead mobile
// connection (radio reacquiring after a long background sleep) can leave a
// fetch hanging for minutes with no error either way; see the ~4-minute
// hang and repeated 15s+ stalls that showed up once sw-timing was actually
// measuring this. 5s is generous for the ~400-900ms this normally takes
// (per that same evidence) while still failing fast enough for a normal
// retry/banner instead of a multi-minute hang.
const DRIVE_FETCH_TIMEOUT_MS = 5000;
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRIVE_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getFileSize(fileId, token) {
  if (sizeCache.has(fileId)) return sizeCache.get(fileId);
  const res = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=size`, {
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

// Posts a message to every open tab/window controlled by this service
// worker — the only way for logDebug()'s in-memory, page-side log to see
// anything that happens here, since a service worker runs in its own
// separate global scope with no shared memory with the page. app.js relays
// these into the normal Debug log via a 'message' listener.
async function logToPage(message) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach((client) => client.postMessage({ type: 'ADP_SW_LOG', message }));
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
  if (cached && cached.chunkCount) {
    const fromCache = await respondFromCachedChunks(cached, request);
    if (fromCache) return fromCache;
    // A chunk needed for this range is missing (partial data loss) — fall
    // through to the live network path below rather than failing outright,
    // same as if the book had never been downloaded at all.
  }

  const token = await getToken();
  if (!token) return new Response('No access token available', { status: 401 });

  const tSizeStart = performance.now();
  const wasSizeCached = sizeCache.has(fileId);
  const total = await getFileSize(fileId, token);
  if (total == null) return new Response('Could not determine file size', { status: 502 });
  const sizeMs = Math.round(performance.now() - tSizeStart);

  const range = parseRange(request.headers.get('Range'), total);
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;

  const tFetchStart = performance.now();
  let driveResponse;
  try {
    driveResponse = await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` },
    });
  } catch (err) {
    const timedOut = err && err.name === 'AbortError';
    logToPage(`sw-timing: fileId=${fileId} range=${start}-${end} — ${timedOut ? `timed out after ${DRIVE_FETCH_TIMEOUT_MS}ms` : 'upstream fetch threw'} (${Math.round(performance.now() - tFetchStart)}ms).`);
    return new Response(timedOut ? 'Upstream fetch timed out' : 'Upstream fetch failed', { status: 504 });
  }
  const fetchMs = Math.round(performance.now() - tFetchStart);
  // Deliberately logs every request, not just slow ones — a fast baseline
  // (e.g. a small seek near the start) is exactly what makes a slow one
  // (e.g. a deep seek after reloadAfterAuth) stand out as an outlier
  // instead of being an isolated, uncontextualized number.
  logToPage(
    `sw-timing: fileId=${fileId} range=${start}-${end}/${total} — size-lookup=${sizeMs}ms (cached=${wasSizeCached}), drive-fetch-headers=${fetchMs}ms, status=${driveResponse.status}.`
  );

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
// assembled straight out of chunked local storage — no fetch, no token
// check. Returns null (rather than an error Response) if a needed chunk is
// missing, so the caller can fall back to the live network path instead of
// failing a request outright over one lost piece.
async function respondFromCachedChunks(cached, request) {
  const total = cached.size;
  const range = parseRange(request.headers.get('Range'), total);
  const start = range ? range.start : 0;
  const end = range ? range.end : total - 1;

  const blob = await getCachedRange(cached.fileId, start, end + 1, cached.chunkSize, cached.mimeType);
  if (!blob) return null;

  const status = range ? 206 : 200;
  const headers = {
    'Accept-Ranges': 'bytes',
    'Content-Type': cached.mimeType,
    'Content-Length': String(end - start + 1),
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

  return new Response(blob, { status, headers });
}
