-- ═══════════════════════════════════════════════════════════════════
-- Shih-Fu CRM+  —  PostgreSQL Schema
-- India-focused retention platform: Vet / Salon / Auto verticals
--
-- Run order:
--   001_extensions  → 002_businesses  → 003_staff
--   → 004_customers → 005_pets_entities → 006_service_events
--   → 007_reminder_templates → 008_reminders → 009_message_log
--   → 010_audit_log → views → indexes
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- 001  EXTENSIONS
-- ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- for fuzzy search on names/phones
CREATE EXTENSION IF NOT EXISTS "citext";       -- case-insensitive email storage


-- ─────────────────────────────────────────────
-- 002  BUSINESSES  (multi-tenant root)
-- ─────────────────────────────────────────────
CREATE TYPE business_vertical AS ENUM (
  'veterinary',
  'salon_beauty',
  'auto_repair',
  'home_services',
  'retail',
  'other'
);

CREATE TYPE subscription_plan AS ENUM ('starter', 'growth', 'scale', 'enterprise');
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'cancelled');

CREATE TABLE businesses (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                VARCHAR(120)  NOT NULL,
  owner_name          VARCHAR(100)  NOT NULL,
  phone               VARCHAR(15)   NOT NULL,                   -- +91XXXXXXXXXX
  email               CITEXT        NOT NULL UNIQUE,
  gstin               VARCHAR(20),                              -- India GST
  city                VARCHAR(60),
  state               VARCHAR(60),
  pincode             VARCHAR(6),
  country             VARCHAR(40)   NOT NULL DEFAULT 'India',
  vertical            business_vertical NOT NULL,
  preferred_language  VARCHAR(10)   NOT NULL DEFAULT 'en',      -- en|hi|ta|te|kn|ml|mr|gu|bn|pa
  logo_url            TEXT,
  whatsapp_number     VARCHAR(15),
  plan                subscription_plan   NOT NULL DEFAULT 'trialing',
  plan_status         subscription_status NOT NULL DEFAULT 'trialing',
  trial_ends_at       TIMESTAMPTZ,
  plan_started_at     TIMESTAMPTZ,
  max_customers       INTEGER       NOT NULL DEFAULT 500,       -- plan limit
  is_active           BOOLEAN       NOT NULL DEFAULT true,
  onboarded_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_businesses_email    ON businesses (email);
CREATE INDEX idx_businesses_vertical ON businesses (vertical);
CREATE INDEX idx_businesses_plan     ON businesses (plan, plan_status);


-- ─────────────────────────────────────────────
-- 003  STAFF  (users who log into the dashboard)
-- ─────────────────────────────────────────────
CREATE TYPE staff_role AS ENUM ('owner', 'manager', 'staff', 'readonly');

CREATE TABLE staff (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID         NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  name          VARCHAR(100) NOT NULL,
  email         CITEXT       NOT NULL,
  phone         VARCHAR(15),
  password_hash TEXT         NOT NULL,
  role          staff_role   NOT NULL DEFAULT 'staff',
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  UNIQUE (business_id, email)
);

CREATE INDEX idx_staff_business ON staff (business_id);
CREATE INDEX idx_staff_email    ON staff (email);


-- ─────────────────────────────────────────────
-- 004  CUSTOMERS
-- One customer record per person per business.
-- ─────────────────────────────────────────────
CREATE TYPE customer_status AS ENUM ('active', 'dormant', 'lost', 'opted_out');
CREATE TYPE preferred_channel AS ENUM ('whatsapp', 'sms', 'email');

CREATE TABLE customers (
  id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID            NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,

  -- Identity
  name            VARCHAR(120)    NOT NULL,
  phone           VARCHAR(15)     NOT NULL,                     -- 10-digit Indian mobile
  phone_verified  BOOLEAN         NOT NULL DEFAULT false,
  email           CITEXT,
  city            VARCHAR(60),
  state           VARCHAR(60),
  pincode         VARCHAR(6),

  -- Communication
  preferred_channel preferred_channel NOT NULL DEFAULT 'whatsapp',
  opted_in_sms      BOOLEAN         NOT NULL DEFAULT false,
  opted_in_whatsapp BOOLEAN         NOT NULL DEFAULT false,
  opted_in_email    BOOLEAN         NOT NULL DEFAULT false,
  opted_in_at       TIMESTAMPTZ,
  opted_out_at      TIMESTAMPTZ,

  -- Lifecycle
  status          customer_status NOT NULL DEFAULT 'active',
  first_visit_at  TIMESTAMPTZ,
  last_visit_at   TIMESTAMPTZ,
  total_visits    INTEGER         NOT NULL DEFAULT 0,
  lifetime_value  NUMERIC(10,2)   NOT NULL DEFAULT 0,           -- INR

  -- Meta
  tags            TEXT[],                                       -- e.g. ['vip','senior_pet']
  notes           TEXT,
  source          VARCHAR(40)     DEFAULT 'manual',             -- manual|import|qr|pos|web
  external_id     VARCHAR(100),                                 -- POS / third-party ID
  created_by      UUID            REFERENCES staff (id),
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  UNIQUE (business_id, phone)
);

CREATE INDEX idx_customers_business   ON customers (business_id);
CREATE INDEX idx_customers_phone      ON customers (business_id, phone);
CREATE INDEX idx_customers_status     ON customers (business_id, status);
CREATE INDEX idx_customers_last_visit ON customers (business_id, last_visit_at);
CREATE INDEX idx_customers_name_trgm  ON customers USING GIN (name gin_trgm_ops);


-- ─────────────────────────────────────────────
-- 005  PETS & ENTITIES
-- Veterinary: pets. Auto: vehicles. Salon: usually blank.
-- Each customer may have multiple pets/vehicles.
-- ─────────────────────────────────────────────
CREATE TYPE entity_type AS ENUM (
  -- Vet
  'dog', 'cat', 'bird', 'rabbit', 'other_animal',
  -- Auto
  'car', 'two_wheeler', 'commercial_vehicle',
  -- Generic
  'person', 'other'
);

CREATE TABLE customer_entities (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id     UUID        NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  business_id     UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,

  -- Identity
  name            VARCHAR(100),                                 -- "Bruno", "MH12 AB1234"
  entity_type     entity_type NOT NULL DEFAULT 'other',
  breed_or_model  VARCHAR(120),                                 -- "Labrador", "Maruti Swift"
  dob_or_year     VARCHAR(20),                                  -- "Jan 2021" / "2019"
  gender          VARCHAR(10),
  colour          VARCHAR(40),
  weight_kg       NUMERIC(5,2),

  -- Vehicle-specific (auto vertical)
  registration_no VARCHAR(20),
  vin_chassis     VARCHAR(50),
  fuel_type       VARCHAR(20),
  insurance_expiry DATE,

  -- Vet-specific
  microchip_id    VARCHAR(50),
  vaccination_record JSONB,                                     -- { "rabies": "2024-03-01", "dhpp": "2024-03-01" }

  notes           TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_entities_customer  ON customer_entities (customer_id);
CREATE INDEX idx_entities_business  ON customer_entities (business_id);


-- ─────────────────────────────────────────────
-- 006  SERVICE EVENTS
-- Every visit, transaction, or appointment is a service event.
-- This is the source of truth that drives all automation.
-- ─────────────────────────────────────────────
CREATE TYPE event_status AS ENUM ('scheduled', 'completed', 'cancelled', 'no_show');

CREATE TABLE service_events (
  id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID            NOT NULL REFERENCES businesses (id)  ON DELETE CASCADE,
  customer_id     UUID            NOT NULL REFERENCES customers (id)   ON DELETE CASCADE,
  entity_id       UUID            REFERENCES customer_entities (id)    ON DELETE SET NULL,
  logged_by       UUID            REFERENCES staff (id)                ON DELETE SET NULL,

  -- Event details
  service_type    VARCHAR(100)    NOT NULL,       -- "Annual Vaccination", "Oil Change", etc.
  service_category VARCHAR(60),                   -- "vaccination", "grooming", "repair"
  event_date      DATE            NOT NULL DEFAULT CURRENT_DATE,
  event_time      TIME,
  status          event_status    NOT NULL DEFAULT 'completed',

  -- Financials (INR)
  amount_charged  NUMERIC(10,2),
  amount_paid     NUMERIC(10,2),
  payment_method  VARCHAR(30),                    -- upi|cash|card|emi

  -- Follow-up scheduling
  follow_up_days  INTEGER,                        -- override default rule (nullable = use template)
  next_due_date   DATE,                           -- computed: event_date + follow_up_days

  -- Staff & notes
  staff_name      VARCHAR(100),
  diagnosis       TEXT,
  prescription    TEXT,
  notes           TEXT,
  attachments     TEXT[],                         -- file URLs

  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_business     ON service_events (business_id);
CREATE INDEX idx_events_customer     ON service_events (customer_id);
CREATE INDEX idx_events_date         ON service_events (business_id, event_date DESC);
CREATE INDEX idx_events_next_due     ON service_events (business_id, next_due_date);
CREATE INDEX idx_events_service_type ON service_events (business_id, service_type);


-- ─────────────────────────────────────────────
-- 007  REMINDER TEMPLATES
-- Business-configurable rules: "For service X, remind after Y days"
-- ─────────────────────────────────────────────
CREATE TABLE reminder_templates (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id         UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,

  name                VARCHAR(120) NOT NULL,
  service_category    VARCHAR(60),                -- matches service_events.service_category
  service_type        VARCHAR(100),               -- exact match OR null = applies to all

  -- Timing
  remind_after_days   INTEGER     NOT NULL,       -- days after event_date
  remind_before_days  INTEGER,                    -- days before next_due_date (alternative trigger)

  -- Message templates (supports {customer_name}, {pet_name}, {business_name}, {service_type}, {due_date})
  whatsapp_template   TEXT,
  sms_template        TEXT,
  email_subject       TEXT,
  email_body          TEXT,

  -- Multi-step: if no response after first, send follow-up
  followup_after_days INTEGER,                    -- null = no follow-up
  followup_channel    preferred_channel,

  -- Control
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  priority            INTEGER     NOT NULL DEFAULT 0,           -- higher = checked first
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_templates_business  ON reminder_templates (business_id, is_active);
CREATE INDEX idx_templates_service   ON reminder_templates (business_id, service_type);


-- ─────────────────────────────────────────────
-- 008  REMINDERS
-- Scheduled reminder instances. One per customer per event.
-- The cron job reads this table and fires messages.
-- ─────────────────────────────────────────────
CREATE TYPE reminder_status AS ENUM (
  'scheduled',    -- waiting to be sent
  'sent',         -- successfully dispatched
  'delivered',    -- confirmed delivered (WhatsApp/SMS callback)
  'read',         -- read receipt (WhatsApp)
  'failed',       -- delivery failed
  'skipped',      -- manually skipped by staff
  'responded'     -- customer replied / booked
);

CREATE TYPE message_channel AS ENUM ('whatsapp', 'sms', 'email');

CREATE TABLE reminders (
  id              UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID              NOT NULL REFERENCES businesses (id)       ON DELETE CASCADE,
  customer_id     UUID              NOT NULL REFERENCES customers (id)        ON DELETE CASCADE,
  entity_id       UUID              REFERENCES customer_entities (id)         ON DELETE SET NULL,
  service_event_id UUID             REFERENCES service_events (id)            ON DELETE SET NULL,
  template_id     UUID              REFERENCES reminder_templates (id)        ON DELETE SET NULL,

  -- What & when
  reminder_type   VARCHAR(100)      NOT NULL,     -- "Annual Vaccination", "Oil Change", etc.
  channel         message_channel   NOT NULL,
  scheduled_at    TIMESTAMPTZ       NOT NULL,
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,

  -- Status
  status          reminder_status   NOT NULL DEFAULT 'scheduled',
  attempt_count   INTEGER           NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  failure_reason  TEXT,

  -- Message content (rendered at send time)
  message_body    TEXT,
  message_subject TEXT,                           -- email only

  -- External IDs for delivery tracking
  twilio_sid      VARCHAR(60),                    -- Twilio message SID (SMS)
  whatsapp_msg_id VARCHAR(80),                    -- Meta API message ID
  email_msg_id    VARCHAR(120),                   -- SMTP message ID

  -- Follow-up chain
  is_followup     BOOLEAN           NOT NULL DEFAULT false,
  parent_id       UUID              REFERENCES reminders (id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reminders_business     ON reminders (business_id);
CREATE INDEX idx_reminders_customer     ON reminders (customer_id);
CREATE INDEX idx_reminders_scheduled    ON reminders (scheduled_at) WHERE status = 'scheduled';
CREATE INDEX idx_reminders_status       ON reminders (business_id, status);
CREATE INDEX idx_reminders_due          ON reminders (business_id, scheduled_at, status);


-- ─────────────────────────────────────────────
-- 009  MESSAGE LOG
-- Immutable append-only log of every message sent.
-- Used for compliance, audit, and delivery analytics.
-- ─────────────────────────────────────────────
CREATE TABLE message_log (
  id              UUID            PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     UUID            NOT NULL REFERENCES businesses (id)    ON DELETE CASCADE,
  customer_id     UUID            NOT NULL REFERENCES customers (id)     ON DELETE CASCADE,
  reminder_id     UUID            REFERENCES reminders (id)              ON DELETE SET NULL,

  channel         message_channel NOT NULL,
  direction       VARCHAR(10)     NOT NULL DEFAULT 'outbound',           -- outbound|inbound
  recipient       VARCHAR(120)    NOT NULL,                              -- phone / email
  message_body    TEXT            NOT NULL,
  message_subject TEXT,

  -- Delivery metadata
  provider        VARCHAR(30),                                           -- twilio|meta|sendgrid
  provider_msg_id VARCHAR(120),
  status          VARCHAR(30)     NOT NULL DEFAULT 'sent',
  error_code      VARCHAR(20),
  error_message   TEXT,

  -- TRAI / Meta compliance
  dlt_template_id VARCHAR(50),                                           -- India DLT
  consent_verified BOOLEAN        NOT NULL DEFAULT false,

  sent_at         TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_msglog_business  ON message_log (business_id, sent_at DESC);
CREATE INDEX idx_msglog_customer  ON message_log (customer_id, sent_at DESC);
CREATE INDEX idx_msglog_reminder  ON message_log (reminder_id);


-- ─────────────────────────────────────────────
-- 010  AUDIT LOG
-- Tracks all create/update/delete actions by staff.
-- ─────────────────────────────────────────────
CREATE TABLE audit_log (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  staff_id      UUID        REFERENCES staff (id) ON DELETE SET NULL,
  action        VARCHAR(50) NOT NULL,             -- CREATE_CUSTOMER, UPDATE_REMINDER, etc.
  resource_type VARCHAR(50) NOT NULL,             -- customer | service_event | reminder
  resource_id   UUID,
  old_value     JSONB,
  new_value     JSONB,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_business ON audit_log (business_id, created_at DESC);
CREATE INDEX idx_audit_staff    ON audit_log (staff_id, created_at DESC);


-- ─────────────────────────────────────────────
-- TRIGGERS — auto-update updated_at
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'businesses','staff','customers','customer_entities',
    'service_events','reminder_templates','reminders'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at()', tbl
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;


-- ─────────────────────────────────────────────
-- TRIGGER — auto-compute next_due_date on service events
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION compute_next_due_date()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.follow_up_days IS NOT NULL AND NEW.event_date IS NOT NULL THEN
    NEW.next_due_date := NEW.event_date + NEW.follow_up_days;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_compute_next_due
  BEFORE INSERT OR UPDATE ON service_events
  FOR EACH ROW EXECUTE FUNCTION compute_next_due_date();


-- ─────────────────────────────────────────────
-- TRIGGER — update customer last_visit_at & total_visits
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_customer_visit_stats()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'completed' THEN
    UPDATE customers
    SET
      last_visit_at = GREATEST(last_visit_at, NEW.event_date::TIMESTAMPTZ),
      first_visit_at = LEAST(COALESCE(first_visit_at, NEW.event_date::TIMESTAMPTZ), NEW.event_date::TIMESTAMPTZ),
      total_visits   = total_visits + 1,
      lifetime_value = lifetime_value + COALESCE(NEW.amount_charged, 0),
      updated_at     = NOW()
    WHERE id = NEW.customer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_visit_stats
  AFTER INSERT ON service_events
  FOR EACH ROW EXECUTE FUNCTION update_customer_visit_stats();


-- ─────────────────────────────────────────────
-- VIEWS
-- ─────────────────────────────────────────────

-- Retention overview per business
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
LEFT JOIN customers c ON c.business_id = b.id
GROUP BY b.id, b.name;


-- Reminder queue: all pending reminders with customer context
CREATE OR REPLACE VIEW v_reminder_queue AS
SELECT
  r.id                        AS reminder_id,
  r.business_id,
  r.channel,
  r.reminder_type,
  r.scheduled_at,
  r.status,
  r.attempt_count,
  c.id                        AS customer_id,
  c.name                      AS customer_name,
  c.phone                     AS customer_phone,
  c.email                     AS customer_email,
  c.preferred_channel,
  e.name                      AS entity_name,
  e.breed_or_model,
  CASE
    WHEN r.scheduled_at < NOW()              THEN 'overdue'
    WHEN r.scheduled_at::DATE = CURRENT_DATE THEN 'today'
    ELSE 'upcoming'
  END                         AS urgency,
  r.scheduled_at::DATE - CURRENT_DATE AS days_until_due
FROM reminders r
JOIN customers c ON c.id = r.customer_id
LEFT JOIN customer_entities e ON e.id = r.entity_id
WHERE r.status = 'scheduled'
ORDER BY r.scheduled_at ASC;


-- Monthly message volume by channel per business
CREATE OR REPLACE VIEW v_message_volume AS
SELECT
  business_id,
  DATE_TRUNC('month', sent_at)  AS month,
  channel,
  COUNT(*)                       AS total_sent,
  COUNT(*) FILTER (WHERE status = 'sent')      AS delivered,
  COUNT(*) FILTER (WHERE status != 'sent')     AS failed
FROM message_log
WHERE direction = 'outbound'
GROUP BY business_id, DATE_TRUNC('month', sent_at), channel
ORDER BY month DESC;
