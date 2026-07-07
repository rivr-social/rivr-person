/**
 * Federation SSO landing consumer: the sovereign side of the global→home
 * pre-authenticated handoff (no-mirror UM v0.4 work, issue
 * rivr-social/rivr-app#102).
 *
 * Flow:
 * - Global's `/api/federation/sso/session-handoff` mints a short-lived,
 *   audience-bound Ed25519 assertion for the CURRENT global session user
 *   and 302-redirects the browser here with
 *   `?assertion=<base64url-json>&next=<relative-path>`.
 * - This route verifies the assertion LOCALLY against global's public key
 *   (resolved from the `nodes` peer row) — no HMAC secret, no callback to
 *   the issuer. On success it mints a `rivr_remote_viewer` session cookie
 *   (the same cookie the older `/api/federation/remote-auth` path sets, so
 *   the existing viewer machinery honors it) and redirects to `next`.
 *
 * Security:
 * - The assertion is audience-bound to this instance's origin, so a token
 *   minted for another peer cannot be replayed here.
 * - Issuer is allow-listed to the configured global identity authority, so
 *   only global's signature is accepted even if another `nodes` row exists.
 * - The instance owner (`PRIMARY_AGENT_ID`) lands a full, unconstrained
 *   session. Any other verified actor is auto-signed-in as a *visitor* with a
 *   read-only-by-default capability scope the owner controls in
 *   /settings/visitor-access; when visitor sign-in is disabled there, a
 *   non-owner handoff falls through unauthenticated instead of authenticating.
 * - The landing (referral path, home, issuer, user-agent, granted scope) is
 *   recorded to `federated_visit_log` when the owner has visit recording on.
 * - Verification failure never strands the user on a JSON error when a safe
 *   local destination exists: it falls through to `next` unauthenticated so
 *   they can log in normally.
 */

import { NextResponse } from "next/server";

import { getInstanceConfig, getGlobalIdentityAuthorityUrl } from "@/lib/federation/instance-config";
import { resolveRequestOrigin } from "@/lib/request-origin";
import {
  createRemoteViewerToken,
  REMOTE_VIEWER_COOKIE_NAME,
  REMOTE_VIEWER_TTL_MS,
} from "@/lib/federation-remote-session";
import { verifySsoAssertion } from "@/lib/federation/sso-assertion";
import { burnSsoNonce } from "@/lib/federation/sso-nonce-store";
import {
  resolveVisitorScope,
  VISITOR_CAPABILITIES,
  type VisitorCapability,
} from "@/lib/federation/visitor-scope";
import { recordFederatedVisit } from "@/lib/federation/visit-log";

/** Milliseconds per minute, for converting the settings TTL to the cookie/token. */
const MS_PER_MINUTE = 60 * 1000;

/** Default post-landing destination when no (valid) `next` is supplied. */
const DEFAULT_NEXT = "/";

/** Constrain `next` to a safe same-document relative path. */
function sanitizeNext(raw: string | null): string {
  if (!raw) return DEFAULT_NEXT;
  if (!raw.startsWith("/")) return DEFAULT_NEXT;
  if (raw.startsWith("//")) return DEFAULT_NEXT;
  if (raw.includes("\\")) return DEFAULT_NEXT;
  return raw;
}

/** Decode a base64url-encoded JSON assertion param. Returns null on failure. */
function decodeAssertionParam(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Set the remote-viewer session cookie on a redirect response. */
function attachRemoteViewerCookie(
  response: NextResponse,
  requestUrl: URL,
  token: string,
  ttlMs: number,
): void {
  response.cookies.set(REMOTE_VIEWER_COOKIE_NAME, token, {
    httpOnly: true,
    secure: requestUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(ttlMs / 1000),
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestUrl = new URL(request.url);
  const config = getInstanceConfig();
  const localOrigin = resolveRequestOrigin(request, config.baseUrl);
  const next = sanitizeNext(requestUrl.searchParams.get("next"));

  const assertion = decodeAssertionParam(requestUrl.searchParams.get("assertion"));
  if (assertion === null) {
    // No / unparseable assertion: send them to the local destination so they
    // can authenticate normally rather than hitting an error page.
    return NextResponse.redirect(new URL(next, localOrigin), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const result = await verifySsoAssertion({
    assertion,
    expectedTargetBaseUrl: localOrigin,
    expectedGlobalIssuerBaseUrl: getGlobalIdentityAuthorityUrl() ?? undefined,
  });

  if (!result.ok) {
    // A bad/expired/forged assertion must not authenticate, but also must
    // not strand the user. Fall through to the local destination.
    // Observability: the verify reason was previously swallowed, making the
    // fleet-wide "Actor assertion verification failed" undiagnosable
    // (2026-07-07). Reason values are enum strings — no claim contents leak.
    console.warn(
      `[sso/land] assertion rejected: reason=${result.reason} issuer-expected=${getGlobalIdentityAuthorityUrl() ?? "unset"} target=${localOrigin}`,
    );
    return NextResponse.redirect(new URL(next, localOrigin), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { claims } = result;

  // AUTH-SEC-002 / F3 — single-use: atomically burn the assertion nonce before
  // minting a session. The assertion travels as a URL query param here, so a
  // captured /sso/land link (history, referer, logs) is especially replayable;
  // the first land wins and any re-presentation falls through unauthenticated.
  let burn: Awaited<ReturnType<typeof burnSsoNonce>>;
  try {
    burn = await burnSsoNonce({
      issuer: claims.globalIssuerBaseUrl,
      nonce: claims.nonce,
      expUnixSec: claims.exp,
      actorId: claims.actorId,
    });
  } catch (error) {
    console.error("[federation/sso/land] nonce burn threw:", error);
    return NextResponse.redirect(new URL(next, localOrigin), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!burn.ok) {
    console.warn(
      `[federation/sso/land] rejected replayed assertion nonce: reason=${burn.reason}`,
    );
    return NextResponse.redirect(new URL(next, localOrigin), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Owner vs. visitor. The instance owner (`PRIMARY_AGENT_ID`) always lands a
  // full, unconstrained session. Any OTHER verified actor is a federated
  // *visitor*: they are auto-signed-in with a read-only-by-default scope that
  // the owner can widen (or disable) in /settings/visitor-access.
  const isOwner =
    !!config.primaryAgentId && claims.actorId === config.primaryAgentId;

  const scope = await resolveVisitorScope();

  // When visitor auto-sign-in is turned off, a non-owner handoff must not
  // authenticate — but it also must not strand the visitor. Fall through to
  // the local destination unauthenticated so they can sign in normally.
  if (!isOwner && !scope.enabled) {
    return NextResponse.redirect(new URL(next, localOrigin), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // Cookie/token lifetime: owners get the standard remote-viewer TTL; visitors
  // get the owner-configured session length.
  const ttlMs = isOwner ? REMOTE_VIEWER_TTL_MS : scope.ttlMinutes * MS_PER_MINUTE;

  // Capabilities recorded for the visit: owners are unconstrained (record the
  // full capability set), visitors get their resolved scope.
  const grantedScope: VisitorCapability[] = isOwner
    ? [...VISITOR_CAPABILITIES]
    : scope.capabilities;

  const token = createRemoteViewerToken({
    actorId: claims.actorId,
    homeBaseUrl: claims.homeBaseUrl,
    localInstanceId: config.instanceId,
    ttlMs,
  });

  // Record the landing (referral path, home, issuer, UA, granted scope) when
  // the owner has visit recording enabled. Best-effort — never blocks the
  // landing.
  if (scope.recordVisits) {
    await recordFederatedVisit({
      visitorActorId: claims.actorId,
      isOwner,
      homeBaseUrl: claims.homeBaseUrl,
      globalIssuerBaseUrl: claims.globalIssuerBaseUrl,
      landingPath: next,
      visitorName: claims.name,
      grantedScope,
      request,
    });
  }

  const response = NextResponse.redirect(new URL(next, localOrigin), {
    headers: { "Cache-Control": "no-store" },
  });
  attachRemoteViewerCookie(response, requestUrl, token, ttlMs);
  return response;
}
