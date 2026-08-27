-- ═══════════════════════════════════════════════════════════════════
-- 002  CUSTOMER ENTITIES — flexible per-vertical data
--
-- The dashboard's Add/Edit Customer form is driven entirely by
-- lib/industry-config.js on the frontend, which defines a different
-- set of "asset" fields (pet weight, vehicle mileage, AC brand, ...)
-- and "retention" fields (next grooming date, next service date, ...)
-- per business vertical. Those key/value pairs don't map onto a fixed
-- set of columns, so they're stored as JSONB blobs instead.
--
-- entity_type also moves off the old fixed pet/vehicle ENUM to a
-- plain string, since the frontend passes the business's vertical
-- (e.g. "salon_spa", "pest_control") which never matched the enum's
-- pet/vehicle values in the first place.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE customer_entities
  ALTER COLUMN entity_type TYPE VARCHAR(30) USING entity_type::text,
  ALTER COLUMN entity_type SET DEFAULT 'other';

DROP TYPE IF EXISTS entity_type;

ALTER TABLE customer_entities
  ADD COLUMN IF NOT EXISTS asset_data     JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS retention_data JSONB NOT NULL DEFAULT '{}'::jsonb;
