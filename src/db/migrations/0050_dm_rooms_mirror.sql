-- RIVR-side mirror for Matrix DM rooms so the (matrixRoomId, participants)
-- tuple survives a homeserver migration and degraded sync.
CREATE TABLE IF NOT EXISTS "dm_rooms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "matrix_room_id" text NOT NULL,
  "participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "dm_rooms_matrix_room_id_idx"
  ON "dm_rooms" ("matrix_room_id")
  WHERE "deleted_at" IS NULL;
