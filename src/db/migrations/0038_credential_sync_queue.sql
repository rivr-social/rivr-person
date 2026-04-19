-- Migration 0038: Credential sync queue (home → global)
-- Implements GitHub issue rivr-social/rivr-person#15.
--
-- After a local password reset on a home instance, the new credential hash
-- must be pushed to global so global's credentialVerifier stays current.
-- The push is best-effort: if global is unreachable, returns 5xx, or the
-- receiver is not yet deployed (rivr-app #7 / #88), the event is written
-- here instead of failing the user's password reset. A retry worker
-- re-attempts queued rows until they succeed or dead-letter.
--
-- References:
--   - HANDOFF_2026-04-19_PRISM_RIVR_MCP_CONNECT.md — "Federation Auth /
--     SSO Plan" step 3 and "Cameron's Clarifications" #1 + #4.
--   - src/lib/federation/credential-sync.ts — POST helper + queue writer.
--   - src/app/api/admin/federation/drain-credential-sync-queue/route.ts —
--     admin-gated retry worker trigger.

-- ── credential_sync_status enum ──────────────────────────────────
DO $$ BEGIN
  CREATE TYPE credential_sync_status AS ENUM ('pending', 'synced', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── credential_sync_queue ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credential_sync_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  event_payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  last_error text,
  status credential_sync_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────
-- Drain worker scans for pending rows older than a floor time; a
-- compound index keeps the scan index-only.
CREATE INDEX IF NOT EXISTS credential_sync_queue_status_idx
  ON credential_sync_queue (status);
CREATE INDEX IF NOT EXISTS credential_sync_queue_agent_id_idx
  ON credential_sync_queue (agent_id);
CREATE INDEX IF NOT EXISTS credential_sync_queue_status_last_attempt_idx
  ON credential_sync_queue (status, last_attempt_at);

-- ── Column documentation ─────────────────────────────────────────
COMMENT ON TABLE credential_sync_queue IS
  'Dead-letter / retry queue for credential.updated events that the home instance could not immediately deliver to global. Drained by a retry worker; dead-letters after MAX_ATTEMPTS.';
COMMENT ON COLUMN credential_sync_queue.agent_id IS
  'Agent whose credential was updated locally and needs to sync to global.';
COMMENT ON COLUMN credential_sync_queue.event_payload IS
  'Full signed credential.updated event (agentId, credentialVersion, updatedAt, signature, nonce). Re-sent verbatim on retry.';
COMMENT ON COLUMN credential_sync_queue.attempts IS
  'Number of delivery attempts made so far. Dead-lettered at MAX_CREDENTIAL_SYNC_ATTEMPTS.';
COMMENT ON COLUMN credential_sync_queue.last_attempt_at IS
  'Timestamp of the most recent delivery attempt (null until first retry).';
COMMENT ON COLUMN credential_sync_queue.last_error IS
  'Human-readable reason the most recent attempt failed (HTTP status, network error, etc.).';
COMMENT ON COLUMN credential_sync_queue.status IS
  'Lifecycle marker: pending (needs retry), synced (delivered), failed (dead-lettered).';
