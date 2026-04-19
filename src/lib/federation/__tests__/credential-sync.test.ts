/**
 * Unit tests for `@/lib/federation/credential-sync`.
 *
 * These are pure-logic tests: the database layer is replaced by a
 * lightweight in-memory stub so they run without a live Postgres. They
 * cover:
 *
 *   1. Successful POST → `{ synced: true }`, no queue write, prior
 *      pending rows for the same agent cleared.
 *   2. Network failure (fetch rejects) → `{ synced: false }`, queued
 *      `pending`, one attempt recorded.
 *   3. 5xx response → queued `pending`, retryable.
 *   4. 404 response → queued `pending` (receiver not yet deployed on
 *      global per rivr-app #7 / #88 is still retryable).
 *   5. 401 response → queued `failed` terminally.
 *   6. Drain worker: retries pending rows, promotes to `synced` on 2xx,
 *      dead-letters after MAX_CREDENTIAL_SYNC_ATTEMPTS.
 *   7. Event shape: `buildCredentialUpdatedEvent` produces canonical
 *      fields; signature verifies via the node's public key.
 */

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// In-memory db + federation stubs — installed before the module under test
// is imported so top-level bindings capture them.
// ---------------------------------------------------------------------------

interface QueueRow {
  id: string;
  agentId: string;
  eventPayload: Record<string, unknown>;
  attempts: number;
  lastAttemptAt: Date | null;
  lastError: string | null;
  status: "pending" | "synced" | "failed";
  createdAt: Date;
  updatedAt: Date;
}

// Keep a module-local registry of queue rows so the stubbed db and the
// test assertions share the same source of truth.
const queueRows: QueueRow[] = [];
let nextRowId = 1;

function resetFakeDb() {
  queueRows.length = 0;
  nextRowId = 1;
}

/**
 * Minimal fluent-builder shim. Implements just the surface the module
 * under test actually uses: insert().values().returning(),
 * update().set().where(), and select().from().where().orderBy().limit().
 *
 * This is deliberately permissive about matchers — we re-implement the
 * semantics of the three SQL predicates we rely on. If the module grows
 * new operators, widen this shim rather than swapping in an ORM-level
 * fake.
 */
const fakeDb = {
  insert() {
    return {
      values(row: Omit<QueueRow, "id" | "createdAt" | "updatedAt">) {
        const id = `row-${nextRowId++}`;
        const now = new Date();
        const full: QueueRow = {
          id,
          createdAt: now,
          updatedAt: now,
          lastAttemptAt: row.lastAttemptAt ?? null,
          lastError: row.lastError ?? null,
          ...row,
        } as QueueRow;
        queueRows.push(full);
        return {
          returning(_selection?: unknown) {
            void _selection;
            return Promise.resolve([{ id }]);
          },
        };
      },
    };
  },
  update(_table: unknown) {
    void _table;
    return {
      set(patch: Partial<QueueRow>) {
        return {
          where(predicate: (row: QueueRow) => boolean) {
            for (const row of queueRows) {
              if (predicate(row)) Object.assign(row, patch);
            }
            return Promise.resolve();
          },
        };
      },
    };
  },
  select() {
    return {
      from(_table: unknown) {
        void _table;
        return {
          where(predicate: (row: QueueRow) => boolean) {
            const filtered = queueRows.filter(predicate);
            return {
              orderBy(_cmp: unknown) {
                void _cmp;
                const sorted = [...filtered].sort(
                  (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
                );
                return {
                  limit(n: number) {
                    return Promise.resolve(sorted.slice(0, n));
                  },
                };
              },
              limit(n: number) {
                return Promise.resolve(filtered.slice(0, n));
              },
            };
          },
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@/db", () => ({ db: fakeDb }));

vi.mock("@/lib/federation", () => ({
  ensureLocalNode: vi.fn(),
}));

// Replace drizzle-orm's predicate builders with JS functions we can
// evaluate against our in-memory rows. Each returned function takes a
// row and returns true/false, matching the shim above.
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => (row: QueueRow) => {
      const key = colKey(col);
      if (!key) return false;
      return (row as unknown as Record<string, unknown>)[key] === value;
    },
    and:
      (...preds: Array<(row: QueueRow) => boolean>) =>
      (row: QueueRow) =>
        preds.every((p) => p(row)),
    or:
      (...preds: Array<(row: QueueRow) => boolean>) =>
      (row: QueueRow) =>
        preds.some((p) => p(row)),
    isNull: (col: unknown) => (row: QueueRow) => {
      const key = colKey(col);
      return key ? (row as unknown as Record<string, unknown>)[key] == null : false;
    },
    lte: (col: unknown, value: Date | number) => (row: QueueRow) => {
      const key = colKey(col);
      if (!key) return false;
      const v = (row as unknown as Record<string, unknown>)[key];
      if (v instanceof Date && value instanceof Date) return v <= value;
      if (typeof v === "number" && typeof value === "number") return v <= value;
      return false;
    },
    inArray:
      (col: unknown, values: unknown[]) =>
      (row: QueueRow) => {
        const key = colKey(col);
        if (!key) return false;
        return values.includes((row as unknown as Record<string, unknown>)[key]);
      },
    desc: (col: unknown) => ({ __desc: true, col }),
    sql: (..._args: unknown[]) => {
      // `sql` template only appears inside `clearSyncedAndOlderRows`,
      // which is a best-effort cleanup. In tests we collapse it to a
      // no-op predicate that matches all rows; the outer `and(...)`
      // already filters by agent + status.
      return () => true;
    },
  };

  function colKey(col: unknown): string | null {
    if (!col || typeof col !== "object") return null;
    const name =
      (col as { name?: string }).name ??
      (col as { _?: { name?: string } })._?.name ??
      null;
    if (!name) return null;
    // Map snake_case columns → camelCase row keys.
    return snakeToCamel(name);
  }

  function snakeToCamel(s: string): string {
    return s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  }
});

// ---------------------------------------------------------------------------
// Module under test + collaborators — import AFTER mocks are registered
// ---------------------------------------------------------------------------

import {
  buildCredentialUpdatedEvent,
  signCredentialUpdatedEvent,
  syncCredentialToGlobal,
  drainCredentialSyncQueue,
  MAX_CREDENTIAL_SYNC_ATTEMPTS,
  CREDENTIAL_UPDATED_EVENT_TYPE,
  getCredentialSyncImportUrl,
  GLOBAL_IMPORT_PATH,
  type SignedCredentialEvent,
} from "../credential-sync";
import { ensureLocalNode } from "@/lib/federation";
import {
  generateNodeKeyPair,
  verifyPayloadSignature,
} from "@/lib/federation-crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = "11111111-1111-1111-1111-111111111111";
const TEST_GLOBAL_BASE = "https://global.test.local";

function installLocalNode() {
  const keyPair = generateNodeKeyPair();
  vi.mocked(ensureLocalNode).mockResolvedValue({
    id: "node-1",
    slug: "home-test",
    displayName: "Home Test",
    role: "person",
    baseUrl: "https://home.test.local",
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    isHosted: true,
    ownerAgentId: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    eventSequence: 0,
  } as unknown as Awaited<ReturnType<typeof ensureLocalNode>>);
  return keyPair;
}

async function buildSignedEvent(version: number): Promise<SignedCredentialEvent> {
  const event = buildCredentialUpdatedEvent({
    agentId: TEST_AGENT_ID,
    credentialVersion: version,
    signingNodeSlug: "home-test",
    updatedAt: new Date("2026-04-19T00:00:00Z"),
    nonce: `nonce-${version}`,
  });
  return signCredentialUpdatedEvent(event);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("credential-sync", () => {
  beforeEach(() => {
    resetFakeDb();
    process.env.GLOBAL_BASE_URL = TEST_GLOBAL_BASE;
    vi.useRealTimers();
    vi.restoreAllMocks();
    installLocalNode();
  });

  afterEach(() => {
    delete process.env.GLOBAL_BASE_URL;
  });

  describe("getCredentialSyncImportUrl", () => {
    it("uses GLOBAL_BASE_URL when set", () => {
      expect(getCredentialSyncImportUrl()).toBe(
        `${TEST_GLOBAL_BASE}${GLOBAL_IMPORT_PATH}`
      );
    });

    it("throws when no override env is set", () => {
      delete process.env.GLOBAL_BASE_URL;
      delete process.env.NEXT_PUBLIC_GLOBAL_URL;
      delete process.env.REGISTRY_URL;
      delete process.env.NEXT_PUBLIC_REGISTRY_URL;
      expect(() => getCredentialSyncImportUrl()).toThrow(/Cannot resolve global/);
    });
  });

  describe("buildCredentialUpdatedEvent", () => {
    it("produces the canonical event shape", () => {
      const event = buildCredentialUpdatedEvent({
        agentId: TEST_AGENT_ID,
        credentialVersion: 5,
        signingNodeSlug: "home-test",
        updatedAt: new Date("2026-04-19T00:00:00Z"),
        nonce: "fixed-nonce",
      });
      expect(event).toEqual({
        type: CREDENTIAL_UPDATED_EVENT_TYPE,
        agentId: TEST_AGENT_ID,
        credentialVersion: 5,
        updatedAt: "2026-04-19T00:00:00.000Z",
        nonce: "fixed-nonce",
        signingNodeSlug: "home-test",
      });
    });
  });

  describe("signCredentialUpdatedEvent", () => {
    it("returns a signature that verifies against the node public key", async () => {
      const keyPair = installLocalNode();
      const event = buildCredentialUpdatedEvent({
        agentId: TEST_AGENT_ID,
        credentialVersion: 2,
        signingNodeSlug: "home-test",
      });
      const signed = await signCredentialUpdatedEvent(event);
      const ok = verifyPayloadSignature(
        signed.event as unknown as Record<string, unknown>,
        signed.signature,
        keyPair.publicKey
      );
      expect(ok).toBe(true);
    });
  });

  describe("syncCredentialToGlobal — live POST", () => {
    it("returns { synced: true } on 2xx and writes no queue row", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true, imported: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const signed = await buildSignedEvent(2);
      const result = await syncCredentialToGlobal(TEST_AGENT_ID, 2, signed);

      expect(result).toEqual({ synced: true });
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${TEST_GLOBAL_BASE}${GLOBAL_IMPORT_PATH}`);
      expect(init.method).toBe("POST");

      expect(queueRows).toHaveLength(0);
    });

    it("clears prior pending rows for the same agent after a successful sync", async () => {
      // Seed a stale pending row from a failed prior attempt.
      queueRows.push({
        id: "row-stale",
        agentId: TEST_AGENT_ID,
        eventPayload: {
          event: {
            type: CREDENTIAL_UPDATED_EVENT_TYPE,
            agentId: TEST_AGENT_ID,
            credentialVersion: 2,
            updatedAt: "2026-04-18T00:00:00.000Z",
            nonce: "stale",
            signingNodeSlug: "home-test",
          },
          signature: "base64sig",
          credentialVersion: 2,
        },
        attempts: 1,
        lastAttemptAt: new Date(),
        lastError: "prior failure",
        status: "pending",
        createdAt: new Date(Date.now() - 60_000),
        updatedAt: new Date(Date.now() - 60_000),
      });
      nextRowId = 99;

      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));

      const signed = await buildSignedEvent(3);
      const result = await syncCredentialToGlobal(TEST_AGENT_ID, 3, signed);

      expect(result.synced).toBe(true);
      const stale = queueRows.find((r) => r.id === "row-stale");
      expect(stale?.status).toBe("synced");
    });
  });

  describe("syncCredentialToGlobal — failure modes", () => {
    it("queues pending on network failure (fetch rejects)", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNRESET"));

      const signed = await buildSignedEvent(3);
      const result = await syncCredentialToGlobal(TEST_AGENT_ID, 3, signed);

      expect(result.synced).toBe(false);
      expect(result.reason).toContain("ECONNRESET");
      expect(result.queueId).toBeTruthy();

      expect(queueRows).toHaveLength(1);
      expect(queueRows[0]).toMatchObject({
        agentId: TEST_AGENT_ID,
        status: "pending",
        attempts: 1,
      });
      expect(queueRows[0].lastError).toContain("ECONNRESET");
    });

    it("queues pending on 5xx (retryable server error)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("internal", { status: 503 })
      );

      const signed = await buildSignedEvent(4);
      const result = await syncCredentialToGlobal(TEST_AGENT_ID, 4, signed);

      expect(result.synced).toBe(false);
      expect(result.reason).toMatch(/HTTP 503/);
      expect(queueRows[0].status).toBe("pending");
    });

    it("queues pending on 404 (receiver not yet deployed on global)", async () => {
      // rivr-app #7 / #88: until global ships the import endpoint, home
      // keeps queueing so that first working deploy catches up.
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));

      const signed = await buildSignedEvent(5);
      const result = await syncCredentialToGlobal(TEST_AGENT_ID, 5, signed);

      expect(result.synced).toBe(false);
      expect(result.reason).toMatch(/HTTP 404/);
      expect(queueRows[0].status).toBe("pending");
    });

    it("dead-letters immediately on 401 (non-retryable auth failure)", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("unauthorized", { status: 401 })
      );

      const signed = await buildSignedEvent(6);
      const result = await syncCredentialToGlobal(TEST_AGENT_ID, 6, signed);

      expect(result.synced).toBe(false);
      expect(queueRows[0].status).toBe("failed");
    });

    it("queues pending when GLOBAL_BASE_URL is not set", async () => {
      delete process.env.GLOBAL_BASE_URL;
      delete process.env.NEXT_PUBLIC_GLOBAL_URL;
      delete process.env.REGISTRY_URL;
      delete process.env.NEXT_PUBLIC_REGISTRY_URL;
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const signed = await buildSignedEvent(7);
      const result = await syncCredentialToGlobal(TEST_AGENT_ID, 7, signed);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.synced).toBe(false);
      expect(queueRows).toHaveLength(1);
      expect(queueRows[0].status).toBe("pending");
    });
  });

  describe("drainCredentialSyncQueue", () => {
    it("promotes pending rows to synced on a successful retry", async () => {
      queueRows.push(pendingRow(1, { lastAttemptAt: null, attempts: 0 }));
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 200 }));

      const result = await drainCredentialSyncQueue();

      expect(result).toMatchObject({ attempted: 1, synced: 1, deadLettered: 0 });
      expect(queueRows[0].status).toBe("synced");
    });

    it("increments attempts and leaves row pending on a transient failure", async () => {
      queueRows.push(pendingRow(2, { attempts: 1, lastAttemptAt: null }));
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));

      const result = await drainCredentialSyncQueue();

      expect(result).toMatchObject({ stillPending: 1, synced: 0, deadLettered: 0 });
      expect(queueRows[0].status).toBe("pending");
      expect(queueRows[0].attempts).toBe(2);
      expect(queueRows[0].lastError).toContain("ETIMEDOUT");
    });

    it("dead-letters after MAX_CREDENTIAL_SYNC_ATTEMPTS", async () => {
      queueRows.push(
        pendingRow(3, {
          attempts: MAX_CREDENTIAL_SYNC_ATTEMPTS - 1,
          lastAttemptAt: null,
        })
      );
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("still broken"));

      const result = await drainCredentialSyncQueue();

      expect(result.deadLettered).toBe(1);
      expect(queueRows[0].status).toBe("failed");
      expect(queueRows[0].attempts).toBe(MAX_CREDENTIAL_SYNC_ATTEMPTS);
    });

    it("dead-letters immediately on a terminal HTTP status (401)", async () => {
      queueRows.push(pendingRow(4, { attempts: 0, lastAttemptAt: null }));
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));

      const result = await drainCredentialSyncQueue();

      expect(result.deadLettered).toBe(1);
      expect(queueRows[0].status).toBe("failed");
    });

    it("skips rows whose last attempt is more recent than the retry floor", async () => {
      const fresh = new Date(Date.now() - 5_000); // 5s ago — inside floor window
      queueRows.push(
        pendingRow(5, { attempts: 1, lastAttemptAt: fresh })
      );
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const result = await drainCredentialSyncQueue();

      expect(result.attempted).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(queueRows[0].status).toBe("pending");
    });
  });
});

// ---------------------------------------------------------------------------
// Row factory
// ---------------------------------------------------------------------------

function pendingRow(
  version: number,
  overrides: Partial<QueueRow> = {}
): QueueRow {
  const now = new Date();
  return {
    id: `row-${nextRowId++}`,
    agentId: TEST_AGENT_ID,
    eventPayload: {
      event: {
        type: CREDENTIAL_UPDATED_EVENT_TYPE,
        agentId: TEST_AGENT_ID,
        credentialVersion: version,
        updatedAt: now.toISOString(),
        nonce: `nonce-${version}`,
        signingNodeSlug: "home-test",
      },
      signature: "base64sig",
      credentialVersion: version,
    },
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
