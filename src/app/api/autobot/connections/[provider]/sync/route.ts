import { NextResponse } from "next/server";
import { auth } from "@/auth";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import { getAutobotUserSettings, saveAutobotUserSettings } from "@/lib/autobot-user-settings";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";
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

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

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

export async function POST(_request: Request, context: RouteContext) {
  const session = await auth();
  const ownerId = session?.user?.id ?? null;
  if (!ownerId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const subject = await resolveAutobotConnectionScope(ownerId);
  const actorId = subject.actorId;

  const { provider } = await context.params;
  const settings = await getAutobotUserSettings(actorId);
  const connection = settings.connections.find((item) => item.provider === provider);

  if (!connection) {
    return NextResponse.json({ error: "Connector is not configured" }, { status: 404 });
  }

  try {
    const syncDispatch: Record<string, () => Promise<ConnectorSyncResult>> = {
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

    const result = syncDispatch[provider]
      ? await syncDispatch[provider]()
      : null;

    if (!result) {
      return NextResponse.json(
        { error: "Sync is not implemented for this connector yet" },
        { status: 400 },
      );
    }

    const nextConnections = updateConnectionState(settings.connections, connection.provider, {
      status: "connected",
      error: undefined,
      lastSyncedAt: new Date().toISOString(),
      accountLabel: result.accountLabel ?? connection.accountLabel,
      externalAccountId: result.externalAccountId ?? connection.externalAccountId,
    });

    const nextSettings = await saveAutobotUserSettings(actorId, {
      connections: nextConnections,
    });

    return NextResponse.json({
      result,
      connections: nextSettings.connections,
      subject,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Connector sync failed";

    const nextConnections = updateConnectionState(settings.connections, connection.provider, {
      status: "error",
      error: message,
    });

    await saveAutobotUserSettings(actorId, {
      connections: nextConnections,
    });

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
