-- Custom domain configuration for sovereign Rivr instances.
-- Stores the custom domain, a DNS TXT verification token, and verification lifecycle state.
-- Each agent (instance owner) may have at most one custom domain.
--
-- Integration note: This table manages the application-level domain lifecycle.
-- Actual Traefik router/certificate provisioning must be handled separately
-- on the host (e.g., via deploy agent writing Traefik dynamic config).

DO $$ BEGIN
  CREATE TYPE domain_verification_status AS ENUM ('pending', 'verified', 'active');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS domain_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  custom_domain text NOT NULL,
  verification_token text NOT NULL,
  verification_status domain_verification_status NOT NULL DEFAULT 'pending',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS domain_configs_agent_id_idx ON domain_configs(agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS domain_configs_custom_domain_idx ON domain_configs(custom_domain);
CREATE INDEX IF NOT EXISTS domain_configs_verification_status_idx ON domain_configs(verification_status);
