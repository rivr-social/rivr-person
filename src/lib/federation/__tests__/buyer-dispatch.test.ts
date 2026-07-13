import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Focused tests for the person owner-routed BUYER-ACTION dispatch (buyer rail
 * P0 §4.5): createBookingAction / bookAssetAction / applyToJob /
 * purchaseWithWalletAction.
 *
 * Proves for each handler:
 *  - happy path: a peer-forwarded, actor-bound mutation dispatches the matching
 *    local action with the coerced payload, UNDER the bound local actor's
 *    federation execution context, and returns 200 + the action result.
 *  - unbound-actor reject: when actor binding fails and no valid assertion is
 *    present, the request is rejected 403 and NO action runs (strict-rejection
 *    semantics preserved).
 *
 * Every dependency is mocked — no DB, no real auth. The four action modules are
 * spied so we can assert call args + that they never run on the reject path.
 */

const mocks = vi.hoisted(() => ({
  authorizeFederationRequest: vi.fn(),
  bindAuthorizedFederationActor: vi.fn(),
  resolveLocalActorId: vi.fn(),
  resolveHomeInstance: vi.fn(),
  createBookingAction: vi.fn(),
  bookAssetAction: vi.fn(),
  applyToJob: vi.fn(),
  purchaseWithWalletAction: vi.fn(),
  validateRemoteViewerToken: vi.fn(),
}));

vi.mock("@/lib/federation/instance-config", () => ({
  getInstanceConfig: () => ({
    instanceId: "bob-node",
    instanceSlug: "bob",
    baseUrl: "https://bob.rivr.social",
    primaryAgentId: "bob-owner",
  }),
}));
vi.mock("@/lib/federation-auth", () => ({
  authorizeFederationRequest: mocks.authorizeFederationRequest,
  bindAuthorizedFederationActor: mocks.bindAuthorizedFederationActor,
  resolveLocalActorId: mocks.resolveLocalActorId,
}));
vi.mock("@/lib/federation/resolution", () => ({
  resolveHomeInstance: mocks.resolveHomeInstance,
}));
vi.mock("@/lib/federation/execution-context", () => ({
  runWithFederationExecutionContext: (_actorId: string, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/federation/domain-events", () => ({
  emitDomainEvent: vi.fn(),
  EVENT_TYPES: {},
}));
vi.mock("@/lib/federation-remote-session", () => ({
  REMOTE_VIEWER_COOKIE_NAME: "rivr_remote_viewer",
  validateRemoteViewerToken: mocks.validateRemoteViewerToken,
  validateFederatedAssertion: vi.fn(),
}));
vi.mock("@/lib/federation/visitor-scope", () => ({
  requiredVisitorCapability: vi.fn(() => null),
  resolveVisitorScope: vi.fn(),
  visitorCan: vi.fn(() => false),
}));
vi.mock("@/lib/persona", () => ({ isPersonaOf: vi.fn(async () => false) }));
vi.mock("@/lib/kg/autobot-kg-client", () => ({}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ agents: {}, ledger: {} }));
vi.mock("@/app/actions/interactions/social", () => ({ toggleFollowAgent: vi.fn() }));
vi.mock("@/app/actions/resource-creation/events", () => ({ createEventResource: vi.fn() }));
vi.mock("@/app/actions/resource-creation/lifecycle", () => ({
  deleteResource: vi.fn(),
  updateResource: vi.fn(),
}));
vi.mock("@/app/actions/resource-creation/offerings", () => ({ createOfferingResource: vi.fn() }));
vi.mock("@/app/actions/interactions/bookings", () => ({ createBookingAction: mocks.createBookingAction }));
vi.mock("@/app/actions/interactions/assets", () => ({ bookAssetAction: mocks.bookAssetAction }));
vi.mock("@/app/actions/interactions/events-jobs", () => ({ applyToJob: mocks.applyToJob }));
vi.mock("@/app/actions/wallet/purchases", () => ({ purchaseWithWalletAction: mocks.purchaseWithWalletAction }));

import { POST } from "@/app/api/federation/mutations/route";

const ACTOR_EXTERNAL = "22222222-2222-2222-2222-222222222222";
const ACTOR_LOCAL = ACTOR_EXTERNAL; // projection keys the local row on the external UUID
const TARGET = "bob-owner";

function forwardRequest(body: Record<string, unknown>): Request {
  return new Request("https://bob.rivr.social/api/federation/mutations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-peer-slug": "dev",
      "x-peer-secret": "s",
      "X-Instance-Id": "dev-node",
      "X-Instance-Slug": "dev",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Peer-authenticated forward, actor successfully bound to the local id, target
  // homed locally. Individual tests override for the reject path.
  mocks.validateRemoteViewerToken.mockReturnValue(null);
  mocks.authorizeFederationRequest.mockResolvedValue({ authorized: true, peerNodeId: "dev-node" });
  mocks.bindAuthorizedFederationActor.mockResolvedValue({ authorized: true, actorId: ACTOR_LOCAL });
  mocks.resolveLocalActorId.mockImplementation(async (_peer: string, id: string) => id);
  mocks.resolveHomeInstance.mockResolvedValue({ isLocal: true, slug: "bob", nodeId: "bob-node" });
});

describe("owner-routed buyer-action dispatch — happy path", () => {
  it("dispatches createBookingAction with the coerced payload and returns 200", async () => {
    mocks.createBookingAction.mockResolvedValue({ success: true, message: "Booked" });
    const payload = { offeringId: "off-1", slotDate: "2026-08-01", slotTime: "10:00" };
    const res = await POST(forwardRequest({ type: "createBookingAction", actorId: ACTOR_EXTERNAL, targetAgentId: TARGET, payload }));

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual({ success: true, message: "Booked" });
    expect(mocks.createBookingAction).toHaveBeenCalledWith(payload);
  });

  it("dispatches bookAssetAction with the coerced payload and returns 200", async () => {
    mocks.bookAssetAction.mockResolvedValue({ success: true, message: "Reserved" });
    const payload = { assetId: "asset-1", startDate: "2026-08-01", endDate: "2026-08-02", purpose: "camp" };
    const res = await POST(forwardRequest({ type: "bookAssetAction", actorId: ACTOR_EXTERNAL, targetAgentId: TARGET, payload }));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mocks.bookAssetAction).toHaveBeenCalledWith(payload);
  });

  it("dispatches applyToJob with the extracted jobId and returns 200", async () => {
    mocks.applyToJob.mockResolvedValue({ success: true, message: "Applied" });
    const res = await POST(forwardRequest({ type: "applyToJob", actorId: ACTOR_EXTERNAL, targetAgentId: TARGET, payload: { jobId: "job-1" } }));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mocks.applyToJob).toHaveBeenCalledWith("job-1");
  });

  it("dispatches purchaseWithWalletAction with the extracted args and returns 200", async () => {
    mocks.purchaseWithWalletAction.mockResolvedValue({ success: true, receiptId: "rec-1" });
    const res = await POST(
      forwardRequest({
        type: "purchaseWithWalletAction",
        actorId: ACTOR_EXTERNAL,
        targetAgentId: TARGET,
        payload: { listingId: "list-1", subtotalCents: 2500, dealPostId: "deal-1" },
      }),
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.receiptId).toBe("rec-1");
    expect(mocks.purchaseWithWalletAction).toHaveBeenCalledWith("list-1", 2500, "deal-1", null, null);
  });

  it("surfaces a business failure as a non-2xx with the action's message", async () => {
    mocks.createBookingAction.mockResolvedValue({ success: false, message: "This time slot is no longer available." });
    const res = await POST(
      forwardRequest({
        type: "createBookingAction",
        actorId: ACTOR_EXTERNAL,
        targetAgentId: TARGET,
        payload: { offeringId: "off-1", slotDate: "2026-08-01", slotTime: "10:00" },
      }),
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("This time slot is no longer available.");
  });
});

describe("owner-routed buyer-action dispatch — unbound-actor reject", () => {
  it("rejects (403) and never dispatches when the actor is unbound and no assertion is present", async () => {
    mocks.bindAuthorizedFederationActor.mockResolvedValue({
      authorized: false,
      reason: "Peer is not authorized to act for this agent. No federation_entity_map row binds the peer to the requested actor.",
    });
    const res = await POST(
      forwardRequest({
        type: "createBookingAction",
        actorId: ACTOR_EXTERNAL,
        targetAgentId: TARGET,
        payload: { offeringId: "off-1", slotDate: "2026-08-01", slotTime: "10:00" },
      }),
    );

    expect(res.status).toBe(403);
    expect((await res.json()).success).toBe(false);
    expect(mocks.createBookingAction).not.toHaveBeenCalled();
  });

  it("rejects applyToJob for an unbound actor without dispatching", async () => {
    mocks.bindAuthorizedFederationActor.mockResolvedValue({ authorized: false, reason: "unbound" });
    const res = await POST(
      forwardRequest({ type: "applyToJob", actorId: ACTOR_EXTERNAL, targetAgentId: TARGET, payload: { jobId: "job-1" } }),
    );

    expect(res.status).toBe(403);
    expect(mocks.applyToJob).not.toHaveBeenCalled();
  });
});
