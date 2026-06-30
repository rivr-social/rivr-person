import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for bindAuthorizedFederationActor() — the verified-principal actor
 * binding for the federation mutation rail.
 *
 * Security regression target (F1): the prior implementation had a
 * `if (authorization.peerTrusted) return { actorId: requestedActorId }`
 * shortcut that accepted ANY body-provided actorId on the shared peer secret.
 * Any holder of the peer secret or fleet admin key could write AS any actor.
 *
 * The strict model requires a pre-existing federation_entity_map row binding
 * the authenticated peer node to the requested actor before the actorId is
 * accepted; otherwise the request is rejected.
 *
 * All database interactions are mocked.
 */

const mockFindFirst = vi.fn();

vi.mock("@/db", () => ({
  db: {
    query: {
      federationEntityMap: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
  },
}));

// federation-auth.ts also imports these; stub to keep the module loadable.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/env", () => ({ getEnv: vi.fn() }));
vi.mock("@/lib/federation/instance-config", () => ({ getInstanceConfig: vi.fn() }));
vi.mock("@/lib/federation-remote-session", () => ({ verifyPackedPayload: vi.fn() }));
vi.mock("@/db/schema", () => ({
  federationEntityMap: {
    originNodeId: "origin_node_id",
    externalEntityId: "external_entity_id",
    entityType: "entity_type",
    localEntityId: "local_entity_id",
  },
  nodePeers: {},
  nodes: {},
}));

import { bindAuthorizedFederationActor } from "@/lib/federation-auth";

const PEER_NODE_ID = "44444444-4444-4444-4444-444444444444";
const CAMERON_ON_CAMALOT = "aa29fa2d-4c2a-4eaf-a069-b2203a2ce667";
const CAMERON_ON_REGENHUB = "ea079076-e7d0-489e-9cb2-1e6275d0d1cf";

describe("bindAuthorizedFederationActor", () => {
  beforeEach(() => {
    mockFindFirst.mockReset();
  });

  it("rejects an unauthorized authorization result", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: false, reason: "Unknown peer node" },
      CAMERON_ON_CAMALOT,
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("Unknown peer node");
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("requires a requestedActorId", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: true, peerNodeId: PEER_NODE_ID },
      undefined,
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("actorId is required");
  });

  // ── Path 1: session / scoped-token / remote-viewer ──────────────────────

  it("accepts a session-bound actor that matches the requested actorId", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: true, actorId: CAMERON_ON_CAMALOT },
      CAMERON_ON_CAMALOT,
    );
    expect(result).toEqual({ authorized: true, actorId: CAMERON_ON_CAMALOT });
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("rejects a session-bound actor that does not match the requested actorId", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: true, actorId: CAMERON_ON_CAMALOT },
      CAMERON_ON_REGENHUB,
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe("Authenticated actor does not match requested actorId.");
  });

  // ── Path 2: peer-secret (server-to-server) — F1 ─────────────────────────

  it("F1: rejects an arbitrary body actorId on the peer secret when no binding exists", async () => {
    // (2a) local-id lookup miss + (2b) external-id lookup miss → reject.
    mockFindFirst.mockResolvedValueOnce(null); // 2a localEntityId lookup
    mockFindFirst.mockResolvedValueOnce(null); // 2b externalEntityId lookup (resolveLocalActorId)

    const result = await bindAuthorizedFederationActor(
      { authorized: true, peerNodeId: PEER_NODE_ID },
      CAMERON_ON_CAMALOT,
    );

    expect(result.authorized).toBe(false);
    expect(result.reason).toContain("No federation_entity_map row binds the peer to the requested actor");
  });

  it("accepts a peer actor already keyed by this instance's local id (2a)", async () => {
    mockFindFirst.mockResolvedValueOnce({ id: "map-row-1" }); // 2a hit

    const result = await bindAuthorizedFederationActor(
      { authorized: true, peerNodeId: PEER_NODE_ID },
      CAMERON_ON_REGENHUB,
    );

    expect(result).toEqual({ authorized: true, actorId: CAMERON_ON_REGENHUB });
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
  });

  it("normalizes a forwarder-local actor id to the receiver-local id (2b)", async () => {
    mockFindFirst.mockResolvedValueOnce(null); // 2a miss
    mockFindFirst.mockResolvedValueOnce({ localEntityId: CAMERON_ON_REGENHUB }); // 2b hit

    const result = await bindAuthorizedFederationActor(
      { authorized: true, peerNodeId: PEER_NODE_ID },
      CAMERON_ON_CAMALOT,
    );

    expect(result).toEqual({ authorized: true, actorId: CAMERON_ON_REGENHUB });
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
  });

  // ── Path 3: admin key without peer or session ───────────────────────────

  it("refuses to bind an arbitrary actor for an admin-key-only authorization", async () => {
    const result = await bindAuthorizedFederationActor(
      { authorized: true },
      CAMERON_ON_CAMALOT,
    );
    expect(result.authorized).toBe(false);
    expect(result.reason).toBe(
      "Federation mutations require an actor-bound session or remote viewer token.",
    );
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});
