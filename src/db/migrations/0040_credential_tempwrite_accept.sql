-- Migration 0038: Accept-side credential temp-write schema
-- Implements GitHub issue rivr-social/rivr-person#16.
--
-- Adds two tables used by POST /api/recovery/accept-credential-tempwrite:
--   - credential_tempwrite_nonces     — replay protection (one-shot nonce ledger)
--   - credential_authority_audit      — append-only trail of credential-authority
--                                       transitions (temp-writes accepted/rejected,
--                                       plus any future authority.revoke/claim events)
--
-- Both tables are append-only and retain full history for the lifetime of the
-- agent so users (and operators) can see every time global temp-wrote credentials
-- to home, including failed attempts.
--
-- References:
--   - HANDOFF_2026-04-19_PRISM_RIVR_MCP_CONNECT.md — Cameron's Clarifications #4.
--   - src/lib/federation/accept-tempwrite.ts   — apply/verify helper.
--   - src/app/api/recovery/accept-credential-tempwrite/route.ts — HTTP surface.

-- ── credential_tempwrite_nonces ───────────────────────────────────
-- Tracks every nonce we have ever accepted so a replayed temp-write
-- (even with a valid signature) is rejected.  Lookup is nonce-first,
-- agentId filters are secondary.  Rows are kept indefinitely; nonces
-- are low-cardinality UUIDs so storage growth is bounded by rotation
-- frequency, not agent count.
CREATE TABLE IF NOT EXISTS credential_tempwrite_nonces (
  nonce               text    PRIMARY KEY,
  agent_id            uuid    NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  credential_version  integer NOT NULL,
  seen_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credential_tempwrite_nonces_agent_id_idx
  ON credential_tempwrite_nonces (agent_id);

CREATE INDEX IF NOT EXISTS credential_tempwrite_nonces_seen_at_idx
  ON credential_tempwrite_nonces (seen_at);

COMMENT ON TABLE  credential_tempwrite_nonces IS
  'Replay-protection ledger for credential.tempwrite.from-global events. A nonce may appear at most once.';
COMMENT ON COLUMN credential_tempwrite_nonces.nonce IS
  'Nonce from the signed event payload. Enforced unique by the primary key.';
COMMENT ON COLUMN credential_tempwrite_nonces.credential_version IS
  'Credential version carried by the event whose nonce we are recording (for diagnostics only; not enforced).';

-- ── credential_authority_audit ────────────────────────────────────
-- Append-only audit trail intended to be user-visible in the activity
-- feed.  Every attempt — success OR failure — must produce exactly one
-- row so users can see when global tried to temp-write credentials to
-- their home instance, whether it was accepted, and why a rejection
-- happened (invalid signature, replay, non-monotonic version, etc.).
CREATE TABLE IF NOT EXISTS credential_authority_audit (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id            uuid        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_kind          text        NOT NULL,      -- 'tempwrite.accepted' | 'tempwrite.rejected'
  source              text        NOT NULL DEFAULT 'global',
  outcome             text        NOT NULL,      -- 'accepted' | short failure code
  credential_version  integer,                   -- NULL when rejected before parse
  nonce               text,                      -- NULL when rejected before parse
  ip_address          text,
  detail              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credential_authority_audit_agent_id_idx
  ON credential_authority_audit (agent_id);

CREATE INDEX IF NOT EXISTS credential_authority_audit_agent_created_idx
  ON credential_authority_audit (agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS credential_authority_audit_event_kind_idx
  ON credential_authority_audit (event_kind);

COMMENT ON TABLE  credential_authority_audit IS
  'Append-only audit log of credential-authority transitions. Every accept-credential-tempwrite attempt appends exactly one row.';
COMMENT ON COLUMN credential_authority_audit.event_kind IS
  'Discriminator: tempwrite.accepted | tempwrite.rejected. Future kinds (authority.revoke, successor.claim) may reuse this table.';
COMMENT ON COLUMN credential_authority_audit.outcome IS
  'Short machine-readable outcome code. "accepted" when applied; else a rejection reason such as "invalid_signature" or "stale_version".';
COMMENT ON COLUMN credential_authority_audit.detail IS
  'Structured context: signingNodeSlug, rejection field, previous/new credentialVersion, etc. No secret material.';
