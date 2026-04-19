export type AutobotConnectionProvider =
  | "teller"
  | "google_docs"
  | "google_calendar"
  | "proton_docs"
  | "notion"
  | "parachute_vault"
  | "obsidian_vault"
  | "messenger"
  | "telegram"
  | "whatsapp_business"
  | "apple_sign_in"
  | "slack"
  | "discord"
  | "dropbox"
  | "zoom"
  | "signal"
  | "facebook"
  | "instagram"
  | "wolfram"
  | "github"
  | "email_smtp"
  | "matrix"
  | "mastodon"
  | "bluesky"
  | "generic_oauth2";

export type AutobotConnectionModule =
  | "docs"
  | "calendar"
  | "messages"
  | "media"
  | "kg"
  | "groups"
  | "wallet";

export type AutobotConnectionAuthStrategy =
  | "oauth2"
  | "interactive"
  | "api_key"
  | "token"
  | "phone"
  | "filesystem"
  | "manual";

export type AutobotConnectionStatus =
  | "disconnected"
  | "connected"
  | "needs_auth"
  | "error";

export type AutobotSyncDirection = "import" | "export" | "bidirectional";

export interface AutobotConnectorDefinition {
  provider: AutobotConnectionProvider;
  label: string;
  description: string;
  authStrategy: AutobotConnectionAuthStrategy;
  authProvider?: string;
  modules: AutobotConnectionModule[];
  capabilities: string[];
  configHints: string[];
  supportsSync: boolean;
}

export interface AutobotConnection {
  provider: AutobotConnectionProvider;
  status: AutobotConnectionStatus;
  syncDirection: AutobotSyncDirection;
  modules: AutobotConnectionModule[];
  accountLabel?: string;
  externalAccountId?: string;
  lastSyncedAt?: string;
  error?: string;
  config: Record<string, string>;
}

export const AUTOBOT_CONNECTOR_DEFINITIONS: AutobotConnectorDefinition[] = [
  {
    provider: "teller",
    label: "Teller Bank Accounts",
    description:
      "Person-level bank connection for wallet balances and supported transfers, available from Connections settings.",
    authStrategy: "interactive",
    authProvider: "teller_bank",
    modules: ["wallet"],
    capabilities: ["link_accounts", "read_balances", "initiate_payments"],
    configHints: ["defaultSourceAccountId", "defaultPayeeAddress"],
    supportsSync: true,
  },
  {
    provider: "google_docs",
    label: "Google Docs",
    description: "Two-way document sync, including structured doc imports for KG ingestion.",
    authStrategy: "oauth2",
    authProvider: "google",
    modules: ["docs", "kg"],
    capabilities: ["read_docs", "write_docs", "sync_tabs", "kg_ingest"],
    configHints: ["folderId", "defaultDocId", "maxResults"],
    supportsSync: true,
  },
  {
    provider: "google_calendar",
    label: "Google Calendar",
    description: "Calendar sync between Rivr events/tasks and Google Calendar.",
    authStrategy: "oauth2",
    authProvider: "google",
    modules: ["calendar"],
    capabilities: ["read_calendar", "write_calendar", "sync_events"],
    configHints: ["calendarId", "maxResults", "timeMin", "timeMax"],
    supportsSync: true,
  },
  {
    provider: "proton_docs",
    label: "Proton Docs",
    description: "Connect Proton Drive/Docs workspaces for document import and future sync.",
    authStrategy: "manual",
    modules: ["docs", "kg"],
    capabilities: ["read_docs", "kg_ingest"],
    configHints: ["workspaceId", "notes"],
    supportsSync: true,
  },
  {
    provider: "notion",
    label: "Notion",
    description: "Import and sync Notion pages and databases into docs and KG.",
    authStrategy: "oauth2",
    authProvider: "notion",
    modules: ["docs", "kg"],
    capabilities: ["read_pages", "write_pages", "kg_ingest"],
    configHints: ["workspaceId", "rootPageId"],
    supportsSync: true,
  },
  {
    provider: "parachute_vault",
    label: "Parachute Vault",
    description: "Connect a Parachute knowledge vault as a file-backed document source.",
    authStrategy: "filesystem",
    modules: ["docs", "kg", "media"],
    capabilities: ["read_files", "ingest_markdown", "ingest_media"],
    configHints: ["vaultPath"],
    supportsSync: true,
  },
  {
    provider: "obsidian_vault",
    label: "Obsidian Vault",
    description: "Attach an Obsidian vault for markdown import, backlink parsing, and KG sync.",
    authStrategy: "filesystem",
    modules: ["docs", "kg", "media"],
    capabilities: ["read_markdown", "read_attachments", "kg_ingest"],
    configHints: ["vaultPath"],
    supportsSync: true,
  },
  {
    provider: "messenger",
    label: "Messenger Threads",
    description: "Import Messenger threads as structured conversation docs for KG parsing.",
    authStrategy: "manual",
    modules: ["messages", "kg", "docs"],
    capabilities: ["import_threads", "kg_ingest", "participant_mapping"],
    configHints: ["exportPath", "accountEmail"],
    supportsSync: true,
  },
  {
    provider: "telegram",
    label: "Telegram",
    description: "Connect groups, communities, or sub-channels to Rivr groups and messages.",
    authStrategy: "phone",
    modules: ["messages", "groups", "kg"],
    capabilities: ["read_messages", "write_messages", "link_channels", "kg_ingest"],
    configHints: ["phoneNumber", "chatId", "threadId", "botToken"],
    supportsSync: true,
  },
  {
    provider: "whatsapp_business",
    label: "WhatsApp Business",
    description: "Connect a WhatsApp Business phone number, webhook, and Meta app for group and customer messaging flows.",
    authStrategy: "manual",
    modules: ["messages", "groups", "kg"],
    capabilities: ["read_messages", "write_messages", "link_phone_number", "webhook_ingest"],
    configHints: ["phoneNumberId", "businessAccountId", "verifyToken", "webhookSecret"],
    supportsSync: false,
  },
  {
    provider: "apple_sign_in",
    label: "Apple Sign In",
    description: "Configure Sign in with Apple for person-instance identity, gated account linking, and future service federation.",
    authStrategy: "oauth2",
    authProvider: "apple",
    modules: ["messages", "media"],
    capabilities: ["identity_login", "oauth_bootstrap"],
    configHints: ["servicesId", "teamId", "keyId", "redirectUri"],
    supportsSync: false,
  },
  {
    provider: "slack",
    label: "Slack",
    description: "Prepare workspace OAuth and channel permissions for message import, posting, and knowledge ingestion.",
    authStrategy: "oauth2",
    authProvider: "slack",
    modules: ["messages", "groups", "kg"],
    capabilities: ["read_messages", "write_messages", "link_channels", "kg_ingest"],
    configHints: ["workspaceId", "channelId", "botScopes"],
    supportsSync: true,
  },
  {
    provider: "discord",
    label: "Discord",
    description: "Set up Discord OAuth and bot permissions for servers, channels, and inbound message context.",
    authStrategy: "oauth2",
    authProvider: "discord",
    modules: ["messages", "groups", "kg"],
    capabilities: ["read_messages", "write_messages", "link_channels", "kg_ingest"],
    configHints: ["guildId", "channelId", "botScopes"],
    supportsSync: true,
  },
  {
    provider: "dropbox",
    label: "Dropbox",
    description: "Connect Dropbox as a file-backed docs and media source for imports, attachments, and KG ingestion.",
    authStrategy: "oauth2",
    authProvider: "dropbox",
    modules: ["docs", "media", "kg"],
    capabilities: ["read_files", "read_media", "kg_ingest"],
    configHints: ["appKey", "appSecret", "rootPath"],
    supportsSync: true,
  },
  {
    provider: "zoom",
    label: "Zoom",
    description: "Configure Zoom OAuth for meetings, transcripts, recordings, and calendar-linked scheduling flows.",
    authStrategy: "oauth2",
    authProvider: "zoom",
    modules: ["calendar", "messages", "media"],
    capabilities: ["read_meetings", "write_meetings", "ingest_recordings"],
    configHints: ["accountId", "meetingScopes", "webhookSecret"],
    supportsSync: true,
  },
  {
    provider: "signal",
    label: "Signal",
    description: "Attach a Signal bridge or service endpoint for secure message ingestion and outbound notifications.",
    authStrategy: "manual",
    modules: ["messages", "kg"],
    capabilities: ["read_messages", "write_messages", "secure_notifications"],
    configHints: ["serviceUrl", "phoneNumber", "deviceName"],
    supportsSync: false,
  },
  {
    provider: "facebook",
    label: "Facebook",
    description: "Link Facebook identity and pages for future social publishing and ingestion.",
    authStrategy: "oauth2",
    authProvider: "facebook",
    modules: ["messages", "media", "kg"],
    capabilities: ["read_posts", "write_posts", "kg_ingest"],
    configHints: ["pageId"],
    supportsSync: true,
  },
  {
    provider: "instagram",
    label: "Instagram",
    description: "Link Instagram identity for media publishing and inbound content ingestion.",
    authStrategy: "oauth2",
    authProvider: "instagram",
    modules: ["media", "kg"],
    capabilities: ["read_media", "write_media", "kg_ingest"],
    configHints: ["accountId"],
    supportsSync: true,
  },
  {
    provider: "wolfram",
    label: "Wolfram",
    description: "Attach Wolfram credentials/runtime for symbolic computation and knowledge tools.",
    authStrategy: "token",
    modules: ["kg"],
    capabilities: ["query_engine", "symbolic_compute"],
    configHints: ["licenseKey", "cloudBaseUrl"],
    supportsSync: true,
  },
  {
    provider: "github",
    label: "GitHub",
    description: "Connect a GitHub account for builder deploy, repository access, and code-related agent context.",
    authStrategy: "token",
    modules: ["docs", "kg"],
    capabilities: ["deploy_site", "read_repos", "push_commits", "kg_ingest"],
    configHints: ["repoUrl", "branch", "token", "basePath"],
    supportsSync: false,
  },
  {
    provider: "email_smtp",
    label: "Email / SMTP",
    description: "Configure SMTP credentials for outbound email and optional IMAP for inbound message ingestion.",
    authStrategy: "token",
    modules: ["messages"],
    capabilities: ["send_email", "read_email", "notifications"],
    configHints: ["smtpHost", "smtpPort", "smtpUser", "smtpPass", "imapHost", "fromAddress"],
    supportsSync: false,
  },
  {
    provider: "matrix",
    label: "Matrix",
    description: "Connect a Matrix homeserver for federated messaging, room bridging, and message context ingestion.",
    authStrategy: "token",
    modules: ["messages", "groups", "kg"],
    capabilities: ["read_messages", "write_messages", "link_rooms", "kg_ingest"],
    configHints: ["homeserverUrl", "userId", "accessToken", "roomId"],
    supportsSync: false,
  },
  {
    provider: "mastodon",
    label: "Mastodon",
    description: "Link a Mastodon account for federated social publishing, timeline ingestion, and identity verification.",
    authStrategy: "oauth2",
    authProvider: "mastodon",
    modules: ["messages", "media", "kg"],
    capabilities: ["read_timeline", "write_posts", "verify_identity", "kg_ingest"],
    configHints: ["instanceUrl", "clientId", "clientSecret"],
    supportsSync: false,
  },
  {
    provider: "bluesky",
    label: "Bluesky",
    description: "Link a Bluesky / AT Protocol account for social publishing, feed ingestion, and identity verification.",
    authStrategy: "token",
    modules: ["messages", "media", "kg"],
    capabilities: ["read_feed", "write_posts", "verify_identity", "kg_ingest"],
    configHints: ["handle", "appPassword", "pdsUrl"],
    supportsSync: false,
  },
  {
    provider: "generic_oauth2",
    label: "Generic OAuth2",
    description: "Store a generic OAuth2 connector definition for future app/service integrations.",
    authStrategy: "oauth2",
    authProvider: "oauth2",
    modules: ["docs", "calendar", "messages", "media", "kg"],
    capabilities: ["oauth_bootstrap"],
    configHints: ["providerName", "authUrl", "tokenUrl", "scopes"],
    supportsSync: true,
  },
];

export const AUTOBOT_CONNECTION_PROVIDER_SET = new Set(
  AUTOBOT_CONNECTOR_DEFINITIONS.map((definition) => definition.provider),
);

export const AUTOBOT_CONNECTION_MODULE_SET = new Set<AutobotConnectionModule>([
  "docs",
  "calendar",
  "messages",
  "media",
  "kg",
  "groups",
  "wallet",
]);

export function getAutobotConnectorDefinition(
  provider: AutobotConnectionProvider,
): AutobotConnectorDefinition | undefined {
  return AUTOBOT_CONNECTOR_DEFINITIONS.find(
    (definition) => definition.provider === provider,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeAutobotConnection(
  input: unknown,
): AutobotConnection | null {
  if (!isRecord(input)) return null;
  if (
    typeof input.provider !== "string" ||
    !AUTOBOT_CONNECTION_PROVIDER_SET.has(
      input.provider as AutobotConnectionProvider,
    )
  ) {
    return null;
  }

  const definition = getAutobotConnectorDefinition(
    input.provider as AutobotConnectionProvider,
  );
  if (!definition) return null;

  const rawConfig = isRecord(input.config) ? input.config : {};
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawConfig)) {
    if (typeof value === "string" && value.trim()) {
      config[key] = value.trim().slice(0, 1000);
    }
  }

  const modules = Array.isArray(input.modules)
    ? input.modules.filter(
        (module): module is AutobotConnectionModule =>
          typeof module === "string" &&
          AUTOBOT_CONNECTION_MODULE_SET.has(module as AutobotConnectionModule),
      )
    : definition.modules;

  return {
    provider: definition.provider,
    status:
      input.status === "connected" ||
      input.status === "needs_auth" ||
      input.status === "error"
        ? input.status
        : "disconnected",
    syncDirection:
      input.syncDirection === "export" || input.syncDirection === "bidirectional"
        ? input.syncDirection
        : "import",
    modules: modules.length > 0 ? modules : definition.modules,
    accountLabel:
      typeof input.accountLabel === "string" && input.accountLabel.trim()
        ? input.accountLabel.trim().slice(0, 200)
        : undefined,
    externalAccountId:
      typeof input.externalAccountId === "string" && input.externalAccountId.trim()
        ? input.externalAccountId.trim().slice(0, 200)
        : undefined,
    lastSyncedAt:
      typeof input.lastSyncedAt === "string" && input.lastSyncedAt.trim()
        ? input.lastSyncedAt.trim()
        : undefined,
    error:
      typeof input.error === "string" && input.error.trim()
        ? input.error.trim().slice(0, 500)
        : undefined,
    config,
  };
}

export function sanitizeAutobotConnections(input: unknown): AutobotConnection[] {
  if (!Array.isArray(input)) return [];

  const deduped = new Map<AutobotConnectionProvider, AutobotConnection>();
  for (const item of input) {
    const connection = sanitizeAutobotConnection(item);
    if (connection) {
      deduped.set(connection.provider, connection);
    }
  }
  return Array.from(deduped.values());
}
