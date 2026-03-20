// src/routes/analytics.js
const express = require('express');
const { query } = require('../../config/database');
const { authenticate } = require('../middleware/auth');
const R      = require('../utils/response');
const logger = require('../utils/logger');

const router = express.Router();
router.use(authenticate);

// ─── GET /analytics/retention ─────────────────────────────────────
router.get('/retention', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const { rows: [summary] } = await query(
      'SELECT * FROM v_retention_summary WHERE business_id = $1',
      [businessId]
    );

    // Monthly repeat visits — last 6 months
    const { rows: monthly } = await query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', event_date), 'Mon YYYY') AS month,
        COUNT(DISTINCT customer_id)                           AS unique_customers,
        COUNT(*)                                              AS total_events,
        ROUND(SUM(COALESCE(amount_charged, 0)), 2)            AS revenue_inr
      FROM service_events
      WHERE business_id = $1
        AND status = 'completed'
        AND event_date >= NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', event_date)
      ORDER BY DATE_TRUNC('month', event_date) ASC
    `, [businessId]);

    // Top returning customers (by visit count)
    const { rows: topCustomers } = await query(`
      SELECT
        c.id, c.name, c.phone, c.preferred_channel,
        c.total_visits, c.lifetime_value, c.last_visit_at
      FROM customers c
      WHERE c.business_id = $1 AND c.total_visits > 1
      ORDER BY c.total_visits DESC, c.lifetime_value DESC
      LIMIT 10
    `, [businessId]);

    // Churn risk: active customers with no visit > 60 days
    const { rows: churnRisk } = await query(`
      SELECT
        c.id, c.name, c.phone, c.preferred_channel,
        c.last_visit_at,
        NOW()::DATE - c.last_visit_at::DATE AS days_since_visit
      FROM customers c
      WHERE c.business_id = $1
        AND c.status = 'active'
        AND c.last_visit_at < NOW() - INTERVAL '60 days'
      ORDER BY c.last_visit_at ASC
      LIMIT 20
    `, [businessId]);

    return R.success(res, { summary, monthly, topCustomers, churnRisk });
  } catch (err) {
    logger.error('Retention analytics error', { error: err.message });
    return R.error(res);
  }
});

// ─── GET /analytics/revenue ───────────────────────────────────────
router.get('/revenue', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    // Monthly revenue breakdown by service category
    const { rows: monthlyRevenue } = await query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', event_date), 'Mon YYYY') AS month,
        service_category,
        COUNT(*)                                              AS events,
        ROUND(SUM(COALESCE(amount_charged, 0)), 2)            AS revenue_inr,
        ROUND(AVG(COALESCE(amount_charged, 0)), 2)            AS avg_ticket_inr
      FROM service_events
      WHERE business_id = $1
        AND status = 'completed'
        AND event_date >= NOW() - INTERVAL '12 months'
      GROUP BY DATE_TRUNC('month', event_date), service_category
      ORDER BY DATE_TRUNC('month', event_date) DESC
    `, [businessId]);

    // Revenue recovered via reminders
    // (customers who came back within 7 days of receiving a reminder)
    const { rows: [recovered] } = await query(`
      SELECT COUNT(DISTINCT se.customer_id) AS customers_recovered,
             ROUND(SUM(COALESCE(se.amount_charged, 0)), 2) AS revenue_recovered_inr
      FROM service_events se
      WHERE se.business_id = $1
        AND se.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM reminders r
          WHERE r.customer_id = se.customer_id
            AND r.status IN ('sent','delivered','read')
            AND r.sent_at BETWEEN se.event_date - INTERVAL '7 days'
                                AND se.event_date
        )
    `, [businessId]);

    // Reminder success rate
    const { rows: [reminderStats] } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('sent','delivered','read','responded')) AS sent_total,
        COUNT(*) FILTER (WHERE status = 'responded')                              AS conversions,
        COUNT(*) FILTER (WHERE status = 'failed')                                 AS failed_total
      FROM reminders
      WHERE business_id = $1
    `, [businessId]);

    return R.success(res, { monthlyRevenue, recovered, reminderStats });
  } catch (err) {
    logger.error('Revenue analytics error', { error: err.message });
    return R.error(res);
  }
});

// ─── GET /analytics/dashboard ─────────────────────────────────────
// Single endpoint that powers the overview dashboard KPIs
router.get('/dashboard', async (req, res) => {
  const businessId = req.user.businessId;
  try {
    const [retentionRes, queueRes, volumeRes] = await Promise.all([
      query('SELECT * FROM v_retention_summary WHERE business_id = $1', [businessId]),
      query(`
        SELECT
          COUNT(*) FILTER (WHERE scheduled_at < NOW())              AS overdue,
          COUNT(*) FILTER (WHERE scheduled_at::DATE = CURRENT_DATE) AS today,
          COUNT(*) FILTER (WHERE scheduled_at > NOW())              AS upcoming
        FROM reminders WHERE business_id = $1 AND status = 'scheduled'
      `, [businessId]),
      query(`
        SELECT channel, COUNT(*) AS sent
        FROM message_log
        WHERE business_id = $1
          AND direction = 'outbound'
          AND sent_at >= DATE_TRUNC('month', NOW())
        GROUP BY channel
      `, [businessId]),
    ]);

    return R.success(res, {
      retention: retentionRes.rows[0] || {},
      queue:     queueRes.rows[0] || {},
      channelVolume: volumeRes.rows,
    });
  } catch (err) {
    logger.error('Dashboard analytics error', { error: err.message });
    return R.error(res);
  }
});

module.exports = router;
