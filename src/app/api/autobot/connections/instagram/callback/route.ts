import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  buildConnectionsRedirectUrl,
  resolveAutobotConnectionScope,
} from "@/lib/autobot-connection-scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/autobot/connections/instagram/callback
 *
 * Handles the Instagram OAuth2 callback. Exchanges the authorization code for
 * a short-lived token, then exchanges that for a long-lived token, and stores
 * it in the accounts table.
 */
export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(
      new URL("/auth/login", request.url),
    );
  }
  const subject = await resolveAutobotConnectionScope(session.user.id);

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const baseUrl = process.env.NEXTAUTH_URL?.trim() || process.env.NEXT_PUBLIC_BASE_URL?.trim() || "";
  const connectionsPage = buildConnectionsRedirectUrl(baseUrl);

  if (error) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { instagram_error: error }),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { instagram_error: "missing_code" }),
    );
  }

  // Validate state cookie
  const cookies = request.headers.get("cookie") ?? "";
  const stateCookie = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("instagram_oauth_state="));
  const savedState = stateCookie?.split("=")[1];

  if (!savedState || savedState !== state) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { instagram_error: "state_mismatch" }),
    );
  }

  const clientId = process.env.INSTAGRAM_CLIENT_ID?.trim();
  const clientSecret = process.env.INSTAGRAM_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { instagram_error: "not_configured" }),
    );
  }

  const redirectUri =
    process.env.INSTAGRAM_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/autobot/connections/instagram/callback`;

  // Exchange code for short-lived token via form POST
  const tokenBody = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });

  const tokenResponse = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("Instagram token exchange failed:", errorText.slice(0, 500));
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { instagram_error: "token_exchange_failed" }),
    );
  }

  const shortLivedData = (await tokenResponse.json()) as {
    access_token?: string;
    user_id?: number;
  };

  if (!shortLivedData.access_token) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { instagram_error: "no_access_token" }),
    );
  }

  // Exchange short-lived token for long-lived token
  const longLivedUrl = new URL("https://graph.instagram.com/access_token");
  longLivedUrl.searchParams.set("grant_type", "ig_exchange_token");
  longLivedUrl.searchParams.set("client_secret", clientSecret);
  longLivedUrl.searchParams.set("access_token", shortLivedData.access_token);

  let finalAccessToken = shortLivedData.access_token;
  let finalExpiresIn: number | undefined;

  const longLivedResponse = await fetch(longLivedUrl.toString(), { cache: "no-store" });
  if (longLivedResponse.ok) {
    const longLivedData = (await longLivedResponse.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    if (longLivedData.access_token) {
      finalAccessToken = longLivedData.access_token;
      finalExpiresIn = longLivedData.expires_in;
    }
  }

  const providerAccountId = shortLivedData.user_id
    ? String(shortLivedData.user_id)
    : "instagram";
  const expiresAt =
    typeof finalExpiresIn === "number"
      ? Math.floor(Date.now() / 1000) + finalExpiresIn
      : null;

  // Upsert the account row
  const [existingAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, subject.actorId),
        eq(accounts.provider, "instagram"),
      ),
    )
    .limit(1);

  if (existingAccount) {
    await db
      .update(accounts)
      .set({
        providerAccountId,
        access_token: finalAccessToken,
        refresh_token: null,
        expires_at: expiresAt,
        token_type: "bearer",
        scope: "instagram_basic,instagram_content_publish",
      })
      .where(eq(accounts.id, existingAccount.id));
  } else {
    await db.insert(accounts).values({
      userId: subject.actorId,
      type: "oauth",
      provider: "instagram",
      providerAccountId,
      access_token: finalAccessToken,
      refresh_token: null,
      expires_at: expiresAt,
      token_type: "bearer",
      scope: "instagram_basic,instagram_content_publish",
    });
  }

  // Clear the state cookie
  const response = NextResponse.redirect(connectionsPage);
  response.cookies.set("instagram_oauth_state", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/api/autobot/connections/instagram",
  });

  return response;
}
