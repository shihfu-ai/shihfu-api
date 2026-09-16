// src/routes/emailAuth.js
// Lets a business connect their own Google account so reminder and
// campaign emails send through their own Gmail mailbox instead of a
// shared Shih-Fu address. Only the narrow gmail.send scope is
// requested — Shih-Fu never gets read access to their inbox — and
// tokens are encrypted at rest (src/utils/crypto.js).
const express = require('express');
const jwt     = require('jsonwebtoken');
const { google } = require('googleapis');
const { query } = require('../../config/database');
const { authenticate } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/crypto');
const R      = require('../utils/response');
const logger = require('../utils/logger');

const router = express.Router();

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
];

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function frontendUrl() {
  return process.env.FRONTEND_URL || 'http://localhost:3000';
}

// ─── GET /email-auth/google/connect-url ────────────────────────────
// Returns the Google consent screen URL for the logged-in business to
// visit. `state` carries the business id as a short-lived signed
// token so the callback (which Google redirects to directly, with no
// Authorization header) knows which business to attach the tokens to.
router.get('/google/connect-url', authenticate, (req, res) => {
  const state = jwt.sign(
    { businessId: req.user.businessId },
    process.env.JWT_SECRET + '_oauth_state',
    { expiresIn: '10m' }
  );

  const url = oauthClient().generateAuthUrl({
    access_type: 'offline',   // required to receive a refresh_token
    prompt:      'consent',   // forces a fresh refresh_token even on re-connect
    scope:       SCOPES,
    state,
  });

  return R.success(res, { url });
});

// ─── GET /email-auth/google/callback ───────────────────────────────
// Google redirects the browser here after consent — no app auth token
// is available, so the business is identified via the signed `state`.
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`${frontendUrl()}/dashboard/settings?email_error=${encodeURIComponent(String(error))}`);
  }

  try {
    const { businessId } = jwt.verify(state, process.env.JWT_SECRET + '_oauth_state');

    const client = oauthClient();
    const { tokens } = await client.getToken(String(code));

    if (!tokens.refresh_token) {
      // Google only issues a refresh_token on first consent (or when
      // prompt=consent forces re-consent); if it's still missing here
      // the account likely needs its prior access revoked first.
      return res.redirect(`${frontendUrl()}/dashboard/settings?email_error=${encodeURIComponent('Google did not return a refresh token — remove Shih-Fu from your Google Account\'s third-party access and try connecting again')}`);
    }

    client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: userinfo } = await oauth2.userinfo.get();

    await query(`
      INSERT INTO business_email_connections
        (business_id, provider, connected_email, access_token_enc, refresh_token_enc, token_expires_at, scope)
      VALUES ($1, 'google', $2, $3, $4, $5, $6)
      ON CONFLICT (business_id) DO UPDATE SET
        connected_email   = EXCLUDED.connected_email,
        access_token_enc  = EXCLUDED.access_token_enc,
        refresh_token_enc = EXCLUDED.refresh_token_enc,
        token_expires_at  = EXCLUDED.token_expires_at,
        scope             = EXCLUDED.scope,
        updated_at        = NOW()
    `, [
      businessId, userinfo.email,
      encrypt(tokens.access_token), encrypt(tokens.refresh_token),
      new Date(tokens.expiry_date), tokens.scope,
    ]);

    logger.info('Google email connected', { businessId, email: userinfo.email });
    return res.redirect(`${frontendUrl()}/dashboard/settings?email_connected=1`);
  } catch (err) {
    logger.error('Google OAuth callback error', { error: err.message });
    return res.redirect(`${frontendUrl()}/dashboard/settings?email_error=${encodeURIComponent('Could not connect your Google account')}`);
  }
});

// ─── GET /email-auth/google/status ─────────────────────────────────
router.get('/google/status', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT connected_email, connected_at FROM business_email_connections WHERE business_id = $1',
      [req.user.businessId]
    );
    if (!rows.length) return R.success(res, { connected: false });
    return R.success(res, { connected: true, email: rows[0].connected_email, connectedAt: rows[0].connected_at });
  } catch (err) {
    logger.error('Email connection status error', { error: err.message });
    return R.error(res);
  }
});

// ─── DELETE /email-auth/google/disconnect ──────────────────────────
router.delete('/google/disconnect', authenticate, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT access_token_enc FROM business_email_connections WHERE business_id = $1',
      [req.user.businessId]
    );

    if (rows.length) {
      try {
        const accessToken = decrypt(rows[0].access_token_enc);
        await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, { method: 'POST' });
      } catch (err) {
        logger.warn('Google token revoke failed (best-effort, disconnecting locally anyway)', { error: err.message });
      }
    }

    await query('DELETE FROM business_email_connections WHERE business_id = $1', [req.user.businessId]);
    return R.success(res, {}, 'Google account disconnected');
  } catch (err) {
    logger.error('Email disconnect error', { error: err.message });
    return R.error(res);
  }
});

module.exports = router;
