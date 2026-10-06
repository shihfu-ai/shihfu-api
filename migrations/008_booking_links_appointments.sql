-- ═══════════════════════════════════════════════════════════════════
-- 008  BOOKING LINKS + APPOINTMENTS
--
-- Every follow-up message (reminder or campaign, any channel) carries a
-- unique booking link. The customer opens it and books a slot, which:
--   * gives the business an appointment, and
--   * tells us which message, channel and send time produced it.
-- That attribution (sent -> clicked -> booked) is the success-rate data
-- the retention analytics, and later the per-business models, learn from.
--
-- booking_links.context freezes what we knew about the customer at send
-- time (days since last visit, past bookings, send hour...) so the data
-- stays correct for training even after the customer record changes.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS booking_settings JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS booking_links (
  id               UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  token            VARCHAR(24)     NOT NULL UNIQUE,
  business_id      UUID            NOT NULL REFERENCES businesses (id)         ON DELETE CASCADE,
  customer_id      UUID            NOT NULL REFERENCES customers (id)          ON DELETE CASCADE,
  reminder_id      UUID            REFERENCES reminders (id)                   ON DELETE SET NULL,
  campaign_id      UUID            REFERENCES campaigns (id)                   ON DELETE SET NULL,
  entity_id        UUID            REFERENCES customer_entities (id)           ON DELETE SET NULL,
  channel          message_channel NOT NULL,

  sent_at          TIMESTAMPTZ,                -- null until the message actually went out
  first_clicked_at TIMESTAMPTZ,
  last_clicked_at  TIMESTAMPTZ,
  click_count      INTEGER         NOT NULL DEFAULT 0,
  booked_at        TIMESTAMPTZ,                -- first booking made through this link

  context          JSONB           NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_booking_links_business ON booking_links (business_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_booking_links_customer ON booking_links (customer_id);

CREATE TABLE IF NOT EXISTS appointments (
  id              UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID         NOT NULL REFERENCES businesses (id)         ON DELETE CASCADE,
  customer_id     UUID         NOT NULL REFERENCES customers (id)          ON DELETE CASCADE,
  entity_id       UUID         REFERENCES customer_entities (id)           ON DELETE SET NULL,
  booking_link_id UUID         REFERENCES booking_links (id)               ON DELETE SET NULL,

  source          VARCHAR(20)  NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('followup_link', 'manual')),
  service_type    VARCHAR(120),
  start_at        TIMESTAMPTZ  NOT NULL,
  duration_min    INTEGER      NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 480),
  status          VARCHAR(20)  NOT NULL DEFAULT 'booked'
                  CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show')),
  notes           TEXT,
  cancelled_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_business_start ON appointments (business_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appointments_customer       ON appointments (customer_id);
CREATE INDEX IF NOT EXISTS idx_appointments_link           ON appointments (booking_link_id);
