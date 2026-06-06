/**
 * GCR Fetch — background.js (MV3 Service Worker)
 *
 * Handles OAuth 2.0 authentication using chrome.identity.launchWebAuthFlow.
 * This works with ANY Google account regardless of the Chrome browser profile.
 *
 * Flow:
 *  1. LAUNCH_AUTH_FLOW  → opens Google consent popup → gets auth code
 *                       → sends code to Vercel backend → gets tokens
 *                       → stores tokens in chrome.storage.local
 *  2. GET_AUTH_TOKEN    → returns a valid access token (refreshing if expired)
 *  3. FETCH_WITH_AUTH   → proxies authenticated API calls from the extension
 *  4. SIGN_OUT          → clears all stored tokens
 *
 * Security:
 *  - CLIENT_SECRET never appears here — it lives on the Vercel backend only.
 *  - Tokens are stored in chrome.storage.local (sandboxed to this extension).
 *  - All API proxying enforces an HTTPS-only, Google-domain allowlist.
 *  - No tokens are ever logged.
 */

'use strict';

// ── Constants ──────────────────────────────────────────────────────
const CLIENT_ID = '30149362431-qq5ivt0rcsi178q3msf61ko5gvsblfhm.apps.googleusercontent.com';
const EXTENSION_ID = 'fjcdbnkobmjngdbmgacmkgpggeblbhia';

const isFirefox = typeof browser !== 'undefined' || (typeof chrome !== 'undefined' && chrome.runtime.getURL && chrome.runtime.getURL('').startsWith('moz-extension://'));
const REDIRECT_URI = isFirefox
  ? 'http://127.0.0.1/mozoauth2/092c675322164b5501eb08e6e6f5e09fa69bd4cc'
  : `https://${EXTENSION_ID}.chromiumapp.org`;

const BACKEND_URL = 'https://gcr-fetch-backend.vercel.app';

const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'email',
  'profile',
].join(' ');

// Buffer (in ms): refresh the token 2 minutes before it expires.
const EXPIRY_BUFFER_MS = 2 * 60 * 1000;

// ── Message router ─────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  switch (message.type) {
    case 'GET_AUTH_TOKEN':
      handleGetAuthToken(sendResponse);
      return true;

    case 'LAUNCH_AUTH_FLOW':
      handleLaunchAuthFlow(sendResponse);
      return true;

    case 'FETCH_WITH_AUTH':
      handleFetchWithAuth(message, sendResponse);
      return true;

    case 'SIGN_OUT':
      handleSignOut(sendResponse);
      return true;

    case 'GET_USER_INFO':
      handleGetUserInfo(sendResponse);
      return true;

    default:
      return false;
  }
});

// ── GET_AUTH_TOKEN ─────────────────────────────────────────────────
/**
 * Returns a valid access token from storage, refreshing it if expired.
 * If no token exists, reports that the user needs to sign in.
 */
async function handleGetAuthToken(sendResponse) {
  try {
    const token = await getValidAccessToken();
    if (token) {
      sendResponse({ success: true, token });
    } else {
      sendResponse({ success: false, needsSignIn: true });
    }
  } catch (err) {
    sendResponse({ success: false, needsSignIn: true });
  }
}

// ── LAUNCH_AUTH_FLOW ───────────────────────────────────────────────
/**
 * Opens the Google OAuth consent popup.
 * On success, exchanges the auth code for tokens via the Vercel backend.
 */
async function handleLaunchAuthFlow(sendResponse) {
  const authUrl = buildAuthUrl();

  chrome.identity.launchWebAuthFlow(
    { url: authUrl, interactive: true },
    async (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        sendResponse({
          success: false,
          error: chrome.runtime.lastError?.message || 'Auth flow cancelled.',
        });
        return;
      }

      // Extract the authorization code from the redirect URL.
      let code;
      try {
        const url = new URL(redirectUrl);
        code = url.searchParams.get('code');
        const errorParam = url.searchParams.get('error');
        if (errorParam) {
          sendResponse({ success: false, error: `Google auth error: ${errorParam}` });
          return;
        }
      } catch {
        sendResponse({ success: false, error: 'Failed to parse redirect URL.' });
        return;
      }

      if (!code) {
        sendResponse({ success: false, error: 'No authorization code returned.' });
        return;
      }

      // Exchange the code for tokens via the Vercel backend.
      try {
        const tokens = await exchangeCodeForTokens(code);
        await storeTokens(tokens);

        // Fetch and store the user's profile info.
        const userInfo = await fetchUserInfo(tokens.access_token);
        await chrome.storage.local.set({ gcr_user: userInfo });

        sendResponse({ success: true, userInfo });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    }
  );
}

// ── SIGN_OUT ───────────────────────────────────────────────────────
async function handleSignOut(sendResponse) {
  await chrome.storage.local.remove([
    'gcr_access_token',
    'gcr_refresh_token',
    'gcr_token_expiry',
    'gcr_user',
  ]);
  sendResponse({ success: true });
}

// ── GET_USER_INFO ──────────────────────────────────────────────────
async function handleGetUserInfo(sendResponse) {
  const data = await chrome.storage.local.get('gcr_user');
  sendResponse({ success: true, userInfo: data.gcr_user || null });
}

// ── FETCH_WITH_AUTH ────────────────────────────────────────────────
/**
 * Proxies an authenticated fetch through the service worker.
 * Only allows requests to Google's API domains over HTTPS.
 */
async function handleFetchWithAuth(message, sendResponse) {
  const { url, responseType, method = 'GET', body, headers = {} } = message;

  const ALLOWED_ORIGINS = [
    'https://classroom.googleapis.com',
    'https://www.googleapis.com',
    'https://drive.google.com',
    'https://docs.google.com',
  ];

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    sendResponse({ success: false, error: 'Invalid URL' });
    return;
  }

  if (parsedUrl.protocol !== 'https:') {
    sendResponse({ success: false, error: 'Only HTTPS URLs are allowed' });
    return;
  }

  const isAllowed = ALLOWED_ORIGINS.some((o) => parsedUrl.origin === o);
  if (!isAllowed) {
    sendResponse({ success: false, error: 'URL not in allowed origins' });
    return;
  }

  let token;
  try {
    token = await getValidAccessToken();
  } catch {
    token = null;
  }

  if (!token) {
    sendResponse({ success: false, needsSignIn: true, error: 'No valid auth token. Please sign in.' });
    return;
  }

  try {
    const fetchOptions = {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}` },
    };
    if (body) {
      fetchOptions.body = body;
    }

    const response = await fetch(url, fetchOptions);

    if (response.status === 401) {
      // Token rejected — clear stored tokens so user is prompted to re-sign in.
      await chrome.storage.local.remove(['gcr_access_token', 'gcr_token_expiry']);
      sendResponse({ success: false, needsSignIn: true, error: 'Session expired. Please sign in again.' });
      return;
    }

    if (!response.ok) {
      let errorDetail = response.statusText;
      try {
        // Clone first so we can still read body on non-OK responses
        const errJson = await response.clone().json();
        const msg = errJson?.error?.message || errJson?.message;
        if (msg) errorDetail = msg;
      } catch {
        try {
          const errText = await response.text();
          if (errText) errorDetail = errText.slice(0, 200); // cap length
        } catch { /* ignore */ }
      }
      sendResponse({ success: false, error: `HTTP ${response.status}: ${errorDetail}` });
      return;
    }

    if (responseType === 'blob') {
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < uint8Array.length; i += chunkSize) {
        binary += String.fromCharCode(...uint8Array.subarray(i, i + chunkSize));
      }
      sendResponse({ success: true, data: btoa(binary), mimeType: blob.type });
    } else if (responseType === 'json') {
      const json = await response.json();
      sendResponse({ success: true, data: json });
    } else {
      const text = await response.text();
      sendResponse({ success: true, data: text });
    }
  } catch {
    console.error('[GCR Fetch] Fetch proxy error');
    sendResponse({ success: false, error: 'Network error during fetch' });
  }
}

// ── Token helpers ──────────────────────────────────────────────────

function buildAuthUrl() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',   // Always show consent to get a refresh token.
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCodeForTokens(code) {
  const res = await fetch(`${BACKEND_URL}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantType: 'authorization_code', code }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Token exchange failed.');
  return data;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(`${BACKEND_URL}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantType: 'refresh_token', refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Token refresh failed.');
  return data;
}

async function storeTokens(tokens) {
  const expiry = Date.now() + (tokens.expires_in * 1000);
  const toStore = {
    gcr_access_token: tokens.access_token,
    gcr_token_expiry: expiry,
  };
  if (tokens.refresh_token) {
    toStore.gcr_refresh_token = tokens.refresh_token;
  }
  await chrome.storage.local.set(toStore);
}

async function getValidAccessToken() {
  const data = await chrome.storage.local.get([
    'gcr_access_token',
    'gcr_refresh_token',
    'gcr_token_expiry',
  ]);

  const { gcr_access_token, gcr_refresh_token, gcr_token_expiry } = data;

  // No tokens at all — user needs to sign in.
  if (!gcr_access_token) return null;

  // Token still valid.
  if (gcr_token_expiry && Date.now() < gcr_token_expiry - EXPIRY_BUFFER_MS) {
    return gcr_access_token;
  }

  // Token expired — try to refresh.
  if (gcr_refresh_token) {
    try {
      const refreshed = await refreshAccessToken(gcr_refresh_token);
      await storeTokens(refreshed);
      return refreshed.access_token;
    } catch {
      // Refresh failed — user must re-authenticate.
      return null;
    }
  }

  return null;
}

async function fetchUserInfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  // Return only the fields we need.
  return {
    email: data.email || '',
    name: data.name || '',
    picture: data.picture || '',
  };
}
