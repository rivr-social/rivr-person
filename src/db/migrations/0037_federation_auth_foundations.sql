-- Migration 0037: Federation-auth foundations (recovery key + instance mode)
-- Implements GitHub issue rivr-social/rivr-person#11.
--
-- Adds per-agent fields supporting the two-user-class federation-auth model:
--   - `instance_mode`    : distinguishes sovereign vs hosted-federated agents
--   - `recovery_*`       : stores only the PUBLIC half of a seed-phrase-derived
--                          keypair. Plaintext seed is NEVER persisted.
--   - `credential_version`: monotonic counter bumped on password/recovery
--                          rotation; mirrors global's `identity_authority`
--                          counter so drift is detectable during sync.
--
-- References:
--   - HANDOFF_2026-04-19_PRISM_RIVR_MCP_CONNECT.md — Cameron's Clarifications
--     #3 (seed phrase sovereign-only) and #5 (two user classes).
--   - src/lib/instance-mode.ts — server-side helper reading RIVR_INSTANCE_MODE.
--   - src/app/api/instance/mode/route.ts — exposes mode to the client.

-- ── instance_mode enum ────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE instance_mode AS ENUM ('hosted-federated', 'sovereign');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── agents: federation-auth columns ──────────────────────────────
ALTER TABLE agents ADD COLUMN IF NOT EXISTS instance_mode instance_mode;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS recovery_public_key text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS recovery_key_fingerprint text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS recovery_key_created_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS recovery_key_rotated_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS credential_version integer NOT NULL DEFAULT 1;

-- ── Indexes ──────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS agents_instance_mode_idx
  ON agents (instance_mode);

-- One agent at a time may own a given recovery-key fingerprint. Partial
-- index so un-classified / hosted-federated rows (which share NULL) do
-- not collide.
CREATE UNIQUE INDEX IF NOT EXISTS agents_recovery_key_fingerprint_idx
  ON agents (recovery_key_fingerprint)
  WHERE recovery_key_fingerprint IS NOT NULL;

-- ── Column documentation ─────────────────────────────────────────
COMMENT ON COLUMN agents.instance_mode IS
  'Operating mode for this agent: sovereign (home-server, seed-phrase UI) or hosted-federated (global is credential authority). NULL means pre-migration; treat as hosted-federated for safety.';
COMMENT ON COLUMN agents.recovery_public_key IS
  'Public half of the seed-phrase-derived recovery keypair. Plaintext seed is NEVER stored server-side.';
COMMENT ON COLUMN agents.recovery_key_fingerprint IS
  'Stable fingerprint of the recovery public key (for display, audit, and UM identity anchor).';
COMMENT ON COLUMN agents.recovery_key_created_at IS
  'Timestamp when the initial recovery key was generated.';
COMMENT ON COLUMN agents.recovery_key_rotated_at IS
  'Timestamp of the most recent recovery key rotation (null until first rotation).';
COMMENT ON COLUMN agents.credential_version IS
  'Monotonic counter bumped on credential changes (password, recovery rotation). Mirrors global identity_authority.credentialVersion for drift detection.';
