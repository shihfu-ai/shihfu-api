-- ═══════════════════════════════════════════════════════════════════
-- 007  CHECK-IN LINK
--
-- Each business gets an unguessable token that powers its public
-- "quick check-in" form (/checkin/<token>) — shown on an iPad at the
-- counter or texted/WhatsApped to a customer who phones to book. The
-- token is the only thing protecting the public endpoint, so it can be
-- regenerated if the link ever leaks. Created lazily on first use.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS checkin_token VARCHAR(40) UNIQUE;
