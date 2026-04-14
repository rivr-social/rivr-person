import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
} from "@/lib/autobot-user-settings";
import {
  AUTOBOT_CONNECTION_PROVIDER_SET,
  getAutobotConnectorDefinition,
  type AutobotConnection,
  type AutobotConnectionProvider,
} from "@/lib/autobot-connectors";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";
import { validateBotToken } from "@/lib/autobot-telegram-sync";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

type SetupBody = {
  accountLabel?: string;
  externalAccountId?: string;
  syncDirection?: AutobotConnection["syncDirection"];
  config?: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeConfig(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, rawValue]) =>
      typeof rawValue === "string" ? [[key, rawValue.trim()]] : [],
    ),
  );
}

function upsertConnection(
  connections: AutobotConnection[],
  nextConnection: AutobotConnection,
): AutobotConnection[] {
  const existing = connections.some(
    (connection) => connection.provider === nextConnection.provider,
  );

  if (existing) {
    return connections.map((connection) =>
      connection.provider === nextConnection.provider ? nextConnection : connection,
    );
  }

  return [...connections, nextConnection].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}

function ensureHttpUrl(value: string, label: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${label} must start with http:// or https://.`);
  }

  return trimmed;
}

async function ensureExistingPath(pathValue: string, label: string): Promise<string> {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    throw new Error(`${label} is required.`);
  }

  const pathStat = await stat(trimmed).catch(() => null);
  if (!pathStat) {
    throw new Error(`${label} does not exist on this instance.`);
  }

  return trimmed;
}

export async function POST(request: Request, context: RouteContext) {
  const session = await auth();
  const ownerId = session?.user?.id ?? null;
  if (!ownerId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const subject = await resolveAutobotConnectionScope(ownerId);
  const actorId = subject.actorId;
  const { provider } = await context.params;
  if (!AUTOBOT_CONNECTION_PROVIDER_SET.has(provider as AutobotConnectionProvider)) {
    return NextResponse.json({ error: "Unknown connector" }, { status: 404 });
  }
  const definition = getAutobotConnectorDefinition(
    provider as AutobotConnectionProvider,
  );

  if (!definition) {
    return NextResponse.json({ error: "Unknown connector" }, { status: 404 });
  }

  let body: SetupBody;
  try {
    body = (await request.json()) as SetupBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const settings = await getAutobotUserSettings(actorId);
  const existingConnection = settings.connections.find(
    (connection) => connection.provider === definition.provider,
  );
  const config = {
    ...(existingConnection?.config ?? {}),
    ...normalizeConfig(body.config),
  };

  let status: AutobotConnection["status"] = "connected";
  let accountLabel =
    typeof body.accountLabel === "string" && body.accountLabel.trim()
      ? body.accountLabel.trim()
      : existingConnection?.accountLabel;
  let externalAccountId =
    typeof body.externalAccountId === "string" && body.externalAccountId.trim()
      ? body.externalAccountId.trim()
      : existingConnection?.externalAccountId;

  try {
    switch (definition.provider) {
      case "telegram": {
        const botToken = config.botToken?.trim();
        if (!botToken) {
          throw new Error("Telegram bot token is required.");
        }
        const botUser = await validateBotToken(botToken);
        if (config.chatId?.trim()) {
          externalAccountId = config.chatId.trim();
        } else {
          externalAccountId = externalAccountId ?? String(botUser.id);
        }
        accountLabel =
          accountLabel ??
          `@${botUser.username?.trim() || botUser.first_name?.trim() || "Telegram Bot"}`;
        break;
      }
      case "whatsapp_business": {
        if (!process.env.WHATSAPP_APP_ID?.trim() || !process.env.WHATSAPP_APP_SECRET?.trim()) {
          throw new Error("WhatsApp Business app credentials are not configured on this instance.");
        }
        if (!config.phoneNumberId?.trim()) {
          throw new Error("WhatsApp phone number ID is required.");
        }
        if (!config.businessAccountId?.trim()) {
          throw new Error("WhatsApp business account ID is required.");
        }
        if (!config.verifyToken?.trim()) {
          throw new Error("WhatsApp verify token is required.");
        }
        accountLabel = accountLabel ?? "WhatsApp Business";
        externalAccountId = externalAccountId ?? config.phoneNumberId.trim();
        status = "needs_auth";
        break;
      }
      case "signal": {
        const serviceUrl = config.serviceUrl?.trim();
        if (!serviceUrl) {
          throw new Error("Signal service URL is required.");
        }
        config.serviceUrl = ensureHttpUrl(serviceUrl, "Signal service URL");
        if (!config.phoneNumber?.trim()) {
          throw new Error("Signal phone number is required.");
        }
        accountLabel = accountLabel ?? "Signal";
        externalAccountId = externalAccountId ?? config.phoneNumber.trim();
        break;
      }
      case "obsidian_vault": {
        config.vaultPath = await ensureExistingPath(
          config.vaultPath ?? "",
          "Obsidian vault path",
        );
        accountLabel = accountLabel ?? "Obsidian Vault";
        externalAccountId = externalAccountId ?? config.vaultPath;
        break;
      }
      case "parachute_vault": {
        config.vaultPath = await ensureExistingPath(
          config.vaultPath ?? "",
          "Parachute vault path",
        );
        accountLabel = accountLabel ?? "Parachute Vault";
        externalAccountId = externalAccountId ?? config.vaultPath;
        break;
      }
      case "messenger": {
        config.exportPath = await ensureExistingPath(
          config.exportPath ?? "",
          "Messenger export path",
        );
        if (!config.accountEmail?.trim()) {
          throw new Error("Messenger account email is required.");
        }
        accountLabel = accountLabel ?? "Messenger";
        externalAccountId = externalAccountId ?? config.accountEmail.trim();
        break;
      }
      case "proton_docs": {
        if (!config.workspaceId?.trim()) {
          throw new Error("Proton workspace ID is required.");
        }
        accountLabel = accountLabel ?? "Proton Docs";
        externalAccountId = externalAccountId ?? config.workspaceId.trim();
        status = "needs_auth";
        break;
      }
      case "wolfram": {
        if (!config.licenseKey?.trim()) {
          throw new Error("Wolfram license key is required.");
        }
        if (config.cloudBaseUrl?.trim()) {
          config.cloudBaseUrl = ensureHttpUrl(
            config.cloudBaseUrl,
            "Wolfram cloud base URL",
          );
        }
        accountLabel = accountLabel ?? "Wolfram";
        externalAccountId =
          externalAccountId ??
          config.appId?.trim() ??
          config.cloudBaseUrl?.trim() ??
          "wolfram";
        break;
      }
      case "github": {
        const repoUrl = config.repoUrl?.trim();
        if (!repoUrl) {
          throw new Error("Repository URL is required.");
        }
        const repoMatch = repoUrl.match(
          /github\.com\/([^/]+)\/([^/]+)/,
        );
        if (!repoMatch) {
          throw new Error("Repository URL must be a valid GitHub URL (e.g. https://github.com/owner/repo).");
        }
        const token = config.token?.trim();
        if (!token) {
          throw new Error("Personal Access Token is required.");
        }
        // Validate token by hitting the GitHub API
        const ghResponse = await fetch(
          `https://api.github.com/repos/${repoMatch[1]}/${repoMatch[2]}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
            },
            cache: "no-store",
          },
        );
        if (!ghResponse.ok) {
          throw new Error(
            `GitHub API returned ${ghResponse.status}. Check your token and repo URL.`,
          );
        }
        const ghRepo = (await ghResponse.json()) as { full_name?: string };
        accountLabel = accountLabel ?? ghRepo.full_name ?? `${repoMatch[1]}/${repoMatch[2]}`;
        externalAccountId = externalAccountId ?? `${repoMatch[1]}/${repoMatch[2]}`;
        config.branch = config.branch?.trim() || "main";
        break;
      }
      case "email_smtp": {
        const smtpHost = config.smtpHost?.trim();
        if (!smtpHost) {
          throw new Error("SMTP host is required.");
        }
        const smtpPort = config.smtpPort?.trim();
        if (!smtpPort || !/^\d+$/.test(smtpPort)) {
          throw new Error("SMTP port must be a number (e.g. 587 or 465).");
        }
        const smtpUser = config.smtpUser?.trim();
        if (!smtpUser) {
          throw new Error("SMTP username is required.");
        }
        if (!config.smtpPass?.trim()) {
          throw new Error("SMTP password is required.");
        }
        const fromAddress = config.fromAddress?.trim();
        accountLabel = accountLabel ?? fromAddress ?? smtpUser;
        externalAccountId = externalAccountId ?? smtpUser;
        break;
      }
      case "matrix": {
        const homeserverUrl = config.homeserverUrl?.trim();
        if (!homeserverUrl) {
          throw new Error("Homeserver URL is required.");
        }
        config.homeserverUrl = ensureHttpUrl(homeserverUrl, "Homeserver URL");
        if (!config.userId?.trim()) {
          throw new Error("User ID is required (e.g. @user:matrix.org).");
        }
        if (!config.accessToken?.trim()) {
          throw new Error("Access token is required.");
        }
        // Validate by calling the whoami endpoint
        const matrixResponse = await fetch(
          `${config.homeserverUrl}/_matrix/client/v3/account/whoami`,
          {
            headers: { Authorization: `Bearer ${config.accessToken.trim()}` },
            cache: "no-store",
          },
        );
        if (!matrixResponse.ok) {
          throw new Error(
            `Matrix whoami returned ${matrixResponse.status}. Check your homeserver URL and access token.`,
          );
        }
        const matrixData = (await matrixResponse.json()) as { user_id?: string };
        accountLabel = accountLabel ?? matrixData.user_id ?? config.userId.trim();
        externalAccountId = externalAccountId ?? matrixData.user_id ?? config.userId.trim();
        break;
      }
      case "mastodon": {
        const instanceUrl = config.instanceUrl?.trim();
        if (!instanceUrl) {
          throw new Error("Instance URL is required.");
        }
        config.instanceUrl = ensureHttpUrl(instanceUrl, "Mastodon instance URL");
        if (!config.clientId?.trim()) {
          throw new Error("Client ID is required.");
        }
        if (!config.clientSecret?.trim()) {
          throw new Error("Client secret is required.");
        }
        accountLabel = accountLabel ?? config.instanceUrl;
        externalAccountId = externalAccountId ?? config.instanceUrl;
        // Mastodon OAuth needs full connect flow; mark as needs_auth
        status = "needs_auth";
        break;
      }
      case "bluesky": {
        const handle = config.handle?.trim();
        if (!handle) {
          throw new Error("Bluesky handle is required.");
        }
        const appPassword = config.appPassword?.trim();
        if (!appPassword) {
          throw new Error("App password is required.");
        }
        const pdsUrl = config.pdsUrl?.trim() || "https://bsky.social";
        // Validate by creating a session
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
          const bskyError = await bskyResponse.text();
          throw new Error(
            `Bluesky authentication failed (${bskyResponse.status}): ${bskyError.slice(0, 200)}`,
          );
        }
        const bskyData = (await bskyResponse.json()) as {
          did?: string;
          handle?: string;
          displayName?: string;
        };
        config.pdsUrl = pdsUrl;
        accountLabel = accountLabel ?? bskyData.displayName ?? bskyData.handle ?? handle;
        externalAccountId = externalAccountId ?? bskyData.did ?? handle;
        break;
      }
      default: {
        status = existingConnection?.status ?? "needs_auth";
      }
    }
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Connector setup failed.",
      },
      { status: 400 },
    );
  }

  const nextConnection: AutobotConnection = {
    provider: definition.provider,
    status,
    syncDirection:
      body.syncDirection ??
      existingConnection?.syncDirection ??
      "import",
    modules: existingConnection?.modules ?? definition.modules,
    accountLabel,
    externalAccountId,
    lastSyncedAt: existingConnection?.lastSyncedAt,
    error: undefined,
    config,
  };

  const nextSettings = await saveAutobotUserSettings(actorId, {
    connections: upsertConnection(settings.connections, nextConnection),
  });

  return NextResponse.json({
    ok: true,
    connection: nextConnection,
    connections: nextSettings.connections,
    subject,
  });
}
