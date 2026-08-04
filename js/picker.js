import { CONFIG } from './config.js';
import { getAccessToken } from './auth.js';
import { addBooks, getLibrary } from './storage.js';

const AUDIO_EXT = /\.(m4a|m4b|mp3)$/i;
const CHAPTERS_EXT = /\.chapters\.json$/i;

let pickerApiLoaded = false;

function loadPickerApi() {
  return new Promise((resolve) => {
    if (pickerApiLoaded) return resolve();
    gapi.load('picker', () => {
      pickerApiLoaded = true;
      resolve();
    });
  });
}

function baseName(name) {
  return name.replace(AUDIO_EXT, '').replace(CHAPTERS_EXT, '');
}

// Pairs each audio file with a same-named "<name>.chapters.json" sidecar
// (see scripts/generate-chapters.ps1). Normally both are multi-selected in
// the same picker session, but multi-select can be fiddly on a touchscreen,
// so a ".chapters.json" picked on its own in a later session instead
// attaches to an existing library entry with a matching name.
function pairDocs(docs) {
  const audioFiles = docs.filter((d) => AUDIO_EXT.test(d.name));
  const chapterFiles = docs.filter((d) => CHAPTERS_EXT.test(d.name));
  const usedChapterIds = new Set();

  const books = audioFiles.map((audio) => {
    const base = baseName(audio.name);
    const chaptersDoc = chapterFiles.find((c) => baseName(c.name) === base);
    if (chaptersDoc) usedChapterIds.add(chaptersDoc.id);
    return {
      name: base,
      audioFileId: audio.id,
      audioMimeType: audio.mimeType,
      chaptersFileId: chaptersDoc ? chaptersDoc.id : null,
      addedAt: Date.now(),
    };
  });

  const orphanChapterFiles = chapterFiles.filter((c) => !usedChapterIds.has(c.id));
  const patches = [];
  if (orphanChapterFiles.length) {
    const lib = getLibrary();
    for (const chaptersDoc of orphanChapterFiles) {
      const base = baseName(chaptersDoc.name);
      const existing = lib.find((b) => b.name === base);
      if (existing) patches.push({ ...existing, chaptersFileId: chaptersDoc.id });
    }
  }

  return [...books, ...patches];
}

export async function openPicker(onBooksAdded) {
  await loadPickerApi();
  const token = getAccessToken();
  if (!token) {
    alert('Please sign in first.');
    return;
  }

  const view = new google.picker.DocsView(google.picker.ViewId.DOCS).setIncludeFolders(true);

  const picker = new google.picker.PickerBuilder()
    .setOAuthToken(token)
    .setDeveloperKey(CONFIG.API_KEY)
    .setAppId(CONFIG.APP_ID)
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setCallback((data) => {
      if (data.action !== google.picker.Action.PICKED) return;
      const books = pairDocs(data.docs || []);
      if (books.length) {
        const lib = addBooks(books);
        onBooksAdded?.(lib);
      }
    })
    .build();

  picker.setVisible(true);
}
