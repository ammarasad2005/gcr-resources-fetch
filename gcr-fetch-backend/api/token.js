/**
 * GCR Fetch Backend — api/token.js
 *
 * Serverless function deployed on Vercel.
 * Handles two operations:
 *   1. authorization_code — exchanges an auth code for access + refresh tokens.
 *   2. refresh_token      — uses a refresh token to get a new access token.
 *
 * The CLIENT_SECRET is stored as a Vercel environment variable and NEVER
 * appears in source code or extension files.
 *
 * Security:
 *  - CORS is restricted to the specific Chrome extension origin.
 *  - Only POST requests are accepted.
 *  - Input is validated strictly before forwarding to Google.
 *  - No tokens are logged or stored server-side.
 */

'use strict';

// Chrome Extension Configuration
const CHROME_EXTENSION_ID = 'fjcdbnkobmjngdbmgacmkgpggeblbhia';
const CHROME_ALLOWED_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}`;
const CHROME_REDIRECT_URI = `https://${CHROME_EXTENSION_ID}.chromiumapp.org`;

// Firefox Extension Configuration (Gecko ID: gcr-fetch@ammarasad.com)
const FIREFOX_REDIRECT_URI = 'http://127.0.0.1/mozoauth2/092c675322164b5501eb08e6e6f5e09fa69bd4cc';

// Google OAuth token endpoint.
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

module.exports = async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────
  const origin = req.headers.origin || '';
  let allowedOrigin = CHROME_ALLOWED_ORIGIN;
  if (origin === CHROME_ALLOWED_ORIGIN || origin.startsWith('moz-extension://') || origin === 'null') {
    allowedOrigin = origin;
  } else if (!origin) {
    allowedOrigin = '*';
  }
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Read secrets from environment ─────────────────────────────────
  const CLIENT_ID     = process.env.GCR_CLIENT_ID;
  const CLIENT_SECRET = process.env.GCR_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('[gcr-fetch] Missing environment variables.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  // ── Parse body ────────────────────────────────────────────────────
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body.' });
  }

  const { grantType, code, refreshToken } = body || {};

  const origin = req.headers.origin || '';
  const userAgent = req.headers['user-agent'] || '';
  const isFirefox = origin.startsWith('moz-extension://') || userAgent.includes('Firefox');
  const redirectUri = isFirefox ? FIREFOX_REDIRECT_URI : CHROME_REDIRECT_URI;

  // ── Route to appropriate grant ────────────────────────────────────
  if (grantType === 'authorization_code') {
    if (!code || typeof code !== 'string' || code.length > 512) {
      return res.status(400).json({ error: 'Invalid or missing code.' });
    }
    return await exchangeCode(res, CLIENT_ID, CLIENT_SECRET, code, redirectUri);
  }

  if (grantType === 'refresh_token') {
    if (!refreshToken || typeof refreshToken !== 'string' || refreshToken.length > 512) {
      return res.status(400).json({ error: 'Invalid or missing refreshToken.' });
    }
    return await refreshAccessToken(res, CLIENT_ID, CLIENT_SECRET, refreshToken);
  }

  return res.status(400).json({ error: 'Invalid grantType.' });
};

// ── Authorization code exchange ────────────────────────────────────
async function exchangeCode(res, clientId, clientSecret, code, redirectUri) {
  const params = new URLSearchParams({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    grant_type:    'authorization_code',
  });

  try {
    const googleRes = await fetch(GOOGLE_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });

    const data = await googleRes.json();

    if (!googleRes.ok) {
      // Forward Google's error description without logging sensitive details.
      return res.status(400).json({ error: data.error_description || 'Token exchange failed.' });
    }

    // Return only what the extension needs; never log tokens.
    return res.status(200).json({
      access_token:  data.access_token,
      refresh_token: data.refresh_token,
      expires_in:    data.expires_in,
    });
  } catch (err) {
    console.error('[gcr-fetch] Network error during code exchange.');
    return res.status(502).json({ error: 'Failed to reach Google token endpoint.' });
  }
}

// ── Refresh token exchange ─────────────────────────────────────────
async function refreshAccessToken(res, clientId, clientSecret, refreshToken) {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id:     clientId,
    client_secret: clientSecret,
    grant_type:    'refresh_token',
  });

  try {
    const googleRes = await fetch(GOOGLE_TOKEN_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });

    const data = await googleRes.json();

    if (!googleRes.ok) {
      return res.status(400).json({ error: data.error_description || 'Token refresh failed.' });
    }

    return res.status(200).json({
      access_token: data.access_token,
      expires_in:   data.expires_in,
    });
  } catch (err) {
    console.error('[gcr-fetch] Network error during token refresh.');
    return res.status(502).json({ error: 'Failed to reach Google token endpoint.' });
  }
}
