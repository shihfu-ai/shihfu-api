-- ═══════════════════════════════════════════════════════════════════
-- 006  BUSINESS VERTICAL WIDENING + PASSWORD RESET
--
-- businesses.vertical was a 6-value ENUM (veterinary, salon_beauty,
-- auto_repair, home_services, retail, other) but the actual signup
-- form (lib/industry-config.js) offers 10 different vertical keys
-- (salon_spa, home_cleaning, ac_maintenance, pest_control,
-- healthcare_eye, healthcare_dental, fitness_wellness, real_estate,
-- plus the 2 that already matched). Only 2 of the 10 signup options
-- ever passed validation - every other business type failed signup
-- with "Validation failed". Same fix already applied to
-- customer_entities.entity_type in migration 002: move off the rigid
-- enum to a plain string.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE businesses
  ALTER COLUMN vertical TYPE VARCHAR(30) USING vertical::text;

DROP TYPE IF EXISTS business_vertical;

-- ─────────────────────────────────────────────
-- Password reset via emailed OTP
-- ─────────────────────────────────────────────
CREATE TABLE password_reset_otps (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_id        UUID          NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
  otp_hash        TEXT          NOT NULL,
  expires_at      TIMESTAMPTZ   NOT NULL,
  attempt_count   INTEGER       NOT NULL DEFAULT 0,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_password_reset_staff ON password_reset_otps (staff_id, used_at);
