import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

const MESSENGER_PROVIDER = "messenger";

type MessengerMessage = {
  sender: string;
  content: string;
  timestamp: string;
};

type MessengerThread = {
  id: string;
  participants: string[];
  messages: MessengerMessage[];
};

function formatTimestamp(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function threadToMarkdown(thread: MessengerThread): string {
  const participantList = thread.participants.join(", ");
  const lines: string[] = [
    `## Thread with ${participantList}`,
    "",
  ];

  for (const message of thread.messages) {
    const ts = formatTimestamp(message.timestamp);
    lines.push(`**${message.sender}** (${ts}): ${message.content}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function threadName(thread: MessengerThread): string {
  const participantList = thread.participants.join(", ");
  const maxLength = 120;
  const prefix = "Messenger: ";
  const name = `${prefix}${participantList}`;
  return name.length > maxLength ? `${name.slice(0, maxLength - 1)}…` : name;
}

async function findSyncedResourceId(
  ownerId: string,
  externalId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->'externalSync'->>'provider' = ${MESSENGER_PROVIDER}`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function countMessengerResources(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->'externalSync'->>'provider' = ${MESSENGER_PROVIDER}`,
      ),
    );

  return row?.count ?? 0;
}

/**
 * Imports a single Messenger thread into the resources table.
 *
 * Converts the thread to markdown and upserts using the externalSync pattern
 * with provider "messenger" and the thread id as externalId.
 *
 * @param userId Owner agent UUID.
 * @param thread Parsed thread data with id, participants, and messages.
 * @returns "created" if a new resource was inserted, "updated" if an existing one was refreshed.
 */
export async function importMessengerThread(
  userId: string,
  thread: MessengerThread,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedResourceId(userId, thread.id);
  const now = new Date();
  const markdown = threadToMarkdown(thread);
  const name = threadName(thread);

  const metadata = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Messenger",
    participantCount: thread.participants.length,
    messageCount: thread.messages.length,
    externalSync: {
      provider: MESSENGER_PROVIDER,
      externalId: thread.id,
      participants: thread.participants,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name,
        description: "Imported from Messenger",
        content: markdown,
        contentType: "text/markdown",
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name,
    type: "document",
    description: "Imported from Messenger",
    content: markdown,
    contentType: "text/markdown",
    ownerId: userId,
    visibility: "private",
    tags: ["messenger", "threads", "imported"],
    metadata,
  });
  return "created";
}

/**
 * Sync function for the Messenger connector.
 *
 * Since Messenger uses a manual/file-based import strategy, this function
 * acts as a status-check/count operation. Actual thread import happens
 * through `importMessengerThread` called from a separate upload flow.
 *
 * For "import" or "bidirectional" directions: counts existing messenger
 * resources and reports the current state.
 *
 * For "export": returns a message that export is not supported.
 *
 * @param userId Owner agent UUID.
 * @param connection The Messenger connector connection configuration.
 * @returns Sync result with counts and status message.
 */
export async function syncMessengerConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  if (connection.syncDirection === "export") {
    return {
      provider: "messenger",
      imported: 0,
      updated: 0,
      skipped: 0,
      message: "Export to Messenger is not supported. Messenger threads are import-only via Facebook data export.",
      accountLabel: connection.accountLabel ?? "Messenger",
      externalAccountId: connection.config.accountEmail ?? undefined,
    };
  }

  const existingCount = await countMessengerResources(userId);

  return {
    provider: "messenger",
    imported: existingCount,
    updated: 0,
    skipped: 0,
    message:
      existingCount > 0
        ? `${existingCount} Messenger thread${existingCount === 1 ? "" : "s"} currently imported. Upload new Facebook data export JSON to import more.`
        : "No Messenger threads imported yet. Upload a Facebook data export JSON to begin.",
    accountLabel: connection.accountLabel ?? "Messenger",
    externalAccountId: connection.config.accountEmail ?? undefined,
  };
}
