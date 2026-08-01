/**
 * @fileoverview Viewer-scoped exposure rules for a serialized agent.
 *
 * `agents.metadata` is a single JSONB grab-bag. It holds public profile display
 * data (bio, skills, persona traits) side by side with material that must never
 * leave the server: contact details, billing references, notification and
 * privacy configuration, account-security stamps, and — since the autobot lane
 * landed — assistant/connector settings that carry live third-party credentials.
 *
 * `serializeAgent` passes that blob through verbatim, and the public profile
 * route (`GET /api/profile/[username]`, which answers unauthenticated callers)
 * returned it to anyone who asked. On 2026-07-31 that route was serving a
 * plaintext GPU-provider API key and a phone number from production.
 *
 * The rule here is an ALLOWLIST, deliberately, and not a deny-list. A deny-list
 * fails open: every new metadata key ships publicly until someone remembers to
 * add it, which is exactly how `autobotSettings.gpuProviderApiKey` became world-
 * readable. With an allowlist a new key is private until it is consciously
 * published.
 *
 * Scope: this governs the field-level blob. `filterAgentByPrivacy`
 * (`@/lib/federation/privacy-filter`) remains the per-viewer scope engine for
 * the federation query lane and is unchanged — the two compose, and this module
 * is the floor beneath it.
 *
 * Key exports: `PUBLIC_AGENT_METADATA_FIELDS`,
 * `sanitizeAgentMetadataForPublic`, `toViewerScopedAgent`.
 */

/**
 * Metadata keys that may be served to a viewer who is not the profile owner.
 *
 * Three groups, all verified against real consumers before inclusion:
 *
 * 1. Profile display — read by `profile-client.tsx` when rendering a profile.
 * 2. Persona traits — the public-profile module manifest fields
 *    (`@/lib/bespoke/modules/public-profile`), which are also the exact set
 *    `PROJECTION_PERMITTED_METADATA_FIELDS` syncs into federated projections.
 * 3. Federation routing — home/canonical stamps that let a remote instance
 *    resolve a projection back to its sovereign home. Non-secret by nature and
 *    required for correct cross-instance routing.
 *
 * Anything absent is private by default. Notably excluded and intended to stay
 * excluded: `autobotSettings`, `autobotEnabled`, `phone`, `privacySettings`,
 * `notificationSettings`, `emailNotifications`, `passwordChangedAt`,
 * `termsAcceptedAt`, `stripeSubscriptionId`, `subscriptionStatus`,
 * `subscriptionTier`, `taxReserve`, `murmurationsPublishing`, `updatedVia`.
 */
export const PUBLIC_AGENT_METADATA_FIELDS: ReadonlySet<string> = new Set([
  // 1. Profile display
  "bio",
  "tagline",
  "location",
  "homeLocale",
  "username",
  "coverImage",
  "profilePhotos",
  "skills",
  "socialLinks",
  "social_links",
  "interests",
  "languages",
  "chapterTags",
  "groupTags",
  "resources",
  "points",

  // 2. Persona traits (public-profile manifest / projection-permitted set)
  "geneKeys",
  "humanDesign",
  "westernAstrology",
  "vedicAstrology",
  "ocean",
  "myersBriggs",
  "enneagram",

  // 3. Federation routing stamps
  "homeBaseUrl",
  "canonicalUrl",
  "homeInstanceUrl",
  "homeInstanceSlug",
  "homeInstanceNodeId",
  "sourceNodeId",
  "sourceNodeSlug",
  "isProjection",
  "federatedPlaceholder",
  "externalEntityId",
]);

/**
 * Returns a copy of an agent metadata blob containing only the keys in
 * {@link PUBLIC_AGENT_METADATA_FIELDS}.
 *
 * Keys holding `undefined` are dropped so the response distinguishes "not set"
 * from "withheld" the same way the stored blob does. The input is never mutated.
 *
 * @param metadata - The stored `agents.metadata` blob (may be null/undefined).
 * @returns A new object safe to serve to a non-owner viewer.
 * @example
 * ```ts
 * sanitizeAgentMetadataForPublic({ bio: "hi", phone: "555", autobotSettings: {} })
 * // => { bio: "hi" }
 * ```
 */
export function sanitizeAgentMetadataForPublic(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};

  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) continue;
    if (PUBLIC_AGENT_METADATA_FIELDS.has(key)) safe[key] = value;
  }
  return safe;
}

/**
 * Applies {@link sanitizeAgentMetadataForPublic} to a serialized agent unless
 * the viewer IS the agent, preserving the surrounding response shape.
 *
 * The owner keeps the full blob: they are the subject, their own settings UI
 * reads it, and withholding it from them would break owner surfaces without
 * closing any exposure.
 *
 * @param agent - A serialized agent (shape preserved; input not mutated).
 * @param options.isSelf - True when the requesting actor is this agent.
 * @returns The agent with metadata scoped to the viewer.
 */
export function toViewerScopedAgent<T extends { metadata?: unknown }>(
  agent: T,
  options: { isSelf: boolean },
): T {
  if (options.isSelf) return agent;
  return {
    ...agent,
    metadata: sanitizeAgentMetadataForPublic(
      agent.metadata as Record<string, unknown> | null | undefined,
    ),
  };
}
