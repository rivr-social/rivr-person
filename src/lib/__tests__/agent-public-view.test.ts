/**
 * Tests for the viewer-scoped agent metadata exposure floor.
 *
 * Regression origin (2026-07-31): `GET /api/profile/[username]` answers
 * unauthenticated callers and returned `agents.metadata` verbatim. Production
 * was serving a plaintext GPU-provider API key inside
 * `autobotSettings.gpuProviderApiKey`, plus a phone number, a password-change
 * stamp, and billing references, to anyone who asked.
 *
 * These pin the two properties that keep it closed:
 *   1. the filter is an ALLOWLIST (unknown keys are withheld, so a NEW secret
 *      key is private on arrival — the deny-list failure mode that caused this),
 *   2. the owner still sees their own blob, so owner surfaces do not regress.
 */
import { describe, it, expect } from "vitest";
import {
  PUBLIC_AGENT_METADATA_FIELDS,
  sanitizeAgentMetadataForPublic,
  toViewerScopedAgent,
} from "@/lib/agent-public-view";

/** A metadata blob shaped like the real production rows this fix closed. */
const REAL_WORLD_METADATA: Record<string, unknown> = {
  // public display
  bio: "Building RIVR",
  tagline: "regenerative infrastructure",
  skills: ["typescript", "postgres"],
  socialLinks: { github: "https://github.com/example" },
  profilePhotos: ["https://cdn.example/a.png"],
  username: "cameron",
  // persona traits
  geneKeys: "25.4",
  enneagram: "5w4",
  // federation routing
  homeBaseUrl: "https://rivr.camalot.me",
  isProjection: true,
  // MUST NOT be exposed
  phone: "7206456281",
  passwordChangedAt: "2026-03-31T06:14:52.000Z",
  privacySettings: { attributeEmail: "self" },
  notificationSettings: { emailNotifications: true },
  emailNotifications: true,
  termsAcceptedAt: "2026-03-31T06:14:52.000Z",
  stripeSubscriptionId: "sub_1ThDGKAsDJJ1nYyvYTPLZgZG",
  subscriptionStatus: "active",
  subscriptionTier: "provider",
  taxReserve: { enabled: true, bps: 1000 },
  murmurationsPublishing: { enabled: true },
  updatedVia: "settings-form",
  autobotEnabled: true,
  autobotSettings: {
    selectedModel: "anthropic/claude-sonnet-4-6",
    gpuProviderApiKey: "453e65aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    connections: [{ provider: "claude_code", config: { token: "enc:v1:abc" } }],
  },
};

/** Every key the production incident proved must never reach a public viewer. */
const MUST_NEVER_LEAK = [
  "phone",
  "passwordChangedAt",
  "privacySettings",
  "notificationSettings",
  "emailNotifications",
  "termsAcceptedAt",
  "stripeSubscriptionId",
  "subscriptionStatus",
  "subscriptionTier",
  "taxReserve",
  "murmurationsPublishing",
  "updatedVia",
  "autobotEnabled",
  "autobotSettings",
] as const;

describe("sanitizeAgentMetadataForPublic — withholds sensitive material", () => {
  it.each(MUST_NEVER_LEAK)("withholds %s from a public viewer", (key) => {
    const safe = sanitizeAgentMetadataForPublic(REAL_WORLD_METADATA);
    expect(safe, `${key} must not survive sanitization`).not.toHaveProperty(key);
  });

  it("withholds the autobot connector lane entirely, credentials included", () => {
    const safe = sanitizeAgentMetadataForPublic(REAL_WORLD_METADATA);
    // The whole blob is gone, so no nested traversal can reach a token.
    expect(safe.autobotSettings).toBeUndefined();
    expect(JSON.stringify(safe)).not.toContain("gpuProviderApiKey");
    expect(JSON.stringify(safe)).not.toContain("453e65");
    expect(JSON.stringify(safe)).not.toContain("enc:v1:");
  });

  it("does not leak a secret through serialization of the whole result", () => {
    const serialized = JSON.stringify(
      sanitizeAgentMetadataForPublic(REAL_WORLD_METADATA),
    );
    expect(serialized).not.toContain("7206456281");
    expect(serialized).not.toContain("sub_1ThDGK");
  });
});

describe("sanitizeAgentMetadataForPublic — preserves what profiles render", () => {
  it("keeps public display, persona-trait, and federation-routing fields", () => {
    const safe = sanitizeAgentMetadataForPublic(REAL_WORLD_METADATA);
    expect(safe).toMatchObject({
      bio: "Building RIVR",
      tagline: "regenerative infrastructure",
      skills: ["typescript", "postgres"],
      socialLinks: { github: "https://github.com/example" },
      profilePhotos: ["https://cdn.example/a.png"],
      username: "cameron",
      geneKeys: "25.4",
      enneagram: "5w4",
      homeBaseUrl: "https://rivr.camalot.me",
      isProjection: true,
    });
  });

  it("keeps every field federated projections sync (projection parity)", () => {
    // Mirrors PROJECTION_PERMITTED_METADATA_FIELDS in federation/projection-sync.ts.
    // A projection that lost these would render blank remote profiles.
    const projectionFields = [
      "bio",
      "location",
      "skills",
      "socialLinks",
      "profilePhotos",
      "geneKeys",
      "humanDesign",
      "westernAstrology",
      "vedicAstrology",
      "ocean",
      "myersBriggs",
      "enneagram",
    ];
    for (const field of projectionFields) {
      expect(
        PUBLIC_AGENT_METADATA_FIELDS.has(field),
        `projection field ${field} must stay publicly readable`,
      ).toBe(true);
    }
  });
});

describe("sanitizeAgentMetadataForPublic — allowlist semantics", () => {
  it("withholds an unknown key, so a NEW secret is private on arrival", () => {
    const safe = sanitizeAgentMetadataForPublic({
      bio: "kept",
      someFutureCredentialKey: "sk_live_do_not_publish",
    });
    expect(safe).toEqual({ bio: "kept" });
  });

  it("drops undefined values but keeps falsy ones", () => {
    const safe = sanitizeAgentMetadataForPublic({
      bio: undefined,
      tagline: "",
      points: 0,
    });
    expect(safe).not.toHaveProperty("bio");
    expect(safe).toEqual({ tagline: "", points: 0 });
  });

  it("returns an empty object for null/undefined/non-object input", () => {
    expect(sanitizeAgentMetadataForPublic(null)).toEqual({});
    expect(sanitizeAgentMetadataForPublic(undefined)).toEqual({});
    expect(
      sanitizeAgentMetadataForPublic("nope" as unknown as Record<string, unknown>),
    ).toEqual({});
  });

  it("does not mutate the caller's blob", () => {
    const input = { bio: "hi", phone: "555" };
    sanitizeAgentMetadataForPublic(input);
    expect(input).toEqual({ bio: "hi", phone: "555" });
  });
});

describe("toViewerScopedAgent", () => {
  const agent = {
    id: "agent-1",
    name: "Cameron",
    metadata: REAL_WORLD_METADATA,
  };

  it("scopes metadata for a viewer who is not the subject", () => {
    const scoped = toViewerScopedAgent(agent, { isSelf: false });
    expect(scoped.metadata).not.toHaveProperty("phone");
    expect(scoped.metadata).not.toHaveProperty("autobotSettings");
    expect(scoped.metadata).toHaveProperty("bio");
  });

  it("returns the owner's own blob untouched", () => {
    const scoped = toViewerScopedAgent(agent, { isSelf: true });
    expect(scoped.metadata).toBe(REAL_WORLD_METADATA);
    expect(scoped.metadata).toHaveProperty("autobotSettings");
  });

  it("preserves surrounding agent fields for a public viewer", () => {
    const scoped = toViewerScopedAgent(agent, { isSelf: false });
    expect(scoped.id).toBe("agent-1");
    expect(scoped.name).toBe("Cameron");
  });

  it("does not mutate the input agent", () => {
    toViewerScopedAgent(agent, { isSelf: false });
    expect(agent.metadata).toHaveProperty("phone");
  });

  it("tolerates an agent with no metadata", () => {
    const scoped = toViewerScopedAgent({ id: "a" }, { isSelf: false });
    expect(scoped.metadata).toEqual({});
  });
});
