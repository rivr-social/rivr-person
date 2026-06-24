// ---------------------------------------------------------------------------
// Canonical direct-agent resolver
//
// The "direct agent" is the ONE user-facing AI assistant that also acts as the
// builder/execution agent. This module is the single resolution path so the
// assistant chat, the builder routes, and any future surfaces all agree on:
//
//   1. WHICH agent id is the user's direct agent, and
//   2. WHICH `autobotSettings` blob (model, connectors, MCP token) drives it.
//
// The self-facing assistant ALWAYS resolves to the user's own account (their
// "clone"): the parent account id is the single direct-agent identity that owns
// the wallet + MCP authority. A child persona NEVER silently takes over the
// assistant — a persona acts only when the user explicitly selects it in the
// chat bubble for that chat (the chat surface threads that selection through
// its own `personaId` path; see `api/autobot/chat/route.ts`).
//
// (The public-facing profile-chat surfaces still use
// `findAutobotEnabledPersona` to pick which persona answers visitors — that is
// a different surface and is unaffected by this resolver.)
// ---------------------------------------------------------------------------

import {
  getAutobotUserSettings,
  type AutobotUserSettings,
} from "@/lib/autobot-user-settings";

/**
 * The resolved direct agent: the agent id that owns the assistant/builder
 * identity, the parent account id that controls it, and that agent's
 * `autobotSettings` (model, connectors, lazily-provisioned MCP token).
 */
export interface ResolvedDirectAgent {
  /** Agent id the assistant/builder runs as. */
  directAgentId: string;
  /** Parent account id that owns/controls the direct agent. */
  controllerId: string;
  /** Whether the resolved direct agent is a persona (vs. the account itself). */
  isPersona: boolean;
  /** The direct agent's autobot settings blob (model, connectors, MCP token). */
  autobotSettings: AutobotUserSettings;
}

/**
 * Resolves the canonical direct-agent for a parent account and loads its
 * `autobotSettings`. This is the ONE path the assistant + builder share so they
 * operate as a single agent identity with a single settings blob.
 *
 * @param controllerId - The authenticated parent account id (e.g.
 *   `session.user.id`). Must be a valid agent id.
 * @returns The resolved direct agent id + its autobot settings.
 * @throws {Error} When `controllerId` is empty.
 */
export async function resolveDirectAgent(
  controllerId: string,
): Promise<ResolvedDirectAgent> {
  if (!controllerId) {
    throw new Error("resolveDirectAgent: controllerId is required.");
  }

  // The direct agent is ALWAYS the account/clone. A persona never silently
  // becomes the self-facing assistant; explicit per-chat persona selection is
  // handled at the chat surface, not here.
  const directAgentId = controllerId;
  const autobotSettings = await getAutobotUserSettings(directAgentId);

  return {
    directAgentId,
    controllerId,
    isPersona: false,
    autobotSettings,
  };
}
