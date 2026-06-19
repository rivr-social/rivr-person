// src/lib/federation-remote-session-types.ts
//
// Edge-safe constants and types for the `rivr_remote_viewer` cookie.
//
// Why this module exists separately from `federation-remote-session.ts`:
// - `federation-remote-session.ts` imports `node:crypto`, which is NOT
//   available in the Next.js edge runtime where `middleware.ts` runs.
// - The middleware (and the edge decoder) only need the cookie name and the
//   payload shape — never the node signing primitives. Keeping those here
//   lets edge code import them without dragging `node:crypto` into the edge
//   bundle.
//
// The canonical values live here; `federation-remote-session.ts` re-exports
// them so existing node-side importers keep working unchanged.

/** Discriminant stamped into the cookie payload `type` field. */
export const REMOTE_VIEWER_TOKEN_TYPE = "remote_viewer" as const;

/** Name of the federated viewer session cookie. */
export const REMOTE_VIEWER_COOKIE_NAME = "rivr_remote_viewer";

/** Persona context optionally carried by a remote-viewer session. */
export type FederatedAssertionPersonaContext = {
  personaId: string;
  personaDisplayName?: string;
  parentAgentId: string;
};

/** Decoded payload of the `rivr_remote_viewer` cookie. */
export type RemoteViewerSessionPayload = {
  type: typeof REMOTE_VIEWER_TOKEN_TYPE;
  actorId: string;
  homeBaseUrl: string;
  localInstanceId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  persona?: FederatedAssertionPersonaContext;
};
