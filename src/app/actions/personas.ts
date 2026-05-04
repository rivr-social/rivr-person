'use server';

/**
 * Server actions for persona management.
 *
 * Personas are child agents linked to a parent account via `parent_agent_id`.
 * They share the parent's wallet but own their own content, profile, and social graph.
 *
 * Key exports:
 * - `createPersona` - Creates a new persona agent under the current user
 * - `listMyPersonas` - Returns all personas owned by the current user
 * - `updatePersona` - Updates a persona's profile fields
 * - `deletePersona` - Soft-deletes a persona
 * - `switchActivePersona` - Sets the active persona cookie
 * - `getActivePersonaInfo` - Returns info about the currently active persona
 */

import { auth } from '@/auth';
import { db } from '@/db';
import { agents } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { getExecutionContext } from '@/lib/federation/execution-context';
import {
  getActivePersonaId,
  setActivePersonaCookie,
  MAX_PERSONAS_PER_ACCOUNT,
} from '@/lib/persona';
import { serializeAgent } from '@/lib/graph-serializers';
import type { SerializedAgent } from '@/lib/graph-serializers';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maximum lengths for persona profile fields. */
const MAX_NAME_LENGTH = 100;
const MAX_USERNAME_LENGTH = 40;
const MAX_BIO_LENGTH = 500;
const MAX_TAGLINE_LENGTH = 140;
const MAX_PRONOUNS_LENGTH = 40;
const MAX_LANGUAGE_LENGTH = 40;
const MAX_VOICE_STYLE_LENGTH = 40;
const MAX_AVATAR_URL_LENGTH = 2000;
const MAX_IMAGE_URL_LENGTH = 2000;

// Constants/types moved to @/lib/persona-config so client components can
// import them without forcing this "use server" file's value-level exports
// to be required-async (which Next 15 enforces).
import {
  PERSONA_SKILL_KEYS,
  type AutobotControlMode,
} from '@/lib/persona-config';

const SKILL_KEY_SET = new Set<string>(PERSONA_SKILL_KEYS);
const SKILL_VALUE_MIN = 0;
const SKILL_VALUE_MAX = 100;

/**
 * Gets the authenticated user ID or throws.
 */
async function requireUserId(): Promise<string> {
  const executionContext = getExecutionContext();
  if (executionContext?.source === 'mcp') {
    return executionContext.controllerId ?? executionContext.actorId;
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) throw new Error('Unauthorized');
  return userId;
}

/**
 * Sanitizes and validates a `skills` map. Returns either the cleaned map (only
 * known keys, clamped to [0, 100]) or an error message describing the failure.
 */
function sanitizeSkills(
  raw: unknown,
): { ok: true; skills: Record<string, number> } | { ok: false; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, skills: {} };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Skills must be an object map.' };
  }
  const cleaned: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SKILL_KEY_SET.has(key)) {
      // Drop unknown keys silently; keeps forward/backward compatibility for new sliders.
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `Skill "${key}" must be a number.` };
    }
    const clamped = Math.max(SKILL_VALUE_MIN, Math.min(SKILL_VALUE_MAX, Math.round(value)));
    cleaned[key] = clamped;
  }
  return { ok: true, skills: cleaned };
}

/** Input shape for creating a persona via the character-creator flow. */
export interface CreatePersonaInput {
  name: string;
  username?: string;
  bio?: string;
  /** 2D avatar image URL (sets agents.image). */
  image?: string;
  tagline?: string;
  pronouns?: string;
  /** One of VOICE_STYLE_OPTIONS — free-form string is preserved if unrecognized. */
  voiceStyle?: string;
  language?: string;
  /** Public URL of an uploaded `.glb` model; persisted to `metadata.avatar3dUrl`. */
  avatar3dUrl?: string;
  /** Map of `PERSONA_SKILL_KEYS` to scores in [0, 100]. */
  skills?: Record<string, number>;
  /** Operating mode for autobot delegation. */
  autobotControlMode?: AutobotControlMode;
}

/**
 * Creates a new persona agent under the current user's account.
 *
 * The persona is a regular agent row with:
 * - `parent_agent_id` set to the current user
 * - `type` = 'person'
 * - `metadata.isPersona` = true
 * - No email or password (personas cannot log in independently)
 *
 * The character-creator flow may also persist `tagline`, `pronouns`, `voiceStyle`,
 * `language`, `avatar3dUrl`, `skills`, and `autobotControlMode` into metadata.
 */
export async function createPersona(input: CreatePersonaInput): Promise<{
  success: boolean;
  personaId?: string;
  error?: string;
}> {
  const userId = await requireUserId();

  const name = (input.name ?? '').trim();
  if (!name || name.length > MAX_NAME_LENGTH) {
    return { success: false, error: 'Name is required and must be under 100 characters.' };
  }

  const username = (input.username ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (username && username.length > MAX_USERNAME_LENGTH) {
    return { success: false, error: 'Username must be under 40 characters.' };
  }

  const bio = (input.bio ?? '').trim();
  if (bio.length > MAX_BIO_LENGTH) {
    return { success: false, error: 'Bio must be under 500 characters.' };
  }

  // Optional rich-creator fields
  const tagline = (input.tagline ?? '').trim();
  if (tagline.length > MAX_TAGLINE_LENGTH) {
    return { success: false, error: `Tagline must be under ${MAX_TAGLINE_LENGTH} characters.` };
  }

  const pronouns = (input.pronouns ?? '').trim();
  if (pronouns.length > MAX_PRONOUNS_LENGTH) {
    return { success: false, error: `Pronouns must be under ${MAX_PRONOUNS_LENGTH} characters.` };
  }

  const voiceStyle = (input.voiceStyle ?? '').trim();
  if (voiceStyle.length > MAX_VOICE_STYLE_LENGTH) {
    return { success: false, error: `Voice style must be under ${MAX_VOICE_STYLE_LENGTH} characters.` };
  }

  const language = (input.language ?? '').trim();
  if (language.length > MAX_LANGUAGE_LENGTH) {
    return { success: false, error: `Language must be under ${MAX_LANGUAGE_LENGTH} characters.` };
  }

  const image = (input.image ?? '').trim();
  if (image.length > MAX_IMAGE_URL_LENGTH) {
    return { success: false, error: 'Image URL is too long.' };
  }

  const avatar3dUrl = (input.avatar3dUrl ?? '').trim();
  if (avatar3dUrl.length > MAX_AVATAR_URL_LENGTH) {
    return { success: false, error: '3D avatar URL is too long.' };
  }

  let controlMode: AutobotControlMode | undefined;
  if (input.autobotControlMode !== undefined) {
    if (!VALID_CONTROL_MODES.includes(input.autobotControlMode)) {
      return { success: false, error: 'Invalid control mode.' };
    }
    controlMode = input.autobotControlMode;
  }

  const skillsResult = sanitizeSkills(input.skills);
  if (!skillsResult.ok) {
    return { success: false, error: skillsResult.error };
  }

  // Check persona limit
  const [countResult] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    );
  const currentCount = Number(countResult?.count ?? 0);
  if (currentCount >= MAX_PERSONAS_PER_ACCOUNT) {
    return {
      success: false,
      error: `You can have at most ${MAX_PERSONAS_PER_ACCOUNT} personas.`,
    };
  }

  // Check username uniqueness if provided
  if (username) {
    const [existing] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          sql`(${agents.metadata}->>'username')::text = ${username}`,
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);
    if (existing) {
      return { success: false, error: 'That username is already taken.' };
    }
  }

  const metadata: Record<string, unknown> = {
    isPersona: true,
    bio: bio || undefined,
    username: username || undefined,
    tagline: tagline || undefined,
    pronouns: pronouns || undefined,
    voiceStyle: voiceStyle || undefined,
    language: language || undefined,
    avatar3dUrl: avatar3dUrl || undefined,
    skills: Object.keys(skillsResult.skills).length > 0 ? skillsResult.skills : undefined,
    autobotControlMode: controlMode,
  };

  const [newAgent] = await db
    .insert(agents)
    .values({
      name,
      type: 'person',
      parentAgentId: userId,
      visibility: 'public',
      image: image || null,
      metadata,
    })
    .returning({ id: agents.id });

  return { success: true, personaId: newAgent.id };
}

/**
 * Lists all personas belonging to the current user.
 */
export async function listMyPersonas(): Promise<{
  success: boolean;
  personas?: SerializedAgent[];
  activePersonaId?: string | null;
  error?: string;
}> {
  const userId = await requireUserId();

  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(agents.createdAt);

  const activeId = await getActivePersonaId();

  return {
    success: true,
    personas: rows.map((r) => serializeAgent(r)),
    activePersonaId: activeId,
  };
}

/**
 * Updates a persona's profile fields.
 * Only the parent account can update its personas.
 */
export async function updatePersona(input: {
  personaId: string;
  name?: string;
  username?: string;
  bio?: string;
  image?: string;
}): Promise<{ success: boolean; error?: string }> {
  const userId = await requireUserId();

  if (!input.personaId || !UUID_RE.test(input.personaId)) {
    return { success: false, error: 'Invalid persona ID.' };
  }

  // Verify ownership
  const [persona] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.id, input.personaId),
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona) {
    return { success: false, error: 'Persona not found or not owned by you.' };
  }

  const updates: Record<string, unknown> = {};
  const metadataUpdates: Record<string, unknown> = {
    ...((persona.metadata ?? {}) as Record<string, unknown>),
  };

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name || name.length > MAX_NAME_LENGTH) {
      return { success: false, error: 'Name is required and must be under 100 characters.' };
    }
    updates.name = name;
  }

  if (input.username !== undefined) {
    const username = input.username.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (username.length > MAX_USERNAME_LENGTH) {
      return { success: false, error: 'Username must be under 40 characters.' };
    }
    // Check uniqueness (excluding self)
    if (username) {
      const [existing] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            sql`(${agents.metadata}->>'username')::text = ${username}`,
            sql`${agents.id} != ${input.personaId}`,
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);
      if (existing) {
        return { success: false, error: 'That username is already taken.' };
      }
    }
    metadataUpdates.username = username || undefined;
  }

  if (input.bio !== undefined) {
    const bio = input.bio.trim();
    if (bio.length > MAX_BIO_LENGTH) {
      return { success: false, error: 'Bio must be under 500 characters.' };
    }
    metadataUpdates.bio = bio || undefined;
  }

  if (input.image !== undefined) {
    updates.image = input.image || null;
  }

  updates.metadata = metadataUpdates;
  updates.updatedAt = new Date();

  await db
    .update(agents)
    .set(updates as Partial<typeof agents.$inferInsert>)
    .where(eq(agents.id, input.personaId));

  return { success: true };
}

/**
 * Soft-deletes a persona. Must be owned by the current user.
 * If the deleted persona was active, clears the persona cookie.
 */
export async function deletePersona(
  personaId: string,
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireUserId();

  if (!personaId || !UUID_RE.test(personaId)) {
    return { success: false, error: 'Invalid persona ID.' };
  }

  // Verify ownership
  const [persona] = await db
    .select({ id: agents.id })
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
    return { success: false, error: 'Persona not found or not owned by you.' };
  }

  await db
    .update(agents)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(agents.id, personaId));

  // Clear active persona if it was the deleted one
  const activeId = await getActivePersonaId();
  if (activeId === personaId) {
    await setActivePersonaCookie(null);
  }

  return { success: true };
}

/**
 * Switches the active persona. Pass null to revert to the main account.
 */
export async function switchActivePersona(
  personaId: string | null,
): Promise<{ success: boolean; error?: string }> {
  const userId = await requireUserId();

  if (personaId === null) {
    await setActivePersonaCookie(null);
    return { success: true };
  }

  if (!UUID_RE.test(personaId)) {
    return { success: false, error: 'Invalid persona ID.' };
  }

  // Verify ownership
  const [persona] = await db
    .select({ id: agents.id })
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
    return { success: false, error: 'Persona not found or not owned by you.' };
  }

  await setActivePersonaCookie(personaId);
  return { success: true };
}

/**
 * Returns info about the currently active persona (or null if operating as self).
 */
export async function getActivePersonaInfo(): Promise<{
  active: boolean;
  persona?: SerializedAgent;
}> {
  const executionContext = getExecutionContext();
  if (executionContext?.source === 'mcp' && executionContext.actorType === 'persona') {
    const [persona] = await db
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.id, executionContext.actorId),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);

    if (!persona || !persona.parentAgentId) {
      return { active: false };
    }

    return {
      active: true,
      persona: serializeAgent(persona),
    };
  }

  const activeId = await getActivePersonaId();
  if (!activeId) return { active: false };

  const [persona] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, activeId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona || !persona.parentAgentId) {
    return { active: false };
  }

  return {
    active: true,
    persona: serializeAgent(persona),
  };
}

// ---------------------------------------------------------------------------
// Autobot control-pane metadata types and constants
// ---------------------------------------------------------------------------

// AutobotControlMode imported from @/lib/persona-config (above).

const VALID_CONTROL_MODES: readonly AutobotControlMode[] = [
  'direct-only',
  'approval-required',
  'delegated',
] as const;

/**
 * Updates autobot-specific metadata fields on a persona.
 *
 * Stores `autobotEnabled` and `autobotControlMode` in the persona's
 * `agents.metadata` JSON column alongside existing profile fields.
 */
export async function updatePersonaAutobotSettings(input: {
  personaId: string;
  autobotEnabled?: boolean;
  autobotControlMode?: AutobotControlMode;
}): Promise<{ success: boolean; error?: string }> {
  const userId = await requireUserId();

  if (!input.personaId || !UUID_RE.test(input.personaId)) {
    return { success: false, error: 'Invalid persona ID.' };
  }

  // Verify ownership
  const [persona] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        eq(agents.id, input.personaId),
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona) {
    return { success: false, error: 'Persona not found or not owned by you.' };
  }

  const metadataUpdates: Record<string, unknown> = {
    ...((persona.metadata ?? {}) as Record<string, unknown>),
  };

  if (input.autobotEnabled !== undefined) {
    metadataUpdates.autobotEnabled = Boolean(input.autobotEnabled);
  }

  if (input.autobotControlMode !== undefined) {
    if (!VALID_CONTROL_MODES.includes(input.autobotControlMode)) {
      return { success: false, error: 'Invalid control mode.' };
    }
    metadataUpdates.autobotControlMode = input.autobotControlMode;
  }

  await db
    .update(agents)
    .set({
      metadata: metadataUpdates,
      updatedAt: new Date(),
    } as Partial<typeof agents.$inferInsert>)
    .where(eq(agents.id, input.personaId));

  return { success: true };
}

// ---------------------------------------------------------------------------
// Public helpers (no auth required)
// ---------------------------------------------------------------------------

/**
 * Finds the first autobot-enabled persona for a given parent agent ID.
 * Falls back to the profile agent itself for older single-person instances
 * that stored the public chat flag directly on the account row.
 *
 * This does NOT require authentication — it reads from public persona metadata.
 */
export async function findAutobotEnabledPersona(
  parentAgentId: string,
): Promise<SerializedAgent | null> {
  if (!parentAgentId || !UUID_RE.test(parentAgentId)) return null;

  const rows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, parentAgentId),
        isNull(agents.deletedAt),
        sql`lower(coalesce(metadata->>'autobotEnabled', metadata->>'autobot_enabled', 'false')) = 'true'`,
      ),
    )
    .limit(1);

  if (rows[0]) return serializeAgent(rows[0]);

  const selfRows = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, parentAgentId),
        isNull(agents.deletedAt),
        sql`lower(coalesce(metadata->>'autobotEnabled', metadata->>'autobot_enabled', 'false')) = 'true'`,
      ),
    )
    .limit(1);

  return selfRows[0] ? serializeAgent(selfRows[0]) : null;
}
