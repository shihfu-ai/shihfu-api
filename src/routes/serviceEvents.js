// src/routes/serviceEvents.js
const express = require('express');
const { query, withTransaction } = require('../../config/database');
const { authenticate }      = require('../middleware/auth');
const { validate, schemas } = require('../middleware/validate');
const R      = require('../utils/response');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

// ─── GET /service-events ──────────────────────────────────────────
router.get('/', validate(schemas.listQuery, 'query'), async (req, res) => {
  const { page, limit, search, from, to, sortDir } = req.query;
  const businessId = req.user.businessId;
  const offset = (page - 1) * limit;

  try {
    const conditions = ['se.business_id = $1'];
    const params = [businessId];
    let p = 2;

    if (search) {
      conditions.push(`(c.name ILIKE $${p} OR se.service_type ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }
    if (from) { conditions.push(`se.event_date >= $${p}`); params.push(from); p++; }
    if (to)   { conditions.push(`se.event_date <= $${p}`); params.push(to);   p++; }

    const where = 'WHERE ' + conditions.join(' AND ');

    const [countRes, dataRes] = await Promise.all([
      query(`
        SELECT COUNT(*) FROM service_events se
        JOIN customers c ON c.id = se.customer_id ${where}
      `, params),
      query(`
        SELECT
          se.*,
          c.name AS customer_name, c.phone AS customer_phone,
          e.name AS entity_name, e.breed_or_model,
          s.name AS logged_by_name
        FROM service_events se
        JOIN customers c ON c.id = se.customer_id
        LEFT JOIN customer_entities e ON e.id = se.entity_id
        LEFT JOIN staff s ON s.id = se.logged_by
        ${where}
        ORDER BY se.event_date ${sortDir === 'asc' ? 'ASC' : 'DESC'}
        LIMIT $${p} OFFSET $${p+1}
      `, [...params, limit, offset]),
    ]);

    return R.paginated(res, dataRes.rows, parseInt(countRes.rows[0].count), page, limit);
  } catch (err) {
    logger.error('List service events error', { error: err.message });
    return R.error(res);
  }
});

// ─── POST /service-events ─────────────────────────────────────────
// Logs a service AND auto-schedules a reminder based on template or override
router.post('/', validate(schemas.createServiceEvent), async (req, res) => {
  const businessId = req.user.businessId;
  const staffId    = req.user.staffId;
  const data       = req.body;

  try {
    const result = await withTransaction(async (client) => {

      // 1. Verify customer belongs to this business
      const { rows: [customer] } = await client.query(
        'SELECT id, name, phone, email, preferred_channel FROM customers WHERE id = $1 AND business_id = $2',
        [data.customerId, businessId]
      );
      if (!customer) throw { statusCode: 404, message: 'Customer not found' };

      // 2. Resolve follow_up_days: explicit override > matching template > null
      let followUpDays = data.followUpDays || null;
      let templateId   = null;

      if (!followUpDays && data.serviceCategory) {
        const { rows: [template] } = await client.query(`
          SELECT id, remind_after_days FROM reminder_templates
          WHERE business_id = $1
            AND is_active = true
            AND (service_category = $2 OR service_type = $3)
          ORDER BY priority DESC LIMIT 1
        `, [businessId, data.serviceCategory, data.serviceType]);

        if (template) {
          followUpDays = template.remind_after_days;
          templateId   = template.id;
        }
      }

      // 3. Create service event
      const { rows: [event] } = await client.query(`
        INSERT INTO service_events
          (business_id, customer_id, entity_id, logged_by, service_type,
           service_category, event_date, event_time, status, amount_charged,
           amount_paid, payment_method, follow_up_days, staff_name,
           diagnosis, prescription, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING *
      `, [
        businessId, data.customerId, data.entityId || null, staffId,
        data.serviceType, data.serviceCategory || null,
        data.eventDate, data.eventTime || null,
        data.status || 'completed', data.amountCharged || null,
        data.amountPaid || null, data.paymentMethod || null,
        followUpDays, data.staffName || null,
        data.diagnosis || null, data.prescription || null, data.notes || null,
      ]);

      // 4. Auto-schedule reminder if follow-up days resolved
      let reminder = null;
      if (followUpDays && event.next_due_date) {
        const scheduledAt = new Date(event.next_due_date);

        // Render message from template or use default
        let messageBody = `Dear ${customer.name}, your ${data.serviceType} follow-up is due. Please contact us to schedule.`;
        if (templateId) {
          const { rows: [tmpl] } = await client.query(
            `SELECT * FROM reminder_templates WHERE id = $1`, [templateId]
          );
          if (tmpl) {
            const channel = customer.preferred_channel;
            const rawMsg = channel === 'whatsapp' ? tmpl.whatsapp_template
                         : channel === 'sms'      ? tmpl.sms_template
                         : tmpl.email_body;
            if (rawMsg) {
              messageBody = rawMsg
                .replace(/{customer_name}/g, customer.name)
                .replace(/{business_name}/g, 'our clinic')
                .replace(/{service_type}/g,  data.serviceType)
                .replace(/{due_date}/g,       event.next_due_date);
            }
          }
        }

        const { rows: [rem] } = await client.query(`
          INSERT INTO reminders
            (business_id, customer_id, entity_id, service_event_id, template_id,
             reminder_type, channel, scheduled_at, status, message_body)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled',$9)
          RETURNING *
        `, [
          businessId, data.customerId, data.entityId || null,
          event.id, templateId,
          data.serviceType, customer.preferred_channel,
          scheduledAt, messageBody,
        ]);
        reminder = rem;
      }

      return { event, reminder };
    });

    logger.info('Service event logged', {
      eventId: result.event.id,
      customerId: data.customerId,
      businessId,
      reminderId: result.reminder?.id,
    });

    return R.created(res, result, `Service logged${result.reminder ? ' and reminder scheduled' : ''}`);

  } catch (err) {
    if (err.statusCode) return R.error(res, err.message, err.statusCode);
    logger.error('Create service event error', { error: err.message });
    return R.error(res);
  }
});

// ─── GET /service-events/:id ──────────────────────────────────────
router.get('/:id', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const { rows } = await query(`
      SELECT se.*, c.name AS customer_name, c.phone,
             e.name AS entity_name, e.breed_or_model
      FROM service_events se
      JOIN customers c ON c.id = se.customer_id
      LEFT JOIN customer_entities e ON e.id = se.entity_id
      WHERE se.id = $1 AND se.business_id = $2
    `, [req.params.id, businessId]);

    if (!rows.length) return R.notFound(res, 'Service event not found');
    return R.success(res, rows[0]);
  } catch (err) {
    logger.error('Get service event error', { error: err.message });
    return R.error(res);
  }
});

// ─── GET /service-events/customer/:customerId ─────────────────────
router.get('/customer/:customerId', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const { rows } = await query(`
      SELECT se.*, e.name AS entity_name, e.breed_or_model
      FROM service_events se
      LEFT JOIN customer_entities e ON e.id = se.entity_id
      WHERE se.customer_id = $1 AND se.business_id = $2
      ORDER BY se.event_date DESC
    `, [req.params.customerId, businessId]);
    return R.success(res, rows);
  } catch (err) {
    return R.error(res);
  }
});

module.exports = router;
