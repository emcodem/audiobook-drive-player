import { getPosition, setPosition, addHistoryEntry } from './storage.js';
import { fetchChapters } from './chapters.js';
import { getThumbnail } from './thumbnails.js';

const SAVE_INTERVAL_MS = 8000;

export class Player {
  constructor({ audioEl, onChaptersLoaded, onTimeUpdate, onEnded, onSleepTimerEnded, onHistoryUpdated }) {
    this.audioEl = audioEl;
    this.book = null;
    this.chapters = [];
    this.onChaptersLoaded = onChaptersLoaded || (() => {});
    this.onTimeUpdate = onTimeUpdate || (() => {});
    this.onEnded = onEnded || (() => {});
    this.onSleepTimerEnded = onSleepTimerEnded || (() => {});
    this.onHistoryUpdated = onHistoryUpdated || (() => {});
    this._lastSaveAt = 0;
    this._sleepTimeoutId = null;
    this._sleepDeadline = null;
    this._lastHistoryChapterIndex = -1;

    audioEl.addEventListener('timeupdate', () => this._handleTimeUpdate());
    audioEl.addEventListener('pause', () => this._savePosition());
    audioEl.addEventListener('ended', () => this.onEnded());
    audioEl.addEventListener('loadedmetadata', () => this._resume());
    audioEl.addEventListener('error', () => this._handlePlaybackError());

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._savePosition();
    });
    window.addEventListener('beforeunload', () => this._savePosition());
  }

  async load(book) {
    this.book = book;
    this.chapters = [];
    this._lastHistoryChapterIndex = -1;
    this.setSleepTimer(0);

    const mime = encodeURIComponent(book.audioMimeType || 'audio/mp4');
    this.audioEl.src = `./drive-audio/${book.audioFileId}?mime=${mime}`;
    this._setupMediaSession();

    const chapterData = await fetchChapters(book.chaptersFileId);
    this.chapters = chapterData ? chapterData.chapters : [];
    this.onChaptersLoaded(this.chapters);
  }

  // minutes === 0 cancels any active timer.
  setSleepTimer(minutes) {
    clearTimeout(this._sleepTimeoutId);
    this._sleepTimeoutId = null;
    this._sleepDeadline = null;
    if (minutes > 0) {
      const ms = minutes * 60 * 1000;
      this._sleepDeadline = Date.now() + ms;
      this._sleepTimeoutId = setTimeout(() => {
        this.pause();
        this._sleepDeadline = null;
        this.onSleepTimerEnded();
      }, ms);
      this._recordSleepHistory(minutes);
    }
  }

  // Records where in the book (and when) the sleep timer was turned on, so
  // the listening history shows it alongside chapter entries.
  _recordSleepHistory(minutes) {
    if (!this.book) return;
    const idx = this.currentChapterIndex();
    const chapter = idx >= 0 ? this.chapters[idx] : null;
    addHistoryEntry(this.book.audioFileId, {
      type: 'sleep',
      chapterIndex: idx,
      title: chapter ? (chapter.title || `Chapter ${idx + 1}`) : this.book.name,
      minutes,
      at: Date.now(),
    });
    this.onHistoryUpdated();
  }

  // Seconds remaining, or null if no sleep timer is active. This counts down
  // in real (wall-clock) time regardless of play/pause state, matching how
  // sleep timers behave in other audiobook/podcast apps.
  getSleepRemainingSeconds() {
    if (!this._sleepDeadline) return null;
    return Math.max(0, Math.round((this._sleepDeadline - Date.now()) / 1000));
  }

  // Re-fetches the same URL after a fresh token has been broadcast to the
  // service worker (used after the user taps "keep listening"). Resume
  // position is preserved because it's continuously saved to localStorage
  // and re-applied on the next 'loadedmetadata' event.
  reloadAfterAuth() {
    if (!this.book) return;
    const wasPlaying = !this.audioEl.paused;
    const src = this.audioEl.src;
    this.audioEl.src = src;
    this.audioEl.load();
    if (wasPlaying) {
      this.audioEl.addEventListener('loadedmetadata', () => this.audioEl.play(), { once: true });
    }
  }

  play() {
    this.audioEl.play();
  }

  pause() {
    this.audioEl.pause();
  }

  togglePlay() {
    if (this.audioEl.paused) this.play();
    else this.pause();
  }

  skip(seconds) {
    const duration = this.audioEl.duration || Infinity;
    this.audioEl.currentTime = Math.max(0, Math.min(duration, this.audioEl.currentTime + seconds));
  }

  seekTo(seconds) {
    this.audioEl.currentTime = seconds;
  }

  jumpToChapter(index) {
    const chapter = this.chapters[index];
    if (chapter) this.seekTo(chapter.start);
  }

  currentChapterIndex() {
    const t = this.audioEl.currentTime;
    let idx = -1;
    this.chapters.forEach((ch, i) => {
      if (t >= ch.start) idx = i;
    });
    return idx;
  }

  _resume() {
    const saved = getPosition(this.book.audioFileId);
    const duration = this.audioEl.duration;
    if (saved && saved.position > 0 && (!duration || saved.position < duration - 2)) {
      this.audioEl.currentTime = saved.position;
    }
  }

  _handleTimeUpdate() {
    this.onTimeUpdate(this.audioEl.currentTime, this.audioEl.duration);
    this._trackChapterHistory();
    const now = Date.now();
    if (now - this._lastSaveAt > SAVE_INTERVAL_MS) {
      this._savePosition();
      this._lastSaveAt = now;
    }
  }

  // Records a history entry whenever playback enters a new chapter, whether
  // by natural advance, a chapter-list tap, or scrubbing — anything that
  // counts as "starting to listen to" that chapter.
  _trackChapterHistory() {
    if (!this.chapters.length) return;
    const idx = this.currentChapterIndex();
    if (idx < 0 || idx === this._lastHistoryChapterIndex) return;
    this._lastHistoryChapterIndex = idx;
    const chapter = this.chapters[idx];
    addHistoryEntry(this.book.audioFileId, {
      chapterIndex: idx,
      title: chapter.title || `Chapter ${idx + 1}`,
      at: Date.now(),
    });
    this.onHistoryUpdated();
  }

  _savePosition() {
    if (!this.book) return;
    setPosition(this.book.audioFileId, this.audioEl.currentTime);
  }

  // A mid-stream load failure most commonly means the access token expired
  // (the service worker's Drive proxy returns 401). Surface the same
  // "tap to keep listening" banner used for proactive expiry warnings.
  _handlePlaybackError() {
    if (!this.book) return;
    window.dispatchEvent(new CustomEvent('adp:token-expiring'));
  }

  _setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const book = this.book;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.name,
      artist: 'Audiobook',
    });
    navigator.mediaSession.setActionHandler('play', () => this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => this.skip(-30));
    navigator.mediaSession.setActionHandler('seekforward', () => this.skip(30));
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) this.seekTo(details.seekTime);
    });

    // Artwork arrives asynchronously; re-set metadata once we have it, but
    // only if this is still the book being played (the user may have
    // already switched to another one by the time this resolves).
    getThumbnail(book.audioFileId).then((url) => {
      if (!url || this.book !== book) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: book.name,
        artist: 'Audiobook',
        artwork: [{ src: url, sizes: '512x512', type: 'image/jpeg' }],
      });
    });
  }
}
