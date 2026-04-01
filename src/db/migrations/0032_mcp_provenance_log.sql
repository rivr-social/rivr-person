-- MCP provenance log: append-only audit trail for every MCP tool invocation.
-- Records who called what, how they authenticated, what they passed, and whether it succeeded.
CREATE TABLE IF NOT EXISTS mcp_provenance_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name text NOT NULL,
  actor_id uuid NOT NULL,
  actor_type text NOT NULL,            -- 'human' | 'persona' | 'autobot'
  auth_mode text NOT NULL,             -- 'session' | 'token'
  controller_id uuid,                  -- parent controller (for personas/autobots)
  args_summary jsonb DEFAULT '{}'::jsonb,
  result_status text NOT NULL,         -- 'success' | 'error'
  error_message text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_provenance_log_tool_name_idx ON mcp_provenance_log(tool_name);
CREATE INDEX IF NOT EXISTS mcp_provenance_log_actor_id_idx ON mcp_provenance_log(actor_id);
CREATE INDEX IF NOT EXISTS mcp_provenance_log_actor_type_idx ON mcp_provenance_log(actor_type);
CREATE INDEX IF NOT EXISTS mcp_provenance_log_created_at_idx ON mcp_provenance_log(created_at DESC);
CREATE INDEX IF NOT EXISTS mcp_provenance_log_result_status_idx ON mcp_provenance_log(result_status);
