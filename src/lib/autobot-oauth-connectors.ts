import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { accounts } from "@/db/schema";

export type SupportedOAuthConnectorProvider =
  | "slack"
  | "discord"
  | "dropbox"
  | "zoom"
  | "apple";

type OAuthProviderConfig = {
  provider: SupportedOAuthConnectorProvider;
  clientIdEnv: string;
  clientSecretEnv?: string;
  authorizationUrl: string;
  tokenUrl: string;
  defaultScopes: string;
  redirectPath: string;
  authorizationParams?: Record<string, string>;
  exchangeCode: (
    code: string,
    redirectUri: string,
  ) => Promise<OAuthTokenResult>;
  resolveAccount: (
    accessToken: string,
    tokenData: OAuthTokenResult,
  ) => Promise<{ providerAccountId: string; label?: string }>;
};

export type OAuthTokenResult = {
  accessToken: string;
  refreshToken?: string | null;
  expiresIn?: number | null;
  tokenType?: string | null;
  idToken?: string | null;
  scope?: string | null;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not configured on this instance.`);
  }
  return value;
}

export function getConnectorBaseUrl(): string {
  const baseUrl =
    process.env.NEXTAUTH_URL?.trim() ||
    process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("NEXTAUTH_URL is not configured.");
  }
  return baseUrl;
}

export function buildOAuthState(): string {
  return crypto.randomBytes(16).toString("hex");
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) {
    throw new Error("JWT is malformed.");
  }
  const payload = parts[1]
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const json = Buffer.from(payload, "base64").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

function buildAppleClientSecret(clientId: string): string {
  const teamId = getRequiredEnv("APPLE_TEAM_ID");
  const keyId = getRequiredEnv("APPLE_KEY_ID");
  const privateKey = getRequiredEnv("APPLE_PRIVATE_KEY").replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: teamId,
      iat: now,
      exp: now + 60 * 60 * 24 * 180,
      aud: "https://appleid.apple.com",
      sub: clientId,
    }),
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign({
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${base64UrlEncode(signature)}`;
}

async function exchangeOAuthForm(
  tokenUrl: string,
  body: URLSearchParams,
  tokenAuth?: { type: "basic"; username: string; password: string },
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (tokenAuth) {
    headers.Authorization = `Basic ${Buffer.from(
      `${tokenAuth.username}:${tokenAuth.password}`,
    ).toString("base64")}`;
  }
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body,
    cache: "no-store",
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `OAuth token exchange failed (${response.status}): ${errorText.slice(0, 500)}`,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

function normalizeTokenResult(data: Record<string, unknown>): OAuthTokenResult {
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("OAuth token exchange did not return an access_token.");
  }
  return {
    accessToken: data.access_token,
    refreshToken:
      typeof data.refresh_token === "string" ? data.refresh_token : null,
    expiresIn:
      typeof data.expires_in === "number" ? data.expires_in : null,
    tokenType:
      typeof data.token_type === "string" ? data.token_type : null,
    idToken: typeof data.id_token === "string" ? data.id_token : null,
    scope: typeof data.scope === "string" ? data.scope : null,
  };
}

export function getOAuthConnectorConfig(
  provider: SupportedOAuthConnectorProvider,
): OAuthProviderConfig {
  switch (provider) {
    case "slack":
      return {
        provider,
        clientIdEnv: "SLACK_CLIENT_ID",
        clientSecretEnv: "SLACK_CLIENT_SECRET",
        authorizationUrl: "https://slack.com/oauth/v2/authorize",
        tokenUrl: "https://slack.com/api/oauth.v2.access",
        defaultScopes: "channels:read,channels:history,groups:read,groups:history,chat:write,users:read,files:read",
        redirectPath: "/api/autobot/connections/slack/callback",
        authorizationParams: {
          user_scope: "identity.basic,identity.email",
        },
        exchangeCode: async (code, redirectUri) => {
          const clientId = getRequiredEnv("SLACK_CLIENT_ID");
          const clientSecret = getRequiredEnv("SLACK_CLIENT_SECRET");
          const body = new URLSearchParams({
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
          });
          const data = await exchangeOAuthForm(
            "https://slack.com/api/oauth.v2.access",
            body,
          );
          if (data.ok !== true) {
            throw new Error(
              `Slack OAuth error: ${String(data.error ?? "unknown_error")}`,
            );
          }
          return normalizeTokenResult(data);
        },
        resolveAccount: async (accessToken) => {
          const response = await fetch("https://slack.com/api/auth.test", {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: "no-store",
          });
          const data = (await response.json()) as {
            ok?: boolean;
            user_id?: string;
            user?: string;
            team_id?: string;
            team?: string;
          };
          if (!response.ok || data.ok !== true) {
            throw new Error("Failed to resolve Slack workspace identity.");
          }
          return {
            providerAccountId: data.team_id || data.user_id || "slack",
            label: data.team || data.user,
          };
        },
      };
    case "discord":
      return {
        provider,
        clientIdEnv: "DISCORD_CLIENT_ID",
        clientSecretEnv: "DISCORD_CLIENT_SECRET",
        authorizationUrl: "https://discord.com/oauth2/authorize",
        tokenUrl: "https://discord.com/api/oauth2/token",
        defaultScopes: "identify email guilds",
        redirectPath: "/api/autobot/connections/discord/callback",
        exchangeCode: async (code, redirectUri) => {
          const clientId = getRequiredEnv("DISCORD_CLIENT_ID");
          const clientSecret = getRequiredEnv("DISCORD_CLIENT_SECRET");
          const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
          });
          return normalizeTokenResult(
            await exchangeOAuthForm("https://discord.com/api/oauth2/token", body),
          );
        },
        resolveAccount: async (accessToken) => {
          const response = await fetch("https://discord.com/api/users/@me", {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: "no-store",
          });
          const data = (await response.json()) as {
            id?: string;
            username?: string;
            global_name?: string;
          };
          if (!response.ok || !data.id) {
            throw new Error("Failed to resolve Discord user identity.");
          }
          return {
            providerAccountId: data.id,
            label: data.global_name || data.username,
          };
        },
      };
    case "dropbox":
      return {
        provider,
        clientIdEnv: "DROPBOX_CLIENT_ID",
        clientSecretEnv: "DROPBOX_CLIENT_SECRET",
        authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
        tokenUrl: "https://api.dropboxapi.com/oauth2/token",
        defaultScopes: "account_info.read files.metadata.read files.content.read files.content.write",
        redirectPath: "/api/autobot/connections/dropbox/callback",
        authorizationParams: {
          token_access_type: "offline",
        },
        exchangeCode: async (code, redirectUri) => {
          const clientId = getRequiredEnv("DROPBOX_CLIENT_ID");
          const clientSecret = getRequiredEnv("DROPBOX_CLIENT_SECRET");
          const body = new URLSearchParams({
            code,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
          });
          return normalizeTokenResult(
            await exchangeOAuthForm("https://api.dropboxapi.com/oauth2/token", body),
          );
        },
        resolveAccount: async (accessToken) => {
          const response = await fetch(
            "https://api.dropboxapi.com/2/users/get_current_account",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
              body: "null",
              cache: "no-store",
            },
          );
          const data = (await response.json()) as {
            account_id?: string;
            email?: string;
            name?: { display_name?: string };
          };
          if (!response.ok || !data.account_id) {
            throw new Error("Failed to resolve Dropbox account identity.");
          }
          return {
            providerAccountId: data.account_id,
            label: data.name?.display_name || data.email,
          };
        },
      };
    case "zoom":
      return {
        provider,
        clientIdEnv: "ZOOM_CLIENT_ID",
        clientSecretEnv: "ZOOM_CLIENT_SECRET",
        authorizationUrl: "https://zoom.us/oauth/authorize",
        tokenUrl: "https://zoom.us/oauth/token",
        defaultScopes: "user:read meeting:read recording:read",
        redirectPath: "/api/autobot/connections/zoom/callback",
        exchangeCode: async (code, redirectUri) => {
          const clientId = getRequiredEnv("ZOOM_CLIENT_ID");
          const clientSecret = getRequiredEnv("ZOOM_CLIENT_SECRET");
          const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
          });
          return normalizeTokenResult(
            await exchangeOAuthForm("https://zoom.us/oauth/token", body, {
              type: "basic",
              username: clientId,
              password: clientSecret,
            }),
          );
        },
        resolveAccount: async (accessToken) => {
          const response = await fetch("https://api.zoom.us/v2/users/me", {
            headers: { Authorization: `Bearer ${accessToken}` },
            cache: "no-store",
          });
          const data = (await response.json()) as {
            id?: string;
            email?: string;
            display_name?: string;
          };
          if (!response.ok || !data.id) {
            throw new Error("Failed to resolve Zoom user identity.");
          }
          return {
            providerAccountId: data.id,
            label: data.display_name || data.email,
          };
        },
      };
    case "apple":
      return {
        provider,
        clientIdEnv: "APPLE_CLIENT_ID",
        authorizationUrl: "https://appleid.apple.com/auth/authorize",
        tokenUrl: "https://appleid.apple.com/auth/token",
        defaultScopes: "name email",
        redirectPath: "/api/autobot/connections/apple/callback",
        authorizationParams: {
          response_mode: "form_post",
        },
        exchangeCode: async (code, redirectUri) => {
          const clientId = getRequiredEnv("APPLE_CLIENT_ID");
          const clientSecret = buildAppleClientSecret(clientId);
          const body = new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
          });
          return normalizeTokenResult(
            await exchangeOAuthForm("https://appleid.apple.com/auth/token", body),
          );
        },
        resolveAccount: async (_accessToken, tokenData) => {
          if (!tokenData.idToken) {
            throw new Error("Apple did not return an id_token.");
          }
          const payload = decodeJwtPayload(tokenData.idToken);
          const sub =
            typeof payload.sub === "string" && payload.sub.trim()
              ? payload.sub.trim()
              : "apple";
          const email =
            typeof payload.email === "string" ? payload.email : undefined;
          return {
            providerAccountId: sub,
            label: email,
          };
        },
      };
  }
}

export function buildOAuthAuthorizationUrl(
  provider: SupportedOAuthConnectorProvider,
  state: string,
): string {
  const config = getOAuthConnectorConfig(provider);
  const clientId = getRequiredEnv(config.clientIdEnv);
  const redirectUri = `${getConnectorBaseUrl()}${config.redirectPath}`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.defaultScopes,
    state,
  });
  for (const [key, value] of Object.entries(config.authorizationParams ?? {})) {
    params.set(key, value);
  }
  const separator = config.authorizationUrl.includes("?") ? "&" : "?";
  return `${config.authorizationUrl}${separator}${params.toString()}`;
}

export function getOAuthStateCookieName(
  provider: SupportedOAuthConnectorProvider,
): string {
  return `${provider}_oauth_state`;
}

export function getOAuthCookiePath(
  provider: SupportedOAuthConnectorProvider,
): string {
  return `/api/autobot/connections/${provider}`;
}

export async function exchangeConnectorOAuthCode(
  provider: SupportedOAuthConnectorProvider,
  code: string,
): Promise<OAuthTokenResult> {
  const config = getOAuthConnectorConfig(provider);
  const redirectUri = `${getConnectorBaseUrl()}${config.redirectPath}`;
  return config.exchangeCode(code, redirectUri);
}

export async function resolveConnectorAccountIdentity(
  provider: SupportedOAuthConnectorProvider,
  accessToken: string,
  tokenData: OAuthTokenResult,
): Promise<{ providerAccountId: string; label?: string }> {
  return getOAuthConnectorConfig(provider).resolveAccount(accessToken, tokenData);
}

export async function upsertConnectorOAuthAccount(
  userId: string,
  provider: SupportedOAuthConnectorProvider,
  tokenData: OAuthTokenResult,
  providerAccountId: string,
): Promise<void> {
  const expiresAt =
    typeof tokenData.expiresIn === "number"
      ? Math.floor(Date.now() / 1000) + tokenData.expiresIn
      : null;

  const [existingAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, provider)))
    .limit(1);

  const values = {
    providerAccountId,
    access_token: tokenData.accessToken,
    refresh_token: tokenData.refreshToken ?? null,
    expires_at: expiresAt,
    token_type: tokenData.tokenType ?? "bearer",
    scope: tokenData.scope ?? getOAuthConnectorConfig(provider).defaultScopes,
    id_token: tokenData.idToken ?? null,
    session_state: null,
  };

  if (existingAccount) {
    await db.update(accounts).set(values).where(eq(accounts.id, existingAccount.id));
    return;
  }

  await db.insert(accounts).values({
    userId,
    type: "oauth",
    provider,
    ...values,
  });
}
