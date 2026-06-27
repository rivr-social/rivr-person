/**
 * Connector sync lane runner.
 *
 * This is the single, scope-aware execution path for triggering an autobot
 * connector sync lane (Notion, Google Drive/Calendar, Slack, Discord, etc.).
 * It is shared by two callers:
 *
 *   1. `POST /api/autobot/connections/[provider]/sync` — the settings UI's
 *      "Sync now" button.
 *   2. The `rivr.connectors.sync` MCP tool — so the already-wired autobot chat
 *      tool-use loop can drive the same lanes the UI exposes.
 *
 * The runner reads/writes the connector lane belonging to a SINGLE actor id
 * (the resolved agent/persona). It never reads an ambient session — the caller
 * passes the actor id it already authorized (route: resolved connection scope;
 * MCP: the execution context's `actorId`). That keeps the credential-bearing
 * lane scoped to the authorized principal.
 */

import type { AutobotConnection } from "@/lib/autobot-connectors";
import { getAutobotConnectorDefinition } from "@/lib/autobot-connectors";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
} from "@/lib/autobot-user-settings";
import {
  syncGoogleCalendarConnection,
  syncGoogleDocsConnection,
  type ConnectorSyncResult,
} from "@/lib/autobot-google-sync";
import { syncNotionConnection } from "@/lib/autobot-notion-sync";
import { syncTelegramConnection } from "@/lib/autobot-telegram-sync";
import { syncMessengerConnection } from "@/lib/autobot-messenger-sync";
import { syncFacebookConnection } from "@/lib/autobot-facebook-sync";
import { syncInstagramConnection } from "@/lib/autobot-instagram-sync";
import { syncObsidianConnection } from "@/lib/autobot-obsidian-sync";
import { syncParachuteConnection } from "@/lib/autobot-parachute-sync";
import { syncProtonConnection } from "@/lib/autobot-proton-sync";
import { syncWolframConnection } from "@/lib/autobot-wolfram-sync";
import { syncGenericOAuth2Connection } from "@/lib/autobot-generic-oauth2";
import { syncSlackConnection } from "@/lib/autobot-slack-sync";
import { syncDiscordConnection } from "@/lib/autobot-discord-sync";
import { syncDropboxConnection } from "@/lib/autobot-dropbox-sync";
import { syncZoomConnection } from "@/lib/autobot-zoom-sync";
import { ingestSyncedResources } from "@/lib/kg/connector-ingest";
import type { ConnectorIngestResult } from "@/lib/kg/connector-ingest";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Connection state set after a successful sync run. */
const CONNECTION_STATUS_CONNECTED = "connected" as const;
/** Connection state set after a failed sync run. */
const CONNECTION_STATUS_ERROR = "error" as const;

/** Stable failure codes so callers (route + MCP tool) can branch precisely. */
export const CONNECTOR_SYNC_FAILURE = {
  /** The provider string is not a known autobot connector. */
  UNKNOWN_PROVIDER: "UNKNOWN_PROVIDER",
  /** The actor has not configured a connection for this provider. */
  NOT_CONFIGURED: "NOT_CONFIGURED",
  /** The provider is known + configured but has no sync lane implementation. */
  SYNC_UNSUPPORTED: "SYNC_UNSUPPORTED",
  /** The lane ran but threw (auth expired, provider API error, etc.). */
  SYNC_FAILED: "SYNC_FAILED",
} as const;

export type ConnectorSyncFailureCode =
  (typeof CONNECTOR_SYNC_FAILURE)[keyof typeof CONNECTOR_SYNC_FAILURE];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when a connector sync cannot run or fails. Carries a stable
 * {@link ConnectorSyncFailureCode} so the route can map it to an HTTP status
 * and the MCP tool can surface a structured error.
 */
export class ConnectorSyncError extends Error {
  constructor(
    message: string,
    readonly code: ConnectorSyncFailureCode,
  ) {
    super(message);
    this.name = "ConnectorSyncError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunConnectorSyncResult {
  result: ConnectorSyncResult;
  kgIngest: ConnectorIngestResult | null;
  connections: AutobotConnection[];
}

/**
 * Build the provider → sync-lane dispatch table for a given actor + resolved
 * connection. Each entry returns a `ConnectorSyncResult`.
 *
 * Sync backend note (messenger-class providers): telegram, whatsapp_business,
 * signal, slack, facebook, and instagram are intended to sync via mautrix
 * bridges on RIVR's Matrix/Synapse infra, not bespoke per-provider polling.
 * Providers whose message sync is delegated to a bridge intentionally have NO
 * entry here and fall through to the SYNC_UNSUPPORTED seam.
 */
function buildSyncDispatch(
  actorId: string,
  connection: AutobotConnection,
): Record<string, () => Promise<ConnectorSyncResult>> {
  return {
    google_docs: () => syncGoogleDocsConnection(actorId, connection),
    google_calendar: () => syncGoogleCalendarConnection(actorId, connection),
    notion: () => syncNotionConnection(actorId, connection),
    telegram: () => syncTelegramConnection(actorId, connection),
    messenger: () => syncMessengerConnection(actorId, connection),
    facebook: () => syncFacebookConnection(actorId, connection),
    instagram: () => syncInstagramConnection(actorId, connection),
    obsidian_vault: () => syncObsidianConnection(actorId, connection),
    parachute_vault: () => syncParachuteConnection(actorId, connection),
    proton_docs: () => syncProtonConnection(actorId, connection),
    wolfram: () => syncWolframConnection(actorId, connection),
    generic_oauth2: () => syncGenericOAuth2Connection(actorId, connection),
    slack: () => syncSlackConnection(actorId, connection),
    discord: () => syncDiscordConnection(actorId, connection),
    dropbox: () => syncDropboxConnection(actorId, connection),
    zoom: () => syncZoomConnection(actorId, connection),
  };
}

/** The set of providers that have a sync-lane implementation. */
export const SYNCABLE_CONNECTOR_PROVIDERS: AutobotConnection["provider"][] = [
  "google_docs",
  "google_calendar",
  "notion",
  "telegram",
  "messenger",
  "facebook",
  "instagram",
  "obsidian_vault",
  "parachute_vault",
  "proton_docs",
  "wolfram",
  "generic_oauth2",
  "slack",
  "discord",
  "dropbox",
  "zoom",
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function updateConnectionState(
  connections: AutobotConnection[],
  provider: AutobotConnection["provider"],
  patch: Partial<AutobotConnection>,
): AutobotConnection[] {
  return connections.map((connection) =>
    connection.provider === provider
      ? {
          ...connection,
          ...patch,
          config: patch.config ?? connection.config,
          modules: patch.modules ?? connection.modules,
        }
      : connection,
  );
}

/**
 * Run a connector sync lane for `actorId`, then bridge the synced resources
 * into the Knowledge Graph and persist the connection's new state.
 *
 * @param actorId  The agent/persona id whose connector lane to read + write.
 *                 The caller MUST have already authorized this actor.
 * @param provider The connector provider key (e.g. `"notion"`).
 * @throws {ConnectorSyncError} with a {@link ConnectorSyncFailureCode} when the
 *   provider is unknown, not configured, has no sync lane, or the lane throws.
 *   On a lane failure the connection state is persisted as `error` first.
 */
export async function runConnectorSync(
  actorId: string,
  provider: string,
): Promise<RunConnectorSyncResult> {
  if (!getAutobotConnectorDefinition(provider as AutobotConnection["provider"])) {
    throw new ConnectorSyncError(
      `Unknown connector provider: ${provider}`,
      CONNECTOR_SYNC_FAILURE.UNKNOWN_PROVIDER,
    );
  }

  const settings = await getAutobotUserSettings(actorId);
  const connection = settings.connections.find(
    (item) => item.provider === provider,
  );

  if (!connection) {
    throw new ConnectorSyncError(
      `Connector "${provider}" is not configured for this actor.`,
      CONNECTOR_SYNC_FAILURE.NOT_CONFIGURED,
    );
  }

  const dispatch = buildSyncDispatch(actorId, connection);
  const runner = dispatch[provider];

  if (!runner) {
    throw new ConnectorSyncError(
      `Sync is not implemented for the "${provider}" connector.`,
      CONNECTOR_SYNC_FAILURE.SYNC_UNSUPPORTED,
    );
  }

  let result: ConnectorSyncResult;
  try {
    result = await runner();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Connector sync failed";

    const erroredConnections = updateConnectionState(
      settings.connections,
      connection.provider,
      {
        status: CONNECTION_STATUS_ERROR,
        error: message,
      },
    );
    await saveAutobotUserSettings(actorId, {
      connections: erroredConnections,
    }).catch(() => {});

    throw new ConnectorSyncError(message, CONNECTOR_SYNC_FAILURE.SYNC_FAILED);
  }

  // Bridge: ingest synced resources into the Knowledge Graph so the autobot can
  // reason over connector data. KG ingest failure never fails the sync.
  let kgIngest: ConnectorIngestResult | null = null;
  try {
    kgIngest = await ingestSyncedResources(actorId, provider);
  } catch (kgErr) {
    console.warn(
      `[connector-sync] KG ingest for ${provider} failed:`,
      kgErr instanceof Error ? kgErr.message : kgErr,
    );
  }

  const nextConnections = updateConnectionState(
    settings.connections,
    connection.provider,
    {
      status: CONNECTION_STATUS_CONNECTED,
      error: undefined,
      lastSyncedAt: new Date().toISOString(),
      accountLabel: result.accountLabel ?? connection.accountLabel,
      externalAccountId:
        result.externalAccountId ?? connection.externalAccountId,
    },
  );

  const nextSettings = await saveAutobotUserSettings(actorId, {
    connections: nextConnections,
  });

  return {
    result,
    kgIngest,
    connections: nextSettings.connections,
  };
}
