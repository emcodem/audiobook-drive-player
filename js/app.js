import { initAuth, requestAccessToken, onAuthReady } from './auth.js';
import { openLibraryFolderPicker, openGrantFilesPicker, syncBooksFolder } from './picker.js';
import {
  getLibrary,
  removeBook,
  getHistory,
  getLibraryFolderId,
  setLibraryFolderId,
} from './storage.js';
import { Player } from './player.js';
import { getThumbnail } from './thumbnails.js';
import { buildClipsMap, findClipNearMisses, chapterNumberFromTitle } from './clips.js';
import { listFilesRecursive } from './drive.js';
import { downloadBook, removeDownload, refreshMetadata, hasCachedFile } from './downloader.js';
import { getDebugEntries, clearDebugEntries, onDebugLog, logDebug } from './debug-log.js';

const PLACEHOLDER_COVER = './icons/icon-192.png';

const els = {
  signInHero: document.getElementById('signInHero'),
  loginBtn: document.getElementById('loginBtn'),
  signInTopBtn: document.getElementById('signInTopBtn'),
  userStatus: document.getElementById('userStatus'),
  libraryView: document.getElementById('libraryView'),
  playerView: document.getElementById('playerView'),
  addLibraryBtn: document.getElementById('addLibraryBtn'),
  grantFilesBtn: document.getElementById('grantFilesBtn'),
  syncStatusMsg: document.getElementById('syncStatusMsg'),
  libraryList: document.getElementById('libraryList'),
  emptyLibraryMsg: document.getElementById('emptyLibraryMsg'),
  backToLibraryBtn: document.getElementById('backToLibraryBtn'),
  playerTitle: document.getElementById('playerTitle'),
  scrubber: document.getElementById('scrubber'),
  currentTimeLabel: document.getElementById('currentTimeLabel'),
  durationLabel: document.getElementById('durationLabel'),
  playPauseBtn: document.getElementById('playPauseBtn'),
  skipBackBtn: document.getElementById('skipBackBtn'),
  skipFwdBtn: document.getElementById('skipFwdBtn'),
  sleepSelect: document.getElementById('sleepSelect'),
  sleepRemainingLabel: document.getElementById('sleepRemainingLabel'),
  chapterList: document.getElementById('chapterList'),
  noChaptersMsg: document.getElementById('noChaptersMsg'),
  historyList: document.getElementById('historyList'),
  emptyHistoryMsg: document.getElementById('emptyHistoryMsg'),
  tokenBanner: document.getElementById('tokenBanner'),
  keepListeningBtn: document.getElementById('keepListeningBtn'),
  updateBanner: document.getElementById('updateBanner'),
  updateReloadBtn: document.getElementById('updateReloadBtn'),
  debugLogBtn: document.getElementById('debugLogBtn'),
  debugLogPanel: document.getElementById('debugLogPanel'),
  debugLogContent: document.getElementById('debugLogContent'),
  debugLogCopyBtn: document.getElementById('debugLogCopyBtn'),
  debugLogClearBtn: document.getElementById('debugLogClearBtn'),
  debugLogCloseBtn: document.getElementById('debugLogCloseBtn'),
  audioEl: document.getElementById('audioEl'),
  clipVideo: document.getElementById('clipVideo'),
};

let sleepDisplayInterval = null;

function stopSleepDisplay() {
  clearInterval(sleepDisplayInterval);
  sleepDisplayInterval = null;
  els.sleepRemainingLabel.textContent = '';
}

function startSleepDisplay() {
  clearInterval(sleepDisplayInterval);
  sleepDisplayInterval = setInterval(() => {
    const remaining = player.getSleepRemainingSeconds();
    if (remaining == null) {
      stopSleepDisplay();
      return;
    }
    els.sleepRemainingLabel.textContent = formatTime(remaining);
  }, 1000);
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

let scrubbing = false;

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// When the book has chapters, the scrubber is scoped to the CURRENT chapter
// only (min/max = chapter start/end) rather than the whole file — dragging
// it can only move within the chapter you're in. Falls back to whole-file
// bounds for books with no chapter data.
function updateScrubber(current, duration) {
  const chapters = player.chapters;
  let rangeStart = 0;
  let rangeEnd = duration || 0;

  if (chapters.length) {
    const idx = player.currentChapterIndex();
    const chapter = chapters[idx] ?? chapters[0];
    rangeStart = chapter.start;
    rangeEnd = chapter.end != null ? chapter.end : duration || chapter.start;
  }

  if (!scrubbing) {
    els.scrubber.min = String(Math.floor(rangeStart));
    els.scrubber.max = String(Math.max(Math.ceil(rangeEnd), Math.floor(rangeStart) + 1));
    els.scrubber.value = String(Math.floor(current));
  }

  if (chapters.length) {
    els.currentTimeLabel.textContent = formatTime(Math.max(0, current - rangeStart));
    els.durationLabel.textContent = formatTime(Math.max(0, rangeEnd - rangeStart));
  } else {
    els.currentTimeLabel.textContent = formatTime(current);
    els.durationLabel.textContent = formatTime(duration);
  }
}

let currentBook = null;
let clipsMap = {}; // chapter number -> Drive file id, from clips.js
let currentClipFileId = null;
let lastDisplayedChapterIdx = -2; // distinct from currentChapterIndex()'s -1 ("no chapter yet")

const player = new Player({
  audioEl: els.audioEl,
  onChaptersLoaded: (chapters) => {
    renderChapters(chapters);
    updateScrubber(els.audioEl.currentTime, els.audioEl.duration);
    renderHistory();
    lastDisplayedChapterIdx = -2;
    updateNowPlayingChapter();
  },
  onTimeUpdate: (current, duration) => {
    updateScrubber(current, duration);
    updateNowPlayingChapter();
  },
  onEnded: () => {
    els.playPauseBtn.textContent = 'Play';
  },
  onSleepTimerEnded: () => {
    els.sleepSelect.value = '0';
    stopSleepDisplay();
  },
  onHistoryUpdated: () => renderHistory(),
});

// Chapter title (e.g. "(90) Erfahrungen Sammeln [German]") replaces the
// filename/book-range title while a chapter is playing — falls back to the
// book name before chapters load or for books with no chapter data.
function updateNowPlayingChapter() {
  const idx = player.currentChapterIndex();
  const chapter = idx >= 0 ? player.chapters[idx] : null;
  els.playerTitle.textContent = chapter ? (chapter.title || `Chapter ${idx + 1}`) : (currentBook?.name || '');

  if (idx === lastDisplayedChapterIdx) return;
  lastDisplayedChapterIdx = idx;
  highlightCurrentChapter();
  updateClipForChapter(chapter);
}

function updateClipForChapter(chapter) {
  const num = chapterNumberFromTitle(chapter?.title);
  const fileId = num != null ? clipsMap[num] : null;
  currentClipFileId = fileId || null;

  if (currentClipFileId) {
    showClip(currentClipFileId);
  } else {
    hideClip();
  }
}

// Loads the clip but only starts it if the audiobook is currently playing
// — the video's own play/pause state otherwise follows the audio element's
// 'play'/'pause' events (see below), so it doesn't run on its own while
// the audio is paused or hasn't started yet.
function showClip(fileId) {
  els.clipVideo.src = `./drive-video/${fileId}?mime=video/mp4`;
  els.clipVideo.classList.remove('hidden');
  if (!els.audioEl.paused) els.clipVideo.play().catch(() => {});
}

function hideClip() {
  els.clipVideo.pause();
  els.clipVideo.removeAttribute('src');
  els.clipVideo.classList.add('hidden');
}

// Scans the configured library folder (once, recursively) for books/
// chapters and clips together, reporting what it actually found — or that
// it couldn't check — in a visible status line. Silently finding nothing
// and silently failing to check look identical otherwise, which makes an
// empty result impossible to debug; when clips come up empty despite
// video-looking files being present, those filenames are surfaced too, so
// a naming/folder mismatch is visible instead of a bare "0 found".
async function syncLibrary() {
  const folderId = getLibraryFolderId();
  if (!folderId) {
    els.syncStatusMsg.textContent = 'No library folder selected yet — tap "Add library folder" above.';
    return;
  }

  els.syncStatusMsg.textContent = 'Scanning library folder…';
  try {
    const files = await listFilesRecursive(folderId);
    const lib = syncBooksFolder(files);
    clipsMap = buildClipsMap(files);
    renderLibrary();

    const clipCount = Object.keys(clipsMap).length;
    let status =
      `Library folder scanned: ${files.length} file${files.length === 1 ? '' : 's'} total, ` +
      `${lib.length} book${lib.length === 1 ? '' : 's'}, ${clipCount} clip${clipCount === 1 ? '' : 's'} found.`;

    if (clipCount === 0) {
      const nearMisses = findClipNearMisses(files);
      if (nearMisses.length) {
        status += ` Video-like files that didn't match "chNNN_final.mp4": ${nearMisses.slice(0, 5).join(', ')}${nearMisses.length > 5 ? '…' : ''}.`;
      }
    }
    // Every filename Drive actually returned — spelled out because a
    // permission gap (e.g. files added to the folder after it was granted)
    // makes some files invisible to files.list with no error, which looks
    // identical to "the folder is just empty" otherwise.
    status += ` Files seen: ${files.map((f) => f.name).join(', ') || '(none)'}.`;
    els.syncStatusMsg.textContent = status;
    console.log('[adp] library folder scan:', files);

    if (!els.playerView.classList.contains('hidden')) {
      const idx = player.currentChapterIndex();
      updateClipForChapter(idx >= 0 ? player.chapters[idx] : null);
    }
  } catch (err) {
    console.error(err);
    els.syncStatusMsg.textContent =
      'Could not scan the library folder — check your sign-in/connection and try again.';
  }
}

els.audioEl.addEventListener('loadedmetadata', () => {
  updateScrubber(els.audioEl.currentTime, els.audioEl.duration);
});

function renderChapters(chapters) {
  els.chapterList.innerHTML = '';
  els.noChaptersMsg.classList.toggle('hidden', chapters.length > 0);
  chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    li.textContent = `${ch.title || 'Chapter ' + (i + 1)} — ${formatTime(ch.start)}`;
    li.addEventListener('click', () => player.jumpToChapter(i));
    els.chapterList.appendChild(li);
  });
}

function highlightCurrentChapter() {
  const idx = player.currentChapterIndex();
  [...els.chapterList.children].forEach((li, i) => li.classList.toggle('active', i === idx));
}

function formatHistoryTimestamp(ms) {
  const date = new Date(ms);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderHistory() {
  if (!currentBook) return;
  const history = getHistory(currentBook.audioFileId);
  els.historyList.innerHTML = '';
  els.emptyHistoryMsg.classList.toggle('hidden', history.length > 0);

  // Most recently listened first.
  [...history].reverse().forEach((entry) => {
    const li = document.createElement('li');
    const label = entry.type === 'sleep' ? `Sleep timer set (${entry.minutes} min) — ${entry.title}` : entry.title;
    const titleText = document.createTextNode(label + ' ');
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = formatHistoryTimestamp(entry.at);
    li.appendChild(titleText);
    li.appendChild(time);
    if (entry.type === 'sleep') li.classList.add('history-sleep');
    if (entry.chapterIndex >= 0) li.addEventListener('click', () => player.jumpToChapter(entry.chapterIndex));
    els.historyList.appendChild(li);
  });
}

// Tracks in-progress downloads across the whole module (not local to any one
// button), keyed by audioFileId, so the state survives a full renderLibrary()
// rebuild — e.g. triggered by removing a different book — instead of being
// wiped and replaced with a fresh, clickable "Download" button. That
// disappearing state was exactly what let the same book be downloaded twice
// in parallel.
const downloadState = new Map(); // fileId -> { received, total, error }
// Keeps the real book object for each fileId that's currently in the
// rendered list, so refreshDownloadRowInPlace (which only has a fileId to
// work with) can look up the actual book instead of passing the ID string
// itself into renderDownloadControl — that mix-up was why "Retry" silently
// did nothing: it started a download with book.audioFileId === undefined.
const booksByFileId = new Map();

function downloadLabelText(state) {
  if (state.error) {
    if (state.notSignedIn) return 'Not signed in';
    return state.message ? `Download failed: ${state.message}` : 'Download failed — retry';
  }
  return state.total
    ? `Downloading… ${Math.round((state.received / state.total) * 100)}%`
    : `Downloading… ${formatBytes(state.received)}`;
}

// Updates just the one row's text/UI directly via a data-file-id lookup,
// instead of re-rendering the whole library list on every progress tick
// (which would be wasteful and would also fight with anything else the user
// is doing in the list at that moment).
function refreshDownloadRowInPlace(fileId) {
  const container = els.libraryList.querySelector(
    `.library-item-download[data-file-id="${fileId}"]`
  );
  if (container) renderDownloadControl(booksByFileId.get(fileId) || fileId, container);
}

// Renders the download/remove-download control for one library item into
// `container`. Checks the in-progress state map first (so a rebuild mid-
// download shows the real progress instead of resetting), then falls back
// to the cache.
async function renderDownloadControl(book, container) {
  const fileId = typeof book === 'string' ? book : book.audioFileId;
  container.dataset.fileId = fileId;

  const state = downloadState.get(fileId);
  if (state) {
    container.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'muted small';
    label.textContent = downloadLabelText(state);
    container.appendChild(label);
    if (state.error) {
      if (state.notSignedIn) {
        const signInBtn = document.createElement('button');
        signInBtn.textContent = 'Sign in';
        signInBtn.className = 'btn ghost small';
        signInBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          requestAccessToken();
        });
        container.appendChild(signInBtn);
      } else {
        const retryBtn = document.createElement('button');
        retryBtn.textContent = 'Retry';
        retryBtn.className = 'btn ghost small';
        retryBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          downloadState.delete(fileId);
          startDownload(book, container);
        });
        container.appendChild(retryBtn);
      }
    }
    return;
  }

  const cached = await hasCachedFile(fileId);
  container.innerHTML = '';

  if (cached) {
    const label = document.createElement('span');
    label.className = 'muted small';
    label.textContent = 'Downloaded';
    container.appendChild(label);
    return;
  }

  const dlBtn = document.createElement('button');
  dlBtn.textContent = 'Download';
  dlBtn.className = 'btn ghost small';
  dlBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startDownload(book, container);
  });
  container.appendChild(dlBtn);
}

// Guards against starting a second download for a book that's already
// downloading — the row won't even show a clickable "Download" button while
// downloadState has an entry, but this is a second line of defense.
function startDownload(book, container) {
  const fileId = book.audioFileId;
  if (downloadState.has(fileId)) return;

  downloadState.set(fileId, { received: 0, total: 0, error: false });
  renderDownloadControl(book, container);

  downloadBook(book, (received, total) => {
    downloadState.set(fileId, { received, total, error: false });
    refreshDownloadRowInPlace(fileId);
  })
    .then(() => {
      downloadState.delete(fileId);
      refreshDownloadRowInPlace(fileId);
    })
    .catch((err) => {
      console.error(err);
      const notSignedIn = err.message === 'Sign in first';
      downloadState.set(fileId, { received: 0, total: 0, error: true, notSignedIn, message: err.message });
      refreshDownloadRowInPlace(fileId);
    });
}

// Called once sign-in succeeds (see handleTokenRefreshed below) — any
// download that stalled out only because there was no token yet resumes on
// its own rather than leaving the person to notice and tap Retry manually.
function resumeDownloadsPendingSignIn() {
  for (const [fileId, state] of downloadState) {
    if (!state.notSignedIn) continue;
    const book = booksByFileId.get(fileId);
    if (!book) continue;
    downloadState.delete(fileId);
    const container = els.libraryList.querySelector(`.library-item-download[data-file-id="${fileId}"]`);
    if (container) startDownload(book, container);
  }
}

// Closes every open item menu — called when a menu button is clicked (so
// opening one closes any other left open) and on any click elsewhere in the
// document (so tapping away dismisses it).
function closeAllItemMenus() {
  document.querySelectorAll('.item-menu-dropdown').forEach((d) => d.classList.add('hidden'));
}
document.addEventListener('click', closeAllItemMenus);

// A single "⋯" button holding both destructive actions for one book, so the
// row only ever shows one small tap target on that side — placed on the
// LEFT, away from where a thumb naturally rests while scrolling a list on
// the right — instead of an always-visible "Remove" button that's easy to
// hit by accident. Options are built fresh each time the menu opens, so
// "Remove downloaded copy" only appears when there actually is one.
function buildItemMenu(book) {
  const wrap = document.createElement('div');
  wrap.className = 'library-item-menu';

  const menuBtn = document.createElement('button');
  menuBtn.textContent = '⋮';
  menuBtn.className = 'btn ghost small library-item-menu-btn';
  menuBtn.setAttribute('aria-label', 'Book options');

  const dropdown = document.createElement('div');
  dropdown.className = 'item-menu-dropdown hidden';

  menuBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const wasOpen = !dropdown.classList.contains('hidden');
    closeAllItemMenus();
    if (wasOpen) return;

    dropdown.innerHTML = '';
    const cached = await hasCachedFile(book.audioFileId);

    if (cached) {
      const refreshBtn = document.createElement('button');
      refreshBtn.textContent = 'Refresh chapters & cover';
      refreshBtn.className = 'item-menu-option';
      refreshBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        refreshBtn.disabled = true;
        refreshBtn.textContent = 'Refreshing…';
        try {
          await refreshMetadata(book);
          refreshBtn.textContent = 'Refreshed ✓';
        } catch (err) {
          console.error(err);
          refreshBtn.textContent = err.message === 'Sign in first' ? 'Sign in first' : 'Refresh failed';
        }
        setTimeout(() => dropdown.classList.add('hidden'), 900);
      });
      dropdown.appendChild(refreshBtn);

      const removeDlBtn = document.createElement('button');
      removeDlBtn.textContent = 'Remove downloaded copy';
      removeDlBtn.className = 'item-menu-option';
      removeDlBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        dropdown.classList.add('hidden');
        if (!confirm('Remove the downloaded copy of this book? You can download it again later.')) return;
        await removeDownload(book.audioFileId);
        refreshDownloadRowInPlace(book.audioFileId);
      });
      dropdown.appendChild(removeDlBtn);
    }

    const removeLibBtn = document.createElement('button');
    removeLibBtn.textContent = 'Remove from library';
    removeLibBtn.className = 'item-menu-option danger';
    removeLibBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dropdown.classList.add('hidden');
      if (!confirm(`Remove "${book.name}" from your library? You can add it back from the Drive folder later.`)) return;
      removeBook(book.audioFileId);
      renderLibrary();
    });
    dropdown.appendChild(removeLibBtn);

    dropdown.classList.remove('hidden');
  });

  wrap.appendChild(menuBtn);
  wrap.appendChild(dropdown);
  return wrap;
}

function renderLibrary() {
  const lib = getLibrary();
  els.libraryList.innerHTML = '';
  els.emptyLibraryMsg.classList.toggle('hidden', lib.length > 0);

  lib.forEach((book) => {
    booksByFileId.set(book.audioFileId, book);
    const li = document.createElement('li');
    li.className = 'library-item';

    const menu = buildItemMenu(book);

    const cover = document.createElement('img');
    cover.className = 'library-item-cover';
    cover.src = PLACEHOLDER_COVER;
    cover.alt = '';
    cover.addEventListener('error', () => {
      cover.src = PLACEHOLDER_COVER;
    });
    getThumbnail(book.audioFileId).then((url) => {
      if (url) cover.src = url;
    });

    const nameSpan = document.createElement('span');
    nameSpan.textContent = book.name;
    nameSpan.className = 'library-item-name';
    nameSpan.addEventListener('click', () => openPlayer(book));

    const downloadWrap = document.createElement('div');
    downloadWrap.className = 'library-item-download';
    renderDownloadControl(book, downloadWrap);

    const info = document.createElement('div');
    info.className = 'library-item-info';
    info.appendChild(nameSpan);
    info.appendChild(downloadWrap);

    li.appendChild(menu);
    li.appendChild(cover);
    li.appendChild(info);
    els.libraryList.appendChild(li);
  });
}

async function openPlayer(book) {
  currentBook = book;
  els.libraryView.classList.add('hidden');
  els.playerView.classList.remove('hidden');
  els.playerTitle.textContent = book.name;
  els.playPauseBtn.textContent = 'Play';
  els.sleepSelect.value = '0';
  stopSleepDisplay();
  renderHistory();
  lastDisplayedChapterIdx = -2;
  hideClip();

  await player.load(book);
}

els.backToLibraryBtn.addEventListener('click', () => {
  player.pause();
  els.playerView.classList.add('hidden');
  els.libraryView.classList.remove('hidden');
});

els.playPauseBtn.addEventListener('click', () => player.togglePlay());
// The clip is decorative (a short muted loop, not frame-synced to the
// narration), but its play/pause state should still follow the audiobook's
// — otherwise it keeps looping merrily away while playback is paused.
els.audioEl.addEventListener('play', () => {
  els.playPauseBtn.textContent = 'Pause';
  if (currentClipFileId) els.clipVideo.play().catch(() => {});
});
els.audioEl.addEventListener('pause', () => {
  els.playPauseBtn.textContent = 'Play';
  els.clipVideo.pause();
});

els.skipBackBtn.addEventListener('click', () => player.skip(-30));
els.skipFwdBtn.addEventListener('click', () => player.skip(30));
els.sleepSelect.addEventListener('change', (e) => {
  const minutes = parseInt(e.target.value, 10);
  player.setSleepTimer(minutes);
  if (minutes > 0) startSleepDisplay();
  else stopSleepDisplay();
});

els.scrubber.addEventListener('input', () => {
  scrubbing = true;
});
els.scrubber.addEventListener('change', () => {
  player.seekTo(parseFloat(els.scrubber.value));
  scrubbing = false;
});

els.addLibraryBtn.addEventListener('click', () => {
  openLibraryFolderPicker((folderId) => {
    setLibraryFolderId(folderId);
    syncLibrary();
  });
});
els.grantFilesBtn.addEventListener('click', () => {
  // The picked docs themselves aren't needed here — the act of selecting
  // them in the dialog is what grants access under drive.file. Re-scanning
  // afterward picks them up via the normal folder-listing path.
  openGrantFilesPicker(() => syncLibrary());
});
els.loginBtn.disabled = true;
els.loginBtn.textContent = 'Loading…';
els.signInTopBtn.disabled = true;
onAuthReady(() => {
  els.loginBtn.disabled = false;
  els.loginBtn.textContent = 'Sign in with Google';
  els.signInTopBtn.disabled = false;
});
els.loginBtn.addEventListener('click', () => requestAccessToken());
els.signInTopBtn.addEventListener('click', () => requestAccessToken());
els.keepListeningBtn.addEventListener('click', () => {
  requestAccessToken();
  els.tokenBanner.classList.add('hidden');
});

// If the currently open book is fully downloaded, its playback doesn't need
// the Google session at all (audio, chapters, and cover are all local) — so
// warning that the session is about to expire would just be a false alarm
// interruption for something that was never going to need it.
window.addEventListener('adp:token-expiring', async () => {
  if (player.book && (await hasCachedFile(player.book.audioFileId))) return;
  els.tokenBanner.classList.remove('hidden');
});

function handleTokenRefreshed() {
  els.signInHero.classList.add('hidden');
  els.signInTopBtn.classList.add('hidden');
  els.userStatus.classList.remove('hidden');
  els.userStatus.textContent = 'Signed in';
  els.libraryView.classList.remove('hidden');
  renderLibrary();
  resumeDownloadsPendingSignIn();
  syncLibrary();

  if (!els.playerView.classList.contains('hidden')) {
    player.reloadAfterAuth();
  }
}

// The library itself (list of books, and any already-downloaded audio) lives
// in localStorage/IndexedDB on this device — none of that needs a Google
// session to read or play. Signing in is only needed to *reach out to
// Drive*: scanning the library folder for new books, loading thumbnails/
// chapters, or streaming a book that hasn't been downloaded. So: show the
// library immediately if there's any local data, sign in or not, and only
// fall back to the full-screen sign-in prompt on a genuinely first run.
const hasLocalLibrary = getLibrary().length > 0 || !!getLibraryFolderId();
if (hasLocalLibrary) {
  els.signInHero.classList.add('hidden');
  els.libraryView.classList.remove('hidden');
  els.signInTopBtn.classList.remove('hidden');
  renderLibrary();
}

initAuth({ onTokenChange: handleTokenRefreshed });

// Without an explicit "persist" grant, mobile browsers can clear IndexedDB
// data (i.e. downloaded books — see file-cache.js) under storage pressure
// or low site engagement, with no warning — which is what "downloaded
// content vanished" almost always turns out to be. This doesn't guarantee
// downloads survive (the browser can still refuse, or a person can clear
// site data manually), but it meaningfully reduces the chance of silent
// automatic eviction, and either way the result is logged so it's visible
// via the Debug panel instead of being an invisible background fact.
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persisted().then((already) => {
    if (already) {
      logDebug('storage: already persisted — downloads are protected from automatic eviction.');
      return;
    }
    navigator.storage.persist().then((granted) => {
      logDebug(
        granted
          ? 'storage: persistence granted — downloads are now protected from automatic eviction.'
          : 'storage: persistence NOT granted by the browser — downloaded books may be cleared automatically under storage pressure.'
      );
    });
  });
} else {
  logDebug('storage: the Persistent Storage API is not available in this browser.');
}

if ('serviceWorker' in navigator) {
  // updateViaCache: 'none' makes the browser always re-fetch this file (and
  // its statically imported modules) from the network when checking for
  // updates, instead of potentially reusing an HTTP-cached copy.
  navigator.serviceWorker.register('./service-worker.js', { type: 'module', updateViaCache: 'none' }).then((reg) => {
    // An installed home-screen PWA is usually *resumed* rather than freshly
    // navigated when reopened — the browser's normal "check for a new
    // service worker on navigation" trigger often never fires on its own.
    // So check for an update explicitly every time the app comes back to
    // the foreground, in addition to right after registration.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update();
    });
    reg.update();
  });

  // The new service worker (install() calls skipWaiting(), activate() calls
  // clients.claim() — see service-worker.js) takes control as soon as it's
  // ready, firing this event. The already-open page is still running the
  // OLD app.js/index.html in memory at that point — reloading is the only
  // way to actually pick up the new version. Rather than reloading
  // immediately (which would cut off playback with no warning), show a
  // small banner and let the reload happen on the user's own tap.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    els.updateBanner.classList.remove('hidden');
  });
  els.updateReloadBtn.addEventListener('click', () => window.location.reload());
}

// On-page debug log — see debug-log.js. Exists because messages logged via
// console.warn aren't reachable on a phone without a computer/adb; anything
// that calls logDebug() elsewhere shows up here instead.
function formatDebugEntry(entry) {
  const time = new Date(entry.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  return `[${time}] ${entry.message}`;
}

function renderDebugLog() {
  const entries = getDebugEntries();
  els.debugLogContent.textContent = entries.length
    ? entries.map(formatDebugEntry).join('\n')
    : '(nothing logged yet)';
  els.debugLogContent.scrollTop = els.debugLogContent.scrollHeight;
}

onDebugLog(() => {
  if (!els.debugLogPanel.classList.contains('hidden')) renderDebugLog();
});

els.debugLogBtn.addEventListener('click', () => {
  renderDebugLog();
  els.debugLogPanel.classList.remove('hidden');
});
els.debugLogCloseBtn.addEventListener('click', () => {
  els.debugLogPanel.classList.add('hidden');
});
els.debugLogClearBtn.addEventListener('click', () => {
  clearDebugEntries();
  renderDebugLog();
});
els.debugLogCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(els.debugLogContent.textContent);
    els.debugLogCopyBtn.textContent = 'Copied!';
    setTimeout(() => {
      els.debugLogCopyBtn.textContent = 'Copy';
    }, 1500);
  } catch {
    // Clipboard API can be unavailable/denied — the text is still visible
    // and selectable on-screen either way, so this is a soft failure.
  }
});
