import { NextResponse } from "next/server";
import { auth } from "@/auth";
import crypto from "node:crypto";

export const dynamic = "force-dynamic";

/**
 * GET /api/autobot/connections/notion/connect
 *
 * Initiates Notion OAuth2 authorization flow.
 * Redirects the browser to Notion's consent screen.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.NOTION_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.json(
      { error: "Notion OAuth is not configured on this instance" },
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
    process.env.NOTION_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/autobot/connections/notion/callback`;

  const state = crypto.randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    owner: "user",
    state,
  });

  const notionAuthUrl = `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;

  const response = NextResponse.redirect(notionAuthUrl);
  response.cookies.set("notion_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/autobot/connections/notion",
  });

  return response;
}
