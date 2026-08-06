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

// Picks every "chNNN_final.mp4" out of an already-fetched file list (see
// drive.js's listFilesRecursive) and returns a { chapterNumber: fileId }
// map. Takes the list rather than fetching it itself so the caller can
// share one Drive listing between this and syncBooksFolder instead of
// scanning the same folder twice.
export function buildClipsMap(files) {
  const map = {};
  for (const file of files) {
    const m = CLIP_FILENAME_RE.exec(file.name);
    if (m) map[parseInt(m[1], 10)] = file.id;
  }
  return map;
}

// Files that look like they were meant to be a clip (contain "final" or end
// in .mp4) but didn't match CLIP_FILENAME_RE — surfaced so a naming
// mismatch is visible instead of just silently showing up as "0 found".
export function findClipNearMisses(files) {
  return files
    .filter((f) => !CLIP_FILENAME_RE.test(f.name))
    .filter((f) => /final/i.test(f.name) || /\.mp4$/i.test(f.name))
    .map((f) => f.name);
}
