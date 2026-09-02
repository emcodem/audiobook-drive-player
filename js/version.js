// Single source of truth for the app's version marker. Bumped on every
// deploy, regardless of which files actually changed — see service-worker.js
// (which imports this to force a byte-diff so the browser's SW update check
// actually detects a new version) and app.js (which displays it on-page, so
// "am I on the latest version" is something you can just look at instead of
// having to guess from whether a specific feature seems to be there).
export const APP_VERSION = '2026-09-01-05';
