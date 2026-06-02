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

// Your Chrome Extension ID — update this if the ID ever changes.
const EXTENSION_ID    = 'aendgiccddokneeecomkliljadbhbeji';
const ALLOWED_ORIGIN  = `chrome-extension://${EXTENSION_ID}`;

// Google OAuth token endpoint.
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Redirect URI registered in Google Cloud Console.
const REDIRECT_URI = `https://${EXTENSION_ID}.chromiumapp.org`;

module.exports = async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
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

  // ── Route to appropriate grant ────────────────────────────────────
  if (grantType === 'authorization_code') {
    if (!code || typeof code !== 'string' || code.length > 512) {
      return res.status(400).json({ error: 'Invalid or missing code.' });
    }
    return await exchangeCode(res, CLIENT_ID, CLIENT_SECRET, code);
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
async function exchangeCode(res, clientId, clientSecret, code) {
  const params = new URLSearchParams({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  REDIRECT_URI,
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
