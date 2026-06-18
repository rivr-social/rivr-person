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
 * - On a person instance the landing actor must be the instance owner
 *   (`PRIMARY_AGENT_ID`); a handoff for anyone else is rejected.
 * - Verification failure never strands the user on a JSON error when a safe
 *   local destination exists: it falls through to `next` unauthenticated so
 *   they can log in normally, except for owner-mismatch which is a hard 403.
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
): void {
  response.cookies.set(REMOTE_VIEWER_COOKIE_NAME, token, {
    httpOnly: true,
    secure: requestUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(REMOTE_VIEWER_TTL_MS / 1000),
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
    return NextResponse.redirect(new URL(next, localOrigin), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { claims } = result;

  // On a person instance, the only actor who may land an authenticated
  // session is the instance owner. A handoff minted for any other agent is
  // a hard authorization failure (it should never happen, since global only
  // ever mints a handoff for the user's OWN home).
  if (config.instanceType === "person") {
    if (!config.primaryAgentId || claims.actorId !== config.primaryAgentId) {
      return NextResponse.json(
        { error: "Actor is not authorized for this person instance" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  const token = createRemoteViewerToken({
    actorId: claims.actorId,
    homeBaseUrl: claims.homeBaseUrl,
    localInstanceId: config.instanceId,
  });

  const response = NextResponse.redirect(new URL(next, localOrigin), {
    headers: { "Cache-Control": "no-store" },
  });
  attachRemoteViewerCookie(response, requestUrl, token);
  return response;
}
