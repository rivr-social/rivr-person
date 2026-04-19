import { NextResponse } from "next/server";
import { auth } from "@/auth";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

const INSTAGRAM_OAUTH_SCOPES = "instagram_basic,instagram_content_publish";

/**
 * GET /api/autobot/connections/instagram/connect
 *
 * Initiates Instagram OAuth2 authorization flow.
 * Redirects the browser to Instagram's consent screen.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.INSTAGRAM_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.json(
      { error: "Instagram OAuth is not configured on this instance" },
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
    process.env.INSTAGRAM_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/autobot/connections/instagram/callback`;

  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: INSTAGRAM_OAUTH_SCOPES,
    state,
  });

  const instagramAuthUrl = `https://www.instagram.com/oauth/authorize?${params.toString()}`;

  const response = NextResponse.redirect(instagramAuthUrl);
  response.cookies.set("instagram_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/autobot/connections/instagram",
  });

  return response;
}
