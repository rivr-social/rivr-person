-- Migration 0039: Recovery seed UI — audit log + retired recovery keys
-- Implements GitHub issues rivr-social/rivr-person#12 #13 #14.
--
-- Adds tables supporting the sovereign recovery-seed flows:
--   - `recovery_seed_audit_log`  : append-only log of reveal/rotate attempts,
--                                    indexed per agent for in-app audit UI.
--   - `retired_recovery_keys`    : history of previously-active recovery
--                                    public keys, retained after rotation so
--                                    historical events signed by the old key
--                                    remain verifiable.
--
-- References:
--   - HANDOFF_2026-04-19_PRISM_RIVR_MCP_CONNECT.md — "Recovery Plan" #1 #2 #8.
--   - Cameron's Clarifications #2 (reveal requires fresh MFA, logged) and
--     #3 (seed UI gated to sovereign instances only).
--   - src/db/migrations/0037_federation_auth_foundations.sql (adds the active
--     recovery_public_key / fingerprint columns to agents).

-- ── email_verification_tokens.metadata ──────────────────────────
-- The recovery-seed MFA service reuses email_verification_tokens with new
-- token_type values ("recovery_seed_mfa_challenge", "recovery_seed_reveal_token").
-- Metadata carries per-challenge context (challengeId, method, attempts
-- remaining) so the verify path does not need a second table.
ALTER TABLE email_verification_tokens
  ADD COLUMN IF NOT EXISTS metadata jsonb;

COMMENT ON COLUMN email_verification_tokens.metadata IS
  'Optional JSON metadata per token row. Used by recovery-seed MFA flows to track challengeId, delivery method, and remaining verification attempts.';

-- ── recovery_seed_method enum ───────────────────────────────────
DO $$ BEGIN
  CREATE TYPE recovery_seed_method AS ENUM ('email', 'sms');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── recovery_seed_event_kind enum ───────────────────────────────
-- We log more than bare reveals so the activity audit can show the full
-- lifecycle: challenge issued, MFA passed/failed, reveal shown, rotation.
DO $$ BEGIN
  CREATE TYPE recovery_seed_event_kind AS ENUM (
    'challenge_issued',
    'challenge_verified',
    'challenge_failed',
    'reveal_succeeded',
    'rotate_succeeded'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── recovery_seed_audit_log ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS recovery_seed_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_kind recovery_seed_event_kind NOT NULL,
  method recovery_seed_method,
  outcome text,
  ip_address text,
  user_agent text,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recovery_seed_audit_log_agent_id_idx
  ON recovery_seed_audit_log (agent_id);
CREATE INDEX IF NOT EXISTS recovery_seed_audit_log_created_at_idx
  ON recovery_seed_audit_log (created_at);
CREATE INDEX IF NOT EXISTS recovery_seed_audit_log_agent_created_idx
  ON recovery_seed_audit_log (agent_id, created_at DESC);

COMMENT ON TABLE recovery_seed_audit_log IS
  'Append-only record of recovery-seed reveal/rotate activity: challenge issuance, MFA outcomes, completed reveals, and rotations. Drives the in-app Security audit view and rate-limit alerts.';
COMMENT ON COLUMN recovery_seed_audit_log.event_kind IS
  'Lifecycle stage: challenge_issued, challenge_verified, challenge_failed, reveal_succeeded, rotate_succeeded.';
COMMENT ON COLUMN recovery_seed_audit_log.method IS
  'MFA channel used for the challenge (email/sms). NULL for rotate_succeeded events that reuse an already-verified challenge.';
COMMENT ON COLUMN recovery_seed_audit_log.outcome IS
  'Short human-readable outcome string (e.g. "success", "code_expired", "rate_limited"). Free-form to avoid coupling schema to UI copy.';

-- ── retired_recovery_keys ───────────────────────────────────────
-- Retention policy: rows are immutable and retained for the lifetime of the
-- agent so peers verifying old signed recovery events can still look up the
-- signing key.
CREATE TABLE IF NOT EXISTS retired_recovery_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  public_key text NOT NULL,
  fingerprint text NOT NULL,
  created_at timestamptz NOT NULL,
  retired_at timestamptz NOT NULL DEFAULT now(),
  retirement_reason text NOT NULL DEFAULT 'rotated'
);

CREATE INDEX IF NOT EXISTS retired_recovery_keys_agent_id_idx
  ON retired_recovery_keys (agent_id);
CREATE INDEX IF NOT EXISTS retired_recovery_keys_fingerprint_idx
  ON retired_recovery_keys (fingerprint);

COMMENT ON TABLE retired_recovery_keys IS
  'History of previously-active recovery public keys. Retained so events signed before rotation remain verifiable. Plaintext seed is never stored.';
COMMENT ON COLUMN retired_recovery_keys.retirement_reason IS
  'Why the key was retired: rotated (user-initiated), revoked, compromised, etc.';
