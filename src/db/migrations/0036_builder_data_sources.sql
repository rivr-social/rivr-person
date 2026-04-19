-- Builder data-source bindings
-- Persisted registry of public data sources the site builder can bind to.

CREATE TABLE IF NOT EXISTS builder_data_sources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id      UUID NOT NULL,
  kind          TEXT NOT NULL,
  label         TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  config        JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bds_agent_id_idx ON builder_data_sources (agent_id);
CREATE INDEX IF NOT EXISTS bds_agent_kind_idx ON builder_data_sources (agent_id, kind);
