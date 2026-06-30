import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { verify } from "@node-rs/bcrypt";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import { getClientIp } from "@/lib/client-ip";

const MINIMUM_PASSWORD_LENGTH = 8;
const MAXIMUM_PASSWORD_LENGTH = 72;

type VerifyPasswordRequest = {
  email?: string;
  password?: string;
};

function invalid() {
  return NextResponse.json({ success: false }, { status: 401 });
}

function rateLimited() {
  return NextResponse.json({ success: false }, { status: 429 });
}

/**
 * Server-to-server credential verification for a locally-homed account.
 *
 * F13 hardening (verified-principal + anti-oracle):
 * - **Peer-authenticated only.** A bare email+password used to be accepted from
 *   anyone, turning this into an open password / account-existence oracle. It is
 *   now gated behind {@link authorizeFederationRequest} and restricted to
 *   server-to-server principals (peer secret or node-admin key); a user session
 *   or MCP token (which carries an `actorId`) is rejected.
 * - **Per-IP rate limit** in addition to per-email, so a caller can't sidestep
 *   the email limiter by spraying many addresses from one host.
 * - **emailVerified gate** — an unverified account cannot be used to authenticate.
 * - **No enriched actor in the response** — return only a boolean so a positive
 *   result can't be used to harvest the account's name/email/avatar.
 */
export async function POST(request: Request) {
  // Server-to-server only. peer-secret → { peerNodeId }, admin key → {} ; both
  // lack an actorId. A session / MCP principal (has actorId) is not allowed to
  // probe credentials through this endpoint.
  const authz = await authorizeFederationRequest(request);
  if (!authz.authorized || authz.actorId) {
    return invalid();
  }

  let body: VerifyPasswordRequest;
  try {
    body = (await request.json()) as VerifyPasswordRequest;
  } catch {
    return invalid();
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (
    !email ||
    password.length < MINIMUM_PASSWORD_LENGTH ||
    password.length > MAXIMUM_PASSWORD_LENGTH
  ) {
    return invalid();
  }

  // Per-IP limit: stops one host enumerating many emails under the per-email cap.
  const clientIp = getClientIp(request.headers);
  const ipLimiter = await rateLimit(
    `federation-remote-password-ip:${clientIp}`,
    RATE_LIMITS.AUTH.limit,
    RATE_LIMITS.AUTH.windowMs,
  );
  if (!ipLimiter.success) {
    return rateLimited();
  }

  const limiter = await rateLimit(
    `federation-remote-password:${email}`,
    RATE_LIMITS.AUTH.limit,
    RATE_LIMITS.AUTH.windowMs,
  );
  if (!limiter.success) {
    return rateLimited();
  }

  const [agent] = await db
    .select({
      id: agents.id,
      passwordHash: agents.passwordHash,
      emailVerified: agents.emailVerified,
    })
    .from(agents)
    .where(eq(agents.email, email))
    .limit(1);

  if (!agent?.passwordHash) {
    return invalid();
  }

  // An unverified email may not be used to authenticate.
  if (!agent.emailVerified) {
    return invalid();
  }

  const passwordValid = await verify(password, agent.passwordHash);
  if (!passwordValid) {
    return invalid();
  }

  // Boolean-only: never leak the enriched actor (name/email/avatar) — the caller
  // already supplied the email and only needs the yes/no decision.
  return NextResponse.json({ success: true });
}
