-- ═══════════════════════════════════════════════════════════════════
-- 005  BUSINESS EMAIL CONNECTIONS
--
-- Lets a business connect their own Google/Gmail account so reminder
-- and campaign emails send through their own mailbox instead of a
-- shared Shih-Fu address — Shih-Fu never gets inbox/read access, only
-- the narrow "send" permission, and tokens are encrypted at rest.
-- One connection per business for now (Google only); provider is kept
-- as a column rather than assumed so another provider (e.g. Microsoft)
-- can be added later without a schema change.
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE business_email_connections (
  business_id           UUID          PRIMARY KEY REFERENCES businesses (id) ON DELETE CASCADE,
  provider              VARCHAR(20)   NOT NULL DEFAULT 'google',
  connected_email        CITEXT        NOT NULL,
  access_token_enc      TEXT          NOT NULL,   -- AES-256-GCM, see src/utils/crypto.js
  refresh_token_enc     TEXT          NOT NULL,
  token_expires_at      TIMESTAMPTZ   NOT NULL,
  scope                 TEXT,
  connected_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
