/**
 * Cross-runtime parity tests for the `rivr_remote_viewer` cookie.
 *
 * The cookie is MINTED node-side (`createRemoteViewerToken`, HMAC via
 * `node:crypto`) but VERIFIED in the edge middleware
 * (`decodeRemoteViewerSessionEdge`, HMAC via Web Crypto `subtle`). These two
 * implementations MUST agree byte-for-byte, otherwise every federated visitor
 * would be silently bounced to /auth/login. These tests sign with the node
 * encoder and verify with the edge decoder (and vice-versa for rejection),
 * pinning that contract.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRemoteViewerToken,
  REMOTE_VIEWER_TTL_MS,
} from "@/lib/federation-remote-session";
import {
  decodeRemoteViewerSessionEdge,
  resolveFederationSecretEdge,
} from "@/lib/federation-remote-session-edge";

const ORIGINAL_ENV = { ...process.env };
const INSTANCE_ID = "66666666-6666-4666-8666-666666666666";
const SECRET = "test-auth-secret-parity-0123456789";

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.AUTH_SECRET;
  delete process.env.NODE_ADMIN_KEY;
  process.env.AUTH_SECRET = SECRET;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolveFederationSecretEdge", () => {
  it("prefers AUTH_SECRET over NODE_ADMIN_KEY", () => {
    process.env.NODE_ADMIN_KEY = "admin-key";
    expect(resolveFederationSecretEdge()).toBe(SECRET);
  });

  it("falls back to NODE_ADMIN_KEY when AUTH_SECRET is empty", () => {
    delete process.env.AUTH_SECRET;
    process.env.NODE_ADMIN_KEY = "admin-key";
    expect(resolveFederationSecretEdge()).toBe("admin-key");
  });

  it("returns null when neither is set", () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NODE_ADMIN_KEY;
    expect(resolveFederationSecretEdge()).toBeNull();
  });
});

describe("node→edge remote-viewer cookie parity", () => {
  it("a node-minted token verifies with the edge decoder", async () => {
    const token = createRemoteViewerToken({
      actorId: "11111111-1111-4111-8111-111111111111",
      homeBaseUrl: "https://home.example.com",
      localInstanceId: INSTANCE_ID,
    });

    const payload = await decodeRemoteViewerSessionEdge(
      token,
      SECRET,
      INSTANCE_ID,
    );

    expect(payload).not.toBeNull();
    expect(payload?.type).toBe("remote_viewer");
    expect(payload?.actorId).toBe("11111111-1111-4111-8111-111111111111");
    expect(payload?.homeBaseUrl).toBe("https://home.example.com");
    expect(payload?.localInstanceId).toBe(INSTANCE_ID);
  });

  it("carries an optional persona context through the round-trip", async () => {
    const token = createRemoteViewerToken({
      actorId: "11111111-1111-4111-8111-111111111111",
      homeBaseUrl: "https://home.example.com",
      localInstanceId: INSTANCE_ID,
      persona: {
        personaId: "persona-1",
        personaDisplayName: "Scout",
        parentAgentId: "11111111-1111-4111-8111-111111111111",
      },
    });

    const payload = await decodeRemoteViewerSessionEdge(
      token,
      SECRET,
      INSTANCE_ID,
    );
    expect(payload?.persona?.personaId).toBe("persona-1");
    expect(payload?.persona?.personaDisplayName).toBe("Scout");
  });

  it("rejects a token bound to a different instance id", async () => {
    const token = createRemoteViewerToken({
      actorId: "11111111-1111-4111-8111-111111111111",
      homeBaseUrl: "https://home.example.com",
      localInstanceId: INSTANCE_ID,
    });

    const payload = await decodeRemoteViewerSessionEdge(
      token,
      SECRET,
      "99999999-9999-4999-8999-999999999999",
    );
    expect(payload).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = createRemoteViewerToken({
      actorId: "11111111-1111-4111-8111-111111111111",
      homeBaseUrl: "https://home.example.com",
      localInstanceId: INSTANCE_ID,
    });

    const payload = await decodeRemoteViewerSessionEdge(
      token,
      "a-different-secret-value",
      INSTANCE_ID,
    );
    expect(payload).toBeNull();
  });

  it("rejects an expired token", async () => {
    const token = createRemoteViewerToken({
      actorId: "11111111-1111-4111-8111-111111111111",
      homeBaseUrl: "https://home.example.com",
      localInstanceId: INSTANCE_ID,
      ttlMs: 1000,
    });

    // Verify "now" is 10 minutes past issuance → expired.
    const payload = await decodeRemoteViewerSessionEdge(
      token,
      SECRET,
      INSTANCE_ID,
      Date.now() + 10 * 60 * 1000,
    );
    expect(payload).toBeNull();
  });

  it("accepts a token within its TTL window using the fixed clock", async () => {
    const issuedAround = Date.now();
    const token = createRemoteViewerToken({
      actorId: "11111111-1111-4111-8111-111111111111",
      homeBaseUrl: "https://home.example.com",
      localInstanceId: INSTANCE_ID,
      ttlMs: REMOTE_VIEWER_TTL_MS,
    });

    const payload = await decodeRemoteViewerSessionEdge(
      token,
      SECRET,
      INSTANCE_ID,
      issuedAround + 60 * 1000,
    );
    expect(payload).not.toBeNull();
  });

  it("rejects a tampered payload (signature mismatch)", async () => {
    const token = createRemoteViewerToken({
      actorId: "11111111-1111-4111-8111-111111111111",
      homeBaseUrl: "https://home.example.com",
      localInstanceId: INSTANCE_ID,
    });
    const [, sig] = token.split(".");
    // Swap the payload for one claiming a different actor, keep the old sig.
    const forgedPayload = Buffer.from(
      JSON.stringify({
        type: "remote_viewer",
        actorId: "deadbeef-dead-4bee-8bee-deadbeefdead",
        homeBaseUrl: "https://home.example.com",
        localInstanceId: INSTANCE_ID,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        nonce: "x",
      }),
      "utf8",
    ).toString("base64url");

    const forged = `${forgedPayload}.${sig}`;
    const payload = await decodeRemoteViewerSessionEdge(
      forged,
      SECRET,
      INSTANCE_ID,
    );
    expect(payload).toBeNull();
  });

  it("rejects malformed cookie shapes", async () => {
    expect(
      await decodeRemoteViewerSessionEdge(undefined, SECRET, INSTANCE_ID),
    ).toBeNull();
    expect(
      await decodeRemoteViewerSessionEdge("", SECRET, INSTANCE_ID),
    ).toBeNull();
    expect(
      await decodeRemoteViewerSessionEdge("no-dot", SECRET, INSTANCE_ID),
    ).toBeNull();
    expect(
      await decodeRemoteViewerSessionEdge("a.b.c", SECRET, INSTANCE_ID),
    ).toBeNull();
  });
});
