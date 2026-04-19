-- Site versions: version history for the bespoke site builder.
-- Each row is a complete snapshot of all site files, enabling lossless rollback.
CREATE TABLE IF NOT EXISTS site_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  version_number integer NOT NULL,
  commit_message text,
  files_snapshot jsonb NOT NULL,
  trigger text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_versions_agent_id_idx ON site_versions(agent_id);
CREATE INDEX IF NOT EXISTS site_versions_agent_version_idx ON site_versions(agent_id, version_number);
CREATE INDEX IF NOT EXISTS site_versions_created_at_idx ON site_versions(created_at DESC);
