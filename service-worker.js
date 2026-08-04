import { getStoredToken } from './js/token-store.js';

const CACHE_NAME = 'adp-shell-v2';
const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/config.js',
  './js/auth.js',
  './js/picker.js',
  './js/storage.js',
  './js/chapters.js',
  './js/player.js',
  './js/token-store.js',
  './js/thumbnails.js',
  './js/app.js',
];

// In-memory cache of the current token + each file's total size (bytes),
// so we don't have to hit Drive's metadata endpoint on every range request.
// Reset whenever the service worker is restarted; re-populated from
// IndexedDB (see token-store.js) or the next 'ADP_TOKEN' message.
let memoryToken = null;
const sizeCache = new Map();

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
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
  const match = url.pathname.match(/\/drive-audio\/([^/]+)$/);

  if (match) {
    const mime = url.searchParams.get('mime') || 'audio/mp4';
    event.respondWith(handleDriveAudio(match[1], event.request, mime));
    return;
  }

  if (event.request.method === 'GET' && url.origin === self.location.origin) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
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

// The <audio> element's own Range requests drive seeking; we forward them to
// Drive and hand back the exact same byte range. We compute Content-Range
// from a size we fetched ourselves rather than trusting Drive's response
// headers, since CORS may not expose Content-Range/Content-Length on every
// response — but the response body itself is always readable once the
// preflight succeeds.
async function handleDriveAudio(fileId, request, mime) {
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
