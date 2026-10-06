// src/services/booking.js
// Booking links (one per outbound message) and the slot calendar behind
// them. All times are India Standard Time (UTC+5:30, no DST), which is
// the only market this app serves, so slots are computed in IST and
// stored as real UTC instants.
const crypto = require('crypto');
const { query } = require('../../config/database');
const logger = require('../utils/logger');

const IST_OFFSET_MIN = 330;
const LINK_VALID_DAYS = 90;

const DEFAULT_SETTINGS = {
  enabled: true,
  days: [1, 2, 3, 4, 5, 6],   // 0 = Sunday ... 6 = Saturday
  open: '10:00',
  close: '18:00',
  slotMinutes: 30,
  capacity: 1,                // appointments that can overlap in one slot
  maxDaysAhead: 30,
  minNoticeHours: 2,
};

function mergeSettings(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  if (!Array.isArray(s.days)) s.days = DEFAULT_SETTINGS.days;
  return s;
}

const webBase = () =>
  (process.env.PUBLIC_WEB_URL || process.env.FRONTEND_URL || 'https://www.shihfu.com').replace(/\/+$/, '');

const bookingUrl = (token) => `${webBase()}/book/${token}`;
const bookingLine = (url) => `Book your appointment: ${url}`;

// ── IST helpers ──────────────────────────────────────────────────
const istNow = (ms = Date.now()) => new Date(ms + IST_OFFSET_MIN * 60000);
const pad = (n) => String(n).padStart(2, '0');
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// IST wall-clock date + minutes-since-midnight -> UTC milliseconds
function istToUtcMs(y, mo, d, minutes) {
  return Date.UTC(y, mo - 1, d, 0, minutes) - IST_OFFSET_MIN * 60000;
}

// ── Link creation ────────────────────────────────────────────────
// Called for every outbound message that belongs to a known customer.
// Returns { id, token, url } or null when the business has booking
// switched off. The row is created before sending so the URL exists;
// markSent() stamps it after delivery succeeds, discard() removes it
// when delivery fails (a failed message must not count as "sent").
async function createLinkFor(msg) {
  if (!msg.business_id || !msg.customer_id) return null;

  const { rows: [biz] } = await query('SELECT vertical, booking_settings FROM businesses WHERE id = $1', [msg.business_id]);
  if (!biz) return null;
  const settings = mergeSettings(biz.booking_settings);
  if (!settings.enabled) return null;

  const { rows: [ctx] } = await query(`
    SELECT c.total_visits, c.last_visit_at, c.created_at,
      (SELECT COUNT(*) FROM booking_links bl WHERE bl.customer_id = c.id AND bl.sent_at IS NOT NULL) AS prior_links,
      (SELECT COUNT(*) FROM booking_links bl WHERE bl.customer_id = c.id AND bl.booked_at IS NOT NULL) AS prior_bookings
    FROM customers c WHERE c.id = $1 AND c.business_id = $2
  `, [msg.customer_id, msg.business_id]);
  if (!ctx) return null;

  const now = Date.now();
  const ist = istNow(now);
  const days = (t) => (t ? Math.floor((now - new Date(t).getTime()) / 86400000) : null);
  const kind = msg.campaign_id ? 'campaign' : 'reminder';
  const context = {
    vertical: biz.vertical,
    kind,
    category: msg.category || 'utility',
    reminder_type: kind === 'reminder' ? (msg.reminder_type || null) : null,
    send_hour_ist: ist.getUTCHours(),
    send_dow_ist: ist.getUTCDay(),
    days_since_last_visit: days(ctx.last_visit_at),
    customer_tenure_days: days(ctx.created_at),
    total_visits: ctx.total_visits,
    prior_links_sent: Number(ctx.prior_links),
    prior_bookings: Number(ctx.prior_bookings),
  };

  const token = crypto.randomBytes(9).toString('base64url'); // 12 chars
  const { rows: [link] } = await query(`
    INSERT INTO booking_links
      (token, business_id, customer_id, reminder_id, campaign_id, entity_id, channel, context)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id, token
  `, [
    token, msg.business_id, msg.customer_id,
    kind === 'reminder' ? (msg.id || null) : null,
    msg.campaign_id || null,
    msg.entity_id || null,
    msg.channel, JSON.stringify(context),
  ]);

  return { id: link.id, token: link.token, url: bookingUrl(link.token) };
}

const markSent = (id) =>
  query('UPDATE booking_links SET sent_at = NOW() WHERE id = $1', [id])
    .catch(err => logger.error('markSent failed', { error: err.message, id }));

const discard = (id) =>
  query('DELETE FROM booking_links WHERE id = $1 AND sent_at IS NULL', [id])
    .catch(err => logger.error('discard link failed', { error: err.message, id }));

// ── Slot calendar ────────────────────────────────────────────────
// Returns [{ date: 'YYYY-MM-DD', slots: [{ startAt: ISO, label: 'HH:MM', free: n }] }]
// covering the days the business is open, excluding full or past slots.
async function listSlots(businessId, settings, { fromMs = Date.now(), db = query } = {}) {
  const s = settings;
  const stepMin = Math.max(5, s.slotMinutes);
  const openMin = toMin(s.open), closeMin = toMin(s.close);
  const earliest = fromMs + s.minNoticeHours * 3600000;

  const today = istNow(fromMs);
  const y0 = today.getUTCFullYear(), m0 = today.getUTCMonth() + 1, d0 = today.getUTCDate();

  const rangeStart = new Date(earliest);
  const rangeEnd = new Date(istToUtcMs(y0, m0, d0 + s.maxDaysAhead + 1, 0));
  const { rows: busy } = await db(`
    SELECT start_at, duration_min FROM appointments
    WHERE business_id = $1 AND status = 'booked' AND start_at < $3
      AND start_at + (duration_min || ' minutes')::interval > $2
  `, [businessId, rangeStart, rangeEnd]);
  const busyRanges = busy.map(b => [new Date(b.start_at).getTime(), new Date(b.start_at).getTime() + b.duration_min * 60000]);

  const out = [];
  for (let i = 0; i <= s.maxDaysAhead; i++) {
    const day = new Date(Date.UTC(y0, m0 - 1, d0 + i));
    if (!s.days.includes(day.getUTCDay())) continue;
    const y = day.getUTCFullYear(), mo = day.getUTCMonth() + 1, d = day.getUTCDate();

    const slots = [];
    for (let t = openMin; t + stepMin <= closeMin; t += stepMin) {
      const startMs = istToUtcMs(y, mo, d, t);
      if (startMs < earliest) continue;
      const endMs = startMs + stepMin * 60000;
      const used = busyRanges.filter(([a, b]) => a < endMs && b > startMs).length;
      const free = s.capacity - used;
      if (free <= 0) continue;
      slots.push({ startAt: new Date(startMs).toISOString(), label: `${pad(Math.floor(t / 60))}:${pad(t % 60)}`, free });
    }
    if (slots.length) out.push({ date: `${y}-${pad(mo)}-${pad(d)}`, slots });
  }
  return out;
}

module.exports = {
  DEFAULT_SETTINGS, LINK_VALID_DAYS, mergeSettings, bookingUrl, bookingLine,
  createLinkFor, markSent, discard, listSlots, istNow,
};
