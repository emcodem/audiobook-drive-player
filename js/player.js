import { getPosition, setPosition } from './storage.js';
import { fetchChapters } from './chapters.js';

const SAVE_INTERVAL_MS = 8000;

export class Player {
  constructor({ audioEl, onChaptersLoaded, onTimeUpdate, onEnded }) {
    this.audioEl = audioEl;
    this.book = null;
    this.chapters = [];
    this.onChaptersLoaded = onChaptersLoaded || (() => {});
    this.onTimeUpdate = onTimeUpdate || (() => {});
    this.onEnded = onEnded || (() => {});
    this._lastSaveAt = 0;

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

    const mime = encodeURIComponent(book.audioMimeType || 'audio/mp4');
    this.audioEl.src = `./drive-audio/${book.audioFileId}?mime=${mime}`;
    this._setupMediaSession();

    const chapterData = await fetchChapters(book.chaptersFileId);
    this.chapters = chapterData ? chapterData.chapters : [];
    this.onChaptersLoaded(this.chapters);
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

  setPlaybackRate(rate) {
    this.audioEl.playbackRate = rate;
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
    const now = Date.now();
    if (now - this._lastSaveAt > SAVE_INTERVAL_MS) {
      this._savePosition();
      this._lastSaveAt = now;
    }
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
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.book.name,
      artist: 'Audiobook',
    });
    navigator.mediaSession.setActionHandler('play', () => this.play());
    navigator.mediaSession.setActionHandler('pause', () => this.pause());
    navigator.mediaSession.setActionHandler('seekbackward', () => this.skip(-30));
    navigator.mediaSession.setActionHandler('seekforward', () => this.skip(30));
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime != null) this.seekTo(details.seekTime);
    });
  }
}
