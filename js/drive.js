import { getAccessToken } from './auth.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

async function listChildren(folderId, token) {
  const files = [];
  let pageToken = '';
  do {
    const url = new URL('https://www.googleapis.com/drive/v3/files');
    url.searchParams.set('q', `'${folderId}' in parents and trashed = false`);
    url.searchParams.set('fields', 'nextPageToken, files(id, name, mimeType)');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Drive files.list failed (${res.status})`);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

// Recursively lists every non-folder file inside a Drive folder and all of
// its subfolders. The "add library folder" grant covers the whole subtree,
// so books, chapter sidecars, and clips can be organized into subfolders
// (e.g. mirroring a local "ComfyUI/output/" layout) instead of needing to
// be flattened into one directory first.
export async function listFilesRecursive(folderId) {
  if (!folderId) return [];
  const token = getAccessToken();
  if (!token) return [];

  const result = [];
  const queue = [folderId];
  while (queue.length) {
    const children = await listChildren(queue.shift(), token);
    for (const file of children) {
      if (file.mimeType === FOLDER_MIME) queue.push(file.id);
      else result.push(file);
    }
  }
  return result;
}
