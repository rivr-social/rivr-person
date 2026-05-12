-- Soft-delete column for groupMatrixRooms so we can reconcile rows whose
-- Synapse-side rooms have been purged without losing the historical mapping.
ALTER TABLE "group_matrix_rooms" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint

DROP INDEX IF EXISTS "group_matrix_rooms_group_agent_id_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "group_matrix_rooms_matrix_room_id_idx";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "group_matrix_rooms_group_agent_id_idx"
  ON "group_matrix_rooms" ("group_agent_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "group_matrix_rooms_matrix_room_id_idx"
  ON "group_matrix_rooms" ("matrix_room_id")
  WHERE "deleted_at" IS NULL;
