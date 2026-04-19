import { NextResponse } from "next/server";
import { auth } from "@/auth";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

const FACEBOOK_OAUTH_SCOPES = "email,pages_read_engagement,pages_manage_posts,public_profile";

/**
 * GET /api/autobot/connections/facebook/connect
 *
 * Initiates Facebook OAuth2 authorization flow.
 * Redirects the browser to Facebook's consent screen.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.FACEBOOK_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.json(
      { error: "Facebook OAuth is not configured on this instance" },
      { status: 503 },
    );
  }

  const baseUrl = process.env.NEXTAUTH_URL?.trim() || process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (!baseUrl) {
    return NextResponse.json(
      { error: "NEXTAUTH_URL is not configured" },
      { status: 503 },
    );
  }

  const redirectUri =
    process.env.FACEBOOK_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/autobot/connections/facebook/callback`;

  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: FACEBOOK_OAUTH_SCOPES,
    state,
  });

  const facebookAuthUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;

  const response = NextResponse.redirect(facebookAuthUrl);
  response.cookies.set("facebook_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/autobot/connections/facebook",
  });

  return response;
}
