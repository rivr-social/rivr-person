/**
 * Unit tests for `src/lib/recovery/assertion.ts`.
 *
 * Covers the deterministic, pure helpers exhaustively:
 *   - parseSignedRecoveryAssertion — shape and type coercion
 *   - verifyIntent                 — allow-listed intent
 *   - verifyTarget                 — homeBaseUrl normalization
 *   - verifyTiming                 — expiry + future-skew + lifetime ceiling
 *   - assertionSignaturePayload    — canonical pre-signature bytes
 *   - resolveGlobalPublicKey       — env-first, peer-registry fallback
 *   - verifyRecoveryAssertion      — full pipeline with mocked DB
 *
 * All database interactions go through a tiny local mock so this suite
 * runs without any federation plumbing or Postgres.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ASSERTION_LIFETIME_MS,
  MAX_FUTURE_SKEW_MS,
  RECOVERY_ASSERTION_INTENT_RESET,
  RecoveryAssertionVerificationError,
  assertionSignaturePayload,
  parseSignedRecoveryAssertion,
  resolveGlobalPublicKey,
  verifyIntent,
  verifyRecoveryAssertion,
  verifyTarget,
  verifyTiming,
  type SignedRecoveryAssertion,
} from "../assertion";
import {
  generateNodeKeyPair,
  signPayload,
} from "@/lib/federation-crypto";
import {
  INSTANCE_MODE_SOVEREIGN,
  INSTANCE_MODE_HOSTED_FEDERATED,
} from "@/lib/instance-mode";

// ---------------------------------------------------------------------------
// DB mock — scripted query responses per test
// ---------------------------------------------------------------------------

type QueryStep = { table: "agents" | "nodes"; rows: unknown[] };

let scriptedQueries: QueryStep[] = [];

function chainableSelect(rows: () => unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows(),
    then: (resolve: (r: unknown[]) => void) => resolve(rows()),
  };
  return chain;
}

function pullQuery(expected: QueryStep["table"]): unknown[] {
  const next = scriptedQueries.shift();
  if (!next) {
    throw new Error(
      `Query on ${expected} had no scripted response. Script one with scriptQuery().`
    );
  }
  if (next.table !== expected) {
    throw new Error(
      `Expected query on ${next.table} but helper was asked for ${expected}.`
    );
  }
  return next.rows;
}

function scriptQuery(table: QueryStep["table"], rows: unknown[]): void {
  scriptedQueries.push({ table, rows });
}

vi.mock("@/db", () => ({
  db: {
    select: (selection?: Record<string, unknown>) => {
      const keys = selection ? Object.keys(selection).sort().join(",") : "";
      // Agents select hydrates several columns including email; nodes only
      // hydrates publicKey + updatedAt.
      const table: QueryStep["table"] = keys.includes("email") ? "agents" : "nodes";
      const rowsFn = () => pullQuery(table);
      // Drizzle treats select(...).from(...).where(...) as thenable in some
      // call shapes. We expose both `.limit()` and a `then()` hook so either
      // await-style works.
      return chainableSelect(rowsFn);
    },
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOME_BASE_URL = "https://rivr.camalot.me";
const GLOBAL_BASE_URL = "https://app.rivr.social";
const AGENT_ID = "77777777-7777-4777-8777-777777777777";

let globalKeypair: { publicKey: string; privateKey: string };

function buildAssertionPayload(
  overrides: Partial<SignedRecoveryAssertion> = {}
): SignedRecoveryAssertion {
  const iat = Date.now();
  const exp = iat + 5 * 60 * 1000;
  const base: Omit<SignedRecoveryAssertion, "signature"> = {
    agentId: AGENT_ID,
    homeBaseUrl: HOME_BASE_URL,
    globalIssuerBaseUrl: GLOBAL_BASE_URL,
    intent: RECOVERY_ASSERTION_INTENT_RESET,
    iat,
    exp,
    nonce: "nonce-abcdefgh-0001",
    ...overrides,
  };

  const { signature: overrideSig, ...payload } = {
    signature: overrides.signature,
    ...base,
  };
  const signature = overrideSig ?? signPayload(payload, globalKeypair.privateKey);
  return { ...base, signature };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  scriptedQueries = [];
  globalKeypair = generateNodeKeyPair();
  process.env.GLOBAL_INSTANCE_PUBLIC_KEY = globalKeypair.publicKey;
  process.env.NEXT_PUBLIC_BASE_URL = HOME_BASE_URL;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseSignedRecoveryAssertion
// ---------------------------------------------------------------------------

describe("parseSignedRecoveryAssertion", () => {
  it("accepts a well-formed assertion", () => {
    const payload = buildAssertionPayload();
    const parsed = parseSignedRecoveryAssertion(payload);
    expect(parsed.agentId).toBe(AGENT_ID);
    expect(parsed.intent).toBe(RECOVERY_ASSERTION_INTENT_RESET);
  });

  it("rejects non-object input", () => {
    expect(() => parseSignedRecoveryAssertion("nope")).toThrow(
      RecoveryAssertionVerificationError
    );
  });

  it("rejects arrays", () => {
    expect(() => parseSignedRecoveryAssertion([])).toThrow(
      RecoveryAssertionVerificationError
    );
  });

  it("rejects missing agentId", () => {
    const p = { ...buildAssertionPayload(), agentId: "" };
    expect(() => parseSignedRecoveryAssertion(p)).toThrow(
      /agentId/
    );
  });

  it("rejects non-http(s) homeBaseUrl", () => {
    const p = { ...buildAssertionPayload(), homeBaseUrl: "ftp://evil.example" };
    expect(() => parseSignedRecoveryAssertion(p)).toThrow(
      /valid http\(s\) URL/
    );
  });

  it("rejects non-numeric exp", () => {
    const raw = { ...buildAssertionPayload() } as Record<string, unknown>;
    raw.exp = "tomorrow";
    expect(() => parseSignedRecoveryAssertion(raw)).toThrow(
      RecoveryAssertionVerificationError
    );
  });

  it("rejects short nonce", () => {
    const p = { ...buildAssertionPayload(), nonce: "abc" };
    expect(() => parseSignedRecoveryAssertion(p)).toThrow(
      /at least 8 characters/
    );
  });

  it("rejects missing signature", () => {
    const p = { ...buildAssertionPayload(), signature: "" };
    expect(() => parseSignedRecoveryAssertion(p)).toThrow(
      /signature/
    );
  });
});

// ---------------------------------------------------------------------------
// verifyIntent
// ---------------------------------------------------------------------------

describe("verifyIntent", () => {
  it("accepts reset-password", () => {
    expect(() => verifyIntent(buildAssertionPayload())).not.toThrow();
  });

  it("rejects any other intent", () => {
    const assertion = {
      ...buildAssertionPayload(),
      intent: "revoke-key" as typeof RECOVERY_ASSERTION_INTENT_RESET,
    };
    try {
      verifyIntent(assertion);
      throw new Error("expected verifyIntent to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe("invalid_intent");
    }
  });
});

// ---------------------------------------------------------------------------
// verifyTarget
// ---------------------------------------------------------------------------

describe("verifyTarget", () => {
  it("matches identical URLs", () => {
    expect(() => verifyTarget(buildAssertionPayload(), HOME_BASE_URL)).not.toThrow();
  });

  it("is case-insensitive on host", () => {
    const assertion = buildAssertionPayload({
      homeBaseUrl: "https://Rivr.Camalot.Me",
    });
    // Re-sign with the new homeBaseUrl payload is unnecessary — verifyTarget
    // does not touch the signature.
    expect(() => verifyTarget(assertion, HOME_BASE_URL)).not.toThrow();
  });

  it("ignores trailing slash", () => {
    const assertion = buildAssertionPayload({ homeBaseUrl: `${HOME_BASE_URL}/` });
    expect(() => verifyTarget(assertion, HOME_BASE_URL)).not.toThrow();
  });

  it("rejects a mismatched host", () => {
    const assertion = buildAssertionPayload({ homeBaseUrl: "https://other.example" });
    try {
      verifyTarget(assertion, HOME_BASE_URL);
      throw new Error("expected wrong_target");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe("wrong_target");
    }
  });
});

// ---------------------------------------------------------------------------
// verifyTiming
// ---------------------------------------------------------------------------

describe("verifyTiming", () => {
  it("accepts a fresh assertion within the 10-minute ceiling", () => {
    const now = Date.now();
    const assertion = buildAssertionPayload({
      iat: now,
      exp: now + 5 * 60 * 1000,
    });
    expect(() => verifyTiming(assertion, now)).not.toThrow();
  });

  it("rejects an expired assertion", () => {
    const now = Date.now();
    const assertion = buildAssertionPayload({
      iat: now - 20 * 60 * 1000,
      exp: now - 1,
    });
    try {
      verifyTiming(assertion, now);
      throw new Error("expected expired");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe("expired");
    }
  });

  it("rejects a lifetime > 10 minutes", () => {
    const now = Date.now();
    const assertion = buildAssertionPayload({
      iat: now,
      exp: now + MAX_ASSERTION_LIFETIME_MS + 60_000,
    });
    try {
      verifyTiming(assertion, now);
      throw new Error("expected lifetime_too_long");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe(
        "lifetime_too_long"
      );
    }
  });

  it("rejects an iat that is too far in the future", () => {
    const now = Date.now();
    const assertion = buildAssertionPayload({
      iat: now + MAX_FUTURE_SKEW_MS + 10_000,
      exp: now + MAX_FUTURE_SKEW_MS + 10_000 + 60_000,
    });
    try {
      verifyTiming(assertion, now);
      throw new Error("expected issued_in_future");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe(
        "issued_in_future"
      );
    }
  });
});

// ---------------------------------------------------------------------------
// assertionSignaturePayload
// ---------------------------------------------------------------------------

describe("assertionSignaturePayload", () => {
  it("omits the signature field", () => {
    const assertion = buildAssertionPayload();
    const canonical = assertionSignaturePayload(assertion);
    expect(canonical).not.toContain('"signature"');
  });

  it("produces identical output regardless of property insertion order", () => {
    const a = buildAssertionPayload();
    const reshuffled: SignedRecoveryAssertion = {
      nonce: a.nonce,
      iat: a.iat,
      exp: a.exp,
      intent: a.intent,
      globalIssuerBaseUrl: a.globalIssuerBaseUrl,
      homeBaseUrl: a.homeBaseUrl,
      agentId: a.agentId,
      signature: a.signature,
    };
    expect(assertionSignaturePayload(reshuffled)).toBe(
      assertionSignaturePayload(a)
    );
  });
});

// ---------------------------------------------------------------------------
// resolveGlobalPublicKey
// ---------------------------------------------------------------------------

describe("resolveGlobalPublicKey", () => {
  it("returns the env var when present", async () => {
    expect(await resolveGlobalPublicKey()).toBe(globalKeypair.publicKey);
  });

  it("falls back to the peer registry when env var is absent", async () => {
    delete process.env.GLOBAL_INSTANCE_PUBLIC_KEY;
    scriptQuery("nodes", [
      { publicKey: globalKeypair.publicKey, updatedAt: new Date() },
    ]);
    expect(await resolveGlobalPublicKey()).toBe(globalKeypair.publicKey);
  });

  it("returns null when neither source yields a key", async () => {
    delete process.env.GLOBAL_INSTANCE_PUBLIC_KEY;
    scriptQuery("nodes", []);
    expect(await resolveGlobalPublicKey()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyRecoveryAssertion (full pipeline)
// ---------------------------------------------------------------------------

describe("verifyRecoveryAssertion", () => {
  it("returns a hydrated agent snapshot on success", async () => {
    scriptQuery("agents", [
      {
        id: AGENT_ID,
        email: "cameron@example.test",
        name: "Cameron",
        credentialVersion: 4,
        sessionVersion: 2,
        instanceMode: INSTANCE_MODE_SOVEREIGN,
        metadata: { note: "hi" },
        deletedAt: null,
      },
    ]);

    const raw = buildAssertionPayload();
    const result = await verifyRecoveryAssertion({ raw });
    expect(result.assertion.nonce).toBe(raw.nonce);
    expect(result.agent.id).toBe(AGENT_ID);
    expect(result.agent.credentialVersion).toBe(4);
    expect(result.agent.sessionVersion).toBe(2);
    expect(result.agent.metadata).toEqual({ note: "hi" });
  });

  it("throws invalid_signature for a tampered payload", async () => {
    const raw = buildAssertionPayload({ signature: "AA==" });
    try {
      await verifyRecoveryAssertion({ raw });
      throw new Error("expected invalid_signature");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe(
        "invalid_signature"
      );
    }
  });

  it("throws missing_public_key when env and registry are empty", async () => {
    delete process.env.GLOBAL_INSTANCE_PUBLIC_KEY;
    scriptQuery("nodes", []);
    const raw = buildAssertionPayload();
    try {
      await verifyRecoveryAssertion({ raw });
      throw new Error("expected missing_public_key");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe(
        "missing_public_key"
      );
    }
  });

  it("throws agent_not_found when no matching row exists", async () => {
    scriptQuery("agents", []);
    const raw = buildAssertionPayload();
    try {
      await verifyRecoveryAssertion({ raw });
      throw new Error("expected agent_not_found");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe(
        "agent_not_found"
      );
    }
  });

  it("throws agent_not_sovereign when instanceMode mismatches", async () => {
    scriptQuery("agents", [
      {
        id: AGENT_ID,
        email: null,
        name: "H",
        credentialVersion: 1,
        sessionVersion: 1,
        instanceMode: INSTANCE_MODE_HOSTED_FEDERATED,
        metadata: {},
        deletedAt: null,
      },
    ]);
    const raw = buildAssertionPayload();
    try {
      await verifyRecoveryAssertion({ raw });
      throw new Error("expected agent_not_sovereign");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe(
        "agent_not_sovereign"
      );
    }
  });

  it("throws wrong_target when homeBaseUrl is mismatched", async () => {
    const raw = buildAssertionPayload({ homeBaseUrl: "https://other.example" });
    try {
      await verifyRecoveryAssertion({ raw });
      throw new Error("expected wrong_target");
    } catch (err) {
      expect(err).toBeInstanceOf(RecoveryAssertionVerificationError);
      expect((err as RecoveryAssertionVerificationError).code).toBe(
        "wrong_target"
      );
    }
  });
});
