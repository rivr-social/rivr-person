"use server";

/**
 * Server action for assigning a 3D model as avatar on a profile or persona.
 *
 * Stores the 3D avatar URL in the agent's metadata under the `metaverseAvatar` key.
 * For personas, also verifies ownership through parent_agent_id.
 *
 * Key exports:
 * - `setAvatar3d` - Sets a 3D model URL as the metaverse avatar for a profile or persona.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/* ── Constants ── */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const AVATAR_3D_METADATA_KEY = "metaverseAvatar";

const TARGET_PROFILE = "profile" as const;
const TARGET_PERSONA = "persona" as const;

type AvatarTarget =
  | { type: typeof TARGET_PROFILE }
  | { type: typeof TARGET_PERSONA; personaId: string };

type SetAvatar3dResult = {
  success: boolean;
  error?: string;
};

/**
 * Sets a 3D model URL as the metaverse avatar for the user's profile or one of their personas.
 *
 * @param target - Whether to set on the profile or a specific persona.
 * @param modelUrl - The URL of the 3D model resource to assign.
 * @returns Success or error result.
 */
export async function setAvatar3d(
  target: AvatarTarget,
  modelUrl: string,
): Promise<SetAvatar3dResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "You must be logged in." };
  }

  const userId = session.user.id;

  if (!modelUrl || typeof modelUrl !== "string") {
    return { success: false, error: "A valid model URL is required." };
  }

  if (target.type === TARGET_PROFILE) {
    return setProfileAvatar3d(userId, modelUrl);
  }

  if (target.type === TARGET_PERSONA) {
    if (!target.personaId || !UUID_RE.test(target.personaId)) {
      return { success: false, error: "Invalid persona ID." };
    }
    return setPersonaAvatar3d(userId, target.personaId, modelUrl);
  }

  return { success: false, error: "Invalid target type." };
}

/**
 * Clears the 3D avatar from the user's profile or persona.
 */
export async function clearAvatar3d(
  target: AvatarTarget,
): Promise<SetAvatar3dResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "You must be logged in." };
  }

  const userId = session.user.id;

  if (target.type === TARGET_PROFILE) {
    return setProfileAvatar3d(userId, null);
  }

  if (target.type === TARGET_PERSONA) {
    if (!target.personaId || !UUID_RE.test(target.personaId)) {
      return { success: false, error: "Invalid persona ID." };
    }
    return setPersonaAvatar3d(userId, target.personaId, null);
  }

  return { success: false, error: "Invalid target type." };
}

/* ── Internal helpers ── */

async function setProfileAvatar3d(
  userId: string,
  modelUrl: string | null,
): Promise<SetAvatar3dResult> {
  try {
    const [current] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, userId))
      .limit(1);

    if (!current) {
      return { success: false, error: "User not found." };
    }

    const existingMetadata =
      current.metadata && typeof current.metadata === "object"
        ? (current.metadata as Record<string, unknown>)
        : {};

    const nextMetadata = { ...existingMetadata };
    if (modelUrl) {
      nextMetadata[AVATAR_3D_METADATA_KEY] = modelUrl;
    } else {
      delete nextMetadata[AVATAR_3D_METADATA_KEY];
    }

    await db
      .update(agents)
      .set({
        metadata: nextMetadata,
        updatedAt: new Date(),
      } as Partial<typeof agents.$inferInsert>)
      .where(eq(agents.id, userId));

    revalidatePath("/profile");
    revalidatePath("/settings");
    return { success: true };
  } catch {
    return { success: false, error: "Failed to update 3D avatar." };
  }
}

async function setPersonaAvatar3d(
  userId: string,
  personaId: string,
  modelUrl: string | null,
): Promise<SetAvatar3dResult> {
  try {
    const [persona] = await db
      .select({ id: agents.id, metadata: agents.metadata })
      .from(agents)
      .where(
        and(
          eq(agents.id, personaId),
          eq(agents.parentAgentId, userId),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);

    if (!persona) {
      return { success: false, error: "Persona not found or not owned by you." };
    }

    const existingMetadata =
      persona.metadata && typeof persona.metadata === "object"
        ? (persona.metadata as Record<string, unknown>)
        : {};

    const nextMetadata = { ...existingMetadata };
    if (modelUrl) {
      nextMetadata[AVATAR_3D_METADATA_KEY] = modelUrl;
    } else {
      delete nextMetadata[AVATAR_3D_METADATA_KEY];
    }

    await db
      .update(agents)
      .set({
        metadata: nextMetadata,
        updatedAt: new Date(),
      } as Partial<typeof agents.$inferInsert>)
      .where(eq(agents.id, personaId));

    revalidatePath("/profile");
    revalidatePath("/autobot");
    return { success: true };
  } catch {
    return { success: false, error: "Failed to update persona 3D avatar." };
  }
}
