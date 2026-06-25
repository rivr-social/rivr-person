-- Builder-owned tables (Wave 2 / T2.4)
-- The "Data" tab in the builder is the set of tables the builder defines for
-- the app/site it is working on. A table is a name + a JSONB column schema;
-- rows store a JSONB object keyed by the table's column keys.

CREATE TABLE IF NOT EXISTS builder_tables (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL,
  site_slug    TEXT NOT NULL DEFAULT 'default',
  name         TEXT NOT NULL,
  description  TEXT,
  columns      JSONB NOT NULL DEFAULT '[]',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS btbl_agent_id_idx ON builder_tables (agent_id);
CREATE INDEX IF NOT EXISTS btbl_agent_site_idx ON builder_tables (agent_id, site_slug);

CREATE TABLE IF NOT EXISTS builder_table_rows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id    UUID NOT NULL REFERENCES builder_tables (id) ON DELETE CASCADE,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS btblrow_table_id_idx ON builder_table_rows (table_id);
