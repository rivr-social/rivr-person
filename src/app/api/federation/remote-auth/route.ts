import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import type {
  FederatedActorContext,
  RemoteAuthResult,
} from "@/lib/federation/cross-instance-types";

/**
 * Token validity bounds for remote actor assertions.
 */
const MAX_ASSERTION_AGE_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ASSERTION_FUTURE_MS = 60 * 1000; // 1 minute clock skew tolerance

/**
 * POST /api/federation/remote-auth
 *
 * Accepts a FederatedActorContext from a remote instance and returns
 * a local session token that identifies the remote viewer.
 *
 * This is the sovereign-side entry point for cross-instance interaction.
 * When a user from global (or another instance) arrives at a sovereign
 * profile page, the client-side code exchanges their home-instance actor
 * context for a local remote-viewer session via this endpoint.
 *
 * Phase 1 implementation: validates the assertion by calling back to the
 * actor's home instance to verify the token. Future phases will support
 * signed assertions that can be verified locally.
 */
export async function POST(request: Request) {
  const config = getInstanceConfig();

  try {
    const body = await request.json();
    const actorContext = body as Partial<FederatedActorContext>;

    // ── Validate required fields ───────────────────────────────────────
    const validationError = validateActorContext(actorContext);
    if (validationError) {
      const errorResult: RemoteAuthResult = {
        success: false,
        viewerState: "anonymous",
        error: validationError,
        errorCode: "INVALID_ACTOR_CONTEXT",
      };
      return NextResponse.json(errorResult, { status: 400 });
    }

    const context = actorContext as FederatedActorContext;

    // ── Validate assertion timing ──────────────────────────────────────
    const timingError = validateAssertionTiming(context);
    if (timingError) {
      const errorResult: RemoteAuthResult = {
        success: false,
        viewerState: "anonymous",
        error: timingError,
        errorCode: "ASSERTION_TIMING_ERROR",
      };
      return NextResponse.json(errorResult, { status: 401 });
    }

    // ── Verify assertion against the actor's home instance ─────────────
    const verification = await verifyActorAssertionWithHome(context);
    if (!verification.valid) {
      return NextResponse.json(
        {
          success: false,
          viewerState: "anonymous" as const,
          error: verification.error || "Actor assertion verification failed",
          errorCode: "ASSERTION_VERIFICATION_FAILED",
        } satisfies RemoteAuthResult,
        { status: 401 },
      );
    }

    // ── Issue a local remote-viewer session token ──────────────────────
    // Phase 1: Return a lightweight token that downstream API calls and
    // components can use to identify the remote viewer.
    // Phase 2+: This could become a proper short-lived JWT or session cookie.
    const sessionToken = generateRemoteSessionToken(context, config.instanceId);

    const result: RemoteAuthResult = {
      success: true,
      viewerState: "remotely_authenticated",
      sessionToken,
      actorId: context.actorId,
      homeBaseUrl: context.homeBaseUrl,
      displayName: verification.displayName,
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error("[federation/remote-auth] Error processing remote auth:", error);
    return NextResponse.json(
      {
        success: false,
        viewerState: "anonymous" as const,
        error: error instanceof Error ? error.message : "Failed to process remote authentication",
        errorCode: "INTERNAL_ERROR",
      } satisfies RemoteAuthResult,
      { status: 500 },
    );
  }
}

// ─── Validation Helpers ──────────────────────────────────────────────────

function validateActorContext(ctx: Partial<FederatedActorContext>): string | null {
  if (!ctx.actorId || typeof ctx.actorId !== "string") {
    return "actorId is required and must be a string";
  }
  if (!ctx.homeBaseUrl || typeof ctx.homeBaseUrl !== "string") {
    return "homeBaseUrl is required and must be a string";
  }
  try {
    const url = new URL(ctx.homeBaseUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return "homeBaseUrl must use http or https";
    }
  } catch {
    return "homeBaseUrl must be a valid URL";
  }
  if (!ctx.assertionType || !["session", "token", "signed"].includes(ctx.assertionType)) {
    return "assertionType must be one of: session, token, signed";
  }
  if (!ctx.assertion || typeof ctx.assertion !== "string") {
    return "assertion is required and must be a string";
  }
  if (!ctx.issuedAt || typeof ctx.issuedAt !== "string") {
    return "issuedAt is required (ISO 8601)";
  }
  if (!ctx.expiresAt || typeof ctx.expiresAt !== "string") {
    return "expiresAt is required (ISO 8601)";
  }
  return null;
}

function validateAssertionTiming(ctx: FederatedActorContext): string | null {
  const now = Date.now();
  const issuedAt = new Date(ctx.issuedAt).getTime();
  const expiresAt = new Date(ctx.expiresAt).getTime();

  if (Number.isNaN(issuedAt) || Number.isNaN(expiresAt)) {
    return "issuedAt and expiresAt must be valid ISO 8601 timestamps";
  }

  if (issuedAt > now + MAX_ASSERTION_FUTURE_MS) {
    return "Assertion issuedAt is in the future";
  }

  if (now - issuedAt > MAX_ASSERTION_AGE_MS) {
    return "Assertion has expired (issuedAt too old)";
  }

  if (expiresAt <= now) {
    return "Assertion has expired (expiresAt in the past)";
  }

  return null;
}

// ─── Home Instance Verification ──────────────────────────────────────────

type VerificationResult = {
  valid: boolean;
  displayName?: string;
  error?: string;
};

/**
 * Verify a remote actor's assertion by calling back to their home instance.
 *
 * Phase 1: For "token" assertions, call the home instance's federation
 * registry to confirm the actor exists and the token is recognized.
 *
 * Phase 2+: For "signed" assertions, verify the signature locally using
 * the home instance's public key from the registry.
 */
async function verifyActorAssertionWithHome(
  ctx: FederatedActorContext,
): Promise<VerificationResult> {
  const homeBaseUrl = ctx.homeBaseUrl.replace(/\/+$/, "");
  const config = getInstanceConfig();

  try {
    // Call the home instance's registry to verify the actor exists
    const registryUrl = `${homeBaseUrl}/api/federation/registry/${encodeURIComponent(ctx.actorId)}`;

    const response = await fetch(registryUrl, {
      headers: {
        Accept: "application/json",
        "X-Instance-Id": config.instanceId,
        "X-Instance-Slug": config.instanceSlug,
        "X-Instance-Type": config.instanceType,
        "X-Remote-Auth-Assertion": ctx.assertion,
        "X-Remote-Auth-Assertion-Type": ctx.assertionType,
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return {
        valid: false,
        error: `Home instance returned ${response.status} for actor verification`,
      };
    }

    const data = await response.json();

    if (!data.success || !data.homeInstance) {
      return {
        valid: false,
        error: "Home instance did not confirm actor identity",
      };
    }

    // Extract display name from canonical profile if available
    const displayName =
      data.canonicalProfile?.displayName ||
      data.homeAuthority?.homeAgentId ||
      ctx.actorId;

    return {
      valid: true,
      displayName: typeof displayName === "string" ? displayName : ctx.actorId,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error
        ? `Home instance unreachable: ${error.message}`
        : "Home instance unreachable",
    };
  }
}

// ─── Session Token Generation ────────────────────────────────────────────

/**
 * Generate a short-lived remote viewer session token.
 *
 * Phase 1: Simple base64-encoded JSON payload with a TTL.
 * Phase 2+: Replace with a proper JWT signed with the instance's private key.
 */
function generateRemoteSessionToken(
  ctx: FederatedActorContext,
  localInstanceId: string,
): string {
  const payload = {
    type: "remote_viewer" as const,
    actorId: ctx.actorId,
    homeBaseUrl: ctx.homeBaseUrl,
    localInstanceId,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minute TTL
    nonce: crypto.randomUUID(),
  };

  // Phase 1: Base64-encoded JSON — not cryptographically secure.
  // This is adequate for initial development since the token is validated
  // server-side on every request. Phase 2 will use proper JWTs.
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}
