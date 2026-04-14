import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type GenericOAuth2Config = {
  providerName: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string;
  clientId?: string;
  clientSecret?: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

type RefreshTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

/* ------------------------------------------------------------------ */
/*  Auth URL builder                                                   */
/* ------------------------------------------------------------------ */

export function buildGenericOAuth2AuthUrl(
  config: GenericOAuth2Config,
  redirectUri: string,
  state: string,
): string {
  const clientId = config.clientId?.trim() || process.env.GENERIC_OAUTH2_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("Generic OAuth2 client_id is not configured.");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes,
    state,
  });

  const separator = config.authUrl.includes("?") ? "&" : "?";
  return `${config.authUrl}${separator}${params.toString()}`;
}

/* ------------------------------------------------------------------ */
/*  Code exchange                                                      */
/* ------------------------------------------------------------------ */

export async function exchangeGenericOAuth2Code(
  config: GenericOAuth2Config,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const clientId =
    config.clientId?.trim() || process.env.GENERIC_OAUTH2_CLIENT_ID?.trim();
  const clientSecret =
    config.clientSecret?.trim() || process.env.GENERIC_OAUTH2_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("Generic OAuth2 client credentials are not configured.");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OAuth2 token exchange failed (${response.status}): ${errorText.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("OAuth2 token exchange did not return an access_token.");
  }

  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
    token_type: typeof data.token_type === "string" ? data.token_type : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Token refresh                                                      */
/* ------------------------------------------------------------------ */

export async function refreshGenericOAuth2Token(
  config: GenericOAuth2Config,
  refreshToken: string,
): Promise<RefreshTokenResponse> {
  const clientId =
    config.clientId?.trim() || process.env.GENERIC_OAUTH2_CLIENT_ID?.trim();
  const clientSecret =
    config.clientSecret?.trim() || process.env.GENERIC_OAUTH2_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("Generic OAuth2 client credentials are not configured.");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OAuth2 token refresh failed (${response.status}): ${errorText.slice(0, 500)}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("OAuth2 token refresh did not return an access_token.");
  }

  return {
    access_token: data.access_token,
    refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : undefined,
    expires_in: typeof data.expires_in === "number" ? data.expires_in : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Sync / connectivity check                                          */
/* ------------------------------------------------------------------ */

export async function syncGenericOAuth2Connection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const providerName = connection.config.providerName?.trim() || "oauth2";

  const [account] = await db
    .select({
      id: accounts.id,
      accessToken: accounts.access_token,
      refreshToken: accounts.refresh_token,
      expiresAt: accounts.expires_at,
      scope: accounts.scope,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        eq(accounts.provider, providerName),
      ),
    )
    .limit(1);

  if (!account?.accessToken) {
    return {
      provider: "generic_oauth2",
      imported: 0,
      updated: 0,
      skipped: 0,
      message: `No linked account found for provider "${providerName}". Connect via OAuth first.`,
      accountLabel: providerName,
    };
  }

  const isExpired =
    typeof account.expiresAt === "number" &&
    Number.isFinite(account.expiresAt) &&
    account.expiresAt * 1000 <= Date.now();

  const tokenUrl = connection.config.tokenUrl?.trim();
  if (isExpired && account.refreshToken && tokenUrl) {
    const config: GenericOAuth2Config = {
      providerName,
      authUrl: connection.config.authUrl?.trim() || "",
      tokenUrl,
      scopes: connection.config.scopes?.trim() || "",
      clientId: connection.config.clientId?.trim(),
      clientSecret: connection.config.clientSecret?.trim(),
    };

    try {
      const refreshed = await refreshGenericOAuth2Token(config, account.refreshToken);
      const nextExpiresAt =
        typeof refreshed.expires_in === "number"
          ? Math.floor(Date.now() / 1000) + refreshed.expires_in
          : null;

      await db
        .update(accounts)
        .set({
          access_token: refreshed.access_token,
          expires_at: nextExpiresAt,
          refresh_token: refreshed.refresh_token ?? account.refreshToken,
        })
        .where(eq(accounts.id, account.id));

      return {
        provider: "generic_oauth2",
        imported: 0,
        updated: 1,
        skipped: 0,
        message: `Token refreshed for provider "${providerName}". Connection is active.`,
        accountLabel: providerName,
        externalAccountId: account.id,
      };
    } catch (refreshError) {
      const errorMessage =
        refreshError instanceof Error ? refreshError.message : String(refreshError);
      return {
        provider: "generic_oauth2",
        imported: 0,
        updated: 0,
        skipped: 0,
        message: `Token refresh failed for provider "${providerName}": ${errorMessage.slice(0, 300)}`,
        accountLabel: providerName,
        externalAccountId: account.id,
      };
    }
  }

  if (isExpired) {
    return {
      provider: "generic_oauth2",
      imported: 0,
      updated: 0,
      skipped: 0,
      message: `Token expired for provider "${providerName}". Reconnect via OAuth.`,
      accountLabel: providerName,
      externalAccountId: account.id,
    };
  }

  return {
    provider: "generic_oauth2",
    imported: 0,
    updated: 0,
    skipped: 0,
    message: `Provider "${providerName}" is connected. Token is valid.`,
    accountLabel: providerName,
    externalAccountId: account.id,
  };
}
