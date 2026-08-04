import { CONFIG } from './config.js';
import { getAccessToken } from './auth.js';
import { addBooks } from './storage.js';

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
// picked in the same session (see scripts/generate-chapters.ps1). Both must
// be selected together since drive.file only grants access to files the
// user explicitly opens with the app.
function pairDocs(docs) {
  const audioFiles = docs.filter((d) => AUDIO_EXT.test(d.name));
  const chapterFiles = docs.filter((d) => CHAPTERS_EXT.test(d.name));

  return audioFiles.map((audio) => {
    const base = baseName(audio.name);
    const chaptersDoc = chapterFiles.find((c) => baseName(c.name) === base);
    return {
      name: base,
      audioFileId: audio.id,
      audioMimeType: audio.mimeType,
      chaptersFileId: chaptersDoc ? chaptersDoc.id : null,
      addedAt: Date.now(),
    };
  });
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
