import { getPosition, setPosition, addHistoryEntry, getHistory } from './storage.js';
import { loadChapters } from './chapters.js';
import { getThumbnail } from './thumbnails.js';
import { logDebug } from './debug-log.js';
import { verifyAndLogChunks } from './file-cache.js';

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

  // Snapshot of what the <audio> element actually has buffered right now —
  // useful for the Debug panel's "Buffered" button when diagnosing whether
  // playback is coming from a real source (cache or live stream) versus
  // just coasting on data the browser already had in memory from earlier.
  getBufferedInfo() {
    const buf = this.audioEl.buffered;
    const ranges = [];
    for (let i = 0; i < buf.length; i++) {
      ranges.push({ start: buf.start(i), end: buf.end(i) });
    }
    return {
      ranges,
      currentTime: this.audioEl.currentTime,
      duration: this.audioEl.duration,
    };
  }

  // Checks every expected chunk of a downloaded book actually exists (see
  // file-cache.js's verifyAndLogChunks) and logs a clear, specific result —
  // whether it's fully intact, completely gone, or only some chunks are
  // missing (which ones), rather than a vague "something's wrong somewhere"
  // the next time a partial storage loss happens.
  async _verifyChunks(book) {
    await verifyAndLogChunks(book);
  }

  async load(book) {
    this.book = book;
    this.chapters = [];
    this._lastHistoryChapterIndex = -1;
    this._chaptersReady = false;
    this._resumeApplied = false;
    this.setSleepTimer(0);

    logDebug(`player: loading "${book.name}" audioFileId=${book.audioFileId} chaptersFileId=${book.chaptersFileId || '(none)'}`);
    this._verifyChunks(book); // fire-and-forget — logs the result, doesn't block playback starting

    const mime = encodeURIComponent(book.audioMimeType || 'audio/mp4');
    this.audioEl.src = `./drive-audio/${book.audioFileId}?mime=${mime}`;
    this._setupMediaSession();

    // Deliberately NOT awaited here — chapter loading (a sidecar fetch, or
    // parsing embedded chapter atoms from the local cache for a downloaded
    // book) is entirely independent of audio playback readiness and should
    // never delay it, no matter how long it takes. Chapter data and audio
    // metadata load independently and can finish in either order —
    // whichever finishes second is what actually has enough information to
    // resume correctly, so both trigger an attempt (see _resume(), which is
    // a no-op until it has what it needs and only ever applies its one-time
    // seek once).
    loadChapters(book).then((chapterData) => {
      if (this.book !== book) return; // a different book was opened meanwhile — this result is stale
      this.chapters = chapterData ? chapterData.chapters : [];
      this._chaptersReady = true;
      this.onChaptersLoaded(this.chapters);
      this._resume();
    });
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
    this._resumeApplied = false; // force _resume() to re-seek on the reload below
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

  // Restores playback position on load: the precise saved position (updated
  // continuously during playback) if there is one, otherwise the start of
  // the most recently listened chapter from the listening history — so a
  // book resumes near where you left off instead of at the very beginning.
  //
  // Called once after chapters finish loading (from load()) and again on
  // the audio element's 'loadedmetadata' — chapter data and audio metadata
  // load independently and can finish in either order, and this needs both
  // (metadata for a valid duration/seek target, chapters for the history
  // fallback), so both call sites funnel through here; the _resumeApplied
  // guard means only the first call that actually has everything performs
  // the seek. Also re-syncs the UI (title, chapter highlight, scrubber)
  // right away via onTimeUpdate — otherwise those only update on the first
  // 'timeupdate' tick, which doesn't fire until playback actually starts,
  // so the player would visually look like it opened at chapter 1 /
  // position 0 until the user tapped Play even though the seek itself
  // (once applied) was already correct.
  _resume() {
    if (this._resumeApplied) {
      this.onTimeUpdate(this.audioEl.currentTime, this.audioEl.duration);
      return;
    }
    if (this.audioEl.readyState < 1 || !this._chaptersReady) return; // wait for the other one

    const duration = this.audioEl.duration;
    const saved = getPosition(this.book.audioFileId);
    let target = null;

    if (saved && saved.position > 0 && (!duration || saved.position < duration - 2)) {
      target = saved.position;
    } else if (this.chapters.length) {
      const history = getHistory(this.book.audioFileId);
      const lastChapterEntry = [...history].reverse().find((e) => e.chapterIndex >= 0);
      const chapter = lastChapterEntry ? this.chapters[lastChapterEntry.chapterIndex] : null;
      if (chapter) target = chapter.start;
    }

    if (target != null) this.audioEl.currentTime = target;
    this._resumeApplied = true;
    this.onTimeUpdate(this.audioEl.currentTime, this.audioEl.duration);
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
