// src/routes/customers.js
const express = require('express');
const { query, withTransaction } = require('../../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { validate, schemas }       = require('../middleware/validate');
const R      = require('../utils/response');
const logger = require('../utils/logger');

const router = express.Router();
// All routes require authentication
router.use(authenticate);

// ─── Retention date helpers ────────────────────────────────────────
// retentionData is a free-form { fieldKey: value } map (see
// lib/industry-config.js on the frontend). Only the date-typed fields
// (values shaped like an <input type="date"> — "YYYY-MM-DD") represent
// an actual due date, so those are the only ones that schedule a
// reminder; select/text fields (e.g. "Recurring Schedule": "Weekly")
// are stored but don't drive automation.
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;

function labelize(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
}

// Upserts one scheduled reminder per date-valued retention field.
// Existing scheduled reminders of the same type get their date moved;
// nothing is touched for fields that are blank or already sent.
//
// message_log.message_body is NOT NULL, so every reminder needs real
// text up front — a reminder created without one will send-then-throw
// the moment someone clicks Send Now (status flips to 'sent' but the
// message_log insert fails on the constraint, leaving it stuck with no
// audit trail and no message ever actually dispatched).
async function syncRetentionReminders(client, { businessId, customerId, entityId, preferredChannel, customerName, entityName, retentionData }) {
  for (const [key, value] of Object.entries(retentionData || {})) {
    if (typeof value !== 'string' || !DATE_VALUE.test(value)) continue;
    const reminderType = labelize(key);
    const messageBody = `Hi ${customerName}, a reminder that ${entityName ? `${entityName}'s ` : 'your '}${reminderType.toLowerCase()} is coming up on ${value}. Please contact us to schedule.`;

    const { rows: [existing] } = await client.query(`
      SELECT id, scheduled_at::DATE::TEXT AS scheduled_date FROM reminders
      WHERE customer_id = $1 AND entity_id = $2 AND reminder_type = $3 AND status = 'scheduled'
      LIMIT 1
    `, [customerId, entityId, reminderType]);

    if (existing) {
      if (existing.scheduled_date !== value) {
        await client.query(`UPDATE reminders SET scheduled_at = $1, message_body = $2 WHERE id = $3`, [value, messageBody, existing.id]);
      }
    } else {
      await client.query(`
        INSERT INTO reminders
          (business_id, customer_id, entity_id, reminder_type, channel, scheduled_at, status, message_body)
        VALUES ($1,$2,$3,$4,$5,$6,'scheduled',$7)
      `, [businessId, customerId, entityId, reminderType, preferredChannel || 'whatsapp', value, messageBody]);
    }
  }
}

// ─── GET /customers ───────────────────────────────────────────────
// Paginated list with search, filter, sort
router.get('/', validate(schemas.listQuery, 'query'), async (req, res) => {
  const { page, limit, search, status, channel, sortBy, sortDir, from, to } = req.query;
  const businessId = req.user.businessId;
  const offset = (page - 1) * limit;

  try {
    const conditions = ['c.business_id = $1'];
    const params = [businessId];
    let p = 2;

    if (search) {
      conditions.push(`(c.name ILIKE $${p} OR c.phone ILIKE $${p} OR c.email ILIKE $${p})`);
      params.push(`%${search}%`); p++;
    }
    if (status) { conditions.push(`c.status = $${p}`); params.push(status); p++; }
    if (channel){ conditions.push(`c.preferred_channel = $${p}`); params.push(channel); p++; }
    if (from)   { conditions.push(`c.created_at >= $${p}`); params.push(from); p++; }
    if (to)     { conditions.push(`c.created_at <= $${p}`); params.push(to); p++; }

    const where = 'WHERE ' + conditions.join(' AND ');
    const allowedSort = { name:'c.name', created_at:'c.created_at', last_visit_at:'c.last_visit_at', next_due_date:'r_next.scheduled_at' };
    const orderClause = `ORDER BY ${allowedSort[sortBy] || 'c.created_at'} ${sortDir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;

    const [countRes, dataRes] = await Promise.all([
      query(`SELECT COUNT(*) FROM customers c ${where}`, params),
      query(`
        SELECT
          c.id, c.name, c.phone, c.email, c.city, c.status,
          c.preferred_channel, c.opted_in_whatsapp, c.opted_in_sms, c.opted_in_email,
          c.total_visits, c.lifetime_value, c.last_visit_at, c.first_visit_at,
          c.tags, c.notes, c.source, c.created_at,
          -- Latest entity (pet/vehicle)
          e.id AS entity_id, e.name AS entity_name,
          e.entity_type, e.breed_or_model,
          -- Next scheduled reminder
          r_next.scheduled_at AS next_reminder_at,
          r_next.reminder_type AS next_reminder_type,
          r_next.channel AS next_reminder_channel
        FROM customers c
        LEFT JOIN LATERAL (
          SELECT id, name, entity_type, breed_or_model
          FROM customer_entities
          WHERE customer_id = c.id AND is_active = true
          ORDER BY created_at ASC LIMIT 1
        ) e ON true
        LEFT JOIN LATERAL (
          SELECT scheduled_at, reminder_type, channel
          FROM reminders
          WHERE customer_id = c.id AND status = 'scheduled'
          ORDER BY scheduled_at ASC LIMIT 1
        ) r_next ON true
        ${where}
        ${orderClause}
        LIMIT $${p} OFFSET $${p+1}
      `, [...params, limit, offset]),
    ]);

    return R.paginated(res, dataRes.rows, parseInt(countRes.rows[0].count), page, limit);
  } catch (err) {
    logger.error('List customers error', { error: err.message, businessId });
    return R.error(res);
  }
});

// ─── POST /customers ──────────────────────────────────────────────
router.post('/', validate(schemas.createCustomer), async (req, res) => {
  const { entity, ...customerData } = req.body;
  const businessId = req.user.businessId;

  try {
    // Check plan limit
    const { rows: [biz] } = await query(
      'SELECT max_customers FROM businesses WHERE id = $1', [businessId]
    );
    const { rows: [cnt] } = await query(
      'SELECT COUNT(*) FROM customers WHERE business_id = $1', [businessId]
    );
    if (parseInt(cnt.count) >= biz.max_customers) {
      return R.error(res, `Customer limit reached (${biz.max_customers}). Please upgrade your plan.`, 403);
    }

    const result = await withTransaction(async (client) => {
      const { rows: [customer] } = await client.query(`
        INSERT INTO customers
          (business_id, name, phone, email, city, address, state, pincode,
           preferred_channel, opted_in_sms, opted_in_whatsapp, opted_in_email,
           opted_in_at, tags, notes, source, external_id, created_by, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                CASE WHEN ($10 OR $11 OR $12) THEN NOW() ELSE NULL END,
                $13,$14,$15,$16,$17,'active')
        RETURNING *
      `, [
        businessId, customerData.name, customerData.phone, customerData.email || null,
        customerData.city || null, customerData.address || null,
        customerData.state || null, customerData.pincode || null,
        customerData.preferredChannel, customerData.optedInSms, customerData.optedInWhatsapp,
        customerData.optedInEmail, customerData.tags || null, customerData.notes || null,
        customerData.source, customerData.externalId || null, req.user.staffId,
      ]);

      let entityRow = null;
      if (entity?.name || entity?.entityType || Object.keys(entity?.assetData || {}).length) {
        const { rows: [e] } = await client.query(`
          INSERT INTO customer_entities
            (customer_id, business_id, name, entity_type, asset_data, retention_data)
          VALUES ($1,$2,$3,$4,$5,$6)
          RETURNING *
        `, [
          customer.id, businessId, entity.name || null,
          entity.entityType || 'other',
          JSON.stringify(entity.assetData || {}),
          JSON.stringify(entity.retentionData || {}),
        ]);
        entityRow = e;

        await syncRetentionReminders(client, {
          businessId, customerId: customer.id, entityId: e.id,
          preferredChannel: customer.preferred_channel,
          customerName: customer.name, entityName: e.name,
          retentionData: entity.retentionData,
        });
      }

      return { customer, entity: entityRow };
    });

    logger.info('Customer created', { customerId: result.customer.id, businessId });
    return R.created(res, result, 'Customer added successfully');

  } catch (err) {
    if (err.code === '23505') return R.conflict(res, 'A customer with this phone number already exists');
    logger.error('Create customer error', { error: err.message, businessId });
    return R.error(res);
  }
});

// ─── GET /customers/:id ───────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const businessId = req.user.businessId;

  try {
    const [custRes, entitiesRes, eventsRes, remindersRes] = await Promise.all([
      query(`SELECT * FROM customers WHERE id = $1 AND business_id = $2`, [id, businessId]),
      query(`SELECT * FROM customer_entities WHERE customer_id = $1 AND is_active = true ORDER BY created_at ASC`, [id]),
      query(`SELECT * FROM service_events WHERE customer_id = $1 AND business_id = $2 ORDER BY event_date DESC LIMIT 20`, [id, businessId]),
      query(`SELECT * FROM reminders WHERE customer_id = $1 AND business_id = $2 ORDER BY scheduled_at ASC LIMIT 10`, [id, businessId]),
    ]);

    if (!custRes.rows.length) return R.notFound(res, 'Customer not found');

    return R.success(res, {
      ...custRes.rows[0],
      entities:      entitiesRes.rows,
      serviceEvents: eventsRes.rows,
      reminders:     remindersRes.rows,
    });
  } catch (err) {
    logger.error('Get customer error', { error: err.message, id });
    return R.error(res);
  }
});

// ─── PATCH /customers/:id ─────────────────────────────────────────
router.patch('/:id', validate(schemas.updateCustomer), async (req, res) => {
  const { id } = req.params;
  const businessId = req.user.businessId;
  const { entity, ...updates } = req.body;

  const hasEntityData = entity && (
    entity.name || entity.entityType ||
    Object.keys(entity.assetData || {}).length ||
    Object.keys(entity.retentionData || {}).length
  );

  // Build dynamic SET clause (snake_case mapping)
  const colMap = {
    name:'name', phone:'phone', email:'email', city:'city', address:'address',
    state:'state', pincode:'pincode',
    preferredChannel:'preferred_channel', optedInSms:'opted_in_sms',
    optedInWhatsapp:'opted_in_whatsapp', optedInEmail:'opted_in_email',
    tags:'tags', notes:'notes', status:'status',
  };

  const setClauses = [];
  const params     = [];
  let p = 1;

  for (const field of Object.keys(updates)) {
    const col = colMap[field];
    if (col) { setClauses.push(`${col} = $${p++}`); params.push(updates[field]); }
  }

  if (!setClauses.length && !hasEntityData) return R.badRequest(res, 'No valid fields to update');

  try {
    const result = await withTransaction(async (client) => {
      let customer;
      if (setClauses.length) {
        params.push(id, businessId);
        const { rows } = await client.query(`
          UPDATE customers SET ${setClauses.join(', ')}
          WHERE id = $${p++} AND business_id = $${p}
          RETURNING *
        `, params);
        customer = rows[0];
      } else {
        const { rows } = await client.query(
          'SELECT * FROM customers WHERE id = $1 AND business_id = $2', [id, businessId]
        );
        customer = rows[0];
      }
      if (!customer) return null;

      if (hasEntityData) {
        const { rows: [existingEntity] } = await client.query(`
          SELECT id FROM customer_entities
          WHERE customer_id = $1 AND is_active = true
          ORDER BY created_at ASC LIMIT 1
        `, [id]);

        let entityRow;
        if (existingEntity) {
          const { rows: [e] } = await client.query(`
            UPDATE customer_entities
            SET name = COALESCE($1, name),
                entity_type = COALESCE($2, entity_type),
                asset_data = $3,
                retention_data = $4
            WHERE id = $5
            RETURNING *
          `, [
            entity.name || null, entity.entityType || null,
            JSON.stringify(entity.assetData || {}),
            JSON.stringify(entity.retentionData || {}),
            existingEntity.id,
          ]);
          entityRow = e;
        } else {
          const { rows: [e] } = await client.query(`
            INSERT INTO customer_entities
              (customer_id, business_id, name, entity_type, asset_data, retention_data)
            VALUES ($1,$2,$3,$4,$5,$6)
            RETURNING *
          `, [
            id, businessId, entity.name || null, entity.entityType || 'other',
            JSON.stringify(entity.assetData || {}),
            JSON.stringify(entity.retentionData || {}),
          ]);
          entityRow = e;
        }

        await syncRetentionReminders(client, {
          businessId, customerId: id, entityId: entityRow.id,
          preferredChannel: customer.preferred_channel,
          customerName: customer.name, entityName: entityRow.name,
          retentionData: entity.retentionData,
        });
      }

      return customer;
    });

    if (!result) return R.notFound(res, 'Customer not found');
    return R.success(res, result, 'Customer updated');
  } catch (err) {
    if (err.code === '23505') return R.conflict(res, 'A customer with this phone number already exists');
    logger.error('Update customer error', { error: err.message, id });
    return R.error(res);
  }
});

// ─── DELETE /customers/:id ────────────────────────────────────────
router.delete('/:id', authorize('owner', 'manager'), async (req, res) => {
  const { id } = req.params;
  const businessId = req.user.businessId;

  try {
    // Soft delete — set status to opted_out and anonymise PII
    const { rows } = await query(`
      UPDATE customers
      SET status = 'opted_out',
          name   = 'Deleted Customer',
          email  = NULL,
          phone  = CONCAT('DEL_', LEFT(phone, 5)),
          opted_out_at = NOW()
      WHERE id = $1 AND business_id = $2
      RETURNING id
    `, [id, businessId]);

    if (!rows.length) return R.notFound(res, 'Customer not found');
    return R.success(res, { id: rows[0].id }, 'Customer removed');
  } catch (err) {
    logger.error('Delete customer error', { error: err.message, id });
    return R.error(res);
  }
});

// ─── POST /customers/import ───────────────────────────────────────
// Bulk import from parsed CSV payload
router.post('/import', authorize('owner', 'manager'), async (req, res) => {
  const { records } = req.body;
  if (!Array.isArray(records) || !records.length) {
    return R.badRequest(res, 'records array required');
  }
  if (records.length > 500) {
    return R.badRequest(res, 'Maximum 500 records per import batch');
  }

  const businessId = req.user.businessId;
  let inserted = 0, skipped = 0, errors = [];

  for (const r of records) {
    try {
      await query(`
        INSERT INTO customers
          (business_id, name, phone, email, city, preferred_channel,
           opted_in_whatsapp, opted_in_sms, source)
        VALUES ($1,$2,$3,$4,$5,$6,true,true,'import')
        ON CONFLICT (business_id, phone) DO NOTHING
      `, [businessId, r.name, r.phone, r.email || null, r.city || null,
          r.channel || 'whatsapp']);
      inserted++;
    } catch (e) {
      skipped++;
      errors.push({ phone: r.phone, reason: e.message });
    }
  }

  return R.success(res, { inserted, skipped, errors }, `Import complete: ${inserted} added, ${skipped} skipped`);
});

module.exports = router;
