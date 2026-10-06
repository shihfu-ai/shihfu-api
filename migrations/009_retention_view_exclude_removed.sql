-- ═══════════════════════════════════════════════════════════════════
-- 009  RETENTION SUMMARY: LEAVE OUT REMOVED CUSTOMERS
--
-- A removed customer (status 'opted_out') no longer appears in the
-- customer list, so the dashboard totals and retention rates must not
-- count them either. Same columns as before; only the join changes.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW v_retention_summary AS
SELECT
  b.id                                              AS business_id,
  b.name                                            AS business_name,
  COUNT(DISTINCT c.id)                              AS total_customers,
  COUNT(DISTINCT c.id) FILTER (
    WHERE c.last_visit_at >= NOW() - INTERVAL '90 days'
  )                                                 AS active_customers,
  COUNT(DISTINCT c.id) FILTER (
    WHERE c.last_visit_at < NOW() - INTERVAL '90 days'
    AND   c.last_visit_at >= NOW() - INTERVAL '180 days'
  )                                                 AS dormant_customers,
  COUNT(DISTINCT c.id) FILTER (
    WHERE c.last_visit_at < NOW() - INTERVAL '180 days'
    OR    c.last_visit_at IS NULL
  )                                                 AS lost_customers,
  ROUND(
    COUNT(DISTINCT c.id) FILTER (WHERE c.total_visits > 1)::NUMERIC
    / NULLIF(COUNT(DISTINCT c.id), 0) * 100, 1
  )                                                 AS repeat_rate_pct,
  ROUND(AVG(c.lifetime_value), 2)                   AS avg_ltv_inr,
  ROUND(SUM(c.lifetime_value), 2)                   AS total_revenue_inr
FROM businesses b
LEFT JOIN customers c ON c.business_id = b.id AND c.status <> 'opted_out'
GROUP BY b.id, b.name;
