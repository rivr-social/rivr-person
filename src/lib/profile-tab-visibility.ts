/**
 * Profile (first-class user) tab-visibility resolution.
 *
 * The person app homes a single sovereign user, so the profile owner deserves
 * metadata-driven, level-based tab-visibility control. This module is the SINGLE
 * pure source of truth for that computation — shared by the public profile
 * client (filtering rendered tabs) and the settings editor — mirroring how the
 * sovereign group repo keeps `resolveGroupMemberCapability` in a pure module.
 *
 * The model is intentionally identical in shape to the group model so the fleet
 * shares one mental model; only the per-person LEVEL semantics differ (see the
 * note on {@link ProfileViewerRelation}).
 */

import {
  PROFILE_TAB_KEYS,
  DEFAULT_PROFILE_TAB_VISIBILITY,
  type ProfileTabKey,
  type ProfileTabVisibilitySettings,
  type ProfileTabVisibilityLevel,
} from "@/lib/types";

/**
 * Visibility levels valid for a PERSON profile tab. Distinct from the group set
 * ("members"/"admin" don't apply to a person); a normalizer coerces unknown or
 * group-only values back to a safe default so a tampered/legacy payload can
 * never widen access.
 */
export const PROFILE_TAB_VISIBILITY_LEVELS = [
  "public",
  "connections",
  "self",
  "hidden",
] as const satisfies readonly ProfileTabVisibilityLevel[];

const PROFILE_TAB_VISIBILITY_LEVEL_SET: ReadonlySet<string> = new Set(
  PROFILE_TAB_VISIBILITY_LEVELS,
);
const PROFILE_TAB_KEY_SET: ReadonlySet<string> = new Set(PROFILE_TAB_KEYS);

/** Metadata key under which a person agent stores its profile tab overrides. */
export const PROFILE_TAB_VISIBILITY_METADATA_KEY = "profileTabVisibility" as const;

/**
 * The relationship a viewer has to the profile being rendered. Resolved by the
 * caller (server: from the session + connection graph) and passed in so this
 * module stays pure and synchronous.
 *
 * - "self"        → the viewer IS the profile owner. Sees every non-hidden tab.
 * - "connections" → an accepted connection of the owner.
 * - "public"      → anyone else (including anonymous / federated visitors).
 */
export type ProfileViewerRelation = "self" | "connections" | "public";

/** Ordered access rank: a higher rank can see everything a lower rank can. */
const VIEWER_RANK: Record<ProfileViewerRelation, number> = {
  public: 0,
  connections: 1,
  self: 2,
};

/**
 * The minimum viewer rank required to see a tab at a given profile visibility
 * level. "hidden" is unreachable (Infinity) so no viewer — not even the owner —
 * sees it on the public-facing render, matching the group "hidden" semantics.
 * Group-only levels ("members"/"admin") never reach this map: the normalizer and
 * {@link isProfileTabVisibilityLevel} reject them, so a stored stray value falls
 * back to the per-tab default rather than being ranked here.
 */
const LEVEL_REQUIRED_RANK: Record<ProfileTabVisibilityLevel, number> = {
  public: VIEWER_RANK.public,
  connections: VIEWER_RANK.connections,
  self: VIEWER_RANK.self,
  hidden: Number.POSITIVE_INFINITY,
};

/**
 * Whether a value is a recognized profile tab visibility level.
 */
export function isProfileTabVisibilityLevel(
  value: unknown,
): value is ProfileTabVisibilityLevel {
  return typeof value === "string" && PROFILE_TAB_VISIBILITY_LEVEL_SET.has(value);
}

/**
 * Normalize raw stored profile tab-visibility input: drop unknown tab keys and
 * coerce invalid/group-only levels back to the per-tab default. Returns only the
 * overrides that actually diverge from the default so storage stays sparse.
 */
export function normalizeProfileTabVisibility(
  raw: unknown,
): ProfileTabVisibilitySettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: ProfileTabVisibilitySettings = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!PROFILE_TAB_KEY_SET.has(key)) continue;
    if (!isProfileTabVisibilityLevel(value)) continue;
    const tab = key as ProfileTabKey;
    // Persist only divergence from the default; selecting the default is a no-op.
    if (value === DEFAULT_PROFILE_TAB_VISIBILITY[tab]) continue;
    result[tab] = value;
  }
  return result;
}

/**
 * Resolve the effective visibility LEVEL for a single profile tab, honoring an
 * explicit per-tab override and falling back to the default-on default.
 */
export function resolveProfileTabVisibilityLevel(
  settings: ProfileTabVisibilitySettings | null | undefined,
  tab: ProfileTabKey,
): ProfileTabVisibilityLevel {
  const override = settings?.[tab];
  if (isProfileTabVisibilityLevel(override)) return override;
  return DEFAULT_PROFILE_TAB_VISIBILITY[tab];
}

/**
 * Whether a tab is visible to a viewer with the given relationship to the owner.
 */
export function isProfileTabVisibleToViewer(
  settings: ProfileTabVisibilitySettings | null | undefined,
  tab: ProfileTabKey,
  viewer: ProfileViewerRelation,
): boolean {
  const level = resolveProfileTabVisibilityLevel(settings, tab);
  return VIEWER_RANK[viewer] >= LEVEL_REQUIRED_RANK[level];
}

/**
 * Compute the ordered set of profile tabs a viewer may see. Order follows the
 * canonical {@link PROFILE_TAB_KEYS} so the rendered tab strip is deterministic.
 */
export function resolveVisibleProfileTabs(
  settings: ProfileTabVisibilitySettings | null | undefined,
  viewer: ProfileViewerRelation,
): ProfileTabKey[] {
  return PROFILE_TAB_KEYS.filter((tab) =>
    isProfileTabVisibleToViewer(settings, tab, viewer),
  );
}

/**
 * Read a person agent's stored profile tab-visibility settings out of its
 * metadata bag, normalizing along the way. Tolerates the metadata being absent
 * or malformed (returns `{}`), so all overrides fall back to default-on.
 */
export function readProfileTabVisibility(
  metadata: Record<string, unknown> | null | undefined,
): ProfileTabVisibilitySettings {
  if (!metadata || typeof metadata !== "object") return {};
  return normalizeProfileTabVisibility(metadata[PROFILE_TAB_VISIBILITY_METADATA_KEY]);
}
