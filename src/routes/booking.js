// src/routes/booking.js
// Appointment booking from follow-up messages.
//
//   Public (the link token is the only protection):
//     GET  /public/book/:token          what the customer sees + open slots (counts a click)
//     POST /public/book/:token          book (or move) an appointment
//     POST /public/book/:token/cancel   cancel it
//   Business (logged in):
//     GET   /appointments               list (upcoming | past | all)
//     GET   /appointments/summary       counts for the dashboard
//     POST  /appointments               add one by hand
//     PATCH /appointments/:id           mark completed / no-show / cancelled, notes
//     GET   /business/booking-settings  hours, slot length, capacity
//     PUT   /business/booking-settings
const express   = require('express');
const rateLimit = require('express-rate-limit');
const { query, withTransaction } = require('../../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, schemas }       = require('../middleware/validate');
const booking = require('../services/booking');
const R       = require('../utils/response');
const logger  = require('../utils/logger');

const publicRouter       = express.Router();
const appointmentsRouter = express.Router();
const settingsRouter     = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
appointmentsRouter.param('id', (req, res, next, val) => (UUID_RE.test(val) ? next() : R.notFound(res, 'Not found')));

// Shared NAT addresses (offices, mobile carriers) mean many real customers
// can arrive from one IP, so page views get a generous ceiling; writes are
// tighter because each one creates a row.
const viewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 120,
  message: { success: false, message: 'Too many requests. Please try again shortly.' },
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: { success: false, message: 'Too many booking attempts. Please try again shortly.' },
});

// ─── Public ───────────────────────────────────────────────────────
async function loadLink(token) {
  const { rows } = await query(`
    SELECT bl.*, c.name AS customer_name, c.status AS customer_status,
           b.name AS business_name, b.phone AS business_phone, b.booking_settings,
           e.name AS entity_name, r.reminder_type
    FROM booking_links bl
    JOIN customers c  ON c.id = bl.customer_id
    JOIN businesses b ON b.id = bl.business_id AND b.is_active = true
    LEFT JOIN customer_entities e ON e.id = bl.entity_id
    LEFT JOIN reminders r ON r.id = bl.reminder_id
    WHERE bl.token = $1 AND bl.sent_at IS NOT NULL
  `, [token]);
  const link = rows[0];
  // A customer who asked to be removed must not get a working booking page.
  if (!link || link.customer_status === 'opted_out') return null;
  return link;
}

const isExpired = (link) => Date.now() - new Date(link.sent_at).getTime() > booking.LINK_VALID_DAYS * 86400000;

const activeAppointment = async (linkId) => {
  const { rows } = await query(`
    SELECT id, start_at, duration_min, service_type, status FROM appointments
    WHERE booking_link_id = $1 AND status = 'booked' AND start_at > NOW()
    ORDER BY created_at DESC LIMIT 1
  `, [linkId]);
  return rows[0] || null;
};

publicRouter.get('/:token', viewLimiter, async (req, res) => {
  try {
    const link = await loadLink(req.params.token);
    if (!link) return R.notFound(res, 'This booking link is not valid');
    if (isExpired(link)) return R.error(res, 'This booking link has expired. Please contact the business directly.', 410);

    // Counted here (not on a redirect) because this call only happens when
    // the page is actually opened in a browser. Mail scanners that merely
    // fetch the URL never run the page's script, so they don't inflate it.
    await query(`
      UPDATE booking_links
      SET click_count = click_count + 1,
          first_clicked_at = COALESCE(first_clicked_at, NOW()),
          last_clicked_at = NOW()
      WHERE id = $1
    `, [link.id]);

    const settings = booking.mergeSettings(link.booking_settings);
    const [slots, appt] = await Promise.all([
      settings.enabled ? booking.listSlots(link.business_id, settings) : [],
      activeAppointment(link.id),
    ]);

    return R.success(res, {
      businessName: link.business_name,
      businessPhone: link.business_phone,
      customerFirstName: String(link.customer_name || '').trim().split(/\s+/)[0],
      entityName: link.entity_name || null,
      reminderType: link.reminder_type || null,
      bookingEnabled: settings.enabled,
      slotMinutes: settings.slotMinutes,
      slots,
      appointment: appt && { startAt: appt.start_at, durationMin: appt.duration_min, serviceType: appt.service_type },
    });
  } catch (err) {
    logger.error('Booking page load error', { error: err.message });
    return R.error(res);
  }
});

publicRouter.post('/:token', writeLimiter, validate(schemas.publicBook), async (req, res) => {
  const { serviceType, notes } = req.body;
  const startAt = new Date(req.body.startAt).toISOString();

  try {
    const link = await loadLink(req.params.token);
    if (!link) return R.notFound(res, 'This booking link is not valid');
    if (isExpired(link)) return R.error(res, 'This booking link has expired. Please contact the business directly.', 410);
    const settings = booking.mergeSettings(link.booking_settings);
    if (!settings.enabled) return R.badRequest(res, 'Online booking is not available right now. Please contact the business directly.');

    const appt = await withTransaction(async (client) => {
      // One writer per business at a time, so two customers cannot both
      // take the last free slot.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [link.business_id]);

      // Moving an appointment: free the old one first so its slot counts as open.
      await client.query(`
        UPDATE appointments SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE booking_link_id = $1 AND status = 'booked' AND start_at > NOW()
      `, [link.id]);

      const days = await booking.listSlots(link.business_id, settings, { db: (sql, p) => client.query(sql, p) });
      const ok = days.some(d => d.slots.some(s => s.startAt === startAt));
      if (!ok) throw { statusCode: 409, message: 'That time is no longer available. Please pick another.' };

      const { rows: [created] } = await client.query(`
        INSERT INTO appointments
          (business_id, customer_id, entity_id, booking_link_id, source, service_type, start_at, duration_min, notes)
        VALUES ($1,$2,$3,$4,'followup_link',$5,$6,$7,$8)
        RETURNING id, start_at, duration_min, service_type
      `, [
        link.business_id, link.customer_id, link.entity_id, link.id,
        serviceType || link.reminder_type || null, startAt, settings.slotMinutes, notes || null,
      ]);

      await client.query('UPDATE booking_links SET booked_at = COALESCE(booked_at, NOW()) WHERE id = $1', [link.id]);
      return created;
    });

    logger.info('Appointment booked via link', { businessId: link.business_id, channel: link.channel });
    return R.created(res, { startAt: appt.start_at, durationMin: appt.duration_min, serviceType: appt.service_type }, 'Appointment booked');
  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    logger.error('Booking error', { error: err.message });
    return R.error(res);
  }
});

publicRouter.post('/:token/cancel', writeLimiter, async (req, res) => {
  try {
    const link = await loadLink(req.params.token);
    if (!link) return R.notFound(res, 'This booking link is not valid');
    const { rowCount } = await query(`
      UPDATE appointments SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE booking_link_id = $1 AND status = 'booked' AND start_at > NOW()
    `, [link.id]);
    if (!rowCount) return R.notFound(res, 'There is no upcoming appointment to cancel');
    return R.success(res, {}, 'Appointment cancelled');
  } catch (err) {
    logger.error('Booking cancel error', { error: err.message });
    return R.error(res);
  }
});

// ─── Business: appointments ───────────────────────────────────────
appointmentsRouter.use(authenticate);

appointmentsRouter.get('/summary', async (req, res) => {
  try {
    const { rows: [s] } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'booked' AND start_at >= NOW())                       AS upcoming,
        COUNT(*) FILTER (WHERE status = 'booked' AND start_at >= NOW()
                          AND start_at < (date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata') + INTERVAL '1 day') AT TIME ZONE 'Asia/Kolkata') AS today,
        COUNT(*) FILTER (WHERE source = 'followup_link' AND created_at >= NOW() - INTERVAL '30 days') AS from_followups_30d
      FROM appointments WHERE business_id = $1
    `, [req.user.businessId]);
    return R.success(res, { upcoming: Number(s.upcoming), today: Number(s.today), from_followups_30d: Number(s.from_followups_30d) });
  } catch (err) {
    logger.error('Appointment summary error', { error: err.message });
    return R.error(res);
  }
});

appointmentsRouter.get('/', validate(schemas.appointmentQuery, 'query'), async (req, res) => {
  const { page, limit, range } = req.query;
  const businessId = req.user.businessId;
  const where = range === 'upcoming'
    ? `a.status = 'booked' AND a.start_at >= NOW() - INTERVAL '2 hours'`
    : range === 'past'
      ? `NOT (a.status = 'booked' AND a.start_at >= NOW() - INTERVAL '2 hours')`
      : 'TRUE';
  const order = range === 'upcoming' ? 'a.start_at ASC' : 'a.start_at DESC';

  try {
    const [{ rows: [{ count }] }, { rows }] = await Promise.all([
      query(`SELECT COUNT(*) FROM appointments a WHERE a.business_id = $1 AND ${where}`, [businessId]),
      query(`
        SELECT a.id, a.start_at, a.duration_min, a.service_type, a.status, a.source, a.notes, a.created_at,
               c.id AS customer_id, c.name AS customer_name, c.phone AS customer_phone,
               e.name AS entity_name, bl.channel AS booked_via_channel
        FROM appointments a
        JOIN customers c ON c.id = a.customer_id
        LEFT JOIN customer_entities e ON e.id = a.entity_id
        LEFT JOIN booking_links bl ON bl.id = a.booking_link_id
        WHERE a.business_id = $1 AND ${where}
        ORDER BY ${order}
        LIMIT $2 OFFSET $3
      `, [businessId, limit, (page - 1) * limit]),
    ]);
    return R.paginated(res, rows, Number(count), page, limit);
  } catch (err) {
    logger.error('List appointments error', { error: err.message });
    return R.error(res);
  }
});

appointmentsRouter.post('/', validate(schemas.createAppointment), async (req, res) => {
  const d = req.body;
  const businessId = req.user.businessId;
  try {
    const { rows: [cust] } = await query('SELECT id FROM customers WHERE id = $1 AND business_id = $2', [d.customerId, businessId]);
    if (!cust) return R.notFound(res, 'Customer not found');
    if (d.entityId) {
      const { rows: [ent] } = await query('SELECT id FROM customer_entities WHERE id = $1 AND customer_id = $2', [d.entityId, d.customerId]);
      if (!ent) return R.notFound(res, 'Pet or vehicle not found for this customer');
    }
    const { rows: [appt] } = await query(`
      INSERT INTO appointments (business_id, customer_id, entity_id, source, service_type, start_at, duration_min, notes)
      VALUES ($1,$2,$3,'manual',$4,$5,$6,$7) RETURNING *
    `, [businessId, d.customerId, d.entityId || null, d.serviceType || null, d.startAt, d.durationMin, d.notes || null]);
    return R.created(res, appt, 'Appointment added');
  } catch (err) {
    logger.error('Create appointment error', { error: err.message });
    return R.error(res);
  }
});

appointmentsRouter.patch('/:id', validate(schemas.updateAppointment), async (req, res) => {
  const { status, notes } = req.body;
  try {
    const { rows: [appt] } = await query(`
      UPDATE appointments SET
        status = COALESCE($3::varchar, status),
        notes = COALESCE($4::text, notes),
        cancelled_at = CASE WHEN $3::varchar = 'cancelled' THEN NOW() ELSE cancelled_at END,
        updated_at = NOW()
      WHERE id = $1 AND business_id = $2 RETURNING *
    `, [req.params.id, req.user.businessId, status || null, notes ?? null]);
    if (!appt) return R.notFound(res, 'Appointment not found');
    return R.success(res, appt, 'Appointment updated');
  } catch (err) {
    logger.error('Update appointment error', { error: err.message });
    return R.error(res);
  }
});

// ─── Business: booking settings ───────────────────────────────────
settingsRouter.use(authenticate);

settingsRouter.get('/booking-settings', async (req, res) => {
  try {
    const { rows: [b] } = await query('SELECT booking_settings FROM businesses WHERE id = $1', [req.user.businessId]);
    return R.success(res, { settings: booking.mergeSettings(b?.booking_settings), defaults: booking.DEFAULT_SETTINGS });
  } catch (err) {
    logger.error('Get booking settings error', { error: err.message });
    return R.error(res);
  }
});

settingsRouter.put('/booking-settings', authorize('owner', 'manager'), validate(schemas.bookingSettings), async (req, res) => {
  try {
    const { rows: [b] } = await query('SELECT booking_settings FROM businesses WHERE id = $1', [req.user.businessId]);
    const next = booking.mergeSettings({ ...(b?.booking_settings || {}), ...req.body });
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    if (toMin(next.close) - toMin(next.open) < next.slotMinutes) {
      return R.badRequest(res, 'Closing time must be later than opening time by at least one appointment length');
    }
    await query('UPDATE businesses SET booking_settings = $1, updated_at = NOW() WHERE id = $2', [JSON.stringify(next), req.user.businessId]);
    return R.success(res, { settings: next }, 'Booking settings saved');
  } catch (err) {
    logger.error('Save booking settings error', { error: err.message });
    return R.error(res);
  }
});

module.exports = { publicRouter, appointmentsRouter, settingsRouter };
