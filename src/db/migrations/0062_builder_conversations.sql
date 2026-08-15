CREATE TABLE IF NOT EXISTS "builder_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "workspace_id" text NOT NULL,
  "base_path" text DEFAULT '' NOT NULL,
  "messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "builder_conversations_owner_workspace_idx"
  ON "builder_conversations" ("agent_id", "workspace_id", "base_path");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "builder_conversations_owner_updated_idx"
  ON "builder_conversations" ("agent_id", "updated_at");
