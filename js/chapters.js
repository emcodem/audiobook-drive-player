import { getAccessToken } from './auth.js';

// Fetches a "<book>.chapters.json" sidecar (see scripts/generate-chapters.ps1).
// This is a small JSON GET done directly from the page (with an Authorization
// header) — unlike audio playback, it doesn't need the service worker's
// Range-proxying since we're not seeking within it or worried about size.
export async function fetchChapters(chaptersFileId) {
  if (!chaptersFileId) return null;
  const token = getAccessToken();
  if (!token) return null;

  try {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${chaptersFileId}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.chapters) || !data.chapters.length) return null;
    return data;
  } catch {
    return null;
  }
}
