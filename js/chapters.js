import { getAccessToken } from './auth.js';
import { getCachedFile } from './file-cache.js';

// Fetches a "<book>.chapters.json" sidecar (see scripts/generate-chapters.ps1).
// This is a small JSON GET done directly from the page (with an Authorization
// header) — unlike audio playback, it doesn't need the service worker's
// Range-proxying since we're not seeking within it or worried about size.
// Pure network fetch — used both as the read-side fallback (loadChapters,
// below) and by downloader.js when caching a book for offline use.
export async function fetchChapters(chaptersFileId) {
  if (!chaptersFileId) return null;
  const token = getAccessToken();
  if (!token) return null;

  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${chaptersFileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.chapters) || !data.chapters.length) return null;
    return data;
  } catch {
    return null;
  }
}

// Cache-first read used by the player: if this book was downloaded for
// offline use, its chapters (or the fact that it has none) were captured at
// download time — see downloader.js — so this trusts that record instead of
// hitting the network at all, even when a chaptersFileId is present. Only
// falls back to fetchChapters for a book that isn't downloaded.
export async function loadChapters(book) {
  const cached = await getCachedFile(book.audioFileId);
  if (cached) {
    return cached.chapters && cached.chapters.length ? { chapters: cached.chapters } : null;
  }
  return fetchChapters(book.chaptersFileId);
}
