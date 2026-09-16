// src/routes/campaigns.js
// Bulk messages to a business's whole customer base — festival
// greetings, promos, seasonal offers. Sent immediately or scheduled
// for a future date; scheduled ones are picked up by campaignCron.
const express = require('express');
const { query, withTransaction } = require('../../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, schemas }       = require('../middleware/validate');
const { dispatchCampaign }        = require('../services/campaignCron');
const R      = require('../utils/response');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

// ─── GET /campaigns ────────────────────────────────────────────────
// All campaigns for the business, most recently scheduled first —
// lets the owner see what's already queued up for the year.
router.get('/', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const { rows } = await query(`
      SELECT * FROM campaigns WHERE business_id = $1 ORDER BY scheduled_at DESC LIMIT 100
    `, [businessId]);
    return R.success(res, rows);
  } catch (err) {
    logger.error('List campaigns error', { error: err.message });
    return R.error(res);
  }
});

// ─── POST /campaigns ───────────────────────────────────────────────
// Create a campaign. If scheduledAt is now (or already past by the
// time validation clamps it), dispatch it inline so "Send Now" feels
// immediate rather than waiting for the next cron tick.
router.post('/', validate(schemas.createCampaign), async (req, res) => {
  const businessId = req.user.businessId;
  const data       = req.body;

  try {
    const { rows: [campaign] } = await query(`
      INSERT INTO campaigns (business_id, created_by, label, message_body, channels, scheduled_at, status)
      VALUES ($1,$2,$3,$4,$5,$6,'scheduled')
      RETURNING *
    `, [businessId, req.user.staffId, data.label, data.messageBody, data.channels, data.scheduledAt]);

    const isDueNow = new Date(data.scheduledAt).getTime() <= Date.now() + 60_000;
    if (isDueNow) {
      const result = await dispatchCampaign(campaign);
      return R.created(res, { ...campaign, ...result, status: 'sent' }, `Sent to ${result.sent} customers`);
    }

    return R.created(res, campaign, `Campaign scheduled for ${new Date(data.scheduledAt).toLocaleDateString('en-IN')}`);
  } catch (err) {
    logger.error('Create campaign error', { error: err.message, businessId });
    return R.error(res);
  }
});

// ─── PATCH /campaigns/:id/cancel ───────────────────────────────────
router.patch('/:id/cancel', authorize('owner', 'manager'), async (req, res) => {
  const businessId = req.user.businessId;
  const { id }     = req.params;
  try {
    const { rows } = await query(`
      UPDATE campaigns SET status = 'cancelled'
      WHERE id = $1 AND business_id = $2 AND status = 'scheduled'
      RETURNING id
    `, [id, businessId]);
    if (!rows.length) return R.notFound(res, 'Campaign not found or already sent');
    return R.success(res, { id: rows[0].id }, 'Campaign cancelled');
  } catch (err) {
    logger.error('Cancel campaign error', { error: err.message, id });
    return R.error(res);
  }
});

module.exports = router;
