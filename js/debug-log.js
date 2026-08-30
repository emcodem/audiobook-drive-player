// A tiny in-memory log, separate from the browser console, so diagnostic
// messages are visible on-device without needing devtools/adb — see the
// "Debug log" toggle in the top bar (wired up in app.js). Still mirrors to
// console.warn too, for anyone who does have devtools open.
const ENTRY_LIMIT = 200;
const entries = [];
const listeners = [];

export function logDebug(message) {
  console.warn(message);
  entries.push({ message: String(message), at: Date.now() });
  if (entries.length > ENTRY_LIMIT) entries.shift();
  listeners.forEach((cb) => cb());
}

export function getDebugEntries() {
  return entries;
}

export function clearDebugEntries() {
  entries.length = 0;
  listeners.forEach((cb) => cb());
}

// Called whenever a new entry is logged, so an open debug panel can update
// live instead of only showing what existed when it was opened.
export function onDebugLog(cb) {
  listeners.push(cb);
}
