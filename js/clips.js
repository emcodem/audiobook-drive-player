import { getAccessToken } from './auth.js';

// Matches the ComfyUI output naming convention, e.g. "ch090_final.mp4".
const CLIP_FILENAME_RE = /^ch0*(\d+)_final\.mp4$/i;

// Chapter titles are ffprobe-embedded and carry a global chapter number in
// parentheses, e.g. "(90) Erfahrungen Sammeln [German]" — this is the only
// value that ties a chapter (from any book file) to a clip filename, since
// clip filenames don't reference a book at all.
export function chapterNumberFromTitle(title) {
  const m = /\((\d+)\)/.exec(title || '');
  return m ? parseInt(m[1], 10) : null;
}

// Lists every "chNNN_final.mp4" directly inside the given Drive folder and
// returns a { chapterNumber: fileId } map. Meant to be re-run on every app
// load (not just once, at folder-pick time) so clips added to the folder
// later — as ComfyUI renders more of them — show up automatically with no
// further picking.
export async function fetchClipsMap(folderId) {
  const map = {};
  if (!folderId) return map;
  const token = getAccessToken();
  if (!token) return map;

  try {
    let pageToken = '';
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
      url.searchParams.set('fields', 'nextPageToken, files(id, name)');
      url.searchParams.set('pageSize', '1000');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) break;
      const data = await res.json();
      for (const file of data.files || []) {
        const m = CLIP_FILENAME_RE.exec(file.name);
        if (m) map[parseInt(m[1], 10)] = file.id;
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
  } catch {
    // Leave whatever was found before the failure; clips are optional.
  }
  return map;
}
