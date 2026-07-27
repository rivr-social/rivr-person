import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestTransaction } from "@/test/db";
import { createTestAgent, createTestResource } from "@/test/fixtures";
import { mockAuthSession, mockUnauthenticated } from "@/test/auth-helpers";
import { resources } from "@/db/schema";

// =============================================================================
// Mocks
// =============================================================================

vi.mock("@/db", async () => {
  const { getTestDbModule } = await import("@/test/db");
  return getTestDbModule();
});

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("next/headers", async () => {
  const { setupNextHeadersMock } = await import("@/test/external-mocks");
  return setupNextHeadersMock();
});

vi.mock("next/cache", async () => {
  const { setupNextCacheMock } = await import("@/test/external-mocks");
  return setupNextCacheMock();
});

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn().mockResolvedValue({ success: true, resetMs: 0 }),
  RATE_LIMITS: {
    WALLET: { limit: 10, windowMs: 60000 },
  },
}));

vi.mock("@/lib/client-ip", () => ({
  getClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

// Global is the only Stripe platform, so this action no longer touches Stripe.
// It submits an obligation and maps the verdict.
const mockSubmitGlobalRefund = vi.fn();

vi.mock("@/lib/global-refund", () => ({
  submitGlobalRefund: (...args: unknown[]) => mockSubmitGlobalRefund(...args),
}));

// Deliberately NOT mocking "@/lib/billing": if this action ever reaches for a
// Stripe client again, the import should fail loudly rather than be satisfied.

// Import AFTER all mocks
import { auth } from "@/auth";
import { rateLimit } from "@/lib/rate-limit";
import { requestRefundAction } from "../refund";

// =============================================================================
// Tests
// =============================================================================

describe("refund actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimit).mockResolvedValue({ success: true, resetMs: 0 });
    // Default to a successful Global verdict; individual tests override.
    mockSubmitGlobalRefund.mockResolvedValue({
      status: "refunded",
      refundId: "re_test_123",
    });
  });

  // ===========================================================================
  // Authentication
  // ===========================================================================

  describe("authentication", () => {
    it("returns error when not authenticated", () =>
      withTestTransaction(async () => {
        vi.mocked(auth).mockResolvedValue(mockUnauthenticated());

        const result = await requestRefundAction("receipt-id");
        expect(result).toEqual({ success: false, error: "Not authenticated" });
      }));
  });

  // ===========================================================================
  // Rate limiting
  // ===========================================================================

  describe("rate limiting", () => {
    it("returns error when rate limited", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
        vi.mocked(rateLimit).mockResolvedValue({ success: false, resetMs: 30000 });

        const result = await requestRefundAction("receipt-id");
        expect(result.success).toBe(false);
        expect(result.error).toContain("Too many refund requests");
      }));
  });

  // ===========================================================================
  // Validation
  // ===========================================================================

  describe("validation", () => {
    it("returns error when receipt does not exist", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction("00000000-0000-0000-0000-000000000000");
        expect(result).toEqual({ success: false, error: "Receipt not found" });
      }));

    it("returns error when receipt is not owned by the user", () =>
      withTestTransaction(async (db) => {
        const owner = await createTestAgent(db);
        const other = await createTestAgent(db);

        const receipt = await createTestResource(db, owner.id, {
          type: "receipt",
          metadata: {
            stripePaymentIntentId: "pi_test_123",
            totalCents: 1000,
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(other.id));

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "Not authorized" });
      }));

    it("returns error when refund was already requested", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            status: "refund_requested",
            stripePaymentIntentId: "pi_test_123",
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "Refund already requested" });
      }));

    it("returns error when receipt was already refunded", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {
            status: "refunded",
            stripePaymentIntentId: "pi_test_123",
          },
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "Refund already requested" });
      }));

    it("returns error when no payment intent is found", () =>
      withTestTransaction(async (db) => {
        const user = await createTestAgent(db);
        const receipt = await createTestResource(db, user.id, {
          type: "receipt",
          metadata: {},
        });

        vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));

        const result = await requestRefundAction(receipt.id);
        expect(result).toEqual({ success: false, error: "No payment intent found" });
      }));
  });

  // ===========================================================================
  // Stripe verification
  // ===========================================================================

  describe("Global-mediated refund", () => {
    async function seedRefundableReceipt(db: TestDatabase) {
      const user = await createTestAgent(db);
      const receipt = await createTestResource(db, user.id, {
        type: "receipt",
        metadata: { stripePaymentIntentId: "pi_test_123", totalCents: 1000 },
      });
      vi.mocked(auth).mockResolvedValue(mockAuthSession(user.id));
      return { user, receipt };
    }

    it("submits the obligation to Global and never calls Stripe itself", () =>
      withTestTransaction(async (db) => {
        const { user, receipt } = await seedRefundableReceipt(db);
        mockSubmitGlobalRefund.mockResolvedValue({
          status: "refunded",
          refundId: "re_test_123",
        });

        const result = await requestRefundAction(receipt.id);

        expect(result.success).toBe(true);
        expect(mockSubmitGlobalRefund).toHaveBeenCalledWith({
          receiptId: receipt.id,
          buyerAgentId: user.id,
        });

        const [updated] = await db
          .select({ metadata: resources.metadata })
          .from(resources)
          .where(eq(resources.id, receipt.id));
        expect(updated.metadata).toEqual(
          expect.objectContaining({ status: "refund_requested" }),
        );
      }));

    it.each([
      ["disabled", /not enabled yet/i],
      ["not-authorized", /not authorized/i],
      ["not-refundable", /not in a refundable state/i],
    ])("refuses and records nothing when Global returns %s", (status, expected) =>
      withTestTransaction(async (db) => {
        const { receipt } = await seedRefundableReceipt(db);
        mockSubmitGlobalRefund.mockResolvedValue({ status });

        const result = await requestRefundAction(receipt.id);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(expected);

        const [unchanged] = await db
          .select({ metadata: resources.metadata })
          .from(resources)
          .where(eq(resources.id, receipt.id));
        expect(
          (unchanged.metadata as Record<string, unknown>).status,
        ).toBeUndefined();
      }));

    it("leaves the receipt untouched on an ambiguous failure", () =>
      withTestTransaction(async (db) => {
        // Global may or may not have executed. Its idempotency key makes a
        // retry safe, so looking settled would be worse than recording nothing.
        const { receipt } = await seedRefundableReceipt(db);
        mockSubmitGlobalRefund.mockResolvedValue({
          status: "error",
          detail: "network",
        });

        const result = await requestRefundAction(receipt.id);

        expect(result.success).toBe(false);
        const [unchanged] = await db
          .select({ metadata: resources.metadata })
          .from(resources)
          .where(eq(resources.id, receipt.id));
        expect(
          (unchanged.metadata as Record<string, unknown>).status,
        ).toBeUndefined();
      }));
  });
});
