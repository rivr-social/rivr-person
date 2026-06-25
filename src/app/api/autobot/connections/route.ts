import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import {
  AUTOBOT_CONNECTOR_DEFINITIONS,
  filterSharedConnections,
  sanitizeAutobotConnections,
  type AutobotConnection,
} from "@/lib/autobot-connectors";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
} from "@/lib/autobot-user-settings";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";
import {
  ENCRYPTED_SECRET_PROVIDERS,
  REDACTED_SECRET_PLACEHOLDER,
  encryptConnectorConfigForProvider,
  isSecretConfigKey,
  redactConnectorConfig,
} from "@/lib/autobot-connector-secrets";

export const dynamic = "force-dynamic";

const AVAILABLE_OAUTH_PROVIDERS = {
  google: Boolean(
    process.env.GOOGLE_CLIENT_ID?.trim() &&
      process.env.GOOGLE_CLIENT_SECRET?.trim(),
  ),
  notion: Boolean(
    process.env.NOTION_CLIENT_ID?.trim() &&
      process.env.NOTION_CLIENT_SECRET?.trim(),
  ),
  facebook: Boolean(
    process.env.FACEBOOK_CLIENT_ID?.trim() &&
      process.env.FACEBOOK_CLIENT_SECRET?.trim(),
  ),
  instagram: Boolean(
    process.env.INSTAGRAM_CLIENT_ID?.trim() &&
      process.env.INSTAGRAM_CLIENT_SECRET?.trim(),
  ),
  apple: Boolean(
    process.env.APPLE_CLIENT_ID?.trim() &&
      process.env.APPLE_TEAM_ID?.trim() &&
      process.env.APPLE_KEY_ID?.trim() &&
      process.env.APPLE_PRIVATE_KEY?.trim(),
  ),
  slack: Boolean(
    process.env.SLACK_CLIENT_ID?.trim() &&
      process.env.SLACK_CLIENT_SECRET?.trim(),
  ),
  discord: Boolean(
    process.env.DISCORD_CLIENT_ID?.trim() &&
      process.env.DISCORD_CLIENT_SECRET?.trim(),
  ),
  dropbox: Boolean(
    process.env.DROPBOX_CLIENT_ID?.trim() &&
      process.env.DROPBOX_CLIENT_SECRET?.trim(),
  ),
  zoom: Boolean(
    process.env.ZOOM_CLIENT_ID?.trim() &&
      process.env.ZOOM_CLIENT_SECRET?.trim(),
  ),
  teller_bank: Boolean(process.env.TELLER_APPLICATION_ID?.trim()),
  oauth2: true,
} as const;

/** A connection as returned to the UI, annotated with whether it is inherited
 * (shared down from the owning agent and therefore read-only at this scope). */
type ScopedAutobotConnection = AutobotConnection & { inherited?: boolean };

/**
 * Strips secret config material from any encrypted-provider connection before it
 * is serialized to the browser. Secret values become the "__stored__"
 * placeholder so the UI can show "configured" without ever receiving the
 * (encrypted-at-rest) token material.
 */
function redactScopedConnection(
  connection: ScopedAutobotConnection,
): ScopedAutobotConnection {
  if (!ENCRYPTED_SECRET_PROVIDERS.has(connection.provider)) return connection;
  return { ...connection, config: redactConnectorConfig(connection.config) };
}

/**
 * Reconciles inbound connector secrets against what is already stored.
 *
 * The GET above redacts encrypted-provider secrets to the "__stored__"
 * placeholder, so a bulk panel save (POST) round-trips that placeholder back.
 * Without this guard the placeholder would overwrite the real (encrypted)
 * secret. For each encrypted-provider connection we: restore any secret whose
 * inbound value is the placeholder from the existing stored value, then
 * re-encrypt newly-entered plaintext secrets at rest. Non-encrypted providers
 * pass through unchanged.
 */
function reconcileConnectionSecrets(
  incoming: AutobotConnection[],
  existing: AutobotConnection[],
): AutobotConnection[] {
  const existingByProvider = new Map(
    existing.map((connection) => [connection.provider, connection]),
  );

  return incoming.map((connection) => {
    if (!ENCRYPTED_SECRET_PROVIDERS.has(connection.provider)) return connection;

    const priorConfig = existingByProvider.get(connection.provider)?.config ?? {};
    const mergedConfig: Record<string, string> = { ...connection.config };
    for (const key of Object.keys(mergedConfig)) {
      if (isSecretConfigKey(key) && mergedConfig[key] === REDACTED_SECRET_PLACEHOLDER) {
        if (priorConfig[key]) {
          mergedConfig[key] = priorConfig[key];
        } else {
          delete mergedConfig[key];
        }
      }
    }

    return {
      ...connection,
      config: encryptConnectorConfigForProvider(connection.provider, mergedConfig),
    };
  });
}

type ConnectionPatchBody = {
  connections?: AutobotConnection[];
};

function mergePersonLevelConnections(
  subjectConnections: AutobotConnection[],
  ownerConnections: AutobotConnection[],
): AutobotConnection[] {
  const byProvider = new Map(
    subjectConnections.map((connection) => [connection.provider, connection]),
  );

  const tellerConnection = ownerConnections.find(
    (connection) => connection.provider === "teller",
  );
  if (tellerConnection) {
    byProvider.set("teller", tellerConnection);
  }

  return [...byProvider.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}

/**
 * Merges a persona's own connectors with the SHARED subset inherited from its
 * owning agent (A3 inheritance). Inherited shared connectors that the persona
 * has not overridden are returned read-only (`inherited: true`). A persona's
 * own connector for the same provider always wins.
 */
function mergeInheritedSharedConnections(
  subjectConnections: AutobotConnection[],
  ownerConnections: AutobotConnection[],
): ScopedAutobotConnection[] {
  const byProvider = new Map<string, ScopedAutobotConnection>();

  for (const inherited of filterSharedConnections(ownerConnections)) {
    byProvider.set(inherited.provider, { ...inherited, inherited: true });
  }

  // The persona's own connectors override any inherited entry for the provider.
  for (const own of subjectConnections) {
    byProvider.set(own.provider, { ...own, inherited: false });
  }

  return [...byProvider.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const subject = await resolveAutobotConnectionScope(session.user.id);

  const [subjectSettings, ownerSettings, subjectLinkedAccounts, ownerLinkedAccounts] = await Promise.all([
    getAutobotUserSettings(subject.actorId),
    subject.actorId === subject.ownerId
      ? Promise.resolve(null)
      : getAutobotUserSettings(subject.ownerId),
    db
      .select({
        provider: accounts.provider,
        providerAccountId: accounts.providerAccountId,
        scope: accounts.scope,
        expiresAt: accounts.expires_at,
      })
      .from(accounts)
      .where(eq(accounts.userId, subject.actorId)),
    subject.actorId === subject.ownerId
      ? Promise.resolve([])
      : db
          .select({
            provider: accounts.provider,
            providerAccountId: accounts.providerAccountId,
            scope: accounts.scope,
            expiresAt: accounts.expires_at,
          })
          .from(accounts)
          .where(eq(accounts.userId, subject.ownerId)),
  ]);

  const connections: ScopedAutobotConnection[] = subject.inheritedSharedOnly
    ? mergeInheritedSharedConnections(
        subjectSettings.connections,
        ownerSettings?.connections ?? [],
      )
    : mergePersonLevelConnections(
        subjectSettings.connections,
        ownerSettings?.connections ?? [],
      );

  const linkedAccounts = [
    ...subjectLinkedAccounts,
    ...ownerLinkedAccounts.filter(
      (account) =>
        account.provider.toLowerCase() === "teller_bank" &&
        !subjectLinkedAccounts.some(
          (existing) =>
            existing.provider === account.provider &&
            existing.providerAccountId === account.providerAccountId,
        ),
    ),
  ];

  return NextResponse.json({
    definitions: AUTOBOT_CONNECTOR_DEFINITIONS,
    connections: connections.map(redactScopedConnection),
    linkedAccounts,
    availableAuthProviders: AVAILABLE_OAUTH_PROVIDERS,
    subject,
  });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const subject = await resolveAutobotConnectionScope(session.user.id);

  let body: ConnectionPatchBody;
  try {
    body = (await request.json()) as ConnectionPatchBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const nextConnections = sanitizeAutobotConnections(body.connections);
  const tellerConnection = nextConnections.find(
    (connection) => connection.provider === "teller",
  );
  let subjectConnections = nextConnections.filter(
    (connection) => connection.provider !== "teller",
  );

  // Inheritance guard (A3): a persona scope inherits the agent's SHARED
  // connectors read-only. Strip any inherited shared provider from the write so
  // a persona can never overwrite the owning agent's shared connector — it may
  // only manage its OWN connectors. The agent's own connectors are edited from
  // the main profile / direct-agent surface.
  if (subject.inheritedSharedOnly && subject.actorId !== subject.ownerId) {
    const ownerSettingsForGuard = await getAutobotUserSettings(subject.ownerId);
    const inheritedProviders = new Set(
      filterSharedConnections(ownerSettingsForGuard.connections).map(
        (connection) => connection.provider,
      ),
    );
    subjectConnections = subjectConnections.filter(
      (connection) => !inheritedProviders.has(connection.provider),
    );
  }

  // Preserve encrypted-at-rest secrets: a bulk save echoes the redacted
  // "__stored__" placeholder back for encrypted providers, so reconcile against
  // the currently-stored config before writing (restore untouched secrets,
  // re-encrypt newly-entered ones).
  const priorSubjectSettings = await getAutobotUserSettings(subject.actorId);
  subjectConnections = reconcileConnectionSecrets(
    subjectConnections,
    priorSubjectSettings.connections,
  );

  const [subjectSettings, ownerSettings] = await Promise.all([
    saveAutobotUserSettings(subject.actorId, {
      connections: subjectConnections,
    }),
    tellerConnection
      ? saveAutobotUserSettings(subject.ownerId, {
          connections: [
            ...(
              await getAutobotUserSettings(subject.ownerId)
            ).connections.filter((connection) => connection.provider !== "teller"),
            tellerConnection,
          ],
        })
      : Promise.resolve(null),
  ]);

  const connections: ScopedAutobotConnection[] = subject.inheritedSharedOnly
    ? mergeInheritedSharedConnections(
        subjectSettings.connections,
        ownerSettings?.connections ?? [],
      )
    : mergePersonLevelConnections(
        subjectSettings.connections,
        ownerSettings?.connections ?? [],
      );

  return NextResponse.json({
    connections: connections.map(redactScopedConnection),
    subject,
  });
}
