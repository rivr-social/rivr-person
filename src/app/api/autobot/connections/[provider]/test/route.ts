import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";
import {
  AUTOBOT_CONNECTION_PROVIDER_SET,
  getAutobotConnectorDefinition,
  type AutobotConnectionProvider,
} from "@/lib/autobot-connectors";
import { validateBotToken } from "@/lib/autobot-telegram-sync";
import { testSlackConnection } from "@/lib/autobot-slack-sync";
import { testDiscordConnection } from "@/lib/autobot-discord-sync";
import { testDropboxConnection } from "@/lib/autobot-dropbox-sync";
import { testZoomConnection } from "@/lib/autobot-zoom-sync";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL = 500;

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

// ---------------------------------------------------------------------------
// Test helpers for providers that use simple OAuth token validation
// ---------------------------------------------------------------------------

async function testOAuthTokenValid(
  userId: string,
  oauthProvider: string,
  apiUrl: string,
  headers: (token: string) => Record<string, string>,
  resolveLabel: (data: Record<string, unknown>) => string | undefined,
): Promise<{ valid: boolean; label?: string; error?: string; testedAt: string }> {
  const testedAt = new Date().toISOString();
  const [account] = await db
    .select({ accessToken: accounts.access_token, expiresAt: accounts.expires_at })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, oauthProvider)))
    .limit(1);

  if (!account?.accessToken) {
    return {
      valid: false,
      error: `No ${oauthProvider} OAuth token found. Please reconnect.`,
      testedAt,
    };
  }

  // Check if token is expired
  if (account.expiresAt && account.expiresAt < Math.floor(Date.now() / 1000)) {
    return {
      valid: false,
      error: `${oauthProvider} token has expired. Please reconnect.`,
      testedAt,
    };
  }

  try {
    const response = await fetch(apiUrl, {
      headers: headers(account.accessToken),
      cache: "no-store",
    });

    if (!response.ok) {
      return {
        valid: false,
        error: `${oauthProvider} API returned ${response.status}. Token may be invalid or expired.`,
        testedAt,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    return {
      valid: true,
      label: resolveLabel(data),
      testedAt,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : `Failed to test ${oauthProvider}`,
      testedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// POST /api/autobot/connections/[provider]/test
// ---------------------------------------------------------------------------

export async function POST(_request: Request, context: RouteContext) {
  const session = await auth();
  const ownerId = session?.user?.id ?? null;
  if (!ownerId) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const subject = await resolveAutobotConnectionScope(ownerId);
  const actorId = subject.actorId;
  const { provider } = await context.params;

  if (!AUTOBOT_CONNECTION_PROVIDER_SET.has(provider as AutobotConnectionProvider)) {
    return NextResponse.json(
      { error: "Unknown connector" },
      { status: STATUS_NOT_FOUND, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const definition = getAutobotConnectorDefinition(provider as AutobotConnectionProvider);
  if (!definition) {
    return NextResponse.json(
      { error: "Unknown connector" },
      { status: STATUS_NOT_FOUND, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const settings = await getAutobotUserSettings(actorId);
  const connection = settings.connections.find((item) => item.provider === provider);

  try {
    let result: { valid: boolean; label?: string; error?: string; testedAt?: string };

    switch (provider) {
      case "google_docs":
      case "google_calendar":
        result = await testOAuthTokenValid(
          actorId,
          "google_workspace",
          "https://openidconnect.googleapis.com/v1/userinfo",
          (token) => ({ Authorization: `Bearer ${token}` }),
          (data) => {
            const name = typeof data.name === "string" ? data.name : undefined;
            const email = typeof data.email === "string" ? data.email : undefined;
            return name || email;
          },
        );
        break;

      case "notion":
        result = await testOAuthTokenValid(
          actorId,
          "notion",
          "https://api.notion.com/v1/users/me",
          (token) => ({
            Authorization: `Bearer ${token}`,
            "Notion-Version": "2022-06-28",
          }),
          (data) => {
            const name = typeof data.name === "string" ? data.name : undefined;
            return name;
          },
        );
        break;

      case "facebook":
        result = await testOAuthTokenValid(
          actorId,
          "facebook",
          "https://graph.facebook.com/v19.0/me?fields=id,name",
          (token) => ({ Authorization: `Bearer ${token}` }),
          (data) => {
            const name = typeof data.name === "string" ? data.name : undefined;
            return name;
          },
        );
        break;

      case "instagram":
        result = await testOAuthTokenValid(
          actorId,
          "instagram",
          "https://graph.instagram.com/me?fields=id,username",
          (token) => ({ Authorization: `Bearer ${token}` }),
          (data) => {
            const username = typeof data.username === "string" ? data.username : undefined;
            return username ? `@${username}` : undefined;
          },
        );
        break;

      case "slack":
        result = await testSlackConnection(actorId);
        break;

      case "discord":
        result = await testDiscordConnection(actorId);
        break;

      case "dropbox":
        result = await testDropboxConnection(actorId);
        break;

      case "zoom":
        result = await testZoomConnection(actorId);
        break;

      case "apple_sign_in":
        result = await testOAuthTokenValid(
          actorId,
          "apple",
          "https://appleid.apple.com/auth/token",
          () => ({}),
          () => undefined,
        );
        // Apple doesn't have a simple identity check endpoint -- just verify token exists
        {
          const [appleAccount] = await db
            .select({ accessToken: accounts.access_token })
            .from(accounts)
            .where(and(eq(accounts.userId, actorId), eq(accounts.provider, "apple")))
            .limit(1);
          result = {
            valid: Boolean(appleAccount?.accessToken),
            label: appleAccount?.accessToken ? "Apple account linked" : undefined,
            error: appleAccount?.accessToken ? undefined : "No Apple account linked.",
          };
        }
        break;

      case "telegram": {
        const botToken = connection?.config.botToken?.trim();
        if (!botToken) {
          result = { valid: false, error: "No bot token configured." };
          break;
        }
        try {
          const botUser = await validateBotToken(botToken);
          result = {
            valid: true,
            label: `@${botUser.username || botUser.first_name}`,
          };
        } catch (error) {
          result = {
            valid: false,
            error: error instanceof Error ? error.message : "Bot token validation failed.",
          };
        }
        break;
      }

      case "wolfram": {
        const licenseKey = connection?.config.licenseKey?.trim();
        if (!licenseKey) {
          result = { valid: false, error: "No Wolfram license key configured." };
          break;
        }
        const baseUrl = connection?.config.cloudBaseUrl?.trim() || "https://www.wolframcloud.com";
        try {
          const response = await fetch(`${baseUrl}/api/v1/me`, {
            headers: { Authorization: `Bearer ${licenseKey}` },
            cache: "no-store",
          });
          if (!response.ok) {
            result = { valid: false, error: `Wolfram API returned ${response.status}.` };
          } else {
            const data = (await response.json()) as Record<string, unknown>;
            result = {
              valid: true,
              label: typeof data.username === "string" ? data.username : "Wolfram",
            };
          }
        } catch (error) {
          result = {
            valid: false,
            error: error instanceof Error ? error.message : "Wolfram connection test failed.",
          };
        }
        break;
      }

      case "signal": {
        const serviceUrl = connection?.config.serviceUrl?.trim();
        if (!serviceUrl) {
          result = { valid: false, error: "No Signal service URL configured." };
          break;
        }
        try {
          const response = await fetch(`${serviceUrl}/v1/about`, { cache: "no-store" });
          result = {
            valid: response.ok,
            label: response.ok ? "Signal bridge reachable" : undefined,
            error: response.ok ? undefined : `Signal bridge returned ${response.status}.`,
          };
        } catch (error) {
          result = {
            valid: false,
            error: error instanceof Error ? error.message : "Signal bridge unreachable.",
          };
        }
        break;
      }

      case "whatsapp_business": {
        const phoneNumberId = connection?.config.phoneNumberId?.trim();
        if (!phoneNumberId) {
          result = { valid: false, error: "No WhatsApp phone number ID configured." };
          break;
        }
        const appSecret = process.env.WHATSAPP_APP_SECRET?.trim();
        if (!appSecret) {
          result = { valid: false, error: "WhatsApp app credentials not configured on this instance." };
          break;
        }
        result = { valid: true, label: `Phone: ${phoneNumberId}` };
        break;
      }

      case "obsidian_vault":
      case "parachute_vault": {
        const vaultPath = connection?.config.vaultPath?.trim();
        if (!vaultPath) {
          result = { valid: false, error: "No vault path configured." };
          break;
        }
        try {
          const { stat } = await import("node:fs/promises");
          const pathStat = await stat(vaultPath);
          result = {
            valid: pathStat.isDirectory(),
            label: vaultPath,
            error: pathStat.isDirectory() ? undefined : "Path exists but is not a directory.",
          };
        } catch {
          result = { valid: false, error: "Vault path does not exist on this instance." };
        }
        break;
      }

      case "messenger": {
        const exportPath = connection?.config.exportPath?.trim();
        if (!exportPath) {
          result = { valid: false, error: "No Messenger export path configured." };
          break;
        }
        try {
          const { stat } = await import("node:fs/promises");
          const pathStat = await stat(exportPath);
          result = {
            valid: pathStat.isDirectory(),
            label: exportPath,
            error: pathStat.isDirectory() ? undefined : "Path exists but is not a directory.",
          };
        } catch {
          result = { valid: false, error: "Export path does not exist on this instance." };
        }
        break;
      }

      case "proton_docs": {
        const workspaceId = connection?.config.workspaceId?.trim();
        result = {
          valid: Boolean(workspaceId),
          label: workspaceId || undefined,
          error: workspaceId ? undefined : "No workspace ID configured.",
        };
        break;
      }

      case "generic_oauth2": {
        const providerName = connection?.config.providerName?.trim() || "oauth2";
        const [oauthAccount] = await db
          .select({ accessToken: accounts.access_token })
          .from(accounts)
          .where(and(eq(accounts.userId, actorId), eq(accounts.provider, providerName)))
          .limit(1);
        result = {
          valid: Boolean(oauthAccount?.accessToken),
          label: oauthAccount?.accessToken ? providerName : undefined,
          error: oauthAccount?.accessToken ? undefined : `No ${providerName} token found. Please connect first.`,
        };
        break;
      }

      case "github": {
        const token = connection?.config.token?.trim();
        const repoUrl = connection?.config.repoUrl?.trim();
        if (!token) {
          result = { valid: false, error: "No GitHub token configured." };
          break;
        }
        const repoMatch = repoUrl?.match(/github\.com\/([^/]+)\/([^/]+)/);
        const apiUrl = repoMatch
          ? `https://api.github.com/repos/${repoMatch[1]}/${repoMatch[2]}`
          : "https://api.github.com/user";
        try {
          const ghResponse = await fetch(apiUrl, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
            cache: "no-store",
          });
          if (!ghResponse.ok) {
            result = {
              valid: false,
              error: `GitHub API returned ${ghResponse.status}. Token may be invalid or expired.`,
            };
          } else {
            const ghData = (await ghResponse.json()) as Record<string, unknown>;
            const label = typeof ghData.full_name === "string"
              ? ghData.full_name
              : typeof ghData.login === "string"
                ? ghData.login
                : "GitHub";
            result = { valid: true, label };
          }
        } catch (error) {
          result = {
            valid: false,
            error: error instanceof Error ? error.message : "GitHub connection test failed.",
          };
        }
        break;
      }

      case "email_smtp": {
        const smtpHost = connection?.config.smtpHost?.trim();
        const smtpPort = connection?.config.smtpPort?.trim();
        const smtpUser = connection?.config.smtpUser?.trim();
        if (!smtpHost || !smtpPort || !smtpUser) {
          result = {
            valid: false,
            error: "SMTP host, port, and username are required.",
          };
          break;
        }
        // Basic TCP connectivity test using DNS resolution of SMTP host
        try {
          const { resolve: dnsResolve } = await import("dns/promises");
          await dnsResolve(smtpHost);
          result = {
            valid: true,
            label: `${smtpUser} via ${smtpHost}:${smtpPort}`,
          };
        } catch {
          result = {
            valid: false,
            error: `Cannot resolve SMTP host: ${smtpHost}`,
          };
        }
        break;
      }

      case "matrix": {
        const homeserverUrl = connection?.config.homeserverUrl?.trim();
        const matrixToken = connection?.config.accessToken?.trim();
        if (!homeserverUrl || !matrixToken) {
          result = {
            valid: false,
            error: "Homeserver URL and access token are required.",
          };
          break;
        }
        try {
          const matrixResponse = await fetch(
            `${homeserverUrl}/_matrix/client/v3/account/whoami`,
            {
              headers: { Authorization: `Bearer ${matrixToken}` },
              cache: "no-store",
            },
          );
          if (!matrixResponse.ok) {
            result = {
              valid: false,
              error: `Matrix API returned ${matrixResponse.status}. Check your token.`,
            };
          } else {
            const matrixData = (await matrixResponse.json()) as { user_id?: string };
            result = {
              valid: true,
              label: typeof matrixData.user_id === "string" ? matrixData.user_id : "Matrix",
            };
          }
        } catch (error) {
          result = {
            valid: false,
            error: error instanceof Error ? error.message : "Matrix connection test failed.",
          };
        }
        break;
      }

      case "mastodon": {
        const instanceUrl = connection?.config.instanceUrl?.trim();
        if (!instanceUrl) {
          result = { valid: false, error: "No Mastodon instance URL configured." };
          break;
        }
        try {
          const mastoResponse = await fetch(`${instanceUrl}/api/v1/instance`, {
            cache: "no-store",
          });
          if (!mastoResponse.ok) {
            result = {
              valid: false,
              error: `Mastodon instance returned ${mastoResponse.status}.`,
            };
          } else {
            const mastoData = (await mastoResponse.json()) as { title?: string; uri?: string };
            result = {
              valid: true,
              label: typeof mastoData.title === "string" ? mastoData.title : mastoData.uri,
            };
          }
        } catch (error) {
          result = {
            valid: false,
            error: error instanceof Error ? error.message : "Mastodon instance unreachable.",
          };
        }
        break;
      }

      case "bluesky": {
        const handle = connection?.config.handle?.trim();
        const appPassword = connection?.config.appPassword?.trim();
        if (!handle || !appPassword) {
          result = { valid: false, error: "Handle and app password are required." };
          break;
        }
        const pdsUrl = connection?.config.pdsUrl?.trim() || "https://bsky.social";
        try {
          const bskyResponse = await fetch(
            `${pdsUrl}/xrpc/com.atproto.server.createSession`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ identifier: handle, password: appPassword }),
              cache: "no-store",
            },
          );
          if (!bskyResponse.ok) {
            result = {
              valid: false,
              error: `Bluesky auth failed (${bskyResponse.status}). Check handle and app password.`,
            };
          } else {
            const bskyData = (await bskyResponse.json()) as {
              handle?: string;
              displayName?: string;
            };
            result = {
              valid: true,
              label: bskyData.displayName || bskyData.handle || handle,
            };
          }
        } catch (error) {
          result = {
            valid: false,
            error: error instanceof Error ? error.message : "Bluesky connection test failed.",
          };
        }
        break;
      }

      default:
        result = {
          valid: false,
          error: `Connection test is not implemented for ${definition.label} yet.`,
        };
    }

    return NextResponse.json(
      {
        provider,
        ...result,
        testedAt: result.testedAt ?? new Date().toISOString(),
      },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connection test failed";
    return NextResponse.json(
      {
        provider,
        valid: false,
        error: message,
        testedAt: new Date().toISOString(),
      },
      { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
