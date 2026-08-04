# Audiobook Drive Player

A client-only (no backend) Progressive Web App that plays audiobooks stored
in your own Google Drive, with chapter navigation and resume-where-you-left-off.
Everything is static HTML/CSS/JS — hosted for free on GitHub Pages, no server
of any kind.

## How it works

- **Auth**: you sign in with Google (Identity Services), granting the app the
  narrow `drive.file` permission — it can only see files *you* explicitly pick,
  not your whole Drive.
- **Adding books**: tap "Add books from Drive" and pick your audio file(s)
  (and their matching `.chapters.json` sidecar, if you made one — see below)
  from the Google Picker. The picked file IDs are remembered in your browser,
  so you only do this once per book.
- **Playback/streaming**: a service worker intercepts the `<audio>` element's
  requests and proxies them to the Google Drive API with your access token
  attached, forwarding byte-range requests so seeking works without ever
  downloading the whole (multi-GB) file at once.
- **Chapters**: read from a small `<book>.chapters.json` file you generate
  once locally (via `scripts/generate-chapters.ps1`, using `ffprobe`) and
  upload next to the audio file in Drive. If a book has no sidecar, there's
  just no chapter list — resume-by-position still works.
- **Resume position**: saved to `localStorage` on your device, keyed per
  Drive file, updated continuously during playback.

### The one real limitation

Google no longer allows a backend-less app to silently refresh its login
in the background. Roughly once per hour of continuous listening, a small
"Tap to keep listening" banner appears — tapping it is instant (you're
already signed in, no re-typing anything), it just can't happen automatically.

## 1. Google Cloud Console setup (one-time, do this yourself)

You need your own Google Cloud project so the app can authenticate as
"your" app rather than someone else's.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and
   create a new project (any name, e.g. "Audiobook Player").
2. **Enable APIs**: in "APIs & Services" → "Library", enable:
   - Google Drive API
   - Google Picker API
3. **OAuth consent screen** ("APIs & Services" → "OAuth consent screen"):
   - User type: **External**
   - Fill in app name, your email as support/contact.
   - Scopes: add `.../auth/drive.file` (this is a **non-sensitive** scope —
     no Google verification review is required for it).
   - Publish the app to **"In production"** status (not "Testing") so your
     login doesn't expire after 7 days.
4. **Create an OAuth Client ID** ("APIs & Services" → "Credentials" →
   "Create Credentials" → "OAuth client ID"):
   - Application type: **Web application**
   - Authorized JavaScript origins: add both
     - `https://<your-github-username>.github.io` (your deployed Pages URL)
     - `http://localhost:8000` (or whatever port you use for local testing)
   - Copy the generated **Client ID**.
5. **Create an API key** (same "Credentials" page → "Create Credentials" →
   "API key") — used only by the Picker:
   - Restrict it to the **Google Picker API**.
   - Copy the key.
6. **Find your project number**: shown on the Cloud Console home/dashboard
   page for your project (a numeric ID, not the project name).

## 2. Configure the app

Edit `js/config.js`:

```js
export const CONFIG = {
  CLIENT_ID: '<your OAuth Client ID>.apps.googleusercontent.com',
  API_KEY: '<your Picker API key>',
  APP_ID: '<your Google Cloud project number>',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
};
```

## 3. Generate chapter sidecars

Requires `ffprobe` (part of [ffmpeg](https://ffmpeg.org/)) on your PATH.

```powershell
.\scripts\generate-chapters.ps1 -Path "C:\media\my_vampire_system"
```

This writes a `<name>.chapters.json` next to each `.m4a`/`.m4b`/`.mp3` file
in that folder. Files with no embedded chapters still get a sidecar (with an
empty chapter list) — this is harmless, the app just won't show a chapter
list for that book.

## 4. Upload to Google Drive

Upload both the audio files and their `.chapters.json` siblings to a folder
in your Google Drive (any folder — the app doesn't require a specific one).

## 5. Deploy

This repo is already set up for GitHub Pages — push to `main` and Pages
serves it at `https://<your-github-username>.github.io/audiobook-drive-player/`.

To test locally first (recommended, since it's easier to debug):

```powershell
npx serve .
# or: python -m http.server 8000
```

Then open `http://localhost:<port>` in Chrome — make sure that origin is
also in your OAuth Client's "Authorized JavaScript origins" (step 1.4 above).

## 6. Install on Android

Open the deployed URL in Chrome on your Android phone → menu (⋮) →
**"Add to Home screen"**. It launches full-screen like a native app from
then on.

## 7. Adding more books later

Open the app, tap "Add books from Drive" again, and pick the new audio file
+ its `.chapters.json` together. Previously added books stay in your library.

## Notes / known limitations

- **Token expiry**: see "The one real limitation" above — a tap roughly
  every hour of continuous playback.
- **Firefox**: service-worker Range-request passthrough only became
  reliable in recent Firefox versions. This app is built and tested against
  Chrome on Android, which has supported it for years.
- **Drive API daily quota**: personal use is nowhere near the limit (Drive
  imposes a project-wide egress cap, generously enough for hundreds of full
  audiobook plays per day).
