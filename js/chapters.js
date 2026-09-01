import { getAccessToken } from './auth.js';
import { getCachedFile, updateCachedFileFields, chunkedByteSource } from './file-cache.js';
import { logDebug } from './debug-log.js';
import { parseChaptersFromByteSource, createHttpRangeByteSource } from './mp4-chapters.js';

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

// Cache-first read used by the player, with an embedded-chapter fallback
// (see mp4-chapters.js) — but ONLY against the local cache, never over the
// network. The QuickTime chapter-text-track method (what most modern
// encoders, ffmpeg included, actually produce) needs one small HTTP
// round-trip PER CHAPTER — fine reading from an already-local blob/chunk,
// but for a book that's merely streaming (no download), a few hundred
// chapters meant a few hundred sequential network round-trips before
// playback could even start, adding a minute or more of delay with no
// visible reason. So: for a downloaded book, parsed straight out of the
// local chunked cache (fast, no network). For anything else, only the
// sidecar — a single small JSON fetch — is used; no chapters at all is the
// honest fallback for a non-downloaded book with no sidecar, rather than a
// slow one.
export async function loadChapters(book) {
  const cached = await getCachedFile(book.audioFileId);
  if (cached) {
    if (cached.chapters && cached.chapters.length) return { chapters: cached.chapters };
    logDebug(`loadChapters: "${book.name}" downloaded but no sidecar chapters captured — trying to parse embedded chapters from the local cache.`);
    const byteSource = chunkedByteSource(book.audioFileId, cached.chunkSize, cached.size, cached.mimeType);
    const result = await parseChaptersFromByteSource(byteSource);
    if (result && result.chapters && result.chapters.length) {
      // Persist this so every future open of the same book reuses it
      // instead of re-parsing the container's chapter atoms from scratch
      // each time — the parse itself is cheap, but there's no reason to
      // repeat it once the answer is known.
      await updateCachedFileFields(book.audioFileId, { chapters: result.chapters });
      logDebug(`loadChapters: "${book.name}" — parsed chapters saved to the cache; future opens won't need to re-parse.`);
    }
    return result;
  }

  const sidecar = await fetchChapters(book.chaptersFileId);
  if (sidecar) return sidecar;

  logDebug(`loadChapters: "${book.name}" isn't downloaded and has no sidecar chapters — not parsing embedded chapters here (it can mean one round-trip per chapter, which would delay playback start for a large chapter count). Signalling the caller to run that parse as a background job instead, after playback has already started — see parseChaptersInBackground below.`);
  return { streamParseNeeded: true };
}

// Same embedded-chapter parse loadChapters() runs against the local cache
// for a downloaded book, but pointed at createHttpRangeByteSource(streamUrl)
// (mp4-chapters.js) instead — i.e. live HTTP Range requests against the
// book that's already streaming for playback. This is exactly the
// per-chapter-round-trip cost loadChapters() deliberately declines to pay
// before playback starts (see the streamParseNeeded case above); called
// from here, by the player, *after* playback has already begun, it's fine
// for this to take a while in the background. Never persisted — there's no
// local cache entry to attach the result to for a book that isn't
// downloaded, so it re-parses from scratch every time the book is opened
// while streaming.
export async function parseChaptersInBackground(book, streamUrl) {
  let byteSource;
  try {
    byteSource = await createHttpRangeByteSource(streamUrl);
  } catch (err) {
    logDebug(`parseChaptersInBackground: "${book.name}" — could not set up Range access to the stream: ${err}`);
    return null;
  }
  const result = await parseChaptersFromByteSource(byteSource);
  if (result && result.chapters && result.chapters.length) {
    logDebug(`parseChaptersInBackground: "${book.name}" — parsed ${result.chapters.length} embedded chapter(s) from the live stream in the background.`);
    return result;
  }
  logDebug(`parseChaptersInBackground: "${book.name}" — background streaming parse finished with no embedded chapters found.`);
  return null;
}
