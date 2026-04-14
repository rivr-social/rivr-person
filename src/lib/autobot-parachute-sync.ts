import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

const PROVIDER_KEY = "parachute";

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

function inferContentType(mimeType?: string, path?: string): string {
  if (mimeType) return mimeType;
  if (!path) return "application/octet-stream";

  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    case "html":
    case "htm":
      return "text/html";
    case "json":
      return "application/json";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function extractTitle(path: string): string {
  const filename = path.split("/").pop() ?? path;
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
}

/**
 * Import a single Parachute file as a resource.
 *
 * Uses the file path as the external ID for upsert deduplication.
 */
export async function importParachuteFile(
  userId: string,
  file: { path: string; content: string; mimeType?: string },
  vaultPath?: string,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedResourceId(userId, file.path);
  const now = new Date();
  const title = extractTitle(file.path);
  const contentType = inferContentType(file.mimeType, file.path);

  const metadata: Record<string, unknown> = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Parachute Vault",
    externalSync: {
      provider: PROVIDER_KEY,
      externalId: file.path,
      ...(vaultPath ? { vaultPath } : {}),
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: title,
        description: "Imported from Parachute vault",
        content: file.content,
        contentType,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: title,
    type: "document",
    description: "Imported from Parachute vault",
    content: file.content,
    contentType,
    ownerId: userId,
    visibility: "private",
    tags: ["parachute", "vault", "imported"],
    metadata,
  });
  return "created";
}

/**
 * Batch import multiple Parachute files.
 */
export async function importParachuteBatch(
  userId: string,
  files: Array<{ path: string; content: string; mimeType?: string }>,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const vaultPath = connection.config.vaultPath?.trim() || undefined;
  let imported = 0;
  let updated = 0;

  for (const file of files) {
    const status = await importParachuteFile(userId, file, vaultPath);
    if (status === "created") imported += 1;
    else updated += 1;
  }

  return {
    provider: "parachute_vault",
    imported,
    updated,
    skipped: 0,
    message: `Batch imported ${files.length} Parachute file${files.length === 1 ? "" : "s"}: ${imported} created, ${updated} updated.`,
    accountLabel: "Parachute Vault",
    externalAccountId: vaultPath ?? "vault",
  };
}

/**
 * Sync entry point for the Parachute vault connector.
 *
 * Parachute vaults are local filesystem directories so the server cannot pull
 * from them directly. Import happens via `importParachuteFile` / `importParachuteBatch`.
 * This function reports the current state of previously imported resources.
 */
export async function syncParachuteConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const vaultPath = connection.config.vaultPath?.trim() || "unknown";
  const existingCount = await countSyncedResources(userId);

  if (connection.syncDirection === "export") {
    return {
      provider: "parachute_vault",
      imported: 0,
      updated: 0,
      skipped: 0,
      message: "Parachute export requires local vault access. Use the Parachute app or filesystem tools to write back to your vault.",
      accountLabel: "Parachute Vault",
      externalAccountId: vaultPath,
    };
  }

  return {
    provider: "parachute_vault",
    imported: 0,
    updated: 0,
    skipped: existingCount,
    message: `Parachute vault sync status: ${existingCount} file${existingCount === 1 ? "" : "s"} previously imported. Upload files via the import endpoint to add more.`,
    accountLabel: "Parachute Vault",
    externalAccountId: vaultPath,
  };
}
