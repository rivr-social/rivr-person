import { NextResponse } from "next/server";
import {
  getGlobalIdentityAuthorityUrl,
  getInstanceConfig,
} from "@/lib/federation/instance-config";
import {
  createRemoteViewerToken,
  REMOTE_VIEWER_COOKIE_NAME,
  REMOTE_VIEWER_TTL_MS,
} from "@/lib/federation-remote-session";
import type { RemoteAuthResult } from "@/lib/federation/cross-instance-types";
import { verifySsoAssertion } from "@/lib/federation/sso-assertion";
import { resolveRequestOrigin } from "@/lib/request-origin";

function normalizeRedirectPath(path: string | null): string {
  if (!path) return "/";
  if (!path.startsWith("/")) return "/";
  if (path.startsWith("//")) return "/";
  return path;
}

function buildError(error: string, code: string, status = 401) {
  return NextResponse.json(
    {
      success: false,
      viewerState: "anonymous",
      error,
      errorCode: code,
    } satisfies RemoteAuthResult,
    { status },
  );
}

function enforcePersonInstanceOwner(actorId: string): NextResponse | null {
  const config = getInstanceConfig();
  if (config.instanceType !== "person") return null;

  if (!config.primaryAgentId) {
    return buildError(
      "Person instance owner is not configured",
      "PERSON_INSTANCE_OWNER_NOT_CONFIGURED",
      500,
    );
  }

  if (actorId !== config.primaryAgentId) {
    return buildError(
      "Actor is not authorized for this person instance",
      "PERSON_INSTANCE_OWNER_REQUIRED",
      403,
    );
  }

  return null;
}

async function authenticateActor(
  assertion: unknown,
  targetBaseUrl: string,
): Promise<
  | { ok: true; result: RemoteAuthResult; token: string }
  | { ok: false; response: NextResponse }
> {
  const verification = await verifySsoAssertion({
    assertion,
    expectedTargetBaseUrl: targetBaseUrl,
    expectedGlobalIssuerBaseUrl: getGlobalIdentityAuthorityUrl() ?? undefined,
  });
  if (!verification.ok) {
    return {
      ok: false,
      response: buildError(
        "Actor assertion verification failed",
        "ASSERTION_VERIFICATION_FAILED",
        401,
      ),
    };
  }

  const { claims } = verification;
  const config = getInstanceConfig();
  const ownerError = enforcePersonInstanceOwner(claims.actorId);
  if (ownerError) {
    return {
      ok: false,
      response: ownerError,
    };
  }

  const sessionToken = createRemoteViewerToken({
    actorId: claims.actorId,
    homeBaseUrl: claims.homeBaseUrl,
    localInstanceId: config.instanceId,
  });

  return {
    ok: true,
    token: sessionToken,
    result: {
      success: true,
      viewerState: "remotely_authenticated",
      sessionToken,
      actorId: claims.actorId,
      homeBaseUrl: claims.homeBaseUrl,
      displayName: claims.name,
    },
  };
}

function attachRemoteViewerCookie(response: NextResponse, requestUrl: URL, token: string): void {
  response.cookies.set(REMOTE_VIEWER_COOKIE_NAME, token, {
    httpOnly: true,
    secure: requestUrl.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(REMOTE_VIEWER_TTL_MS / 1000),
  });
}

export async function POST(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const config = getInstanceConfig();
    const publicOrigin = resolveRequestOrigin(request, config.baseUrl);
    const assertion = await request.json();
    const auth = await authenticateActor(assertion, publicOrigin);
    if (!auth.ok) return auth.response;

    const response = NextResponse.json(auth.result);
    attachRemoteViewerCookie(response, requestUrl, auth.token);
    return response;
  } catch (error) {
    return buildError(
      error instanceof Error ? error.message : "Failed to process remote authentication",
      "INTERNAL_ERROR",
      500,
    );
  }
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const config = getInstanceConfig();
  const publicOrigin = resolveRequestOrigin(request, config.baseUrl);
  const redirectPath = normalizeRedirectPath(requestUrl.searchParams.get("redirect"));
  const response = NextResponse.redirect(new URL(redirectPath, publicOrigin));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
