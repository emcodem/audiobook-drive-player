// localStorage-backed library list and per-book resume position.
const LIBRARY_KEY = 'adp.library.v1';

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
