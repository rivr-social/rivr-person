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

const FACEBOOK_GRAPH_API = "https://graph.facebook.com/v19.0";

/**
 * GET /api/autobot/connections/facebook/callback
 *
 * Handles the Facebook OAuth2 callback. Exchanges the authorization code for
 * an access token and stores it in the accounts table.
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
      buildConnectionsRedirectUrl(baseUrl, { facebook_error: error }),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { facebook_error: "missing_code" }),
    );
  }

  // Validate state cookie
  const cookies = request.headers.get("cookie") ?? "";
  const stateCookie = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("facebook_oauth_state="));
  const savedState = stateCookie?.split("=")[1];

  if (!savedState || savedState !== state) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { facebook_error: "state_mismatch" }),
    );
  }

  const clientId = process.env.FACEBOOK_CLIENT_ID?.trim();
  const clientSecret = process.env.FACEBOOK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { facebook_error: "not_configured" }),
    );
  }

  const redirectUri =
    process.env.FACEBOOK_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/autobot/connections/facebook/callback`;

  // Exchange code for short-lived token
  const tokenUrl = new URL(`${FACEBOOK_GRAPH_API}/oauth/access_token`);
  tokenUrl.searchParams.set("client_id", clientId);
  tokenUrl.searchParams.set("client_secret", clientSecret);
  tokenUrl.searchParams.set("redirect_uri", redirectUri);
  tokenUrl.searchParams.set("code", code);

  const tokenResponse = await fetch(tokenUrl.toString(), { cache: "no-store" });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("Facebook token exchange failed:", errorText.slice(0, 500));
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { facebook_error: "token_exchange_failed" }),
    );
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  };

  if (!tokenData.access_token) {
    return NextResponse.redirect(
      `${connectionsPage}&facebook_error=no_access_token`,
    );
  }

  // Exchange short-lived token for long-lived token
  const longLivedUrl = new URL(`${FACEBOOK_GRAPH_API}/oauth/access_token`);
  longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
  longLivedUrl.searchParams.set("client_id", clientId);
  longLivedUrl.searchParams.set("client_secret", clientSecret);
  longLivedUrl.searchParams.set("fb_exchange_token", tokenData.access_token);

  let finalAccessToken = tokenData.access_token;
  let finalExpiresIn = tokenData.expires_in;

  const longLivedResponse = await fetch(longLivedUrl.toString(), { cache: "no-store" });
  if (longLivedResponse.ok) {
    const longLivedData = (await longLivedResponse.json()) as {
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    if (longLivedData.access_token) {
      finalAccessToken = longLivedData.access_token;
      finalExpiresIn = longLivedData.expires_in;
    }
  }

  // Get user info
  const meUrl = new URL(`${FACEBOOK_GRAPH_API}/me`);
  meUrl.searchParams.set("fields", "id,name");
  meUrl.searchParams.set("access_token", finalAccessToken);

  const meResponse = await fetch(meUrl.toString(), { cache: "no-store" });
  const meData = meResponse.ok
    ? ((await meResponse.json()) as { id?: string; name?: string })
    : { id: "facebook", name: undefined };

  const providerAccountId = meData.id || "facebook";
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
        eq(accounts.provider, "facebook"),
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
        token_type: tokenData.token_type ?? "bearer",
        scope: "email,pages_read_engagement,pages_manage_posts,public_profile",
      })
      .where(eq(accounts.id, existingAccount.id));
  } else {
    await db.insert(accounts).values({
      userId: subject.actorId,
      type: "oauth",
      provider: "facebook",
      providerAccountId,
      access_token: finalAccessToken,
      refresh_token: null,
      expires_at: expiresAt,
      token_type: tokenData.token_type ?? "bearer",
      scope: "email,pages_read_engagement,pages_manage_posts,public_profile",
    });
  }

  // Clear the state cookie
  const response = NextResponse.redirect(connectionsPage);
  response.cookies.set("facebook_oauth_state", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/api/autobot/connections/facebook",
  });

  return response;
}
