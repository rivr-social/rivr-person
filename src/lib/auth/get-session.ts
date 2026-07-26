// src/lib/auth/get-session.ts
//
// Unified session helper for NextAuth + the federated `rivr_remote_viewer`
// cookie.
//
// Purpose:
// - Give server components and API routes a single call-site for "who is the
//   authenticated actor right now?".
// - Accept **either** the NextAuth JWT session (`auth()`) **or** the signed
//   `rivr_remote_viewer` cookie minted by the cross-instance SSO lander
//   (`/api/federation/sso/land`).
// - Surface the cross-instance visitor's identity, ownership, and effective
//   capability scope so downstream code can make read/write decisions without
//   re-parsing the cookie or re-reading the settings table.
//
// Trust model:
// - NextAuth takes precedence. A valid NextAuth JWT yields a full local
//   session and the cookie is never consulted.
// - The cookie is HMAC-verified AND instance-bound AND expiry-checked on every
//   read via {@link validateRemoteViewerToken}. We never trust a cookie that
//   did not round-trip through the verifier.
// - The instance OWNER (`PRIMARY_AGENT_ID`) who lands via SSO is flagged
//   `isOwner: true` and is NOT constrained by the visitor scope. Every other
//   federated visitor receives the resolved {@link VisitorScope}.
//
// Why this diverges from group/global's `get-session.ts`:
// - Person's remote-viewer cookie carries `expiresAt` (ISO string) and is
//   instance-bound, so verification needs the local instance id and expiry is
//   read from `expiresAt` rather than a unix `exp`.
// - Person adds non-owner visitor mode (owner-configurable scope), so the
//   unified session carries `isOwner` and `visitorScope`.

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";

import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  REMOTE_VIEWER_COOKIE_NAME,
  validateRemoteViewerToken,
  type RemoteViewerSessionPayload,
} from "@/lib/federation-remote-session";
import {
  resolveVisitorScope,
  type VisitorScope,
} from "@/lib/federation/visitor-scope";

/**
 * Authentication source the session was resolved from.
 *
 * - `nextauth` — classic NextAuth JWT session, set by the credentials provider
 *   on this instance (the sovereign owner signing in locally).
 * - `federated` — signed `rivr_remote_viewer` cookie minted by the SSO lander
 *   after verifying an assertion from the global identity authority.
 */
export type SessionAuthMethod = "nextauth" | "federated";

/** Shape returned by {@link getSession}. */
export interface UnifiedSession {
  user: {
    /** Canonical actor/agent id. Always present. */
    id: string;
    /** Email address when known; federated cookies do not carry email. */
    email: string | null;
    /** Display name when known. */
    name: string | null;
    /** Avatar URL when known. */
    image: string | null;
    /** Home base URL for federated viewers; null for local NextAuth users. */
    homeBaseUrl: string | null;
    /** How this session was authenticated. */
    authMethod: SessionAuthMethod;
    /** Whether this actor matches the configured instance owner. */
    isOwner: boolean;
  };
  /** ISO expiry string. NextAuth stamps this; federated is the cookie `expiresAt`. */
  expires: string;
  /**
   * Full remote-viewer payload when {@link UnifiedSession.user.authMethod} is
   * `"federated"`. Provided so advanced callers can inspect `homeBaseUrl`,
   * `persona`, `nonce`, etc. without re-parsing the cookie.
   */
  remoteViewer?: RemoteViewerSessionPayload;
  /**
   * Effective visitor capability scope for a NON-owner federated visitor.
   * Absent for the owner (NextAuth or federated) — owners are unconstrained.
   */
  visitorScope?: VisitorScope;
}

/**
 * Resolve the HMAC secret the remote-viewer cookie was signed with. Mirrors
 * `resolveFederationSecret()` in `federation-remote-session.ts` so a cookie
 * minted by the lander verifies here.
 *
 * @returns The signing secret, or `null` when none is configured.
 */
function resolveSessionSecret(): string | null {
  const authSecret = (process.env.AUTH_SECRET ?? "").trim();
  if (authSecret.length > 0) return authSecret;
  const adminKey = (process.env.NODE_ADMIN_KEY ?? "").trim();
  if (adminKey.length > 0) return adminKey;
  return null;
}

/**
 * Internal: read and verify the federated remote-viewer cookie, if present.
 *
 * Always HMAC-verified, instance-bound, and expiry-checked via
 * {@link validateRemoteViewerToken}. Returns `null` when the cookie is absent,
 * the signature/binding/expiry fails, or no signing secret is configured.
 */
async function readFederatedSession(): Promise<UnifiedSession | null> {
  if (!resolveSessionSecret()) return null;

  const cookieStore = await cookies();
  const raw = cookieStore.get(REMOTE_VIEWER_COOKIE_NAME)?.value;
  if (!raw) return null;

  const { instanceId, primaryAgentId } = getInstanceConfig();
  const payload = validateRemoteViewerToken(raw, instanceId);
  if (!payload) return null;

  const isOwner =
    primaryAgentId !== null && payload.actorId === primaryAgentId;

  // Enrich the federated session from the local projected agent row. The
  // remote-viewer cookie carries only identity claims (actorId, homeBaseUrl,
  // nonce) and no display fields, but the visitor exists locally as a
  // projection/mirror whose name and avatar are synced from their home
  // instance. Best-effort: a missing/partial projection just yields null.
  let name: string | null = null;
  let image: string | null = null;
  let email: string | null = null;
  try {
    const [agent] = await db
      .select({ name: agents.name, image: agents.image, email: agents.email })
      .from(agents)
      .where(eq(agents.id, payload.actorId))
      .limit(1);
    if (agent) {
      name = agent.name ?? null;
      image = agent.image ?? null;
      email = agent.email ?? null;
    }
  } catch {
    /* best-effort: never fail session resolution on a projection lookup */
  }

  // The owner is unconstrained; only non-owner visitors carry a capability
  // scope. Resolving the scope is also best-effort — a missing settings table
  // (pre-migration) degrades to the safe default inside resolveVisitorScope.
  const visitorScope = isOwner ? undefined : await resolveVisitorScope();

  return {
    user: {
      id: payload.actorId,
      email,
      name,
      image,
      homeBaseUrl: payload.homeBaseUrl,
      authMethod: "federated",
      isOwner,
    },
    expires: payload.expiresAt,
    remoteViewer: payload,
    ...(visitorScope ? { visitorScope } : {}),
  };
}

/**
 * Resolve the unified session for this request.
 *
 * Resolution order:
 * 1. NextAuth session via `auth()` — takes precedence (the sovereign owner).
 * 2. Federated `rivr_remote_viewer` cookie (HMAC-verified, instance-bound,
 *    expiry-checked).
 * 3. `null` when neither source yields an authenticated actor.
 *
 * Safe to call from server components, route handlers, and server actions.
 * Not safe from middleware — use
 * {@link ../federation-remote-session-edge.decodeRemoteViewerSessionEdge} and
 * NextAuth's `getToken` directly in that runtime.
 *
 * @returns The unified session, or `null` if unauthenticated.
 */
export async function getSession(): Promise<UnifiedSession | null> {
  const nextAuthSession = await auth();
  if (nextAuthSession?.user?.id) {
    const { primaryAgentId } = getInstanceConfig();
    return {
      user: {
        id: nextAuthSession.user.id,
        email: nextAuthSession.user.email ?? null,
        name: nextAuthSession.user.name ?? null,
        image: nextAuthSession.user.image ?? null,
        homeBaseUrl: null,
        authMethod: "nextauth",
        isOwner:
          primaryAgentId !== null && nextAuthSession.user.id === primaryAgentId,
      },
      expires: nextAuthSession.expires,
    };
  }

  return readFederatedSession();
}
