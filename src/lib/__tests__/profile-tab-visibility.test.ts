/**
 * Tests for the pure profile (first-class user) tab-visibility model.
 *
 * The person app homes a single sovereign user, so the profile owner gets the
 * same metadata-driven, level-based tab-visibility control a group admin has.
 * These tests pin the pure resolver (no DB): default-on behavior, explicit-off
 * restriction, sparse normalization, defensive coercion of group-only/invalid
 * levels, and the viewer-rank gating that decides which tabs a self/connection/
 * public viewer sees. They mirror the sovereign group repo's capability-
 * resolution test shape, adapted to the person app's profile tab set
 * (about/posts/docs/media/events/groups/photos/offerings/activity).
 */
import { describe, it, expect } from "vitest";
import {
  PROFILE_TAB_KEYS,
  DEFAULT_PROFILE_TAB_VISIBILITY,
  type ProfileTabVisibilitySettings,
} from "@/lib/types";
import {
  PROFILE_TAB_VISIBILITY_LEVELS,
  PROFILE_TAB_VISIBILITY_METADATA_KEY,
  isProfileTabVisibilityLevel,
  normalizeProfileTabVisibility,
  resolveProfileTabVisibilityLevel,
  isProfileTabVisibleToViewer,
  resolveVisibleProfileTabs,
  readProfileTabVisibility,
} from "@/lib/profile-tab-visibility";

describe("profile tab-visibility — defaults (default-on)", () => {
  it("every profile tab defaults to public when no overrides are stored", () => {
    for (const tab of PROFILE_TAB_KEYS) {
      expect(DEFAULT_PROFILE_TAB_VISIBILITY[tab]).toBe("public");
      expect(resolveProfileTabVisibilityLevel({}, tab)).toBe("public");
      expect(resolveProfileTabVisibilityLevel(null, tab)).toBe("public");
      expect(resolveProfileTabVisibilityLevel(undefined, tab)).toBe("public");
    }
  });

  it("a public (anonymous) viewer sees ALL tabs by default", () => {
    const visible = resolveVisibleProfileTabs({}, "public");
    expect(visible).toEqual([...PROFILE_TAB_KEYS]);
  });

  it("self and connections viewers also see all tabs by default", () => {
    expect(resolveVisibleProfileTabs({}, "self")).toEqual([...PROFILE_TAB_KEYS]);
    expect(resolveVisibleProfileTabs({}, "connections")).toEqual([
      ...PROFILE_TAB_KEYS,
    ]);
  });
});

describe("profile tab-visibility — explicit-off restriction", () => {
  it("a connections-level tab is hidden from the public but shown to connections and self", () => {
    const settings: ProfileTabVisibilitySettings = { offerings: "connections" };
    expect(isProfileTabVisibleToViewer(settings, "offerings", "public")).toBe(false);
    expect(isProfileTabVisibleToViewer(settings, "offerings", "connections")).toBe(true);
    expect(isProfileTabVisibleToViewer(settings, "offerings", "self")).toBe(true);
  });

  it("a self-level tab is shown only to the owner", () => {
    const settings: ProfileTabVisibilitySettings = { photos: "self" };
    expect(isProfileTabVisibleToViewer(settings, "photos", "public")).toBe(false);
    expect(isProfileTabVisibleToViewer(settings, "photos", "connections")).toBe(false);
    expect(isProfileTabVisibleToViewer(settings, "photos", "self")).toBe(true);
  });

  it("a hidden tab is shown to NO viewer, not even the owner", () => {
    const settings: ProfileTabVisibilitySettings = { photos: "hidden" };
    expect(isProfileTabVisibleToViewer(settings, "photos", "public")).toBe(false);
    expect(isProfileTabVisibleToViewer(settings, "photos", "connections")).toBe(false);
    expect(isProfileTabVisibleToViewer(settings, "photos", "self")).toBe(false);
  });

  it("restricting one tab does not affect the others (they stay default-on)", () => {
    const settings: ProfileTabVisibilitySettings = { photos: "hidden" };
    const visibleToPublic = resolveVisibleProfileTabs(settings, "public");
    expect(visibleToPublic).not.toContain("photos");
    expect(visibleToPublic).toEqual(
      PROFILE_TAB_KEYS.filter((t) => t !== "photos"),
    );
  });

  it("mixed levels gate each viewer rank correctly", () => {
    const settings: ProfileTabVisibilitySettings = {
      about: "public",
      posts: "connections",
      events: "self",
      photos: "hidden",
    };
    expect(resolveVisibleProfileTabs(settings, "public")).toEqual([
      "about",
      "docs",
      "media",
      "groups",
      "offerings",
      "activity",
    ]);
    expect(resolveVisibleProfileTabs(settings, "connections")).toEqual([
      "about",
      "posts",
      "docs",
      "media",
      "groups",
      "offerings",
      "activity",
    ]);
    expect(resolveVisibleProfileTabs(settings, "self")).toEqual([
      "about",
      "posts",
      "docs",
      "media",
      "events",
      "groups",
      "offerings",
      "activity",
    ]);
  });
});

describe("isProfileTabVisibilityLevel", () => {
  it("accepts exactly the four profile levels", () => {
    for (const level of PROFILE_TAB_VISIBILITY_LEVELS) {
      expect(isProfileTabVisibilityLevel(level)).toBe(true);
    }
  });

  it("rejects group-only levels and junk", () => {
    expect(isProfileTabVisibilityLevel("members")).toBe(false);
    expect(isProfileTabVisibilityLevel("admin")).toBe(false);
    expect(isProfileTabVisibilityLevel("")).toBe(false);
    expect(isProfileTabVisibilityLevel(null)).toBe(false);
    expect(isProfileTabVisibilityLevel(42)).toBe(false);
  });
});

describe("normalizeProfileTabVisibility — sparse + defensive", () => {
  it("drops keys equal to the default so storage stays sparse", () => {
    const result = normalizeProfileTabVisibility({
      about: "public", // equals default → omitted
      posts: "connections", // diverges → kept
    });
    expect(result).toEqual({ posts: "connections" });
  });

  it("drops unknown tab keys", () => {
    const result = normalizeProfileTabVisibility({
      posts: "self",
      treasury: "admin", // not a profile tab
      bogus: "public",
    });
    expect(result).toEqual({ posts: "self" });
  });

  it("drops invalid and group-only levels (never widens or stores them)", () => {
    const result = normalizeProfileTabVisibility({
      posts: "members", // group-only → dropped (falls back to default-on)
      events: "admin", // group-only → dropped
      photos: "nonsense", // junk → dropped
      groups: "hidden", // valid divergence → kept
    });
    expect(result).toEqual({ groups: "hidden" });
  });

  it("returns {} for non-object / array / nullish input", () => {
    expect(normalizeProfileTabVisibility(null)).toEqual({});
    expect(normalizeProfileTabVisibility(undefined)).toEqual({});
    expect(normalizeProfileTabVisibility("public")).toEqual({});
    expect(normalizeProfileTabVisibility(["public"])).toEqual({});
    expect(normalizeProfileTabVisibility(123)).toEqual({});
  });

  it("a normalized value that diverges round-trips through the resolver", () => {
    const stored = normalizeProfileTabVisibility({ offerings: "self" });
    expect(resolveProfileTabVisibilityLevel(stored, "offerings")).toBe("self");
    // and an omitted (defaulted) tab still resolves to its default-on level
    expect(resolveProfileTabVisibilityLevel(stored, "about")).toBe("public");
  });
});

describe("readProfileTabVisibility — metadata extraction", () => {
  it("reads and normalizes the profileTabVisibility bag from metadata", () => {
    const metadata = {
      [PROFILE_TAB_VISIBILITY_METADATA_KEY]: {
        posts: "connections",
        about: "public", // sparse: dropped
        treasury: "admin", // unknown: dropped
      },
      unrelated: "value",
    };
    expect(readProfileTabVisibility(metadata)).toEqual({ posts: "connections" });
  });

  it("returns {} when metadata is missing, malformed, or lacks the key", () => {
    expect(readProfileTabVisibility(null)).toEqual({});
    expect(readProfileTabVisibility(undefined)).toEqual({});
    expect(readProfileTabVisibility({})).toEqual({});
    expect(
      readProfileTabVisibility({ [PROFILE_TAB_VISIBILITY_METADATA_KEY]: "oops" }),
    ).toEqual({});
  });
});
