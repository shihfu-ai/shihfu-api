-- ═══════════════════════════════════════════════════════════════════
-- 003  CUSTOMERS — address field
--
-- The Add/Edit Customer form has always had an "Address / Area" field,
-- but customers never had a column for it, so anything typed there was
-- silently discarded on every save. Phone editing has the same "typed
-- but discarded" shape but doesn't need a schema change (the phone
-- column already exists) — just wiring in the route/validation layer.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS address TEXT;
