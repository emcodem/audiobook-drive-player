import { getAccessToken } from './auth.js';
import { getCachedFile } from './file-cache.js';

// Drive auto-generates a thumbnail for m4a/m4b files (often the embedded
// cover art) — thumbnailLink is a signed URL usable directly in an <img src>
// as long as the browser has an active Google session, no extra headers
// needed. In-memory cache per page load (object URLs for downloaded books
// don't need re-creating on every call within a session; the short-lived
// Drive-signed links for non-downloaded books aren't persisted since Drive's
// docs note they're short-lived, hours at most).
const cache = new Map();

export async function getThumbnail(fileId) {
  if (cache.has(fileId)) return cache.get(fileId);

  // Cache-first: a downloaded book's cover image bytes were captured at
  // download time (see downloader.js) and work with no network or token —
  // this is what makes a downloaded book's cover show up fully offline
  // instead of falling back to the placeholder.
  const cached = await getCachedFile(fileId);
  if (cached && cached.thumbnailBlob) {
    const url = URL.createObjectURL(cached.thumbnailBlob);
    cache.set(fileId, url);
    return url;
  }

  const token = getAccessToken();
  if (!token) return null;

  try {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=thumbnailLink`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const link = res.ok ? (await res.json()).thumbnailLink || null : null;
    cache.set(fileId, link);
    return link;
  } catch {
    cache.set(fileId, null);
    return null;
  }
}
