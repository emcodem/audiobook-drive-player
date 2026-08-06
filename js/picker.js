import { CONFIG } from './config.js';
import { getAccessToken } from './auth.js';
import { addBooks, getLibrary } from './storage.js';

const AUDIO_EXT = /\.(m4a|m4b|mp3)$/i;
const CHAPTERS_EXT = /\.chapters\.json$/i;
const LIBRARY_MIME_TYPES = 'audio/mp4,audio/x-m4a,audio/x-m4b,audio/mpeg,audio/mp3,application/json,video/mp4';

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

// Note on drive.file scope: picking a FOLDER only grants access to whatever
// files were already individually accessible at pick time — it does not
// retroactively cover files uploaded into that folder afterward (confirmed
// empirically: re-picking the same folder after adding new files did not
// surface them). This is only used to record *where* to scan; actually
// granting access to new files requires openGrantFilesPicker below.
async function pickFolder(onFolderPicked) {
  await loadPickerApi();
  const token = getAccessToken();
  if (!token) {
    alert('Please sign in first.');
    return;
  }

  const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(true)
    .setMode(google.picker.DocsViewMode.LIST);

  const picker = new google.picker.PickerBuilder()
    .setOAuthToken(token)
    .setDeveloperKey(CONFIG.API_KEY)
    .setAppId(CONFIG.APP_ID)
    .addView(view)
    .setCallback((data) => {
      if (data.action !== google.picker.Action.PICKED) return;
      const folder = (data.docs || [])[0];
      if (folder) onFolderPicked(folder.id, folder.name);
    })
    .build();
  picker.setVisible(true);
}

// Folder containing everything: audiobook files, their
// "<name>.chapters.json" sidecars, and any "chNNN_final.mp4" video clips.
// Only tells the app where to scan — see the drive.file caveat above for
// why this alone doesn't grant access to files added later.
export function openLibraryFolderPicker(onFolderPicked) {
  return pickFolder(onFolderPicked);
}

// Grants the app access to specific files directly. Under drive.file scope
// this is the ONLY thing that reliably covers files added to Drive after
// your last pick — run this (selecting the new files, or all of them)
// whenever you've uploaded new books, chapter sidecars, or clips. Supports
// mixed types in one multiselect session, so a batch of new audio +
// sidecar + clip files can all be granted in a single pick.
export async function openGrantFilesPicker(onFilesPicked) {
  await loadPickerApi();
  const token = getAccessToken();
  if (!token) {
    alert('Please sign in first.');
    return;
  }

  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setIncludeFolders(true)
    .setMimeTypes(LIBRARY_MIME_TYPES)
    .setMode(google.picker.DocsViewMode.LIST);

  const picker = new google.picker.PickerBuilder()
    .setOAuthToken(token)
    .setDeveloperKey(CONFIG.API_KEY)
    .setAppId(CONFIG.APP_ID)
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setCallback((data) => {
      if (data.action !== google.picker.Action.PICKED) return;
      onFilesPicked(data.docs || []);
    })
    .build();
  picker.setVisible(true);
}

// Pairs each audio file in an already-fetched file list (see drive.js's
// listFilesRecursive) with its "<name>.chapters.json" sibling by filename,
// adding/updating library entries for all of them in one pass. Takes the
// list rather than fetching it itself so the caller can share one Drive
// listing between this and clips.js's buildClipsMap instead of scanning the
// same folder twice. Meant to be re-run on every app load — files already
// granted (via openGrantFilesPicker) show up with no further action; new
// files still need a grant first (see that function's comment).
export function syncBooksFolder(files) {
  if (!files.length) return getLibrary();

  const audioByBase = new Map();
  const chaptersByBase = new Map();
  for (const file of files) {
    if (AUDIO_EXT.test(file.name)) audioByBase.set(baseName(file.name), file);
    else if (CHAPTERS_EXT.test(file.name)) chaptersByBase.set(baseName(file.name), file);
  }
  if (!audioByBase.size) return getLibrary();

  const lib = getLibrary();
  const books = [...audioByBase.entries()].map(([base, audio]) => {
    const existing = lib.find((b) => b.audioFileId === audio.id);
    return {
      name: base,
      audioFileId: audio.id,
      audioMimeType: audio.mimeType,
      chaptersFileId: chaptersByBase.get(base)?.id || existing?.chaptersFileId || null,
      addedAt: existing?.addedAt || Date.now(),
    };
  });

  return addBooks(books);
}
