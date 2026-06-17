-- RFC 8628 device authorization grant records for MCP token issuance.
CREATE TABLE IF NOT EXISTS mcp_device_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code TEXT NOT NULL UNIQUE,
  user_code TEXT NOT NULL UNIQUE,
  client_name TEXT,
  scopes JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  token_jti UUID,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS mcp_device_codes_status_idx ON mcp_device_codes(status);
CREATE INDEX IF NOT EXISTS mcp_device_codes_expires_at_idx ON mcp_device_codes(expires_at);
