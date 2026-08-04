import { initAuth, requestAccessToken } from './auth.js';
import { openAudioPicker, openChaptersPicker } from './picker.js';
import { getLibrary, removeBook } from './storage.js';
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

const player = new Player({
  audioEl: els.audioEl,
  onChaptersLoaded: renderChapters,
  onTimeUpdate: (current, duration) => {
    if (!scrubbing) {
      els.scrubber.max = String(Math.floor(duration || 0));
      els.scrubber.value = String(Math.floor(current || 0));
    }
    els.currentTimeLabel.textContent = formatTime(current);
    els.durationLabel.textContent = formatTime(duration);
    highlightCurrentChapter();
  },
  onEnded: () => {
    els.playPauseBtn.textContent = 'Play';
  },
  onSleepTimerEnded: () => {
    els.sleepSelect.value = '0';
    stopSleepDisplay();
  },
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
  els.libraryView.classList.add('hidden');
  els.playerView.classList.remove('hidden');
  els.playerTitle.textContent = book.name;
  els.playPauseBtn.textContent = 'Play';
  els.sleepSelect.value = '0';
  stopSleepDisplay();

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
