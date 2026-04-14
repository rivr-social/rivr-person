import { NextResponse } from "next/server";
import { auth } from "@/auth";
import crypto from "node:crypto";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import { buildGenericOAuth2AuthUrl } from "@/lib/autobot-generic-oauth2";
import type { GenericOAuth2Config } from "@/lib/autobot-generic-oauth2";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";

export const dynamic = "force-dynamic";

/**
 * GET /api/autobot/connections/oauth2/connect
 *
 * Initiates a generic OAuth2 authorization flow.
 * Reads the user's generic_oauth2 connection config for providerName,
 * authUrl, scopes, and client credentials. Redirects the browser to
 * the configured authorization endpoint.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const subject = await resolveAutobotConnectionScope(session.user.id);

  const settings = await getAutobotUserSettings(subject.actorId);
  const connection = settings.connections.find(
    (c) => c.provider === "generic_oauth2",
  );

  if (!connection) {
    return NextResponse.json(
      { error: "No generic_oauth2 connection is configured in your settings." },
      { status: 400 },
    );
  }

  const authUrl = connection.config.authUrl?.trim();
  const tokenUrl = connection.config.tokenUrl?.trim();
  const providerName = connection.config.providerName?.trim() || "oauth2";
  const scopes = connection.config.scopes?.trim() || "";
  const clientId =
    connection.config.clientId?.trim() || process.env.GENERIC_OAUTH2_CLIENT_ID?.trim();

  if (!authUrl) {
    return NextResponse.json(
      { error: "authUrl is not configured for the generic_oauth2 connection." },
      { status: 400 },
    );
  }

  if (!tokenUrl) {
    return NextResponse.json(
      { error: "tokenUrl is not configured for the generic_oauth2 connection." },
      { status: 400 },
    );
  }

  if (!clientId) {
    return NextResponse.json(
      { error: "client_id is not configured. Set it in the connection config or GENERIC_OAUTH2_CLIENT_ID env var." },
      { status: 503 },
    );
  }

  const baseUrl =
    process.env.NEXTAUTH_URL?.trim() || process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (!baseUrl) {
    return NextResponse.json(
      { error: "NEXTAUTH_URL is not configured." },
      { status: 503 },
    );
  }

  const redirectUri = `${baseUrl}/api/autobot/connections/oauth2/callback`;
  const state = crypto.randomBytes(16).toString("hex");

  const config: GenericOAuth2Config = {
    providerName,
    authUrl,
    tokenUrl,
    scopes,
    clientId,
  };

  const authorizationUrl = buildGenericOAuth2AuthUrl(config, redirectUri, state);

  const response = NextResponse.redirect(authorizationUrl);
  response.cookies.set("oauth2_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/autobot/connections/oauth2",
  });

  return response;
}
