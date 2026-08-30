import { getAccessToken } from './auth.js';
import { getCachedFile } from './file-cache.js';
import { logDebug } from './debug-log.js';

// Fetches a "<book>.chapters.json" sidecar (see scripts/generate-chapters.ps1).
// This is a small JSON GET done directly from the page (with an Authorization
// header) — unlike audio playback, it doesn't need the service worker's
// Range-proxying since we're not seeking within it or worried about size.
// Pure network fetch — used both as the read-side fallback (loadChapters,
// below) and by downloader.js when caching a book for offline use.
//
// Every early return here is logged via logDebug (see debug-log.js — check
// it through the "Debug log" button in the top bar) with which case it
// hit — "no chapters" can mean several different things (no sidecar file
// matched at all, sign-in/network failure, or a sidecar that legitimately
// has no chapter data) and they'd otherwise all look identical.
export async function fetchChapters(chaptersFileId) {
  if (!chaptersFileId) {
    logDebug('fetchChapters: this book has no chaptersFileId — no matching <name>.chapters.json was found for it when the library folder was scanned.');
    return null;
  }
  const token = getAccessToken();
  if (!token) {
    logDebug('fetchChapters: no access token available (not signed in).');
    return null;
  }

  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${chaptersFileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      logDebug(`fetchChapters: request for chaptersFileId=${chaptersFileId} failed with status ${res.status}.`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data.chapters) || !data.chapters.length) {
      logDebug(`fetchChapters: chaptersFileId=${chaptersFileId} fetched OK but its "chapters" array is missing or empty.`);
      return null;
    }
    return data;
  } catch (err) {
    logDebug(`fetchChapters: request for chaptersFileId=${chaptersFileId} threw an error: ${err}`);
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
    if (!cached.chapters || !cached.chapters.length) {
      logDebug(`loadChapters: "${book.name}" is downloaded, but no chapters were captured at download time (see downloadBook's fetchChapters call for why).`);
      return null;
    }
    return { chapters: cached.chapters };
  }
  return fetchChapters(book.chaptersFileId);
}
