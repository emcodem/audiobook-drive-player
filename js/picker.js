import { CONFIG } from './config.js';
import { getAccessToken } from './auth.js';
import { addBooks, getLibrary } from './storage.js';

const AUDIO_EXT = /\.(m4a|m4b|mp3)$/i;
const CHAPTERS_EXT = /\.chapters\.json$/i;
const AUDIO_MIME_TYPES = 'audio/mp4,audio/x-m4a,audio/x-m4b,audio/mpeg,audio/mp3';
const CHAPTERS_MIME_TYPE = 'application/json';

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

async function buildPicker(mimeTypes, onPicked) {
  await loadPickerApi();
  const token = getAccessToken();
  if (!token) {
    alert('Please sign in first.');
    return null;
  }

  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setIncludeFolders(true)
    .setMimeTypes(mimeTypes)
    // Grid/thumbnail mode (the default) barely shows any of the filename,
    // which makes it hard to tell near-identical audiobook files apart on a
    // narrow phone screen. List mode gives the name column far more room.
    .setMode(google.picker.DocsViewMode.LIST);

  return new google.picker.PickerBuilder()
    .setOAuthToken(token)
    .setDeveloperKey(CONFIG.API_KEY)
    .setAppId(CONFIG.APP_ID)
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setCallback((data) => {
      if (data.action !== google.picker.Action.PICKED) return;
      onPicked(data.docs || []);
    })
    .build();
}

// Filtered to audio files only, so the picker isn't cluttered with every
// other file type in Drive. Each picked file becomes (or updates) a library
// entry with no chapters yet.
export async function openAudioPicker(onBooksAdded) {
  const picker = await buildPicker(AUDIO_MIME_TYPES, (docs) => {
    const audioFiles = docs.filter((d) => AUDIO_EXT.test(d.name));
    if (!audioFiles.length) return;

    const books = audioFiles.map((audio) => ({
      name: baseName(audio.name),
      audioFileId: audio.id,
      audioMimeType: audio.mimeType,
      chaptersFileId: null,
      addedAt: Date.now(),
    }));
    const lib = addBooks(books);
    onBooksAdded?.(lib);
  });
  picker?.setVisible(true);
}

// Filtered to JSON files only. Attaches each picked "<name>.chapters.json"
// to an existing library entry with a matching name — since a lone JSON
// file isn't playable on its own, it never creates a new book. Reports back
// clearly when a file doesn't match anything, instead of silently no-oping.
export async function openChaptersPicker(onBooksAdded) {
  const picker = await buildPicker(CHAPTERS_MIME_TYPE, (docs) => {
    const jsonFiles = docs.filter((d) => CHAPTERS_EXT.test(d.name));
    if (!jsonFiles.length) {
      alert('That doesn\'t look like a ".chapters.json" file (the kind generate-chapters.ps1 creates).');
      return;
    }

    const lib = getLibrary();
    const patches = [];
    const unmatched = [];
    for (const doc of jsonFiles) {
      const base = baseName(doc.name);
      const existing = lib.find((b) => b.name === base);
      if (existing) patches.push({ ...existing, chaptersFileId: doc.id });
      else unmatched.push(doc.name);
    }

    if (patches.length) onBooksAdded?.(addBooks(patches));
    if (unmatched.length) {
      alert(
        `No matching audiobook found for: ${unmatched.join(', ')}\n\n` +
          `Add the audiobook first with "Add audiobook", then attach its chapters file.`
      );
    }
  });
  picker?.setVisible(true);
}
