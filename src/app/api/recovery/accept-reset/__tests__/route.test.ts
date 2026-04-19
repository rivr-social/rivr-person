/**
 * Route-level tests for `POST /api/recovery/accept-reset`.
 *
 * Verifies the HTTP contract layered on top of
 * `@/lib/recovery/assertion`:
 *   - Rate-limit shape (429 with retry-after header)
 *   - Malformed JSON / body (400)
 *   - Password policy enforcement (400 `invalid_password`)
 *   - Verification rejections map to the advertised HTTP status with the
 *     correct machine-readable code.
 *   - Replay (unique-constraint) produces 409 with `invalid_payload`.
 *   - Happy path writes password+audit+nonce and returns 200 with a
 *     `credentialSync` status the caller can display.
 *
 * The verification library is exercised exhaustively in its own test
 * file; here we only mock its single entry point `verifyRecoveryAssertion`
 * so the route wiring can be tested in isolation.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_FORBIDDEN,
  STATUS_NOT_FOUND,
  STATUS_CONFLICT,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import { RecoveryAssertionVerificationError } from "@/lib/recovery/assertion";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const checkRateLimitMock = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  RATE_LIMITS: { AUTH: { limit: 5, windowMs: 60_000 } },
  RATE_LIMIT_TIERS: { AUTH: { windowMs: 60_000, maxRequests: 5, prefix: "rl:auth" } },
}));

const verifyMock = vi.fn();
vi.mock("@/lib/recovery/assertion", async () => {
  const actual = await vi.importActual<typeof import("@/lib/recovery/assertion")>(
    "@/lib/recovery/assertion"
  );
  return {
    ...actual,
    verifyRecoveryAssertion: (...args: unknown[]) => verifyMock(...args),
  };
});

// Headers mock — route calls `await headers()`.
const headersMock = new Headers({ "x-real-ip": "10.0.0.1", "user-agent": "vitest" });
vi.mock("next/headers", () => ({
  headers: async () => headersMock,
}));

// bcrypt mock — avoid native binding + keep tests deterministic.
vi.mock("@node-rs/bcrypt", () => ({
  hash: async (v: string) => `hashed:${v}`,
}));

// DB mock — collect transaction callbacks + insert payloads so we can
// assert the route's final writes. Default behavior is "everything
// succeeds"; individual tests override for the replay case.
const insertedRows: Array<{ table: string; values: unknown }> = [];
const updatedRows: Array<{ table: string; set: Record<string, unknown> }> = [];

function tableName(t: unknown): string {
  if (t && typeof t === "object" && "name" in (t as Record<string, unknown>)) {
    return String((t as Record<string, unknown>).name);
  }
  return "unknown";
}

type TxLike = {
  insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> };
  update: (t: unknown) => {
    set: (v: Record<string, unknown>) => {
      where: () => { returning: () => Promise<unknown[]> };
    };
  };
};

let transactionShouldThrow: unknown = null;

vi.mock("@/db", () => ({
  db: {
    insert: (t: unknown) => ({
      values: async (values: unknown) => {
        insertedRows.push({ table: tableName(t), values });
      },
    }),
    transaction: async (cb: (tx: TxLike) => Promise<unknown>) => {
      if (transactionShouldThrow !== null) {
        throw transactionShouldThrow;
      }
      const tx: TxLike = {
        insert: (t) => ({
          values: async (values: unknown) => {
            insertedRows.push({ table: tableName(t), values });
          },
        }),
        update: (t) => ({
          set: (values: Record<string, unknown>) => {
            updatedRows.push({ table: tableName(t), set: values });
            return {
              where: () => ({
                returning: async () => [
                  {
                    id: (values.id as string) ?? "agent-id",
                    credentialVersion: values.credentialVersion ?? 1,
                    sessionVersion: values.sessionVersion ?? 1,
                  },
                ],
              }),
            };
          },
        }),
      };
      return cb(tx);
    },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRequest(body: unknown): Request {
  return new Request("http://localhost:3000/api/recovery/accept-reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const AGENT_ID = "88888888-8888-4888-8888-888888888888";

function buildValidBody(): { assertion: Record<string, unknown>; newPassword: string } {
  return {
    assertion: {
      agentId: AGENT_ID,
      homeBaseUrl: "https://rivr.camalot.me",
      globalIssuerBaseUrl: "https://app.rivr.social",
      intent: "reset-password",
      iat: Date.now(),
      exp: Date.now() + 60_000,
      nonce: "nonce-abcdefgh-9999",
      signature: "base64sig",
    },
    newPassword: "correcthorsebatterystaple",
  };
}

let POST: (req: Request) => Promise<Response>;

beforeEach(async () => {
  vi.clearAllMocks();
  insertedRows.length = 0;
  updatedRows.length = 0;
  transactionShouldThrow = null;
  checkRateLimitMock.mockResolvedValue({
    allowed: true,
    remaining: 4,
    resetAt: new Date(),
    retryAfterMs: 0,
  });

  // Default successful verification result — tests override for failure cases.
  verifyMock.mockResolvedValue({
    assertion: {
      agentId: AGENT_ID,
      homeBaseUrl: "https://rivr.camalot.me",
      globalIssuerBaseUrl: "https://app.rivr.social",
      intent: "reset-password",
      iat: Date.now(),
      exp: Date.now() + 60_000,
      nonce: "nonce-abcdefgh-9999",
      signature: "base64sig",
    },
    agent: {
      id: AGENT_ID,
      email: "c@example.test",
      name: "C",
      credentialVersion: 4,
      sessionVersion: 8,
      instanceMode: "sovereign",
      metadata: { prior: true },
    },
  });

  ({ POST } = await import("../route"));
});

afterEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/recovery/accept-reset", () => {
  it("returns 429 when the rate limit is exceeded", async () => {
    checkRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
      retryAfterMs: 60_000,
    });
    const response = await POST(buildRequest(buildValidBody()));
    expect(response.status).toBe(STATUS_TOO_MANY_REQUESTS);
    expect(response.headers.get("retry-after")).toBe("60");
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("returns 400 on malformed JSON", async () => {
    const response = await POST(buildRequest("{nope"));
    expect(response.status).toBe(STATUS_BAD_REQUEST);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "invalid_payload" });
  });

  it("returns 400 invalid_password when password is too short", async () => {
    const body = buildValidBody();
    body.newPassword = "short";
    const response = await POST(buildRequest(body));
    expect(response.status).toBe(STATUS_BAD_REQUEST);
    const resp = await response.json();
    expect(resp).toMatchObject({ ok: false, code: "invalid_password" });
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_password when password is too long", async () => {
    const body = buildValidBody();
    body.newPassword = "x".repeat(73);
    const response = await POST(buildRequest(body));
    expect(response.status).toBe(STATUS_BAD_REQUEST);
    const resp = await response.json();
    expect(resp).toMatchObject({ ok: false, code: "invalid_password" });
  });

  it("returns 401 invalid_signature when verification fails with that code", async () => {
    verifyMock.mockRejectedValueOnce(
      new RecoveryAssertionVerificationError("invalid_signature", "bad sig")
    );
    const response = await POST(buildRequest(buildValidBody()));
    expect(response.status).toBe(STATUS_UNAUTHORIZED);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "invalid_signature" });
  });

  it("returns 403 wrong_target for target mismatch", async () => {
    verifyMock.mockRejectedValueOnce(
      new RecoveryAssertionVerificationError("wrong_target", "mismatch")
    );
    const response = await POST(buildRequest(buildValidBody()));
    expect(response.status).toBe(STATUS_FORBIDDEN);
    const body = await response.json();
    expect(body.code).toBe("wrong_target");
  });

  it("returns 404 when agent does not exist", async () => {
    verifyMock.mockRejectedValueOnce(
      new RecoveryAssertionVerificationError(
        "agent_not_found",
        "missing",
        { agentId: "gone" }
      )
    );
    const response = await POST(buildRequest(buildValidBody()));
    expect(response.status).toBe(STATUS_NOT_FOUND);
    const body = await response.json();
    expect(body.code).toBe("agent_not_found");
  });

  it("returns 500 missing_public_key when global key is unconfigured", async () => {
    verifyMock.mockRejectedValueOnce(
      new RecoveryAssertionVerificationError(
        "missing_public_key",
        "no key configured"
      )
    );
    const response = await POST(buildRequest(buildValidBody()));
    expect(response.status).toBe(STATUS_INTERNAL_ERROR);
    const body = await response.json();
    expect(body.code).toBe("missing_public_key");
  });

  it("returns 409 when a nonce is replayed (unique-constraint violation)", async () => {
    transactionShouldThrow = Object.assign(new Error("replay"), {
      code: "23505",
      constraint: "recovery_assertion_nonces_nonce_idx",
    });
    const response = await POST(buildRequest(buildValidBody()));
    expect(response.status).toBe(STATUS_CONFLICT);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, code: "invalid_payload" });
    expect(body.message).toMatch(/already been used/);
  });

  it("returns 200 on happy path with bumped credentialVersion + sessionVersion", async () => {
    const response = await POST(buildRequest(buildValidBody()));
    expect(response.status).toBe(STATUS_OK);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.agentId).toBe(AGENT_ID);
    expect(body.credentialVersion).toBe(5); // 4 + 1 from mocked agent snapshot
    expect(body.sessionVersion).toBe(9); // 8 + 1

    // A password hash was written.
    const agentUpdate = updatedRows.find((u) => true);
    expect(agentUpdate).toBeTruthy();
    expect(
      (agentUpdate!.set as { passwordHash: unknown }).passwordHash
    ).toMatch(/^hashed:/);
    expect(
      (agentUpdate!.set as { credentialVersion: number }).credentialVersion
    ).toBe(5);
    expect(
      (agentUpdate!.set as { sessionVersion: number }).sessionVersion
    ).toBe(9);
    // Lockout counter/window is cleared.
    expect(
      (agentUpdate!.set as { failedLoginAttempts: number }).failedLoginAttempts
    ).toBe(0);
    expect(
      (agentUpdate!.set as { lockedUntil: unknown }).lockedUntil
    ).toBeNull();

    // A nonce row was inserted.
    const nonceInsert = insertedRows.find(
      (r) => (r.values as Record<string, unknown>).nonce === "nonce-abcdefgh-9999"
    );
    expect(nonceInsert).toBeTruthy();

    // An audit row was written.
    const auditInsert = insertedRows.find(
      (r) =>
        (r.values as Record<string, unknown>).eventType ===
        "recovery.password_reset.accepted"
    );
    expect(auditInsert).toBeTruthy();

    // credentialSync reports "skipped" because the sibling module is not
    // present on this branch.
    expect(body.credentialSync).toBe("skipped");
  });
});
