// src/routes/reminders.js
const express = require('express');
const { query, withTransaction } = require('../../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, schemas }       = require('../middleware/validate');
const messagingService = require('../services/messaging');
const R      = require('../utils/response');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

// ─── GET /reminders ───────────────────────────────────────────────
// Full queue with urgency grouping
router.get('/', validate(schemas.listQuery, 'query'), async (req, res) => {
  const { page, limit, status, channel, from, to } = req.query;
  const businessId = req.user.businessId;
  const offset = (page - 1) * limit;

  try {
    const conditions = ['r.business_id = $1'];
    const params = [businessId];
    let p = 2;

    if (status)  { conditions.push(`r.status = $${p}`);  params.push(status);  p++; }
    if (channel) { conditions.push(`r.channel = $${p}`); params.push(channel); p++; }
    if (from)    { conditions.push(`r.scheduled_at >= $${p}`); params.push(from); p++; }
    if (to)      { conditions.push(`r.scheduled_at <= $${p}`); params.push(to);   p++; }

    const where = 'WHERE ' + conditions.join(' AND ');

    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM reminders r ${where}`, params),
      query(`
        SELECT
          r.*,
          c.name AS customer_name, c.phone AS customer_phone,
          c.email AS customer_email, c.preferred_channel,
          e.name AS entity_name, e.breed_or_model,
          CASE
            WHEN r.scheduled_at < NOW()              THEN 'overdue'
            WHEN r.scheduled_at::DATE = CURRENT_DATE THEN 'today'
            ELSE 'upcoming'
          END AS urgency,
          r.scheduled_at::DATE - CURRENT_DATE AS days_until_due
        FROM reminders r
        JOIN customers c ON c.id = r.customer_id
        LEFT JOIN customer_entities e ON e.id = r.entity_id
        ${where}
        ORDER BY r.scheduled_at ASC
        LIMIT $${p} OFFSET $${p+1}
      `, [...params, limit, offset]),
    ]);

    return R.paginated(res, dataRes.rows, parseInt(countRes.rows[0].count), page, limit);
  } catch (err) {
    logger.error('List reminders error', { error: err.message });
    return R.error(res);
  }
});

// ─── GET /reminders/summary ───────────────────────────────────────
// Queue counts for dashboard KPIs
router.get('/summary', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_at < NOW())                       AS overdue,
        COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_at::DATE = CURRENT_DATE)          AS today,
        COUNT(*) FILTER (WHERE status = 'scheduled' AND scheduled_at > NOW())                       AS upcoming,
        COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')
                         AND sent_at >= DATE_TRUNC('month', NOW()))                                 AS sent_this_month,
        COUNT(*) FILTER (WHERE status = 'responded')                                                AS responded
      FROM reminders
      WHERE business_id = $1
    `, [businessId]);

    return R.success(res, rows[0]);
  } catch (err) {
    logger.error('Reminder summary error', { error: err.message });
    return R.error(res);
  }
});

// ─── POST /reminders ──────────────────────────────────────────────
// Manually create a reminder
router.post('/', validate(schemas.createReminder), async (req, res) => {
  const businessId = req.user.businessId;
  const data       = req.body;

  try {
    const { rows: [customer] } = await query(
      'SELECT id FROM customers WHERE id = $1 AND business_id = $2',
      [data.customerId, businessId]
    );
    if (!customer) return R.notFound(res, 'Customer not found');

    const { rows: [reminder] } = await query(`
      INSERT INTO reminders
        (business_id, customer_id, entity_id, service_event_id, template_id,
         reminder_type, channel, scheduled_at, status, message_body, message_subject)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled',$9,$10)
      RETURNING *
    `, [
      businessId, data.customerId, data.entityId || null,
      data.serviceEventId || null, data.templateId || null,
      data.reminderType, data.channel, data.scheduledAt,
      data.messageBody || null, data.messageSubject || null,
    ]);

    return R.created(res, reminder, 'Reminder scheduled');
  } catch (err) {
    logger.error('Create reminder error', { error: err.message });
    return R.error(res);
  }
});

// ─── POST /reminders/:id/send ─────────────────────────────────────
// Manually trigger sending a specific reminder NOW
router.post('/:id/send', async (req, res) => {
  const businessId = req.user.businessId;
  const { id }     = req.params;

  try {
    const { rows } = await query(`
      SELECT r.*, c.name AS customer_name, c.phone, c.email,
             e.name AS entity_name
      FROM reminders r
      JOIN customers c ON c.id = r.customer_id
      LEFT JOIN customer_entities e ON e.id = r.entity_id
      WHERE r.id = $1 AND r.business_id = $2
    `, [id, businessId]);

    if (!rows.length) return R.notFound(res, 'Reminder not found');
    const reminder = rows[0];

    if (reminder.status === 'sent') {
      return R.badRequest(res, 'Reminder already sent');
    }

    const sendResult = await messagingService.send(reminder);

    // Update reminder record
    await query(`
      UPDATE reminders
      SET status = $1, sent_at = NOW(), attempt_count = attempt_count + 1,
          last_attempt_at = NOW(),
          twilio_sid = $2, whatsapp_msg_id = $3, email_msg_id = $4
      WHERE id = $5
    `, [
      sendResult.success ? 'sent' : 'failed',
      sendResult.twilioSid || null,
      sendResult.whatsappMsgId || null,
      sendResult.emailMsgId || null,
      id,
    ]);

    // Log to message_log
    await query(`
      INSERT INTO message_log
        (business_id, customer_id, reminder_id, channel, recipient,
         message_body, provider, provider_msg_id, status, consent_verified)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, true)
    `, [
      businessId, reminder.customer_id, id, reminder.channel,
      reminder.channel === 'email' ? reminder.email : reminder.phone,
      reminder.message_body,
      sendResult.provider, sendResult.providerId,
      sendResult.success ? 'sent' : 'failed',
    ]);

    if (!sendResult.success) {
      return R.error(res, `Message delivery failed: ${sendResult.error}`, 502);
    }

    return R.success(res, { reminderId: id, channel: reminder.channel }, 'Reminder sent successfully');
  } catch (err) {
    logger.error('Send reminder error', { error: err.message, id });
    return R.error(res);
  }
});

// ─── POST /reminders/send-overdue ────────────────────────────────
// Bulk send all overdue reminders for the business
router.post('/send-overdue', authorize('owner', 'manager'), async (req, res) => {
  const businessId = req.user.businessId;

  try {
    const { rows: overdue } = await query(`
      SELECT r.*, c.name AS customer_name, c.phone, c.email
      FROM reminders r
      JOIN customers c ON c.id = r.customer_id
      WHERE r.business_id = $1
        AND r.status = 'scheduled'
        AND r.scheduled_at < NOW()
        AND r.attempt_count < 3
      ORDER BY r.scheduled_at ASC
      LIMIT 50
    `, [businessId]);

    if (!overdue.length) return R.success(res, { sent: 0 }, 'No overdue reminders to send');

    let sent = 0, failed = 0;
    for (const reminder of overdue) {
      const result = await messagingService.send(reminder);
      await query(`
        UPDATE reminders
        SET status = $1, sent_at = CASE WHEN $2 THEN NOW() ELSE sent_at END,
            attempt_count = attempt_count + 1, last_attempt_at = NOW()
        WHERE id = $3
      `, [result.success ? 'sent' : 'failed', result.success, reminder.id]);

      result.success ? sent++ : failed++;
    }

    return R.success(res, { sent, failed, total: overdue.length }, `${sent} reminders sent`);
  } catch (err) {
    logger.error('Send overdue error', { error: err.message });
    return R.error(res);
  }
});

// ─── PATCH /reminders/:id/skip ────────────────────────────────────
router.patch('/:id/skip', async (req, res) => {
  const businessId = req.user.businessId;
  const { id }     = req.params;

  try {
    const { rows } = await query(`
      UPDATE reminders SET status = 'skipped'
      WHERE id = $1 AND business_id = $2 AND status = 'scheduled'
      RETURNING id
    `, [id, businessId]);

    if (!rows.length) return R.notFound(res, 'Reminder not found or already processed');
    return R.success(res, { id: rows[0].id }, 'Reminder skipped');
  } catch (err) {
    return R.error(res);
  }
});

module.exports = router;
