// src/lib/federation/owner-routed-actor.ts

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { nodes } from "@/db/schema";
import { materializeFederatedActor } from "@/lib/federation";
import {
  burnSsoNonce,
  type BurnSsoNonceResult,
} from "@/lib/federation/sso-nonce-store";
import { verifyOwnerRoutedActorAssertion } from "@/lib/federation/owner-routed-actor-assertion";

/**
 * Receiver-side orchestration for the owner-routed home-signed actor assertion
 * (buyer rail, open-issues P0). PERSON is a receiver in this pass: it verifies a
 * presented assertion against the authenticated peer's REGISTERED Ed25519 key
 * (`nodes.publicKey`), burns its nonce (single-use), then materializes + binds
 * the actor via the existing projection rail (`materializeFederatedActor`),
 * returning the receiver-local agent id.
 *
 * Nothing here grants AUTHORITY — only identity. The subsequent
 * `bindAuthorizedFederationActor` re-derives the binding and the write runs
 * against this instance's own graph.
 *
 * (The sovereign SENDER minter — `mintOwnerRoutedActorAssertion` — is added when
 * a sovereign wires its own `write-router.ts` forwarder in the parity wave; it
 * is not needed on the receiver path and is omitted here to keep only active
 * code. `signOwnerRoutedActorAssertion` lives in the pure assertion module and
 * is exercised by the round-trip tests.)
 *
 * `resolveOwnerRoutedActor` accepts injected dependencies so the whole flow is
 * unit-testable without a database (mirrors `verifySsoAssertion`'s injected key
 * lookup).
 */

/** Namespaces owner-routed actor-assertion nonces so they never collide with SSO nonces. */
function nonceIssuer(homeBaseUrl: string): string {
  return `${homeBaseUrl.replace(/\/+$/, "")}#owner-routed-actor`;
}

/** Stable reason strings for a rejected owner-routed actor resolution. */
export type ResolveOwnerRoutedActorFailure =
  | "peer-no-public-key"
  | "actor-mismatch"
  | "replayed"
  | `assertion-${string}`;

export type ResolveOwnerRoutedActorResult =
  | { ok: true; localActorId: string }
  | { ok: false; reason: ResolveOwnerRoutedActorFailure };

/** Injectable dependencies for {@link resolveOwnerRoutedActor} (tests stub these). */
export interface ResolveOwnerRoutedActorDeps {
  loadPeer?: (
    peerNodeId: string,
  ) => Promise<{ publicKey: string | null; slug: string } | null>;
  burnNonce?: (input: {
    issuer: string;
    nonce: string;
    expUnixSec: number;
    actorId?: string | null;
  }) => Promise<BurnSsoNonceResult>;
  materialize?: (params: {
    peerNode: { id: string; slug: string };
    externalActorId: string;
    identity?: { name?: string | null; avatarUrl?: string | null; parentAgentId?: string | null };
  }) => Promise<string>;
  now?: number;
}

export interface ResolveOwnerRoutedActorParams {
  /** The authenticated sending peer's node id (from peer-secret auth). */
  peerNodeId: string;
  /** This receiver's base URL (audience binding). */
  audienceBaseUrl: string;
  /** The `actorId` from the mutation body — the assertion must vouch for it. */
  requestedActorId: string;
  /** The `actorAssertion` object from the mutation body. */
  assertion: unknown;
}

async function defaultLoadPeer(
  peerNodeId: string,
): Promise<{ publicKey: string | null; slug: string } | null> {
  const peer = await db.query.nodes
    .findFirst({
      where: eq(nodes.id, peerNodeId),
      columns: { publicKey: true, slug: true },
    })
    .catch(() => null);
  return peer ? { publicKey: peer.publicKey ?? null, slug: peer.slug } : null;
}

/**
 * Verify a presented owner-routed actor assertion and, on success, materialize +
 * bind the actor, returning the receiver-local agent id. Fails closed with a
 * stable reason on every rejection path.
 */
export async function resolveOwnerRoutedActor(
  params: ResolveOwnerRoutedActorParams,
  deps: ResolveOwnerRoutedActorDeps = {},
): Promise<ResolveOwnerRoutedActorResult> {
  const loadPeer = deps.loadPeer ?? defaultLoadPeer;
  const burnNonce = deps.burnNonce ?? burnSsoNonce;
  const materialize = deps.materialize ?? materializeFederatedActor;

  const peer = await loadPeer(params.peerNodeId);
  if (!peer || !peer.publicKey) {
    return { ok: false, reason: "peer-no-public-key" };
  }

  const verified = verifyOwnerRoutedActorAssertion({
    assertion: params.assertion,
    expectedAudienceBaseUrl: params.audienceBaseUrl,
    expectedHomeNodeId: params.peerNodeId,
    peerPublicKey: peer.publicKey,
    now: deps.now,
  });
  if (!verified.ok) {
    return { ok: false, reason: `assertion-${verified.reason}` };
  }

  const { claims } = verified;

  // The assertion must vouch for exactly the actor named in the mutation body.
  if (claims.actorId !== params.requestedActorId) {
    return { ok: false, reason: "actor-mismatch" };
  }

  // Single-use: burn AFTER a valid signature (so an attacker cannot pollute the
  // nonce table) and BEFORE materialization.
  const burned = await burnNonce({
    issuer: nonceIssuer(claims.homeBaseUrl),
    nonce: claims.nonce,
    expUnixSec: claims.exp,
    actorId: claims.actorId,
  });
  if (!burned.ok) {
    return { ok: false, reason: "replayed" };
  }

  const localActorId = await materialize({
    peerNode: { id: params.peerNodeId, slug: peer.slug },
    externalActorId: claims.actorId,
    identity: {
      name: claims.name ?? null,
      avatarUrl: claims.avatarUrl ?? null,
      parentAgentId: claims.parentAgentId ?? null,
    },
  });

  return { ok: true, localActorId };
}
