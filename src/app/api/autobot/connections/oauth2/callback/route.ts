import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import { exchangeGenericOAuth2Code } from "@/lib/autobot-generic-oauth2";
import type { GenericOAuth2Config } from "@/lib/autobot-generic-oauth2";
import {
  buildConnectionsRedirectUrl,
  resolveAutobotConnectionScope,
} from "@/lib/autobot-connection-scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/autobot/connections/oauth2/callback
 *
 * Handles the generic OAuth2 callback. Exchanges the authorization code
 * for access/refresh tokens and upserts them into the accounts table
 * with provider set to the configured providerName (or "oauth2").
 */
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
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    "";
  const connectionsPage = buildConnectionsRedirectUrl(baseUrl);

  if (error) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { oauth_error: error }),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { oauth_error: "missing_code" }),
    );
  }

  /* ---- Validate state cookie ---- */
  const cookies = request.headers.get("cookie") ?? "";
  const stateCookie = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("oauth2_state="));
  const savedState = stateCookie?.split("=")[1];

  if (!savedState || savedState !== state) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { oauth_error: "state_mismatch" }),
    );
  }

  /* ---- Read connection config ---- */
  const settings = await getAutobotUserSettings(subject.actorId);
  const connection = settings.connections.find(
    (c) => c.provider === "generic_oauth2",
  );

  if (!connection) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { oauth_error: "no_connection_config" }),
    );
  }

  const providerName = connection.config.providerName?.trim() || "oauth2";
  const tokenUrl = connection.config.tokenUrl?.trim();

  if (!tokenUrl) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { oauth_error: "missing_token_url" }),
    );
  }

  const config: GenericOAuth2Config = {
    providerName,
    authUrl: connection.config.authUrl?.trim() || "",
    tokenUrl,
    scopes: connection.config.scopes?.trim() || "",
    clientId: connection.config.clientId?.trim(),
    clientSecret: connection.config.clientSecret?.trim(),
  };

  const redirectUri = `${baseUrl}/api/autobot/connections/oauth2/callback`;

  /* ---- Exchange code for tokens ---- */
  let tokenData: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  try {
    tokenData = await exchangeGenericOAuth2Code(config, code, redirectUri);
  } catch (exchangeError) {
    const message =
      exchangeError instanceof Error ? exchangeError.message : String(exchangeError);
    console.error("Generic OAuth2 token exchange failed:", message.slice(0, 500));
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { oauth_error: "token_exchange_failed" }),
    );
  }

  const providerAccountId = providerName;
  const expiresAt =
    typeof tokenData.expires_in === "number"
      ? Math.floor(Date.now() / 1000) + tokenData.expires_in
      : null;

  /* ---- Upsert account row ---- */
  const [existingAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, subject.actorId),
        eq(accounts.provider, providerName),
      ),
    )
    .limit(1);

  if (existingAccount) {
    await db
      .update(accounts)
      .set({
        providerAccountId,
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token ?? null,
        expires_at: expiresAt,
        token_type: tokenData.token_type ?? "bearer",
        scope: config.scopes || null,
      })
      .where(eq(accounts.id, existingAccount.id));
  } else {
    await db.insert(accounts).values({
      userId: subject.actorId,
      type: "oauth",
      provider: providerName,
      providerAccountId,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? null,
      expires_at: expiresAt,
      token_type: tokenData.token_type ?? "bearer",
      scope: config.scopes || null,
    });
  }

  /* ---- Clear state cookie and redirect ---- */
  const response = NextResponse.redirect(connectionsPage);
  response.cookies.set("oauth2_state", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/api/autobot/connections/oauth2",
  });

  return response;
}
