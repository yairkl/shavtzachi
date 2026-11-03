/* global google */
// Google Identity Services token management (serverless, browser-only).
export const CLIENT_ID = '164567961502-8kl22d26nc1iekcil8d8pgmk5q9iie6g.apps.googleusercontent.com';
export const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly';

const TOKEN_KEY = 'google_access_token';
const EXPIRY_KEY = 'google_token_expiry';
const LEGACY_KEY = 'gsheets_access_token';
const SKEW_MS = 60 * 1000; // refresh a minute before expiry

const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const safeDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

const listeners = new Set();
let refreshTimer = null;
let inflight = null;

/** Subscribe to session events: 'expired' | 'refreshed'. Returns unsubscribe fn. */
export function onSessionEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (type) => listeners.forEach((fn) => fn(type));

export function getStoredToken() {
  return safeGet(TOKEN_KEY);
}

export function isTokenValid() {
  const token = getStoredToken();
  if (!token) return false;
  const expiry = Number(safeGet(EXPIRY_KEY));
  // Tokens saved before expiry tracking existed have no expiry: treat as unknown/expired.
  return !!expiry && Date.now() < expiry - SKEW_MS;
}

function waitForGoogle(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (typeof google !== 'undefined' && google.accounts?.oauth2) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('Google sign-in library failed to load'));
      setTimeout(check, 100);
    };
    check();
  });
}

function storeToken(response) {
  safeSet(TOKEN_KEY, response.access_token);
  safeDel(LEGACY_KEY);
  const ttl = Number(response.expires_in) || 3600;
  safeSet(EXPIRY_KEY, String(Date.now() + ttl * 1000));
  scheduleRefresh();
}

/**
 * Request an access token from Google.
 * interactive=false tries silently (no popup); interactive=true may open the consent/account popup.
 */
export async function requestToken({ interactive = false } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    await waitForGoogle();
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        prompt: interactive ? '' : 'none',
        callback: (response) => {
          if (response.access_token) {
            storeToken(response);
            emit('refreshed');
            resolve(response.access_token);
          } else {
            reject(new Error(response.error || 'Sign-in failed'));
          }
        },
        error_callback: (err) => reject(new Error(err?.type || 'Sign-in failed')),
      });
      client.requestAccessToken();
    });
  })().finally(() => { inflight = null; });
  return inflight;
}

/** Try to get a valid token without user interaction. Returns the token or null. */
export async function ensureToken() {
  if (isTokenValid()) {
    scheduleRefresh();
    return getStoredToken();
  }
  if (!getStoredToken()) return null;
  try {
    return await requestToken({ interactive: false });
  } catch {
    return null;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const expiry = Number(safeGet(EXPIRY_KEY));
  if (!expiry) return;
  const delay = Math.max(expiry - SKEW_MS - Date.now(), 5000);
  refreshTimer = setTimeout(async () => {
    try {
      await requestToken({ interactive: false });
    } catch {
      emit('expired');
    }
  }, delay);
}

export function clearSession() {
  clearTimeout(refreshTimer);
  safeDel(TOKEN_KEY);
  safeDel(EXPIRY_KEY);
  safeDel(LEGACY_KEY);
}

export function logout() {
  const token = getStoredToken();
  clearSession();
  try {
    if (token && typeof google !== 'undefined') google.accounts.oauth2.revoke(token, () => {});
  } catch { /* ignore */ }
}

export function notifyExpired() {
  emit('expired');
}
