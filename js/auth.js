import { CONFIG } from './config.js';
import { setStoredToken } from './token-store.js';

let tokenClient = null;
let currentToken = null;
let expiresAt = 0;
let expiryTimer = null;
let onTokenChange = () => {};

export function initAuth({ onTokenChange: cb } = {}) {
  onTokenChange = cb || onTokenChange;
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
}

// Must be called directly from a user click handler. Google Identity Services
// requires a user gesture both for the very first login and for every later
// re-auth once the ~1hr access token expires — there is no silent-refresh
// path available to a client-only (no backend) app.
export function requestAccessToken() {
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
