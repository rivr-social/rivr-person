/**
 * Tests for `src/lib/mailer.ts` — the central transactional mailer
 * that routes between local SMTP (on global) and the signed email
 * relay (on peer instances) per issue #103.
 *
 * Covered behaviors:
 *   - Global instance routes sendTransactionalEmail to @/lib/email.sendEmail
 *   - Peer instance with GLOBAL_IDENTITY_AUTHORITY_URL relays via
 *     sendEmailViaGlobal (no local SMTP call)
 *   - Peer instance with no URL configured falls back to local SMTP
 *     AND emits a one-shot warning
 *   - Relay failures surface as { success: false, error, delegated: true }
 *     without throwing (so signup/password-reset flows aren't crashed)
 *   - sendBulkTransactionalEmail fans each recipient through the same
 *     transport decision and returns a per-recipient Map
 *   - Kind is propagated verbatim into the relay request
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — declared before importing the unit under test.
// ---------------------------------------------------------------------------

// `@/lib/federation/email-relay` transitively imports `@/db`, which asserts
// DATABASE_URL at import time. Stub `@/db` so the mailer test can run in
// isolation without any database / env plumbing.
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
    })),
  },
}));

const mockSendEmail = vi.fn();
vi.mock("@/lib/email", () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
}));

const mockSendEmailViaGlobal = vi.fn();
// Replace the relay module entirely. Carry forward the kind enum + a local
// EmailRelayError so the mailer's `instanceof EmailRelayError` branch still
// has a real constructor to match against.
vi.mock("@/lib/federation/email-relay", () => {
  class EmailRelayError extends Error {
    readonly code: string;
    readonly status?: number;
    constructor(message: string, code: string, status?: number) {
      super(message);
      this.name = "EmailRelayError";
      this.code = code;
      this.status = status;
    }
  }
  const EMAIL_RELAY_KINDS = {
    VERIFICATION: "verification",
    PASSWORD_RESET: "password-reset",
    RECOVERY: "recovery",
    TRANSACTIONAL: "transactional",
  } as const;
  return {
    EmailRelayError,
    EMAIL_RELAY_KINDS,
    EMAIL_RELAY_KIND_SET: new Set(Object.values(EMAIL_RELAY_KINDS)),
    sendEmailViaGlobal: (...args: unknown[]) => mockSendEmailViaGlobal(...args),
  };
});

// ---------------------------------------------------------------------------
// Imports AFTER mocks
// ---------------------------------------------------------------------------
import {
  sendBulkTransactionalEmail,
  sendTransactionalEmail,
} from "@/lib/mailer";
import {
  EmailRelayError,
  EMAIL_RELAY_KINDS,
} from "@/lib/federation/email-relay";
import { resetInstanceConfig } from "@/lib/federation/instance-config";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_ENV = { ...process.env };

const BASE_PARAMS = {
  kind: EMAIL_RELAY_KINDS.VERIFICATION,
  to: "alice@example.com",
  subject: "Please verify",
  html: "<p>Click the link</p>",
  text: "Click the link",
} as const;

function mockConsoleWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

function mockConsoleError(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.INSTANCE_TYPE;
  delete process.env.INSTANCE_ID;
  delete process.env.GLOBAL_IDENTITY_AUTHORITY_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
  delete process.env.BASE_URL;
  resetInstanceConfig();
  mockSendEmail.mockReset();
  mockSendEmailViaGlobal.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetInstanceConfig();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// sendTransactionalEmail — global instance
// ---------------------------------------------------------------------------

describe("sendTransactionalEmail: global instance", () => {
  it("routes to local sendEmail when INSTANCE_TYPE defaults to global", async () => {
    mockSendEmail.mockResolvedValueOnce({
      success: true,
      messageId: "<local@test>",
    });

    const result = await sendTransactionalEmail({ ...BASE_PARAMS });

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendEmailViaGlobal).not.toHaveBeenCalled();
    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: BASE_PARAMS.to,
        subject: BASE_PARAMS.subject,
        html: BASE_PARAMS.html,
        text: BASE_PARAMS.text,
      }),
    );
    expect(result).toEqual({
      success: true,
      messageId: "<local@test>",
      error: undefined,
      delegated: false,
    });
  });

  it("routes to local sendEmail on explicit INSTANCE_TYPE=global even when GLOBAL_IDENTITY_AUTHORITY_URL is set", async () => {
    process.env.INSTANCE_TYPE = "global";
    process.env.GLOBAL_IDENTITY_AUTHORITY_URL = "https://a.rivr.social";
    resetInstanceConfig();
    mockSendEmail.mockResolvedValueOnce({
      success: true,
      messageId: "<global-stays-local@test>",
    });

    const result = await sendTransactionalEmail({ ...BASE_PARAMS });

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendEmailViaGlobal).not.toHaveBeenCalled();
    expect(result.delegated).toBe(false);
    expect(result.success).toBe(true);
  });

  it("surfaces local transport failures without crashing the caller", async () => {
    mockSendEmail.mockResolvedValueOnce({
      success: false,
      error: "SMTP 421 service not available",
    });

    const result = await sendTransactionalEmail({ ...BASE_PARAMS });

    expect(result).toEqual({
      success: false,
      messageId: undefined,
      error: "SMTP 421 service not available",
      delegated: false,
    });
  });
});

// ---------------------------------------------------------------------------
// sendTransactionalEmail — peer instance
// ---------------------------------------------------------------------------

describe("sendTransactionalEmail: peer instance", () => {
  beforeEach(() => {
    process.env.INSTANCE_TYPE = "person";
    process.env.INSTANCE_ID = "77777777-7777-4777-8777-777777777777";
    process.env.NEXT_PUBLIC_BASE_URL =
      "https://spirit-of-the-front-range.rivr.social";
    process.env.GLOBAL_IDENTITY_AUTHORITY_URL = "https://a.rivr.social";
    resetInstanceConfig();
  });

  it("routes to sendEmailViaGlobal when peer + URL configured", async () => {
    mockSendEmailViaGlobal.mockResolvedValueOnce({
      ok: true,
      messageId: "<relayed@global>",
      emailLogId: "log-1",
    });

    const result = await sendTransactionalEmail({
      ...BASE_PARAMS,
      recipientAgentId: "99999999-9999-4999-8999-999999999999",
      meta: { flow: "signup" },
    });

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendEmailViaGlobal).toHaveBeenCalledOnce();
    const relayCall = mockSendEmailViaGlobal.mock.calls[0][0];
    expect(relayCall).toEqual(
      expect.objectContaining({
        globalBaseUrl: "https://a.rivr.social",
        kind: "verification",
        peerBaseUrl:
          "https://spirit-of-the-front-range.rivr.social",
        recipientEmail: BASE_PARAMS.to,
        recipientAgentId: "99999999-9999-4999-8999-999999999999",
        subject: BASE_PARAMS.subject,
        textBody: BASE_PARAMS.text,
        htmlBody: BASE_PARAMS.html,
        meta: { flow: "signup" },
      }),
    );
    expect(result).toEqual({
      success: true,
      messageId: "<relayed@global>",
      delegated: true,
    });
  });

  it("propagates each relay kind verbatim", async () => {
    mockSendEmailViaGlobal.mockResolvedValue({
      ok: true,
      messageId: "<ok>",
      emailLogId: "log",
    });

    for (const kind of Object.values(EMAIL_RELAY_KINDS)) {
      mockSendEmailViaGlobal.mockClear();
      await sendTransactionalEmail({ ...BASE_PARAMS, kind });
      expect(mockSendEmailViaGlobal).toHaveBeenCalledOnce();
      expect(mockSendEmailViaGlobal.mock.calls[0][0].kind).toBe(kind);
    }
  });

  it("returns failure (not throws) when relay server responds with ok=false", async () => {
    mockSendEmailViaGlobal.mockResolvedValueOnce({
      ok: false,
      code: "unknown_peer",
      error: "Peer instance not registered on global",
    });

    const result = await sendTransactionalEmail({ ...BASE_PARAMS });

    expect(result.success).toBe(false);
    expect(result.delegated).toBe(true);
    expect(result.error).toContain("unknown_peer");
    expect(result.error).toContain("not registered");
  });

  it("returns failure (not throws) when relay transport exhausts retries", async () => {
    const errSpy = mockConsoleError();
    mockSendEmailViaGlobal.mockRejectedValueOnce(
      new EmailRelayError(
        "Email relay exhausted 3 attempts: connect ECONNREFUSED",
        "retries_exhausted",
        undefined,
      ),
    );

    const result = await sendTransactionalEmail({ ...BASE_PARAMS });

    expect(result.success).toBe(false);
    expect(result.delegated).toBe(true);
    expect(result.error).toContain("retries_exhausted");
    expect(errSpy).toHaveBeenCalled();
  });

  it("falls back to local SMTP with a one-shot warning when GLOBAL_IDENTITY_AUTHORITY_URL is missing", async () => {
    delete process.env.GLOBAL_IDENTITY_AUTHORITY_URL;
    resetInstanceConfig();
    const warnSpy = mockConsoleWarn();
    mockSendEmail.mockResolvedValue({
      success: true,
      messageId: "<fallback-local@test>",
    });

    const r1 = await sendTransactionalEmail({ ...BASE_PARAMS });
    const r2 = await sendTransactionalEmail({ ...BASE_PARAMS });

    expect(r1.delegated).toBe(false);
    expect(r2.delegated).toBe(false);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
    expect(mockSendEmailViaGlobal).not.toHaveBeenCalled();
    // Warning should be emitted ONCE across both calls.
    const peerWarnings = warnSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("Peer instance email will not deliver"),
    );
    expect(peerWarnings.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sendBulkTransactionalEmail
// ---------------------------------------------------------------------------

describe("sendBulkTransactionalEmail", () => {
  it("routes each recipient through the same transport decision (global)", async () => {
    mockSendEmail.mockImplementation(async (opts: { to: string }) => ({
      success: true,
      messageId: `<bulk-${opts.to}>`,
    }));

    const recipients = ["a@test.com", "b@test.com", "c@test.com"];
    const results = await sendBulkTransactionalEmail(recipients, {
      kind: "transactional",
      subject: "Broadcast",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(results.size).toBe(3);
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    expect(mockSendEmailViaGlobal).not.toHaveBeenCalled();
    for (const r of recipients) {
      const entry = results.get(r);
      expect(entry?.success).toBe(true);
      expect(entry?.delegated).toBe(false);
      expect(entry?.messageId).toBe(`<bulk-${r}>`);
    }
  });

  it("routes each recipient through the relay on peer", async () => {
    process.env.INSTANCE_TYPE = "group";
    process.env.INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
    process.env.NEXT_PUBLIC_BASE_URL = "https://example.rivr.social";
    process.env.GLOBAL_IDENTITY_AUTHORITY_URL = "https://a.rivr.social";
    resetInstanceConfig();

    mockSendEmailViaGlobal.mockImplementation(async (opts: {
      recipientEmail: string;
    }) => ({
      ok: true,
      messageId: `<relay-${opts.recipientEmail}>`,
      emailLogId: "log",
    }));

    const results = await sendBulkTransactionalEmail(
      ["x@test.com", "y@test.com"],
      {
        kind: "transactional",
        subject: "Broadcast",
        html: "<p>hi</p>",
        text: "hi",
        agentIdFor: (email) =>
          email === "x@test.com" ? "agent-x" : undefined,
      },
    );

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendEmailViaGlobal).toHaveBeenCalledTimes(2);
    expect(results.get("x@test.com")?.success).toBe(true);
    expect(results.get("x@test.com")?.delegated).toBe(true);
    // agentIdFor is plumbed through for audit
    const firstCall = mockSendEmailViaGlobal.mock.calls.find(
      ([c]) => c.recipientEmail === "x@test.com",
    );
    expect(firstCall?.[0].recipientAgentId).toBe("agent-x");
    const secondCall = mockSendEmailViaGlobal.mock.calls.find(
      ([c]) => c.recipientEmail === "y@test.com",
    );
    expect(secondCall?.[0].recipientAgentId).toBeUndefined();
  });

  it("captures per-recipient failures without throwing", async () => {
    mockSendEmail
      .mockResolvedValueOnce({ success: true, messageId: "<ok>" })
      .mockRejectedValueOnce(new Error("bounce"))
      .mockResolvedValueOnce({ success: true, messageId: "<ok-2>" });

    const results = await sendBulkTransactionalEmail(
      ["a@test.com", "b@test.com", "c@test.com"],
      { kind: "transactional", subject: "s", html: "<p>h</p>" },
    );

    expect(results.get("a@test.com")?.success).toBe(true);
    expect(results.get("b@test.com")?.success).toBe(false);
    expect(results.get("b@test.com")?.error).toBe("bounce");
    expect(results.get("c@test.com")?.success).toBe(true);
  });

  it("handles empty recipient list without sending anything", async () => {
    const results = await sendBulkTransactionalEmail([], {
      kind: "transactional",
      subject: "s",
      html: "<p>h</p>",
    });
    expect(results.size).toBe(0);
    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockSendEmailViaGlobal).not.toHaveBeenCalled();
  });
});
