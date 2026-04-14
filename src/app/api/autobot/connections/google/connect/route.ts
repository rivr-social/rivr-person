import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const GOOGLE_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/calendar",
].join(" ");

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.json(
      { error: "Google OAuth is not configured on this instance" },
      { status: 503 },
    );
  }

  const baseUrl = process.env.NEXTAUTH_URL?.trim() || process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (!baseUrl) {
    return NextResponse.json({ error: "NEXTAUTH_URL is not configured" }, { status: 503 });
  }

  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/autobot/connections/google/callback`;

  const state = crypto.randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  params.set("state", state);

  const response = NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
  response.cookies.set("google_oauth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/autobot/connections/google",
  });

  return response;
}
