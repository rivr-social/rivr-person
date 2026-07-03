import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";
import {
  facetedTagsFromVaultPath,
  flattenFacetedTags,
  normalizeFacetedTags,
  serializeFacetedTagsToMetadata,
} from "@/lib/parachute-doc";

const PROVIDER_KEY = "parachute";

/** A directed link preserved from a note's `[[wikilinks]]` for provenance only. */
export interface ParachuteLink {
  target: string;
  relationship?: string;
}

/** One note to import — the portable shape all ingress paths (upload, daemon) reduce to. */
export interface ParachuteImportFile {
  path: string;
  content: string;
  mimeType?: string;
  /** Explicit note tags (frontmatter + inline `#nested/tag`), merged with path facets. */
  tags?: string[];
  /** YAML frontmatter minus `tags`, preserved under `metadata.parachute.frontmatter`. */
  frontmatter?: Record<string, unknown>;
  /** `[[wikilinks]]` edges, preserved for provenance (NOT materialized as ledger edges). */
  links?: ParachuteLink[];
}

/** Where a batch of notes came from — a live connector, or an ad-hoc upload/daemon pull. */
type ParachuteImportSource =
  | AutobotConnection
  | { vaultPath?: string | null }
  | undefined;

/** Existing synced resource with the fields needed for idempotency checks. */
interface SyncedResourceRow {
  id: string;
  /** `metadata.parachute.sourceHash` of the last import, when present. */
  sourceHash: string | null;
}

/**
 * Computes a stable content hash for a note so re-importing an unchanged note is a
 * no-op. Combines the body with the sorted tag set: a change to either the text or
 * the note's tags produces a new hash and triggers an update.
 */
function computeSourceHash(content: string, tags: string[]): string {
  const sortedTags = [...tags].sort((a, b) => a.localeCompare(b)).join(",");
  return createHash("sha256").update(`${content}\n${sortedTags}`).digest("hex");
}

/** Resolve the vault path from either a live connection or an ad-hoc import source. */
function resolveVaultPath(source: ParachuteImportSource): string | undefined {
  if (!source) return undefined;
  if ("config" in source) {
    return source.config.vaultPath?.trim() || undefined;
  }
  return source.vaultPath?.trim() || undefined;
}

async function findSyncedResourceRow(
  ownerId: string,
  externalId: string,
): Promise<SyncedResourceRow | null> {
  const [row] = await db
    .select({
      id: resources.id,
      sourceHash: sql<
        string | null
      >`${resources.metadata}->'parachute'->>'sourceHash'`,
    })
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

  if (!row) return null;
  return { id: row.id, sourceHash: row.sourceHash ?? null };
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
 * Uses the file path as the external ID for upsert deduplication. The faceted
 * location merges BOTH hierarchy signals Parachute expresses (T2.5):
 *   1. the folder path (`work/projects/rivr/spec.md` → `work/projects/rivr`), and
 *   2. the note's explicit slash-nested tags (`work/projects/rivr`, `status/draft`).
 * The merged tag-paths persist under `metadata.facetedTags` and project — with the
 * provider markers — into the flat `tags` column for existing search.
 *
 * Re-import is idempotent: a `metadata.parachute.sourceHash` over the body+tags lets
 * an unchanged note short-circuit to `"skipped"` (no rewrite, no re-embed); a changed
 * note updates in place by path; a new path is created.
 */
export async function importParachuteFile(
  userId: string,
  file: ParachuteImportFile,
  vaultPath?: string,
): Promise<"created" | "updated" | "skipped"> {
  const existing = await findSyncedResourceRow(userId, file.path);
  const now = new Date();
  const title = extractTitle(file.path);
  const contentType = inferContentType(file.mimeType, file.path);

  // Merge folder-derived facets with the note's explicit (possibly slash-nested)
  // tags. normalizeFacetedTags accepts the mixed TagPath[] / string[] input and
  // dedups, so path facets and tag facets collapse cleanly into one set.
  const facetedTags = normalizeFacetedTags([
    ...facetedTagsFromVaultPath(file.path),
    ...(file.tags ?? []),
  ]);
  const sourceHash = computeSourceHash(file.content, file.tags ?? []);

  // Skip-unchanged: an existing note whose stored hash matches is a no-op.
  if (existing && existing.sourceHash === sourceHash) {
    return "skipped";
  }

  const baseMetadata: Record<string, unknown> = {
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
    // Richer provenance + idempotency key. Links are captured for provenance
    // only — they are NOT materialized as RIVR ledger edges (v1 non-goal).
    parachute: {
      ...(vaultPath ? { vaultPath } : {}),
      importedAt: now.toISOString(),
      sourceHash,
      ...(file.frontmatter && Object.keys(file.frontmatter).length > 0
        ? { frontmatter: file.frontmatter }
        : {}),
      ...(file.links && file.links.length > 0 ? { links: file.links } : {}),
    },
  };
  const metadata = serializeFacetedTagsToMetadata(baseMetadata, facetedTags);
  const tags = [
    "parachute",
    "vault",
    "imported",
    ...flattenFacetedTags(facetedTags),
  ];

  if (existing) {
    await db
      .update(resources)
      .set({
        name: title,
        description: "Imported from Parachute vault",
        content: file.content,
        contentType,
        tags,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existing.id));
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
    tags,
    metadata,
  });
  return "created";
}

/**
 * Batch import multiple Parachute files.
 *
 * The `source` may be a live {@link AutobotConnection} (connector sync) or a plain
 * `{ vaultPath }` object (the ad-hoc upload / daemon-pull import endpoint), so the
 * import route can call this without fabricating a full connection object.
 */
export async function importParachuteBatch(
  userId: string,
  files: ParachuteImportFile[],
  source?: ParachuteImportSource,
): Promise<ConnectorSyncResult> {
  const vaultPath = resolveVaultPath(source);
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of files) {
    const status = await importParachuteFile(userId, file, vaultPath);
    if (status === "created") imported += 1;
    else if (status === "updated") updated += 1;
    else skipped += 1;
  }

  return {
    provider: "parachute_vault",
    imported,
    updated,
    skipped,
    message: `Batch imported ${files.length} Parachute file${files.length === 1 ? "" : "s"}: ${imported} created, ${updated} updated, ${skipped} skipped.`,
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
