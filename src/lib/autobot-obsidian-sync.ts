import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

const PROVIDER_KEY = "obsidian";

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
        sql`${resources.metadata}->'externalSync'->>'provider' = ${PROVIDER_KEY}`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function countSyncedResources(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->'externalSync'->>'provider' = ${PROVIDER_KEY}`,
      ),
    );

  return row?.count ?? 0;
}

function extractTitle(
  note: { path: string; content: string; frontmatter?: Record<string, unknown> },
): string {
  if (note.frontmatter?.title && typeof note.frontmatter.title === "string") {
    return note.frontmatter.title;
  }

  const headingMatch = note.content.match(/^#\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }

  const filename = note.path.split("/").pop() ?? note.path;
  return filename.replace(/\.md$/i, "");
}

/**
 * Import a single Obsidian note as a resource.
 *
 * Uses the note path as the external ID for upsert deduplication.
 */
export async function importObsidianNote(
  userId: string,
  note: { path: string; content: string; frontmatter?: Record<string, unknown> },
  vaultPath?: string,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedResourceId(userId, note.path);
  const now = new Date();
  const title = extractTitle(note);

  const metadata: Record<string, unknown> = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Obsidian Vault",
    frontmatter: note.frontmatter ?? null,
    externalSync: {
      provider: PROVIDER_KEY,
      externalId: note.path,
      ...(vaultPath ? { vaultPath } : {}),
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: title,
        description: "Imported from Obsidian vault",
        content: note.content,
        contentType: "text/markdown",
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: title,
    type: "document",
    description: "Imported from Obsidian vault",
    content: note.content,
    contentType: "text/markdown",
    ownerId: userId,
    visibility: "private",
    tags: ["obsidian", "vault", "imported"],
    metadata,
  });
  return "created";
}

/**
 * Batch import multiple Obsidian notes.
 */
export async function importObsidianBatch(
  userId: string,
  notes: Array<{ path: string; content: string; frontmatter?: Record<string, unknown> }>,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const vaultPath = connection.config.vaultPath?.trim() || undefined;
  let imported = 0;
  let updated = 0;

  for (const note of notes) {
    const status = await importObsidianNote(userId, note, vaultPath);
    if (status === "created") imported += 1;
    else updated += 1;
  }

  return {
    provider: "obsidian_vault",
    imported,
    updated,
    skipped: 0,
    message: `Batch imported ${notes.length} Obsidian note${notes.length === 1 ? "" : "s"}: ${imported} created, ${updated} updated.`,
    accountLabel: "Obsidian Vault",
    externalAccountId: vaultPath ?? "vault",
  };
}

/**
 * Sync entry point for the Obsidian vault connector.
 *
 * Obsidian vaults are local filesystem directories so the server cannot pull
 * from them directly. Import happens via `importObsidianNote` / `importObsidianBatch`.
 * This function reports the current state of previously imported resources.
 */
export async function syncObsidianConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const vaultPath = connection.config.vaultPath?.trim() || "unknown";
  const existingCount = await countSyncedResources(userId);

  if (connection.syncDirection === "export") {
    return {
      provider: "obsidian_vault",
      imported: 0,
      updated: 0,
      skipped: 0,
      message: "Obsidian export requires local vault access. Use the Obsidian app or filesystem tools to write back to your vault.",
      accountLabel: "Obsidian Vault",
      externalAccountId: vaultPath,
    };
  }

  return {
    provider: "obsidian_vault",
    imported: 0,
    updated: 0,
    skipped: existingCount,
    message: `Obsidian vault sync status: ${existingCount} note${existingCount === 1 ? "" : "s"} previously imported. Upload notes via the import endpoint to add more.`,
    accountLabel: "Obsidian Vault",
    externalAccountId: vaultPath,
  };
}
