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

const NOTION_API_VERSION = "2026-03-11";

/**
 * GET /api/autobot/connections/notion/callback
 *
 * Handles the Notion OAuth2 callback. Exchanges the authorization code for
 * access/refresh tokens and stores them in the accounts table.
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
      buildConnectionsRedirectUrl(baseUrl, { notion_error: error }),
    );
  }

  if (!code) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { notion_error: "missing_code" }),
    );
  }

  // Validate state cookie
  const cookies = request.headers.get("cookie") ?? "";
  const stateCookie = cookies
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("notion_oauth_state="));
  const savedState = stateCookie?.split("=")[1];

  if (!savedState || savedState !== state) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { notion_error: "state_mismatch" }),
    );
  }

  const clientId = process.env.NOTION_CLIENT_ID?.trim();
  const clientSecret = process.env.NOTION_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { notion_error: "not_configured" }),
    );
  }

  const redirectUri =
    process.env.NOTION_REDIRECT_URI?.trim() ||
    `${baseUrl}/api/autobot/connections/notion/callback`;

  // Exchange code for token
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const tokenResponse = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_API_VERSION,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    console.error("Notion token exchange failed:", errorText.slice(0, 500));
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { notion_error: "token_exchange_failed" }),
    );
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    refresh_token?: string | null;
    expires_in?: number;
    token_type?: string;
    bot_id?: string;
    workspace_id?: string;
    workspace_name?: string;
    owner?: { type?: string; user?: { id?: string } };
  };

  if (!tokenData.access_token) {
    return NextResponse.redirect(
      buildConnectionsRedirectUrl(baseUrl, { notion_error: "no_access_token" }),
    );
  }

  const providerAccountId = tokenData.workspace_id || tokenData.bot_id || "notion";
  const expiresAt =
    typeof tokenData.expires_in === "number"
      ? Math.floor(Date.now() / 1000) + tokenData.expires_in
      : null;

  // Upsert the account row
  const [existingAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, subject.actorId),
        eq(accounts.provider, "notion"),
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
        scope: "read_content,update_content,insert_content",
      })
      .where(eq(accounts.id, existingAccount.id));
  } else {
    await db.insert(accounts).values({
      userId: subject.actorId,
      type: "oauth",
      provider: "notion",
      providerAccountId,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token ?? null,
      expires_at: expiresAt,
      token_type: tokenData.token_type ?? "bearer",
      scope: "read_content,update_content,insert_content",
    });
  }

  // Clear the state cookie
  const response = NextResponse.redirect(connectionsPage);
  response.cookies.set("notion_oauth_state", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 0,
    path: "/api/autobot/connections/notion",
  });

  return response;
}
