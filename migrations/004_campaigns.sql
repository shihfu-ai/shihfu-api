-- ═══════════════════════════════════════════════════════════════════
-- 004  CAMPAIGNS
--
-- Bulk messages a business sends to its whole customer base at once —
-- festival greetings, promos, seasonal offers. Each campaign can go
-- out immediately or be scheduled for a future date (e.g. Diwali,
-- New Year) so the owner can plan a year of outreach in advance
-- without it slipping their mind. A cron job (like reminderCron)
-- picks up due campaigns and dispatches them via the same messaging
-- service and message_log audit trail as individual reminders.
-- ═══════════════════════════════════════════════════════════════════

CREATE TYPE campaign_status AS ENUM ('scheduled', 'sending', 'sent', 'failed', 'cancelled');

CREATE TABLE campaigns (
  id              UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID              NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  created_by      UUID              REFERENCES staff (id) ON DELETE SET NULL,

  label           VARCHAR(120)      NOT NULL,             -- "Diwali Greetings 2026"
  message_body    TEXT              NOT NULL,
  channels        TEXT[]            NOT NULL,              -- subset of whatsapp|sms|email

  scheduled_at    TIMESTAMPTZ       NOT NULL,
  status          campaign_status   NOT NULL DEFAULT 'scheduled',

  sent_count      INTEGER           NOT NULL DEFAULT 0,
  skipped_count   INTEGER           NOT NULL DEFAULT 0,
  failed_count    INTEGER           NOT NULL DEFAULT 0,
  sent_at         TIMESTAMPTZ,

  created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_campaigns_business  ON campaigns (business_id);
CREATE INDEX idx_campaigns_due       ON campaigns (status, scheduled_at);

-- Link each dispatched message back to the campaign that sent it, same
-- audit trail individual reminders already get via message_log.
ALTER TABLE message_log
  ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns (id) ON DELETE SET NULL;
