import { initAuth, requestAccessToken, onAuthReady } from './auth.js';
import { openAudioPicker, openChaptersPicker } from './picker.js';
import { getLibrary, removeBook, getHistory } from './storage.js';
import { Player } from './player.js';
import { getThumbnail } from './thumbnails.js';

const PLACEHOLDER_COVER = './icons/icon-192.png';

const els = {
  loginBtn: document.getElementById('loginBtn'),
  userStatus: document.getElementById('userStatus'),
  libraryView: document.getElementById('libraryView'),
  playerView: document.getElementById('playerView'),
  addAudioBtn: document.getElementById('addAudioBtn'),
  addChaptersBtn: document.getElementById('addChaptersBtn'),
  libraryList: document.getElementById('libraryList'),
  emptyLibraryMsg: document.getElementById('emptyLibraryMsg'),
  backToLibraryBtn: document.getElementById('backToLibraryBtn'),
  playerCover: document.getElementById('playerCover'),
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
};

els.playerCover.addEventListener('error', () => {
  els.playerCover.src = PLACEHOLDER_COVER;
});

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

const player = new Player({
  audioEl: els.audioEl,
  onChaptersLoaded: (chapters) => {
    renderChapters(chapters);
    updateScrubber(els.audioEl.currentTime, els.audioEl.duration);
    renderHistory();
  },
  onTimeUpdate: (current, duration) => {
    updateScrubber(current, duration);
    highlightCurrentChapter();
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

  els.playerCover.src = PLACEHOLDER_COVER;
  getThumbnail(book.audioFileId).then((url) => {
    if (url) els.playerCover.src = url;
  });

  await player.load(book);
}

els.backToLibraryBtn.addEventListener('click', () => {
  player.pause();
  els.playerView.classList.add('hidden');
  els.libraryView.classList.remove('hidden');
});

els.playPauseBtn.addEventListener('click', () => player.togglePlay());
els.audioEl.addEventListener('play', () => (els.playPauseBtn.textContent = 'Pause'));
els.audioEl.addEventListener('pause', () => (els.playPauseBtn.textContent = 'Play'));

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

els.addAudioBtn.addEventListener('click', () => openAudioPicker(() => renderLibrary()));
els.addChaptersBtn.addEventListener('click', () => openChaptersPicker(() => renderLibrary()));
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
  els.loginBtn.classList.add('hidden');
  els.userStatus.classList.remove('hidden');
  els.userStatus.textContent = 'Signed in';
  els.libraryView.classList.remove('hidden');
  renderLibrary();

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
