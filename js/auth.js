import { CONFIG } from './config.js';
import { setStoredToken } from './token-store.js';

let tokenClient = null;
let currentToken = null;
let expiresAt = 0;
let expiryTimer = null;
let onTokenChange = () => {};
let readyCallbacks = [];

// Defense in depth against the Google Identity Services <script> tag being
// slow to load (e.g. a poor mobile connection) — waits rather than throwing,
// so a slow load degrades to "button does nothing until ready" instead of
// silently aborting the rest of app.js's setup (which would leave every
// button on the page non-functional, not just login).
function waitForGoogleIdentity(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const start = Date.now();
    const interval = setInterval(() => {
      if (window.google?.accounts?.oauth2) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Google Identity Services script did not load in time'));
      }
    }, 50);
  });
}

export async function initAuth({ onTokenChange: cb } = {}) {
  onTokenChange = cb || onTokenChange;
  try {
    await waitForGoogleIdentity();
  } catch (err) {
    console.error(err);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: (resp) => {
      if (resp.error) {
        console.error('Google auth error:', resp);
        return;
      }
      handleNewToken(resp.access_token, resp.expires_in);
    },
  });
  readyCallbacks.forEach((cb2) => cb2());
  readyCallbacks = [];
}

// Fires immediately if auth is already initialized, otherwise once it is.
// Lets the UI (e.g. the login button) stay disabled until a click would
// actually do something.
export function onAuthReady(cb) {
  if (tokenClient) cb();
  else readyCallbacks.push(cb);
}

// Must be called directly from a user click handler. Google Identity Services
// requires a user gesture both for the very first login and for every later
// re-auth once the ~1hr access token expires — there is no silent-refresh
// path available to a client-only (no backend) app.
export function requestAccessToken() {
  if (!tokenClient) {
    console.warn('Google sign-in is not ready yet — please try again in a moment.');
    return;
  }
  tokenClient.requestAccessToken({ prompt: '' });
}

export function getAccessToken() {
  return currentToken;
}

export function isLoggedIn() {
  return !!currentToken;
}

function handleNewToken(token, expiresInSeconds) {
  currentToken = token;
  expiresAt = Date.now() + expiresInSeconds * 1000;
  setStoredToken(token, expiresAt);
  broadcastToServiceWorker(token, expiresAt);
  scheduleExpiryWarning();
  onTokenChange(token);
}

function broadcastToServiceWorker(token, expiresAtMs) {
  navigator.serviceWorker.ready.then((reg) => {
    reg.active?.postMessage({ type: 'ADP_TOKEN', token, expiresAt: expiresAtMs });
  });
}

function scheduleExpiryWarning() {
  clearTimeout(expiryTimer);
  const warnInMs = expiresAt - Date.now() - 5 * 60 * 1000;
  expiryTimer = setTimeout(() => {
    window.dispatchEvent(new CustomEvent('adp:token-expiring'));
  }, Math.max(warnInMs, 0));
}

// The setTimeout above is scheduled once, right after sign-in, for however
// many minutes out the 5-minutes-before point is — but a backgrounded tab
// (screen off, app switched away) gets its timers throttled or suspended by
// the browser, especially over the long stretches typical of audiobook
// listening. The timer can land much later than intended, or effectively
// never fire before the token has actually expired — so the person only
// finds out reactively, from a playback error, instead of with the 5-minute
// notice this was supposed to give them. Re-checking the ACTUAL remaining
// time (wall-clock expiresAt vs Date.now(), not a timer's own sense of
// elapsed time) every time the tab becomes visible again catches that case:
// coming back to a phone whose screen was off for 20 minutes immediately
// re-evaluates and fires the same warning right away if the token is
// already within (or past) the window, rather than waiting on a timer that
// may never make it there.
function checkExpirySoon() {
  if (!expiresAt) return;
  if (expiresAt - Date.now() <= 5 * 60 * 1000) {
    window.dispatchEvent(new CustomEvent('adp:token-expiring'));
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkExpirySoon();
});
