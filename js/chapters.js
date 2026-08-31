import { getAccessToken } from './auth.js';
import { getCachedFile } from './file-cache.js';
import { logDebug } from './debug-log.js';
import { parseChaptersFromByteSource, blobByteSource, createHttpRangeByteSource } from './mp4-chapters.js';

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

// Cache-first read used by the player, now with an embedded-chapter fallback
// (see mp4-chapters.js) on both paths: the sidecar (fetchChapters, above)
// isn't the only possible source — most audiobook files that have chapters
// at all actually embed them directly in the container, which is exactly
// what generate-chapters.ps1's ffprobe pass originally read them out of to
// build the sidecar in the first place. Parsing that directly here means a
// working sidecar is no longer required at all: for a downloaded book, it's
// parsed straight out of the local blob (zero network); for a streaming
// book, via small Range requests through the same drive-audio proxy used
// for playback.
export async function loadChapters(book) {
  const cached = await getCachedFile(book.audioFileId);
  if (cached) {
    if (cached.chapters && cached.chapters.length) return { chapters: cached.chapters };
    logDebug(`loadChapters: "${book.name}" downloaded but no sidecar chapters captured — trying to parse embedded chapters from the local audio file.`);
    return parseChaptersFromByteSource(blobByteSource(cached.blob));
  }

  const sidecar = await fetchChapters(book.chaptersFileId);
  if (sidecar) return sidecar;

  try {
    const mime = encodeURIComponent(book.audioMimeType || 'audio/mp4');
    const url = `./drive-audio/${book.audioFileId}?mime=${mime}`;
    logDebug(`loadChapters: "${book.name}" has no sidecar chapters — trying to parse embedded chapters via Range requests.`);
    const byteSource = await createHttpRangeByteSource(url);
    return await parseChaptersFromByteSource(byteSource);
  } catch (err) {
    logDebug(`loadChapters: embedded-chapter parse via network failed: ${err}`);
    return null;
  }
}
