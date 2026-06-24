import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getActivePersonaId, setActivePersonaCookie } from "@/lib/persona";
import { resolveDirectAgent } from "@/lib/assistant/resolve-direct-agent";

// ---------------------------------------------------------------------------
// Autobot connection scope
//
// Connectors are AGENT-OWNED: each connector lives in
// `agents.metadata.autobotSettings.connections` keyed to the agent that owns
// it. This module resolves WHICH agent's connector lane a given request reads
// and writes, and HOW inheritance applies (A2/A3):
//
//   - The MAIN PROFILE owner owns + edits the full agent connector lane.
//   - A PERSONA owns its own connector lane, but the connector UI for a persona
//     surfaces only the SHARED subset inherited from its parent agent (A2:
//     "Personas show SHARED connectors only").
//   - The ASSISTANT (the user's direct agent — resolved via
//     `resolveDirectAgent`, NOT a persona) INHERITS the agent's connectors. It
//     reads the direct agent's lane rather than its own NextAuth `accounts`
//     flow (A3: "the assistant inherits the agent's connectors").
// ---------------------------------------------------------------------------

/** Constant scope-type identifiers (no magic strings at call sites). */
export const SCOPE_TYPE_PERSON = "person" as const;
export const SCOPE_TYPE_PERSONA = "persona" as const;

/** Human-readable scope labels. */
export const MAIN_PROFILE_SCOPE_LABEL = "Main profile";
export const DEFAULT_PERSONA_SCOPE_LABEL = "Persona";

/** Settings route + tab the connectors flow lives on. */
export const CONNECTORS_SETTINGS_PATH = "/settings";
export const CONNECTORS_SETTINGS_TAB = "connectors";
export const DEFAULT_REDIRECT_BASE_URL = "http://localhost:3000";

export type AutobotConnectionScopeType =
  | typeof SCOPE_TYPE_PERSON
  | typeof SCOPE_TYPE_PERSONA;

export type AutobotConnectionScope = {
  /** The agent id whose connector lane this request reads/writes. */
  actorId: string;
  /** The controlling parent account id. */
  ownerId: string;
  scopeType: AutobotConnectionScopeType;
  scopeLabel: string;
  personaName?: string;
  /**
   * When true, this scope only exposes the SHARED subset inherited from the
   * owning agent (persona inheritance). When false/undefined, the scope owns
   * and edits its full connector lane (main profile / direct agent).
   */
  inheritedSharedOnly?: boolean;
};

/**
 * Resolves the persona-cookie-driven connector scope for the connectors UI.
 *
 * The MAIN PROFILE owns the full agent connector lane. When a persona is
 * active, the persona's connector surface shows the SHARED subset only
 * (`inheritedSharedOnly: true`), implementing the A2 rule that personas show
 * shared connectors only.
 *
 * @param ownerId - The authenticated parent account id (`session.user.id`).
 * @throws {Error} When `ownerId` is empty.
 */
export async function resolveAutobotConnectionScope(
  ownerId: string,
): Promise<AutobotConnectionScope> {
  if (!ownerId) {
    throw new Error("resolveAutobotConnectionScope: ownerId is required.");
  }

  const activePersonaId = await getActivePersonaId();
  if (!activePersonaId) {
    return {
      actorId: ownerId,
      ownerId,
      scopeType: SCOPE_TYPE_PERSON,
      scopeLabel: MAIN_PROFILE_SCOPE_LABEL,
    };
  }

  const [persona] = await db
    .select({
      id: agents.id,
      name: agents.name,
      parentAgentId: agents.parentAgentId,
    })
    .from(agents)
    .where(
      and(
        eq(agents.id, activePersonaId),
        eq(agents.parentAgentId, ownerId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona) {
    await setActivePersonaCookie(null);
    return {
      actorId: ownerId,
      ownerId,
      scopeType: SCOPE_TYPE_PERSON,
      scopeLabel: MAIN_PROFILE_SCOPE_LABEL,
    };
  }

  const personaLabel = persona.name?.trim()
    ? persona.name.trim()
    : DEFAULT_PERSONA_SCOPE_LABEL;

  return {
    actorId: persona.id,
    ownerId,
    scopeType: SCOPE_TYPE_PERSONA,
    scopeLabel: personaLabel,
    personaName: persona.name?.trim() ? persona.name.trim() : undefined,
    // Personas inherit the shared subset of the parent agent's connectors.
    inheritedSharedOnly: true,
  };
}

/**
 * Resolves the ASSISTANT's connector scope (A3). The assistant is the user's
 * DIRECT AGENT (resolved via `resolveDirectAgent`), NOT a persona, and it
 * INHERITS the agent's connectors — so its connector lane IS the direct
 * agent's lane. This is the scope the assistant chat/builder should read so it
 * never maintains a separate connector setup.
 *
 * @param controllerId - The authenticated parent account id (`session.user.id`).
 * @throws {Error} When `controllerId` is empty.
 */
export async function resolveAssistantConnectionScope(
  controllerId: string,
): Promise<AutobotConnectionScope> {
  if (!controllerId) {
    throw new Error(
      "resolveAssistantConnectionScope: controllerId is required.",
    );
  }

  const { directAgentId, isPersona } = await resolveDirectAgent(controllerId);

  if (!isPersona) {
    return {
      actorId: directAgentId,
      ownerId: controllerId,
      scopeType: SCOPE_TYPE_PERSON,
      scopeLabel: MAIN_PROFILE_SCOPE_LABEL,
    };
  }

  // The direct agent is a persona-backed agent row. The assistant still
  // inherits the FULL connector lane of that agent (not the shared-only
  // subset), so it can act as that agent.
  const [agentRow] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, directAgentId))
    .limit(1);

  const label = agentRow?.name?.trim()
    ? agentRow.name.trim()
    : DEFAULT_PERSONA_SCOPE_LABEL;

  return {
    actorId: directAgentId,
    ownerId: controllerId,
    scopeType: SCOPE_TYPE_PERSONA,
    scopeLabel: label,
    personaName: agentRow?.name?.trim() ? agentRow.name.trim() : undefined,
  };
}

export function buildConnectionsRedirectUrl(
  baseUrl: string,
  params?: Record<string, string | null | undefined>,
): string {
  const normalizedBaseUrl = baseUrl.trim() || DEFAULT_REDIRECT_BASE_URL;
  const url = new URL(CONNECTORS_SETTINGS_PATH, normalizedBaseUrl);
  url.searchParams.set("tab", CONNECTORS_SETTINGS_TAB);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value.trim()) {
        url.searchParams.set(key, value.trim());
      }
    }
  }
  return url.toString();
}
