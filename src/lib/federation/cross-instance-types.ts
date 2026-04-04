// src/lib/federation/cross-instance-types.ts

/**
 * Cross-instance federation types for home authority resolution,
 * remote actor context, and canonical profile references.
 *
 * These types implement the contracts defined in:
 * - docs/federation-arch/31-cross-instance-datapoint-projection-model.md
 * - docs/federation-arch/38-home-authority-global-index-and-cross-instance-interaction-plan.md
 *
 * IMPORTANT: This file is a mirror of the same types in rivr-monorepo.
 * Both repos must stay in sync until a shared package is extracted.
 */

import type { InstanceType } from "./instance-config";

// ─── Home Authority Reference ───────────��──────────────────────────────────

/**
 * Describes the canonical home authority for a federated entity.
 */
export type HomeAuthorityRef = {
  /** Base URL of the home instance (e.g., "https://rivr.camalot.me") */
  homeBaseUrl: string;
  /** Canonical agent ID on the home instance */
  homeAgentId: string;
  /** Instance type of the home authority */
  homeInstanceType: InstanceType;
  /** Agent ID on the global index (if indexed there) */
  globalIndexAgentId?: string;
  /** UM manifest endpoint on the home instance */
  manifestUrl?: string;
  /** Direct link to the canonical profile page */
  canonicalProfileUrl?: string;
};

// ─── Federated Actor Context ──────────��────────────────────────────────────

/**
 * Portable authenticated actor context for cross-instance interactions.
 */
export type FederatedActorContext = {
  /** Actor's canonical agent ID */
  actorId: string;
  /** Base URL of the actor's home instance */
  homeBaseUrl: string;
  /** UM manifest URL for the actor (optional) */
  manifestUrl?: string;
  /** How the assertion was produced */
  assertionType: "session" | "token" | "signed";
  /** The assertion payload (JWT, signed token, or session reference) */
  assertion: string;
  /** ISO 8601 timestamp when the assertion was issued */
  issuedAt: string;
  /** ISO 8601 timestamp when the assertion expires */
  expiresAt: string;
  /** Anti-replay nonce */
  nonce?: string;
};

// ─── Canonical Profile Reference ────────────���──────────────────────────────

/**
 * Lightweight profile reference for rendering profile cards,
 * search results, member lists, and activity attribution.
 */
export type CanonicalProfileRef = {
  /** Agent ID on the local instance */
  agentId: string;
  /** Display name */
  displayName: string;
  /** Username slug (if known) */
  username?: string;
  /** Avatar URL */
  avatarUrl?: string;
  /** Home authority reference */
  homeAuthority: HomeAuthorityRef;
  /** True if this instance is the home authority for this agent */
  isLocallyHomed: boolean;
  /** The canonical profile URL */
  canonicalUrl: string;
  /** URL on the global index for discovery (if indexed) */
  globalIndexUrl?: string;
};

// ─── Projected Datapoint ──────────���────────────────────────────────────────

export type ProjectionPointer = {
  rel: string;
  href: string;
  mediaType?: string;
  authority?: "rivr" | "solid" | "external";
};

export type ManifestRef = {
  id?: string | null;
  url?: string | null;
};

export type ProjectedDatapoint = {
  id: string;
  subjectId: string;
  subjectType: "agent" | "resource" | "relationship" | "document_shard";
  projectionKind: "summary" | "detail" | "shard" | "pointer" | "claim";
  authorityNodeId: string;
  authorityBaseUrl: string;
  visibility: "public" | "locale" | "connections" | "self" | "granted";
  publicationSurfaces: string[];
  validFrom?: string | null;
  validUntil?: string | null;
  permissionsBasis: {
    ownership?: boolean;
    directGrant?: boolean;
    relationship?: string[];
    attributePolicies?: string[];
  };
  payload: Record<string, unknown>;
  pointers?: ProjectionPointer[];
  manifest?: ManifestRef;
};

// ─── Federation Facade Response ──────────────���─────────────────────────────

export type UniversalManifestProjection = {
  "@context": string | string[];
  "@id"?: string;
  "@type": string | string[];
  manifestVersion: string;
  subject: Record<string, unknown>;
  claims?: Array<Record<string, unknown>>;
  consents?: Array<Record<string, unknown>>;
  shards?: Array<Record<string, unknown>>;
  pointers?: Array<Record<string, unknown>>;
  validFrom?: string;
  validUntil?: string;
};

export type FederationFacadeResponse = {
  subjectId: string;
  authority: {
    nodeId: string;
    baseUrl: string;
    instanceType: InstanceType;
  };
  projections: ProjectedDatapoint[];
  portableManifestSubset?: UniversalManifestProjection;
  cache: {
    ttlSeconds?: number;
    etag?: string;
  };
};

// ─── Remote Interaction Types ───────────���─────────────────────────��────────

export type RemoteViewerState = "anonymous" | "locally_authenticated" | "remotely_authenticated";

export type RemoteAuthResult = {
  success: boolean;
  viewerState: RemoteViewerState;
  sessionToken?: string;
  actorId?: string;
  homeBaseUrl?: string;
  displayName?: string;
  error?: string;
  errorCode?: string;
};

export type FederatedInteractionAction =
  | "connect"
  | "follow"
  | "react"
  | "rsvp"
  | "thanks"
  | "message_thread_start"
  | "membership_request"
  | "kg_push_doc"
  | "kg_query";

export type FederatedInteractionRequest = {
  action: FederatedInteractionAction;
  actor: FederatedActorContext;
  targetAgentId: string;
  targetInstanceNodeId: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
};

export type FederatedInteractionResult = {
  success: boolean;
  action: FederatedInteractionAction;
  data?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  federationEventEmitted?: boolean;
};
