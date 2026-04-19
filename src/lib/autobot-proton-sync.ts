import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

const PROVIDER_KEY = "proton";

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

/**
 * Import a single Proton document as a resource.
 *
 * Uses the document id as the external ID for upsert deduplication.
 */
export async function importProtonDocument(
  userId: string,
  doc: { id: string; title: string; content: string },
): Promise<"created" | "updated"> {
  const existingId = await findSyncedResourceId(userId, doc.id);
  const now = new Date();

  const metadata: Record<string, unknown> = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Proton Docs",
    externalSync: {
      provider: PROVIDER_KEY,
      externalId: doc.id,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: doc.title,
        description: "Imported from Proton Docs",
        content: doc.content,
        contentType: "text/plain",
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: doc.title,
    type: "document",
    description: "Imported from Proton Docs",
    content: doc.content,
    contentType: "text/plain",
    ownerId: userId,
    visibility: "private",
    tags: ["proton", "docs", "imported"],
    metadata,
  });
  return "created";
}

/**
 * Batch import multiple Proton documents.
 */
export async function importProtonBatch(
  userId: string,
  docs: Array<{ id: string; title: string; content: string }>,
): Promise<ConnectorSyncResult> {
  let imported = 0;
  let updated = 0;

  for (const doc of docs) {
    const status = await importProtonDocument(userId, doc);
    if (status === "created") imported += 1;
    else updated += 1;
  }

  return {
    provider: "proton_docs",
    imported,
    updated,
    skipped: 0,
    message: `Batch imported ${docs.length} Proton document${docs.length === 1 ? "" : "s"}: ${imported} created, ${updated} updated.`,
    accountLabel: "Proton Docs",
  };
}

/**
 * Sync entry point for the Proton Docs connector.
 *
 * Proton Docs does not have a public API, so all sync is manual import only.
 * This function reports the current state of previously imported resources.
 */
export async function syncProtonConnection(
  userId: string,
  _connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const existingCount = await countSyncedResources(userId);

  return {
    provider: "proton_docs",
    imported: 0,
    updated: 0,
    skipped: existingCount,
    message: `Proton Docs sync is manual import only (no public API available). ${existingCount} document${existingCount === 1 ? "" : "s"} previously imported. Use the import endpoint to add documents manually.`,
    accountLabel: "Proton Docs",
  };
}
