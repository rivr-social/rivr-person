import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  createRemoteViewerToken,
  REMOTE_VIEWER_COOKIE_NAME,
  REMOTE_VIEWER_TTL_MS,
} from "@/lib/federation-remote-session";
import type {
  FederatedActorContext,
  RemoteAuthResult,
} from "@/lib/federation/cross-instance-types";
import { resolveRequestOrigin } from "@/lib/request-origin";
import { safeOutboundUrlString } from "@/lib/safe-outbound-url";

const MAX_ASSERTION_AGE_MS = 5 * 60 * 1000;
const MAX_ASSERTION_FUTURE_MS = 60 * 1000;

type VerificationResult = {
  valid: boolean;
  displayName?: string;
  manifestUrl?: string;
  error?: string;
};

function normalizeRedirectPath(path: string | null): string {
  if (!path) return "/";
  if (!path.startsWith("/")) return "/";
  if (path.startsWith("//")) return "/";
  return path;
}

function validateActorContext(ctx: Partial<FederatedActorContext>): string | null {
  if (!ctx.actorId || typeof ctx.actorId !== "string") return "actorId is required";
  if (!ctx.homeBaseUrl || typeof ctx.homeBaseUrl !== "string") return "homeBaseUrl is required";
  try {
    const url = new URL(ctx.homeBaseUrl);
    if (!["http:", "https:"].includes(url.protocol)) return "homeBaseUrl must be http/https";
  } catch {
    return "homeBaseUrl must be a valid URL";
  }
  if (!ctx.assertionType || !["session", "token", "signed"].includes(ctx.assertionType)) {
    return "assertionType must be one of: session, token, signed";
  }
  if (!ctx.assertion || typeof ctx.assertion !== "string") return "assertion is required";
  if (!ctx.issuedAt || typeof ctx.issuedAt !== "string") return "issuedAt is required";
  if (!ctx.expiresAt || typeof ctx.expiresAt !== "string") return "expiresAt is required";
  return null;
}

function validateAssertionTiming(ctx: FederatedActorContext): string | null {
  const now = Date.now();
  const issuedAt = new Date(ctx.issuedAt).getTime();
  const expiresAt = new Date(ctx.expiresAt).getTime();
  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return "issuedAt and expiresAt must be valid ISO timestamps";
  }
  if (issuedAt > now + MAX_ASSERTION_FUTURE_MS) return "Assertion issuedAt is in the future";
  if (now - issuedAt > MAX_ASSERTION_AGE_MS) return "Assertion too old";
  if (expiresAt <= now) return "Assertion expired";
  return null;
}

async function verifyActorAssertionWithHome(
  ctx: FederatedActorContext,
  targetBaseUrl: string,
): Promise<VerificationResult> {
  const verifyUrl = safeOutboundUrlString(
    new URL("/api/federation/remote-assertion/verify", ctx.homeBaseUrl),
    { protocols: ["https:", "http:"] },
  );

  try {
    const response = await fetch(verifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        actorId: ctx.actorId,
        homeBaseUrl: ctx.homeBaseUrl,
        targetBaseUrl,
        assertion: ctx.assertion,
        issuedAt: ctx.issuedAt,
        expiresAt: ctx.expiresAt,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const data = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok || data.valid !== true) {
      return {
        valid: false,
        error:
          typeof data.error === "string"
            ? data.error
            : `Home verification failed (${response.status})`,
      };
    }

    return {
      valid: true,
      displayName: typeof data.displayName === "string" ? data.displayName : undefined,
      manifestUrl: typeof data.manifestUrl === "string" ? data.manifestUrl : undefined,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? `Home instance unreachable: ${error.message}` : "Home instance unreachable",
    };
  }
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
  actorContext: Partial<FederatedActorContext>,
  targetBaseUrl: string,
): Promise<
  | { ok: true; result: RemoteAuthResult; token: string }
  | { ok: false; response: NextResponse }
> {
  const validationError = validateActorContext(actorContext);
  if (validationError) {
    return {
      ok: false,
      response: buildError(validationError, "INVALID_ACTOR_CONTEXT", 400),
    };
  }

  const context = actorContext as FederatedActorContext;
  const timingError = validateAssertionTiming(context);
  if (timingError) {
    return {
      ok: false,
      response: buildError(timingError, "ASSERTION_TIMING_ERROR", 401),
    };
  }

  const verification = await verifyActorAssertionWithHome(context, targetBaseUrl);
  if (!verification.valid) {
    return {
      ok: false,
      response: buildError(
        verification.error || "Actor assertion verification failed",
        "ASSERTION_VERIFICATION_FAILED",
        401,
      ),
    };
  }

  const config = getInstanceConfig();
  const ownerError = enforcePersonInstanceOwner(context.actorId);
  if (ownerError) {
    return {
      ok: false,
      response: ownerError,
    };
  }

  const sessionToken = createRemoteViewerToken({
    actorId: context.actorId,
    homeBaseUrl: context.homeBaseUrl,
    localInstanceId: config.instanceId,
  });

  return {
    ok: true,
    token: sessionToken,
    result: {
      success: true,
      viewerState: "remotely_authenticated",
      sessionToken,
      actorId: context.actorId,
      homeBaseUrl: context.homeBaseUrl,
      displayName: verification.displayName,
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
    const actor = (await request.json()) as Partial<FederatedActorContext>;
    const auth = await authenticateActor(actor, publicOrigin);
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
  const actorContext: Partial<FederatedActorContext> = {
    actorId: requestUrl.searchParams.get("actorId") ?? undefined,
    homeBaseUrl: requestUrl.searchParams.get("homeBaseUrl") ?? undefined,
    assertionType: (requestUrl.searchParams.get("assertionType") as
      | "session"
      | "token"
      | "signed"
      | null) ?? undefined,
    assertion: requestUrl.searchParams.get("assertion") ?? undefined,
    issuedAt: requestUrl.searchParams.get("issuedAt") ?? undefined,
    expiresAt: requestUrl.searchParams.get("expiresAt") ?? undefined,
    manifestUrl: requestUrl.searchParams.get("manifestUrl") ?? undefined,
  };

  const auth = await authenticateActor(actorContext, publicOrigin);
  if (!auth.ok) return auth.response;

  const redirectPath = normalizeRedirectPath(requestUrl.searchParams.get("redirect"));
  const response = NextResponse.redirect(new URL(redirectPath, publicOrigin));
  attachRemoteViewerCookie(response, requestUrl, auth.token);
  return response;
}
