/**
 * Tests for `src/lib/federation/email-relay.ts` — the peer-side client
 * that peer Rivr instances use to delegate outbound email to global.
 *
 * Covered behaviors:
 *   - canonicalizeEmailRelayBody matches federation-crypto.canonicalize
 *   - sendEmailViaGlobal signs with the local node's private key
 *   - sendEmailViaGlobal retries on 5xx
 *   - sendEmailViaGlobal does NOT retry on 4xx
 *   - sendEmailViaGlobal throws EmailRelayError after exhausting retries
 *   - validation rejects unknown kinds / missing globalBaseUrl
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canonicalize,
  generateNodeKeyPair,
  verifyPayloadSignature,
} from "@/lib/federation-crypto";

// =============================================================================
// Key material generated once per module — deterministic across cases so the
// signature verification checks are a real crypto round-trip.
// =============================================================================

const KEY_PAIR = generateNodeKeyPair();
const LOCAL_INSTANCE_ID = "77777777-7777-4777-8777-777777777777";

// =============================================================================
// Mocks
// =============================================================================

interface DbSelectChain {
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
}

const selectResultsQueue: Array<unknown[]> = [];

const mockDbSelect = vi.fn(() => {
  const chain: DbSelectChain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => {
      const next = selectResultsQueue.shift() ?? [];
      return Promise.resolve(next);
    }),
  };
  return chain;
});

vi.mock("@/db", () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));

// getInstanceConfig reads env — replace with a stable stub so the test
// doesn't depend on whatever INSTANCE_ID is set during test runs.
vi.mock("@/lib/federation/instance-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/federation/instance-config")>();
  return {
    ...actual,
    getInstanceConfig: () => ({
      instanceId: LOCAL_INSTANCE_ID,
      instanceType: "person" as const,
      instanceSlug: "spirit-of-the-front-range",
      primaryAgentId: null,
      registryUrl: "",
      minioBucketPrefix: "",
      baseUrl: "https://spirit-of-the-front-range.rivr.social",
      isGlobal: false,
    }),
  };
});

// Import AFTER mocks are in place.
import {
  EmailRelayError,
  EmailRelayHeader,
  EMAIL_RELAY_KINDS,
  canonicalizeEmailRelayBody,
  sendEmailViaGlobal,
  type EmailRelayRequestBody,
} from "../email-relay";

// =============================================================================
// Fixtures
// =============================================================================

const GLOBAL_BASE = "https://a.rivr.social";
const PEER_BASE = "https://spirit-of-the-front-range.rivr.social";
const RECIPIENT = "alice@example.com";
const FIXED_ISSUED_AT = "2026-04-19T12:00:00.000Z";

/** Queue the local node's private-key row for the `.select().limit()` path. */
function queueLocalPrivateKey(privateKey: string | null = KEY_PAIR.privateKey): void {
  selectResultsQueue.push([{ privateKey }]);
}

/** Build a deterministic relay body for canonicalization/signing assertions. */
function fullBody(): EmailRelayRequestBody {
  return {
    kind: EMAIL_RELAY_KINDS.VERIFICATION,
    peerBaseUrl: PEER_BASE,
    peerInstanceId: LOCAL_INSTANCE_ID,
    peerAgentId: "88888888-8888-4888-8888-888888888888",
    recipientEmail: RECIPIENT,
    recipientAgentId: "99999999-9999-4999-8999-999999999999",
    subject: "Please verify",
    textBody: "hello",
    htmlBody: "<p>hello</p>",
    issuedAt: FIXED_ISSUED_AT,
    meta: { token: "abc" },
  };
}

// =============================================================================
// canonicalizeEmailRelayBody
// =============================================================================

describe("canonicalizeEmailRelayBody", () => {
  beforeEach(() => {
    selectResultsQueue.length = 0;
  });

  it("produces the exact same JSON whether keys are inserted in order A or B", () => {
    const bodyA = fullBody();
    const bodyB: EmailRelayRequestBody = {
      // Insert in a different field order — canonical result must match.
      textBody: bodyA.textBody,
      subject: bodyA.subject,
      recipientEmail: bodyA.recipientEmail,
      recipientAgentId: bodyA.recipientAgentId,
      peerInstanceId: bodyA.peerInstanceId,
      peerBaseUrl: bodyA.peerBaseUrl,
      peerAgentId: bodyA.peerAgentId,
      meta: bodyA.meta,
      kind: bodyA.kind,
      issuedAt: bodyA.issuedAt,
      htmlBody: bodyA.htmlBody,
    };
    expect(canonicalizeEmailRelayBody(bodyA)).toBe(canonicalizeEmailRelayBody(bodyB));
  });

  it("matches the generic canonicalize output for the signed surface", () => {
    const body = fullBody();
    const expected = canonicalize({
      htmlBody: body.htmlBody,
      issuedAt: body.issuedAt,
      kind: body.kind,
      meta: body.meta,
      peerAgentId: body.peerAgentId,
      peerBaseUrl: body.peerBaseUrl,
      peerInstanceId: body.peerInstanceId,
      recipientAgentId: body.recipientAgentId,
      recipientEmail: body.recipientEmail,
      subject: body.subject,
      textBody: body.textBody,
    });
    expect(canonicalizeEmailRelayBody(body)).toBe(expected);
  });

  it("strips undefined-valued optional fields deterministically", () => {
    const body: EmailRelayRequestBody = {
      kind: EMAIL_RELAY_KINDS.TRANSACTIONAL,
      peerBaseUrl: PEER_BASE,
      peerInstanceId: LOCAL_INSTANCE_ID,
      recipientEmail: RECIPIENT,
      subject: "hi",
      textBody: "body",
      issuedAt: FIXED_ISSUED_AT,
    };
    const canonical = canonicalizeEmailRelayBody(body);
    // Optional fields are simply absent from the canonical form.
    expect(canonical).not.toContain("htmlBody");
    expect(canonical).not.toContain("meta");
    expect(canonical).not.toContain("peerAgentId");
    expect(canonical).not.toContain("recipientAgentId");
  });
});

// =============================================================================
// sendEmailViaGlobal
// =============================================================================

describe("sendEmailViaGlobal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResultsQueue.length = 0;
  });

  it("rejects invalid kinds early", async () => {
    await expect(
      sendEmailViaGlobal({
        globalBaseUrl: GLOBAL_BASE,
        // @ts-expect-error — intentional invalid value.
        kind: "marketing",
        peerBaseUrl: PEER_BASE,
        recipientEmail: RECIPIENT,
        subject: "hi",
        textBody: "body",
      }),
    ).rejects.toThrow(EmailRelayError);
  });

  it("rejects missing globalBaseUrl", async () => {
    await expect(
      sendEmailViaGlobal({
        globalBaseUrl: "",
        kind: EMAIL_RELAY_KINDS.VERIFICATION,
        peerBaseUrl: PEER_BASE,
        recipientEmail: RECIPIENT,
        subject: "hi",
        textBody: "body",
      }),
    ).rejects.toThrow(EmailRelayError);
  });

  it("throws EmailRelayError when the local node has no private key", async () => {
    queueLocalPrivateKey(null);
    await expect(
      sendEmailViaGlobal({
        globalBaseUrl: GLOBAL_BASE,
        kind: EMAIL_RELAY_KINDS.VERIFICATION,
        peerBaseUrl: PEER_BASE,
        recipientEmail: RECIPIENT,
        subject: "hi",
        textBody: "body",
      }),
    ).rejects.toMatchObject({
      name: "EmailRelayError",
      code: "local_private_key_missing",
    });
  });

  it("signs the canonical body with the local key so global can verify", async () => {
    queueLocalPrivateKey();
    const capturedHeaders: Array<Record<string, string>> = [];
    const capturedBodies: string[] = [];

    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedHeaders.push(
        Object.fromEntries(new Headers(init.headers as HeadersInit)),
      );
      capturedBodies.push(init.body as string);
      return new Response(
        JSON.stringify({
          ok: true,
          messageId: "<msg>",
          emailLogId: "log-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const response = await sendEmailViaGlobal({
      globalBaseUrl: GLOBAL_BASE,
      kind: EMAIL_RELAY_KINDS.VERIFICATION,
      peerBaseUrl: PEER_BASE,
      recipientEmail: RECIPIENT,
      subject: "hi",
      textBody: "body",
      issuedAt: FIXED_ISSUED_AT,
      fetchImpl,
    });

    // Response passes through unchanged.
    expect(response).toMatchObject({ ok: true, messageId: "<msg>" });

    // One HTTP call, to the expected URL.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      `${GLOBAL_BASE}/api/federation/email/send`,
    );

    // Node header echoes the local instance id.
    expect(capturedHeaders[0][EmailRelayHeader.NODE]).toBe(LOCAL_INSTANCE_ID);
    const signature = capturedHeaders[0][EmailRelayHeader.SIGNATURE];
    expect(signature).toBeTruthy();

    // Verify the signature is valid for the canonical body shape using
    // the matching public key — this is the round-trip the receiving
    // global performs in production.
    const parsedBody = JSON.parse(capturedBodies[0]) as EmailRelayRequestBody;
    const signedSurface = {
      htmlBody: parsedBody.htmlBody,
      issuedAt: parsedBody.issuedAt,
      kind: parsedBody.kind,
      meta: parsedBody.meta,
      peerAgentId: parsedBody.peerAgentId,
      peerBaseUrl: parsedBody.peerBaseUrl,
      peerInstanceId: parsedBody.peerInstanceId,
      recipientAgentId: parsedBody.recipientAgentId,
      recipientEmail: parsedBody.recipientEmail,
      subject: parsedBody.subject,
      textBody: parsedBody.textBody,
    };
    expect(
      verifyPayloadSignature(signedSurface, signature, KEY_PAIR.publicKey),
    ).toBe(true);

    // The body carries the stable local-instance id.
    expect(parsedBody.peerInstanceId).toBe(LOCAL_INSTANCE_ID);
  });

  it("retries on 5xx up to maxAttempts then succeeds", async () => {
    queueLocalPrivateKey();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("boom", { status: 500 }),
      )
      .mockResolvedValueOnce(
        new Response("still boom", { status: 502 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, messageId: "<m>", emailLogId: "l" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ) as unknown as typeof fetch;

    const result = await sendEmailViaGlobal({
      globalBaseUrl: GLOBAL_BASE,
      kind: EMAIL_RELAY_KINDS.VERIFICATION,
      peerBaseUrl: PEER_BASE,
      recipientEmail: RECIPIENT,
      subject: "hi",
      textBody: "body",
      maxAttempts: 3,
      baseBackoffMs: 0,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 4xx; returns the response immediately", async () => {
    queueLocalPrivateKey();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, error: "bad signature", code: "status_unauthorized" }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const result = await sendEmailViaGlobal({
      globalBaseUrl: GLOBAL_BASE,
      kind: EMAIL_RELAY_KINDS.VERIFICATION,
      peerBaseUrl: PEER_BASE,
      recipientEmail: RECIPIENT,
      subject: "hi",
      textBody: "body",
      maxAttempts: 3,
      baseBackoffMs: 0,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, code: "status_unauthorized" });
    // Exactly one call — no retry on 4xx.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws EmailRelayError after exhausting all retries on repeated 5xx", async () => {
    queueLocalPrivateKey();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("server broken", { status: 503 })) as unknown as typeof fetch;

    await expect(
      sendEmailViaGlobal({
        globalBaseUrl: GLOBAL_BASE,
        kind: EMAIL_RELAY_KINDS.VERIFICATION,
        peerBaseUrl: PEER_BASE,
        recipientEmail: RECIPIENT,
        subject: "hi",
        textBody: "body",
        maxAttempts: 3,
        baseBackoffMs: 0,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "EmailRelayError",
      code: "retries_exhausted",
      status: 503,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries on network errors and eventually throws retries_exhausted", async () => {
    queueLocalPrivateKey();
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("ECONNRESET")) as unknown as typeof fetch;

    await expect(
      sendEmailViaGlobal({
        globalBaseUrl: GLOBAL_BASE,
        kind: EMAIL_RELAY_KINDS.VERIFICATION,
        peerBaseUrl: PEER_BASE,
        recipientEmail: RECIPIENT,
        subject: "hi",
        textBody: "body",
        maxAttempts: 2,
        baseBackoffMs: 0,
        fetchImpl,
      }),
    ).rejects.toMatchObject({
      name: "EmailRelayError",
      code: "retries_exhausted",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
