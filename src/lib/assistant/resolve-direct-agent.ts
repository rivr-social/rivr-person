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
// Resolution order (delegated to `findAutobotEnabledPersona`):
//   - the parent account's autobot-enabled child persona, if any; otherwise
//   - the parent account's own agent row (single-person instances store the
//     flag directly on the account row).
//
// When neither carries the autobot-enabled flag we fall back to the parent
// account id itself, so the builder always has a valid agent identity to key
// settings off of (the parent owns the wallet + MCP authority).
// ---------------------------------------------------------------------------

import { findAutobotEnabledPersona } from "@/app/actions/personas";
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

  const persona = await findAutobotEnabledPersona(controllerId);
  const directAgentId = persona?.id ?? controllerId;
  const isPersona = directAgentId !== controllerId;

  const autobotSettings = await getAutobotUserSettings(directAgentId);

  return {
    directAgentId,
    controllerId,
    isPersona,
    autobotSettings,
  };
}
