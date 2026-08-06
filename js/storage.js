// localStorage-backed library list and per-book resume position.
const LIBRARY_KEY = 'adp.library.v1';
const LIBRARY_FOLDER_KEY = 'adp.libraryFolder.v1';

export function getLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LIBRARY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveLibrary(list) {
  localStorage.setItem(LIBRARY_KEY, JSON.stringify(list));
}

export function addBooks(newBooks) {
  const lib = getLibrary();
  for (const book of newBooks) {
    const idx = lib.findIndex((b) => b.audioFileId === book.audioFileId);
    if (idx >= 0) lib[idx] = { ...lib[idx], ...book };
    else lib.push(book);
  }
  saveLibrary(lib);
  return lib;
}

export function removeBook(audioFileId) {
  saveLibrary(getLibrary().filter((b) => b.audioFileId !== audioFileId));
}

function positionKey(fileId) {
  return `adp.position.${fileId}`;
}

export function getPosition(fileId) {
  try {
    return JSON.parse(localStorage.getItem(positionKey(fileId))) || null;
  } catch {
    return null;
  }
}

export function setPosition(fileId, seconds) {
  localStorage.setItem(
    positionKey(fileId),
    JSON.stringify({ position: seconds, updatedAt: Date.now() })
  );
}

const HISTORY_LIMIT = 200;

function historyKey(fileId) {
  return `adp.history.${fileId}`;
}

// Reverse-chronological is left to callers (rendering); this returns entries
// in the order they were listened to (oldest first).
export function getHistory(fileId) {
  try {
    return JSON.parse(localStorage.getItem(historyKey(fileId))) || [];
  } catch {
    return [];
  }
}

export function addHistoryEntry(fileId, entry) {
  const history = getHistory(fileId);
  history.push(entry);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  localStorage.setItem(historyKey(fileId), JSON.stringify(history));
  return history;
}

// A single Drive folder holding everything: audiobook files, their
// "<name>.chapters.json" sidecars, and any "chNNN_final.mp4" video clips —
// picked once, ever.
export function getLibraryFolderId() {
  return localStorage.getItem(LIBRARY_FOLDER_KEY) || null;
}

export function setLibraryFolderId(folderId) {
  localStorage.setItem(LIBRARY_FOLDER_KEY, folderId);
}
