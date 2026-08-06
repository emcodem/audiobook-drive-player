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

const PLACEHOLDER_COVER = './icons/icon-192.png';

const els = {
  signInHero: document.getElementById('signInHero'),
  loginBtn: document.getElementById('loginBtn'),
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
  speedSelect: document.getElementById('speedSelect'),
  sleepSelect: document.getElementById('sleepSelect'),
  sleepRemainingLabel: document.getElementById('sleepRemainingLabel'),
  chapterList: document.getElementById('chapterList'),
  noChaptersMsg: document.getElementById('noChaptersMsg'),
  historyList: document.getElementById('historyList'),
  emptyHistoryMsg: document.getElementById('emptyHistoryMsg'),
  tokenBanner: document.getElementById('tokenBanner'),
  keepListeningBtn: document.getElementById('keepListeningBtn'),
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
    const titleText = document.createTextNode(entry.title + ' ');
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = formatHistoryTimestamp(entry.at);
    li.appendChild(titleText);
    li.appendChild(time);
    li.addEventListener('click', () => player.jumpToChapter(entry.chapterIndex));
    els.historyList.appendChild(li);
  });
}

function renderLibrary() {
  const lib = getLibrary();
  els.libraryList.innerHTML = '';
  els.emptyLibraryMsg.classList.toggle('hidden', lib.length > 0);

  lib.forEach((book) => {
    const li = document.createElement('li');
    li.className = 'library-item';

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

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'btn ghost small';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeBook(book.audioFileId);
      renderLibrary();
    });

    li.appendChild(cover);
    li.appendChild(nameSpan);
    li.appendChild(removeBtn);
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
els.speedSelect.addEventListener('change', (e) => player.setPlaybackRate(parseFloat(e.target.value)));

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
onAuthReady(() => {
  els.loginBtn.disabled = false;
  els.loginBtn.textContent = 'Sign in with Google';
});
els.loginBtn.addEventListener('click', () => requestAccessToken());
els.keepListeningBtn.addEventListener('click', () => {
  requestAccessToken();
  els.tokenBanner.classList.add('hidden');
});

window.addEventListener('adp:token-expiring', () => {
  els.tokenBanner.classList.remove('hidden');
});

function handleTokenRefreshed() {
  els.signInHero.classList.add('hidden');
  els.userStatus.classList.remove('hidden');
  els.userStatus.textContent = 'Signed in';
  els.libraryView.classList.remove('hidden');
  renderLibrary();
  syncLibrary();

  if (!els.playerView.classList.contains('hidden')) {
    player.reloadAfterAuth();
  }
}

initAuth({ onTokenChange: handleTokenRefreshed });

if ('serviceWorker' in navigator) {
  // updateViaCache: 'none' makes the browser always re-fetch this file (and
  // its statically imported modules) from the network when checking for
  // updates, instead of potentially reusing an HTTP-cached copy.
  navigator.serviceWorker.register('./service-worker.js', { type: 'module', updateViaCache: 'none' });
}
