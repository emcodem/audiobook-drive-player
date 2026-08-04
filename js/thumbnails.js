import { getAccessToken } from './auth.js';

// Drive auto-generates a thumbnail for m4a/m4b files (often the embedded
// cover art) — thumbnailLink is a signed URL usable directly in an <img src>
// as long as the browser has an active Google session, no extra headers
// needed. Cached in-memory per page load rather than persisted, since
// Drive's docs note these links are short-lived (hours).
const cache = new Map();

export async function getThumbnail(fileId) {
  if (cache.has(fileId)) return cache.get(fileId);
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
