// src/routes/checkin.js
// Quick check-in form: a public, no-login page a business shows on an
// iPad/display at the counter, or sends as a link to someone booking
// by phone, so the customer fills in their own basic details.
//
//   Public  (token is the only protection):
//     GET  /public/checkin/:token   business name + vertical for the form
//     POST /public/checkin/:token   submit a check-in
//   Business (logged in):
//     GET  /business/checkin-link             the shareable token
//     POST /business/checkin-link/regenerate  invalidate the old link
const crypto  = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { query, withTransaction } = require('../../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, schemas }       = require('../middleware/validate');
const R      = require('../utils/response');
const logger = require('../utils/logger');

const publicRouter   = express.Router();
const businessRouter = express.Router();

const newToken = () => crypto.randomBytes(12).toString('base64url');

// Anyone with the link can post, so cap submissions per IP. One shared
// counter iPad is a single IP, hence the fairly generous ceiling.
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  message: { success: false, message: 'Too many check-ins from this device. Please try again shortly.' },
});

async function findBusiness(token) {
  const { rows } = await query(
    'SELECT id, name, vertical, max_customers FROM businesses WHERE checkin_token = $1 AND is_active = true',
    [token]
  );
  return rows[0] || null;
}

// ─── GET /public/checkin/:token ────────────────────────────────────
publicRouter.get('/:token', async (req, res) => {
  try {
    const business = await findBusiness(req.params.token);
    if (!business) return R.notFound(res, 'This check-in link is not valid');
    return R.success(res, { businessName: business.name, vertical: business.vertical });
  } catch (err) {
    logger.error('Check-in lookup error', { error: err.message });
    return R.error(res);
  }
});

// ─── POST /public/checkin/:token ───────────────────────────────────
publicRouter.post('/:token', submitLimiter, validate(schemas.publicCheckin), async (req, res) => {
  const { name, phone, email, city, channels, entity } = req.body;

  try {
    const business = await findBusiness(req.params.token);
    if (!business) return R.notFound(res, 'This check-in link is not valid');

    // Someone already on file — never overwrite from an unauthenticated
    // form (anyone with the link could otherwise edit a real customer's
    // record). The business can update them from the dashboard.
    const { rows: [existing] } = await query(
      'SELECT id FROM customers WHERE business_id = $1 AND phone = $2', [business.id, phone]
    );
    if (existing) return R.success(res, { status: 'existing', businessName: business.name }, 'Welcome back');

    const { rows: [cnt] } = await query('SELECT COUNT(*) FROM customers WHERE business_id = $1', [business.id]);
    if (parseInt(cnt.count) >= business.max_customers) {
      return R.error(res, 'We are not able to take new check-ins online right now. Please see the front desk.', 403);
    }

    const assetData = entity?.assetData || {};
    const hasEntity = entity?.name || Object.values(assetData).some(v => v);

    await withTransaction(async (client) => {
      const { rows: [customer] } = await client.query(`
        INSERT INTO customers
          (business_id, name, phone, email, city, preferred_channel,
           opted_in_whatsapp, opted_in_sms, opted_in_email, opted_in_at,
           tags, source, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
                CASE WHEN ($7 OR $8 OR $9) THEN NOW() ELSE NULL END,
                ARRAY['checkin'],'checkin','active')
        RETURNING id
      `, [
        business.id, name, phone, email || null, city || null,
        channels[0] || 'whatsapp',
        channels.includes('whatsapp'), channels.includes('sms'), channels.includes('email'),
      ]);

      if (hasEntity) {
        await client.query(`
          INSERT INTO customer_entities (customer_id, business_id, name, entity_type, asset_data, retention_data)
          VALUES ($1,$2,$3,$4,$5,'{}'::jsonb)
        `, [customer.id, business.id, entity?.name || null, business.vertical, JSON.stringify(assetData)]);
      }
    });

    logger.info('Customer checked in', { businessId: business.id });
    return R.created(res, { status: 'created', businessName: business.name }, 'Checked in');
  } catch (err) {
    if (err.code === '23505') return R.success(res, { status: 'existing', businessName: '' }, 'Welcome back');
    logger.error('Check-in submit error', { error: err.message });
    return R.error(res);
  }
});

// ─── GET /business/channel-status ──────────────────────────────────
businessRouter.get('/channel-status', authenticate, async (req, res) => {
  try {
    return R.success(res, await require('../services/messaging').getChannelStatus(req.user.businessId));
  } catch (err) {
    logger.error('Channel status error', { error: err.message });
    return R.error(res);
  }
});

// ─── GET /business/checkin-link ────────────────────────────────────
businessRouter.get('/checkin-link', authenticate, async (req, res) => {
  try {
    const { rows: [b] } = await query('SELECT checkin_token FROM businesses WHERE id = $1', [req.user.businessId]);
    let token = b?.checkin_token;
    if (!token) {
      token = newToken();
      await query('UPDATE businesses SET checkin_token = $1 WHERE id = $2', [token, req.user.businessId]);
    }
    return R.success(res, { token });
  } catch (err) {
    logger.error('Get check-in link error', { error: err.message });
    return R.error(res);
  }
});

// ─── POST /business/checkin-link/regenerate ────────────────────────
businessRouter.post('/checkin-link/regenerate', authenticate, authorize('owner', 'manager'), async (req, res) => {
  try {
    const token = newToken();
    await query('UPDATE businesses SET checkin_token = $1 WHERE id = $2', [token, req.user.businessId]);
    return R.success(res, { token }, 'New link created. The old link no longer works.');
  } catch (err) {
    logger.error('Regenerate check-in link error', { error: err.message });
    return R.error(res);
  }
});

module.exports = { publicRouter, businessRouter };
