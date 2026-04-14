import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { accounts } from "@/db/schema";
import {
  AUTOBOT_CONNECTOR_DEFINITIONS,
  sanitizeAutobotConnections,
  type AutobotConnection,
} from "@/lib/autobot-connectors";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
} from "@/lib/autobot-user-settings";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";

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

  const connections = mergePersonLevelConnections(
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
    connections,
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
  const subjectConnections = nextConnections.filter(
    (connection) => connection.provider !== "teller",
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

  const connections = mergePersonLevelConnections(
    subjectSettings.connections,
    ownerSettings?.connections ?? [],
  );

  return NextResponse.json({
    connections,
    subject,
  });
}
