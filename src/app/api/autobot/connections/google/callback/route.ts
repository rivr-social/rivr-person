import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import {
  buildConnectionsRedirectUrl,
  resolveAutobotConnectionScope,
} from "@/lib/autobot-connection-scope";

export const dynamic = "force-dynamic";

const GOOGLE_CONNECTOR_PROVIDER = "google_workspace";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/auth/login", request.url));
  }

  const subject = await resolveAutobotConnectionScope(session.user.id);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const baseUrl =
    process.env.NEXTAUTH_URL?.trim() || process.env.NEXT_PUBLIC_BASE_URL?.trim() || "";

  if (error) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { google_error: error }),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { google_error: "missing_code" }),
    );
  }

  const cookies = request.headers.get("cookie") ?? "";
  const stateCookie = cookies
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("google_oauth_state="));
  const savedState = stateCookie?.split("=")[1];

  if (!savedState || savedState !== state) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { google_error: "state_mismatch" }),
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { google_error: "not_configured" }),
    );
  }

  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/autobot/connections/google/callback`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("Google token exchange failed:", errorText.slice(0, 500));
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { google_error: "token_exchange_failed" }),
    );
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    id_token?: string;
  };

  if (!tokenData.access_token) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { google_error: "no_access_token" }),
    );
  }

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
    cache: "no-store",
  });

  const profile = profileResponse.ok
    ? ((await profileResponse.json()) as {
        sub?: string;
        email?: string;
        name?: string;
      })
    : {};

  const providerAccountId = profile.sub || profile.email || "google-workspace";
  const expiresAt =
    typeof tokenData.expires_in === "number"
      ? Math.floor(Date.now() / 1000) + tokenData.expires_in
      : null;

  const [existingAccount] = await db
    .select({ id: accounts.id, refreshToken: accounts.refresh_token })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, subject.actorId),
        eq(accounts.provider, GOOGLE_CONNECTOR_PROVIDER),
      ),
    )
    .limit(1);

  const values = {
    providerAccountId,
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token ?? existingAccount?.refreshToken ?? null,
    expires_at: expiresAt,
    token_type: tokenData.token_type ?? "Bearer",
    scope: tokenData.scope ?? null,
    id_token: tokenData.id_token ?? null,
  };

  if (existingAccount) {
    await db.update(accounts).set(values).where(eq(accounts.id, existingAccount.id));
  } else {
    await db.insert(accounts).values({
      userId: subject.actorId,
      type: "oauth",
      provider: GOOGLE_CONNECTOR_PROVIDER,
      ...values,
    });
  }

  const response = NextResponse.redirect(buildConnectionsRedirectUrl(baseUrl));
  response.cookies.set("google_oauth_state", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/api/autobot/connections/google",
  });

  return response;
}
