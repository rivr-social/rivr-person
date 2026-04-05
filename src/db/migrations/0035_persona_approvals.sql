-- Migration: persona_approvals
-- Creates persona_action_approvals and persona_audit_log tables
-- for the autobot approval hooks and policy engine.

-- ---------------------------------------------------------------------------
-- Enum for approval status
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "approval_status" AS ENUM ('pending', 'approved', 'rejected', 'expired');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ---------------------------------------------------------------------------
-- Enum for audit decision
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "audit_decision" AS ENUM ('auto_allowed', 'approved', 'rejected', 'expired');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ---------------------------------------------------------------------------
-- Enum for action risk level
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "action_risk_level" AS ENUM ('low', 'medium', 'high');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- ---------------------------------------------------------------------------
-- persona_action_approvals — queue of pending/resolved action approvals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "persona_action_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "persona_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "action_type" text NOT NULL,
  "action_payload" jsonb NOT NULL DEFAULT '{}',
  "risk_level" "action_risk_level" NOT NULL DEFAULT 'medium',
  "status" "approval_status" NOT NULL DEFAULT 'pending',
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "resolution_note" text,
  "expires_at" timestamp with time zone
);

-- Indices for persona_action_approvals
CREATE INDEX IF NOT EXISTS "paa_persona_id_idx" ON "persona_action_approvals" ("persona_id");
CREATE INDEX IF NOT EXISTS "paa_status_idx" ON "persona_action_approvals" ("status");
CREATE INDEX IF NOT EXISTS "paa_risk_level_idx" ON "persona_action_approvals" ("risk_level");
CREATE INDEX IF NOT EXISTS "paa_requested_at_idx" ON "persona_action_approvals" ("requested_at");
CREATE INDEX IF NOT EXISTS "paa_expires_at_idx" ON "persona_action_approvals" ("expires_at");
CREATE INDEX IF NOT EXISTS "paa_persona_status_idx" ON "persona_action_approvals" ("persona_id", "status");

-- ---------------------------------------------------------------------------
-- persona_audit_log — append-only log of all persona action decisions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "persona_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "persona_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "action_type" text NOT NULL,
  "risk_level" "action_risk_level" NOT NULL DEFAULT 'medium',
  "decision" "audit_decision" NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}',
  "actor_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "approval_id" uuid REFERENCES "persona_action_approvals"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Indices for persona_audit_log
CREATE INDEX IF NOT EXISTS "pal_persona_id_idx" ON "persona_audit_log" ("persona_id");
CREATE INDEX IF NOT EXISTS "pal_action_type_idx" ON "persona_audit_log" ("action_type");
CREATE INDEX IF NOT EXISTS "pal_decision_idx" ON "persona_audit_log" ("decision");
CREATE INDEX IF NOT EXISTS "pal_created_at_idx" ON "persona_audit_log" ("created_at");
CREATE INDEX IF NOT EXISTS "pal_persona_created_idx" ON "persona_audit_log" ("persona_id", "created_at");
