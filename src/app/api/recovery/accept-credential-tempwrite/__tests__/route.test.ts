/**
 * Route-level tests for `POST /api/recovery/accept-credential-tempwrite`.
 *
 * Verifies the HTTP contract layered on top of the library in
 * `@/lib/federation/accept-tempwrite`:
 *   - Content-Type guard (415)
 *   - Rate-limit shape (429 with retryAfterSec detail)
 *   - Malformed/forbidden-field envelope (400)
 *   - Successful happy-path (200 with AcceptTempwriteSuccessResponse body)
 *   - Rejected payload produces an audit row via `writeAuditRejected`
 *
 * The library behavior itself is exercised exhaustively in
 * `src/lib/federation/__tests__/accept-tempwrite.test.ts`; here we only
 * mock it so we can reason about the route wiring without re-running the
 * full crypto/DB plumbing.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_UNSUPPORTED_MEDIA_TYPE,
  STATUS_FORBIDDEN,
} from "@/lib/http-status";
import { CREDENTIAL_TEMPWRITE_EVENT_TYPE } from "@/lib/federation/accept-tempwrite";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const rateLimitMock = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
  RATE_LIMITS: {
    PASSWORD_RESET: { limit: 5, windowMs: 60_000 },
  },
}));

const acceptMock = vi.fn();
const writeAuditAcceptedMock = vi.fn();
const writeAuditRejectedMock = vi.fn();

vi.mock("@/lib/federation/accept-tempwrite", async () => {
  // Pull the real module for error classes and constants so the route's
  // `instanceof TempwriteRejectedError` check still works.
  const actual = await vi.importActual<
    typeof import("@/lib/federation/accept-tempwrite")
  >("@/lib/federation/accept-tempwrite");

  return {
    ...actual,
    acceptCredentialTempwrite: (...args: unknown[]) => acceptMock(...args),
    writeAuditAccepted: (...args: unknown[]) => writeAuditAcceptedMock(...args),
    writeAuditRejected: (...args: unknown[]) => writeAuditRejectedMock(...args),
  };
});

// Late-import so mocks are registered first.
let POST: (req: Request) => Promise<Response>;

beforeEach(async () => {
  vi.clearAllMocks();
  rateLimitMock.mockResolvedValue({ success: true, resetMs: 0 });
  ({ POST } = await import("../route"));
});

afterEach(() => {
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_ID = "99999999-9999-4999-8999-999999999999";

function buildValidEnvelope(): Record<string, unknown> {
  return {
    event: {
      type: CREDENTIAL_TEMPWRITE_EVENT_TYPE,
      agentId: AGENT_ID,
      newCredentialVerifier: "$2b$12$hash",
      credentialVersion: 4,
      timestamp: new Date().toISOString(),
      nonce: "22222222-2222-4222-8222-222222222222",
    },
    signature: "deadbeef",
    signingNodeSlug: "global",
  };
}

function buildRequest(body: unknown, init: RequestInit = {}): Request {
  return new Request("http://localhost:3000/api/recovery/accept-credential-tempwrite", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/recovery/accept-credential-tempwrite", () => {
  it("returns 415 when content-type is not JSON", async () => {
    const req = new Request(
      "http://localhost:3000/api/recovery/accept-credential-tempwrite",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "nope",
      }
    );
    const response = await POST(req);
    expect(response.status).toBe(STATUS_UNSUPPORTED_MEDIA_TYPE);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: "unsupported_media_type" });
  });

  it("returns 429 when the per-IP rate limit is exceeded", async () => {
    rateLimitMock.mockResolvedValueOnce({ success: false, resetMs: 60_000 });
    const response = await POST(buildRequest(buildValidEnvelope()));
    expect(response.status).toBe(STATUS_TOO_MANY_REQUESTS);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: "rate_limited" });
    expect(body.detail).toMatchObject({ retryAfterSec: 60 });
  });

  it("returns 400 on malformed JSON", async () => {
    const response = await POST(buildRequest("{not-json"));
    expect(response.status).toBe(STATUS_BAD_REQUEST);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("malformed_json");
  });

  it("returns 400 and does not call the lib when a forbidden field is present", async () => {
    const envelope = buildValidEnvelope();
    (envelope.event as Record<string, unknown>).profile = { bio: "forbidden" };
    const response = await POST(buildRequest(envelope));
    expect(response.status).toBe(STATUS_BAD_REQUEST);
    expect(acceptMock).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.error).toBe("forbidden_field");
    expect(writeAuditRejectedMock).toHaveBeenCalledTimes(1);
    expect(writeAuditRejectedMock.mock.calls[0][0]).toMatchObject({
      agentId: null,
      outcome: "forbidden_field",
    });
  });

  it("returns 200 and writes an accepted audit row on happy path", async () => {
    const appliedAt = new Date();
    acceptMock.mockResolvedValueOnce({
      agentId: AGENT_ID,
      previousCredentialVersion: 3,
      credentialVersion: 4,
      sessionVersion: 8,
      appliedAt,
    });

    const envelope = buildValidEnvelope();
    const response = await POST(buildRequest(envelope));
    expect(response.status).toBe(STATUS_OK);

    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      agentId: AGENT_ID,
      credentialVersion: 4,
      previousCredentialVersion: 3,
      sessionVersion: 8,
      appliedAt: appliedAt.toISOString(),
    });

    expect(acceptMock).toHaveBeenCalledTimes(1);
    expect(writeAuditAcceptedMock).toHaveBeenCalledTimes(1);
    expect(writeAuditAcceptedMock.mock.calls[0][0]).toMatchObject({
      agentId: AGENT_ID,
      credentialVersion: 4,
      nonce: (envelope.event as Record<string, unknown>).nonce,
      signingNodeSlug: "global",
      previousCredentialVersion: 3,
      sessionVersion: 8,
    });
  });

  it("maps lib rejections to their advertised HTTP status", async () => {
    const { TempwriteSignatureError } = await import(
      "@/lib/federation/accept-tempwrite"
    );
    acceptMock.mockRejectedValueOnce(
      new TempwriteSignatureError("bad signature")
    );
    const response = await POST(buildRequest(buildValidEnvelope()));
    expect(response.status).toBe(STATUS_FORBIDDEN);
    const body = await response.json();
    expect(body).toMatchObject({ ok: false, error: "invalid_signature" });
    expect(writeAuditRejectedMock).toHaveBeenCalledTimes(1);
    expect(writeAuditRejectedMock.mock.calls[0][0]).toMatchObject({
      agentId: AGENT_ID,
      outcome: "invalid_signature",
    });
  });
});
