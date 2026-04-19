/**
 * Unit tests for `src/lib/federation/accept-tempwrite.ts`.
 *
 * Covers the deterministic happy/edge paths for:
 *   - `validateTempwritePayload`  (pure, no DB)
 *   - `resolveGlobalPublicKey`    (env-first, peer-registry fallback)
 *   - `acceptCredentialTempwrite` (verify + apply, mocked DB)
 *
 * All database interactions are mocked so the suite runs without
 * Postgres or any federation plumbing. The goal is to verify the
 * allow-list, signature verification, replay detection, version
 * monotonicity, session invalidation, and instance-mode guardrails
 * described in issue #16.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import {
  ACCEPTED_CREDENTIAL_FIELDS,
  CREDENTIAL_TEMPWRITE_EVENT_TYPE,
  GLOBAL_NODE_SLUG_ENV_VAR,
  GLOBAL_PUBLIC_KEY_ENV_VAR,
  MAX_TIMESTAMP_SKEW_MS,
  PER_AGENT_ACCEPT_FLOOR_MS,
  TempwriteAgentNotFoundError,
  TempwriteAgentThrottleError,
  TempwriteAuthorityStatusError,
  TempwriteForbiddenFieldError,
  TempwriteMalformedError,
  TempwriteReplayError,
  TempwriteSignatureError,
  TempwriteStaleTimestampError,
  TempwriteStaleVersionError,
  TempwriteWrongInstanceModeError,
  acceptCredentialTempwrite,
  resolveGlobalPublicKey,
  validateTempwritePayload,
} from "../accept-tempwrite";

import {
  generateNodeKeyPair,
  signPayload,
} from "@/lib/federation-crypto";
import {
  INSTANCE_MODE_ENV_VAR,
  INSTANCE_MODE_HOSTED_FEDERATED,
  INSTANCE_MODE_SOVEREIGN,
  resetInstanceModeCache,
} from "@/lib/instance-mode";

// ---------------------------------------------------------------------------
// Database mocks
// ---------------------------------------------------------------------------

type QueryStep = {
  table: "agents" | "nodes" | "credentialAuthorityAudit" | "credentialTempwriteNonces";
  rows: unknown[];
};

// Scripted responses per test. Shift() consumes the first expected query.
let scriptedQueries: QueryStep[] = [];
const insertedRows: Array<{ table: string; values: unknown }> = [];
const updatedRows: Array<{ table: string; set: Record<string, unknown> }> = [];
const transactionCallbacks: Array<(tx: unknown) => Promise<unknown>> = [];

function pullQuery(table: QueryStep["table"]): unknown[] {
  const next = scriptedQueries.shift();
  if (!next) {
    throw new Error(
      `Query on ${table} had no scripted response; tests must enqueue one via scriptQuery().`
    );
  }
  if (next.table !== table) {
    throw new Error(
      `Query expected ${next.table} but helper was asked for ${table}.`
    );
  }
  return next.rows;
}

function scriptQuery(table: QueryStep["table"], rows: unknown[]): void {
  scriptedQueries.push({ table, rows });
}

// Build a chainable object that terminates on the limit() call which
// returns an array. Used for agents / audit / nodes / nonce lookups.
function chainableSelect(rowsProvider: () => unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rowsProvider(),
  };
  return chain;
}

// Build an insert chain where .values() resolves without returning rows.
function insertChain(table: string) {
  return {
    values: async (values: unknown) => {
      insertedRows.push({ table, values });
    },
  };
}

function updateChain(table: string) {
  return {
    set: (set: Record<string, unknown>) => {
      updatedRows.push({ table, set });
      return {
        where: async () => {},
      };
    },
  };
}

vi.mock("@/db", () => ({
  db: {
    select: (selection?: Record<string, unknown>) => {
      // Selection's keys disambiguate which table we're reading so the
      // script can assert correct ordering without importing the
      // drizzle table instances.
      const keys = selection ? Object.keys(selection).sort().join(",") : "";
      let table: QueryStep["table"] = "agents";
      if (keys.includes("credentialVersion") && keys.includes("sessionVersion")) {
        table = "agents";
      } else if (keys === "publicKey,role,slug") {
        table = "nodes";
      } else if (keys === "migrationStatus") {
        table = "nodes";
      } else if (keys === "createdAt") {
        table = "credentialAuthorityAudit";
      } else if (keys === "nonce") {
        table = "credentialTempwriteNonces";
      }
      return chainableSelect(() => pullQuery(table));
    },
    insert: (tableObj: { _?: unknown } | unknown) => {
      const name = tableName(tableObj);
      return insertChain(name);
    },
    update: (tableObj: unknown) => {
      const name = tableName(tableObj);
      return updateChain(name);
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      transactionCallbacks.push(cb);
      // Provide a tx object with the same insert/update shape so the
      // library code inside the transaction works.
      const tx = {
        insert: (t: unknown) => insertChain(tableName(t)),
        update: (t: unknown) => updateChain(tableName(t)),
      };
      return cb(tx);
    },
  },
}));

function tableName(tableObj: unknown): string {
  // drizzle exposes table names via the internal _ descriptor in
  // modern versions but we only need a label here.
  if (
    typeof tableObj === "object" &&
    tableObj !== null &&
    "name" in (tableObj as Record<string, unknown>)
  ) {
    return String((tableObj as Record<string, unknown>).name);
  }
  return "unknown";
}

// Avoid importing the real @node-rs/bcrypt native binding during tests.
vi.mock("@node-rs/bcrypt", () => ({
  hash: async (v: string) => `bcrypted:${v}`,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const CURRENT_VERSION = 3;
const NEXT_VERSION = CURRENT_VERSION + 1;
const CURRENT_SESSION_VERSION = 7;
const NEW_VERIFIER = "$2b$12$abcdefghijklmnopqrstuuvwxyz123456789abcdefghijklmno";
const NONCE = "11111111-1111-4111-8111-deadbeef0001";

let globalKeypair: { publicKey: string; privateKey: string };
let originalEnv: NodeJS.ProcessEnv;

function buildEvent(overrides: Partial<Record<string, unknown>> = {}): Record<
  string,
  unknown
> {
  return {
    type: CREDENTIAL_TEMPWRITE_EVENT_TYPE,
    agentId: AGENT_ID,
    newCredentialVerifier: NEW_VERIFIER,
    credentialVersion: NEXT_VERSION,
    timestamp: new Date().toISOString(),
    nonce: NONCE,
    ...overrides,
  };
}

function signEvent(event: Record<string, unknown>): string {
  return signPayload(event, globalKeypair.privateKey);
}

function scriptHappyPathReads(): void {
  // Order matches acceptCredentialTempwrite:
  //   1. agents lookup
  //   2. local-node migration status
  //   3. latest audit (per-agent spacing)
  //   4. existing nonce lookup
  scriptQuery("agents", [
    {
      id: AGENT_ID,
      credentialVersion: CURRENT_VERSION,
      sessionVersion: CURRENT_SESSION_VERSION,
      metadata: { foo: "bar" },
    },
  ]);
  scriptQuery("nodes", [{ migrationStatus: "active" }]);
  scriptQuery("credentialAuthorityAudit", []);
  scriptQuery("credentialTempwriteNonces", []);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  originalEnv = { ...process.env };
  scriptedQueries = [];
  insertedRows.length = 0;
  updatedRows.length = 0;
  transactionCallbacks.length = 0;
  resetInstanceModeCache();
  globalKeypair = generateNodeKeyPair();
  process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_SOVEREIGN;
  process.env[GLOBAL_PUBLIC_KEY_ENV_VAR] = globalKeypair.publicKey;
});

afterEach(() => {
  process.env = originalEnv;
  resetInstanceModeCache();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// validateTempwritePayload
// ---------------------------------------------------------------------------

describe("validateTempwritePayload", () => {
  it("accepts a well-formed envelope and returns normalized shape", () => {
    const event = buildEvent();
    const body = { event, signature: "sig", signingNodeSlug: "global" };
    const parsed = validateTempwritePayload(body);
    expect(parsed.event).toEqual(event);
    expect(parsed.signature).toBe("sig");
    expect(parsed.signingNodeSlug).toBe("global");
  });

  it("throws TempwriteMalformedError when body is not an object", () => {
    expect(() => validateTempwritePayload("nope")).toThrow(TempwriteMalformedError);
  });

  it("throws TempwriteMalformedError when event is missing", () => {
    expect(() => validateTempwritePayload({ signature: "sig" })).toThrow(
      TempwriteMalformedError
    );
  });

  it("throws TempwriteMalformedError when signature is missing", () => {
    expect(() => validateTempwritePayload({ event: buildEvent() })).toThrow(
      TempwriteMalformedError
    );
  });

  it("rejects any field outside ACCEPTED_CREDENTIAL_FIELDS", () => {
    const event = {
      ...buildEvent(),
      profile: { bio: "I should not be here" },
    };
    const body = { event, signature: "sig" };
    try {
      validateTempwritePayload(body);
      throw new Error("expected TempwriteForbiddenFieldError");
    } catch (err) {
      expect(err).toBeInstanceOf(TempwriteForbiddenFieldError);
      expect((err as TempwriteForbiddenFieldError).detail.forbiddenFields)
        .toContain("profile");
    }
  });

  it("rejects persona field even when credential fields are also present", () => {
    const event = {
      ...buildEvent(),
      personas: [{ id: "evil" }],
    };
    expect(() => validateTempwritePayload({ event, signature: "s" })).toThrow(
      TempwriteForbiddenFieldError
    );
  });

  it("rejects state/metadata fields", () => {
    const event = { ...buildEvent(), metadata: { forcedAdmin: true } };
    expect(() => validateTempwritePayload({ event, signature: "s" })).toThrow(
      TempwriteForbiddenFieldError
    );
  });

  it("rejects when type discriminator is wrong", () => {
    const event = { ...buildEvent(), type: "credential.updated" };
    expect(() => validateTempwritePayload({ event, signature: "s" })).toThrow(
      TempwriteMalformedError
    );
  });

  it("rejects non-integer credentialVersion", () => {
    const event = { ...buildEvent(), credentialVersion: 1.5 };
    expect(() => validateTempwritePayload({ event, signature: "s" })).toThrow(
      TempwriteMalformedError
    );
  });

  it("rejects malformed timestamp", () => {
    const event = { ...buildEvent(), timestamp: "not-a-date" };
    expect(() => validateTempwritePayload({ event, signature: "s" })).toThrow(
      TempwriteMalformedError
    );
  });

  it("ACCEPTED_CREDENTIAL_FIELDS is exactly the documented allow-list", () => {
    expect([...ACCEPTED_CREDENTIAL_FIELDS].sort()).toEqual([
      "agentId",
      "credentialVersion",
      "newCredentialVerifier",
      "nonce",
      "timestamp",
      "type",
    ]);
  });
});

// ---------------------------------------------------------------------------
// resolveGlobalPublicKey
// ---------------------------------------------------------------------------

describe("resolveGlobalPublicKey", () => {
  it("returns env var content verbatim when PEM contains real newlines", async () => {
    process.env[GLOBAL_PUBLIC_KEY_ENV_VAR] = globalKeypair.publicKey;
    expect(await resolveGlobalPublicKey()).toBe(globalKeypair.publicKey);
  });

  it("un-escapes literal \\n sequences into real newlines", async () => {
    const escaped = globalKeypair.publicKey.replace(/\n/g, "\\n");
    process.env[GLOBAL_PUBLIC_KEY_ENV_VAR] = escaped;
    const resolved = await resolveGlobalPublicKey();
    expect(resolved).toBe(globalKeypair.publicKey);
  });

  it("falls back to peer registry when env var is unset", async () => {
    delete process.env[GLOBAL_PUBLIC_KEY_ENV_VAR];
    process.env[GLOBAL_NODE_SLUG_ENV_VAR] = "registered-global";
    scriptQuery("nodes", [
      {
        publicKey: globalKeypair.publicKey,
        role: "global",
        slug: "registered-global",
      },
    ]);
    expect(await resolveGlobalPublicKey()).toBe(globalKeypair.publicKey);
  });

  it("throws when no source yields a key", async () => {
    delete process.env[GLOBAL_PUBLIC_KEY_ENV_VAR];
    scriptQuery("nodes", []);
    await expect(resolveGlobalPublicKey()).rejects.toThrow(
      /Cannot resolve global public key/
    );
  });
});

// ---------------------------------------------------------------------------
// acceptCredentialTempwrite
// ---------------------------------------------------------------------------

describe("acceptCredentialTempwrite", () => {
  it("applies a valid event and invalidates existing sessions", async () => {
    scriptHappyPathReads();
    const event = buildEvent();
    const signature = signEvent(event);

    const result = await acceptCredentialTempwrite(
      { event: event as never, signature, signingNodeSlug: "global" },
      { now: () => new Date(event.timestamp as string) }
    );

    expect(result.previousCredentialVersion).toBe(CURRENT_VERSION);
    expect(result.credentialVersion).toBe(NEXT_VERSION);
    expect(result.sessionVersion).toBe(CURRENT_SESSION_VERSION + 1);
    expect(result.agentId).toBe(AGENT_ID);

    // The transaction callback ran, producing one nonce insert and one agents update.
    expect(transactionCallbacks).toHaveLength(1);
    const nonceInsert = insertedRows.find((r) =>
      (r.values as Record<string, unknown>).nonce === NONCE
    );
    expect(nonceInsert).toBeTruthy();
    const agentUpdate = updatedRows[0];
    expect(agentUpdate).toBeTruthy();
    expect((agentUpdate.set as { passwordHash: unknown }).passwordHash).toBe(
      NEW_VERIFIER
    );
    expect(
      (agentUpdate.set as { credentialVersion: number }).credentialVersion
    ).toBe(NEXT_VERSION);
    expect(
      (agentUpdate.set as { sessionVersion: number }).sessionVersion
    ).toBe(CURRENT_SESSION_VERSION + 1);
  });

  it("rejects when instance mode is hosted-federated", async () => {
    process.env[INSTANCE_MODE_ENV_VAR] = INSTANCE_MODE_HOSTED_FEDERATED;
    resetInstanceModeCache();
    const event = buildEvent();
    const signature = signEvent(event);
    await expect(
      acceptCredentialTempwrite({
        event: event as never,
        signature,
      })
    ).rejects.toBeInstanceOf(TempwriteWrongInstanceModeError);
  });

  it("rejects an invalid signature", async () => {
    const event = buildEvent();
    const badSignature = signEvent({ ...event, agentId: "tampered" });
    await expect(
      acceptCredentialTempwrite({
        event: event as never,
        signature: badSignature,
      })
    ).rejects.toBeInstanceOf(TempwriteSignatureError);
  });

  it("rejects a timestamp outside the skew window", async () => {
    const event = buildEvent({
      timestamp: new Date(Date.now() - (MAX_TIMESTAMP_SKEW_MS + 60_000)).toISOString(),
    });
    const signature = signEvent(event);
    await expect(
      acceptCredentialTempwrite({ event: event as never, signature })
    ).rejects.toBeInstanceOf(TempwriteStaleTimestampError);
  });

  it("rejects when the agent does not exist", async () => {
    scriptQuery("agents", []);
    const event = buildEvent();
    const signature = signEvent(event);
    await expect(
      acceptCredentialTempwrite({ event: event as never, signature })
    ).rejects.toBeInstanceOf(TempwriteAgentNotFoundError);
  });

  it("rejects a non-monotonic credentialVersion", async () => {
    scriptQuery("agents", [
      {
        id: AGENT_ID,
        credentialVersion: NEXT_VERSION, // already at or above incoming
        sessionVersion: CURRENT_SESSION_VERSION,
        metadata: {},
      },
    ]);
    const event = buildEvent({ credentialVersion: NEXT_VERSION });
    const signature = signEvent(event);
    try {
      await acceptCredentialTempwrite({
        event: event as never,
        signature,
      });
      throw new Error("expected TempwriteStaleVersionError");
    } catch (err) {
      expect(err).toBeInstanceOf(TempwriteStaleVersionError);
      expect((err as TempwriteStaleVersionError).status).toBe(409);
    }
  });

  it("rejects when local node is migrating out", async () => {
    scriptQuery("agents", [
      {
        id: AGENT_ID,
        credentialVersion: CURRENT_VERSION,
        sessionVersion: CURRENT_SESSION_VERSION,
        metadata: {},
      },
    ]);
    scriptQuery("nodes", [{ migrationStatus: "migrating_out" }]);
    const event = buildEvent();
    const signature = signEvent(event);
    await expect(
      acceptCredentialTempwrite({ event: event as never, signature })
    ).rejects.toBeInstanceOf(TempwriteAuthorityStatusError);
  });

  it("throttles per-agent when spacing is below PER_AGENT_ACCEPT_FLOOR_MS", async () => {
    scriptQuery("agents", [
      {
        id: AGENT_ID,
        credentialVersion: CURRENT_VERSION,
        sessionVersion: CURRENT_SESSION_VERSION,
        metadata: {},
      },
    ]);
    scriptQuery("nodes", [{ migrationStatus: "active" }]);
    scriptQuery("credentialAuthorityAudit", [
      { createdAt: new Date(Date.now() - (PER_AGENT_ACCEPT_FLOOR_MS / 2)) },
    ]);
    const event = buildEvent();
    const signature = signEvent(event);
    await expect(
      acceptCredentialTempwrite({ event: event as never, signature })
    ).rejects.toBeInstanceOf(TempwriteAgentThrottleError);
  });

  it("rejects a nonce that has already been seen", async () => {
    scriptQuery("agents", [
      {
        id: AGENT_ID,
        credentialVersion: CURRENT_VERSION,
        sessionVersion: CURRENT_SESSION_VERSION,
        metadata: {},
      },
    ]);
    scriptQuery("nodes", [{ migrationStatus: "active" }]);
    scriptQuery("credentialAuthorityAudit", []);
    scriptQuery("credentialTempwriteNonces", [{ nonce: NONCE }]);
    const event = buildEvent();
    const signature = signEvent(event);
    await expect(
      acceptCredentialTempwrite({ event: event as never, signature })
    ).rejects.toBeInstanceOf(TempwriteReplayError);
  });

  it("rehashes when options.rehash is true", async () => {
    scriptHappyPathReads();
    const PLAINTEXT = "correct horse battery staple";
    const event = buildEvent({ newCredentialVerifier: PLAINTEXT });
    const signature = signEvent(event);
    await acceptCredentialTempwrite(
      { event: event as never, signature },
      { now: () => new Date(event.timestamp as string), rehash: true }
    );
    const agentUpdate = updatedRows[0];
    expect(
      (agentUpdate.set as { passwordHash: string }).passwordHash
    ).toBe(`bcrypted:${PLAINTEXT}`);
  });

  it("randomUUID should produce distinct nonces when events chain", () => {
    // Sanity check — unrelated to the library but guards against a
    // regression in the test fixture helpers.
    expect(crypto.randomUUID()).not.toEqual(crypto.randomUUID());
  });
});
