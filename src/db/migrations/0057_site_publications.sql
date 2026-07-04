-- Site publications (builder publish -> serve on custom domains).
--
--   site_publications : the current *published* builder site per owner agent,
--                       plus its optional custom-domain binding. Publishing
--                       snapshots the workspace files into a `site_versions` row
--                       AND writes those files into MinIO under `storage_prefix`
--                       (in `storage_bucket`). Host-dispatch (`/site-host`)
--                       resolves an incoming foreign Host header to the matching
--                       bound `custom_domain` and streams the requested file
--                       from storage.
--
-- Home-authority (per-instance); NEVER federated. No secrets stored here: the
-- DNS-write credential lives only on the agent's autobot connector lane
-- (encrypted at rest). Distinct from `domain_configs`, which points a domain at
-- the whole sovereign instance (Traefik router) rather than at a published
-- static site. Idempotent so it can be applied by hand where the boot migrate
-- chain is blocked.

CREATE TABLE IF NOT EXISTS site_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  published_version_id uuid REFERENCES site_versions(id) ON DELETE SET NULL,
  published_version_number integer,
  storage_bucket text,
  storage_prefix text,
  file_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  theme text,
  custom_domain text,
  domain_provider text,
  domain_status text NOT NULL DEFAULT 'unbound',
  domain_error text,
  published_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One publication per owner agent.
CREATE UNIQUE INDEX IF NOT EXISTS site_publications_agent_id_idx
  ON site_publications (agent_id);
-- At most one owner per bound custom domain; many NULLs allowed.
CREATE UNIQUE INDEX IF NOT EXISTS site_publications_custom_domain_idx
  ON site_publications (custom_domain);

COMMENT ON TABLE site_publications IS
  'Current published builder site per owner agent plus optional custom-domain binding served via host-dispatch from MinIO. No secrets stored here. Home-authority; never federated.';
