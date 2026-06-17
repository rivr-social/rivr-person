/**
 * Connector → KG Ingest Bridge
 *
 * After a connector sync writes resources to the DB, this module picks up
 * those resources and feeds them into the scoped Knowledge Graph so the
 * autobot can reason over synced external data (Notion docs, Google Docs,
 * Slack threads, etc.).
 *
 * Flow:
 *   connector sync → resources table → ingestSyncedResources() → kg_documents + kg_triples
 *
 * Resources are matched by `metadata.externalSync.provider` and only ingested
 * when they have non-empty content. A content hash prevents redundant
 * re-ingestion of unchanged documents.
 */

import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources as resourcesTable } from "@/db/schema";
import { createDoc, ingestDoc, listDocs } from "@/lib/kg/native-kg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectorIngestResult {
  provider: string;
  ingested: number;
  skipped: number;
  errors: number;
  details: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum content length to ingest into the KG (characters). */
const MAX_INGEST_CONTENT_LENGTH = 50_000;

/** KG scope type for person-level knowledge. */
const SCOPE_TYPE = "person";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Ingest recently synced connector resources into the person's KG scope.
 *
 * Queries resources with `metadata.externalSync.provider` matching the given
 * provider, checks whether each has already been ingested (by content hash),
 * and creates/ingests new or changed documents into the KG.
 *
 * @param actorId The owner agent ID (used as both resource owner and KG scope ID).
 * @param provider The connector provider name (e.g., "notion", "google_docs").
 * @returns Summary of ingested/skipped/errored documents.
 */
export async function ingestSyncedResources(
  actorId: string,
  provider: string,
): Promise<ConnectorIngestResult> {
  const result: ConnectorIngestResult = {
    provider,
    ingested: 0,
    skipped: 0,
    errors: 0,
    details: [],
  };

  // Query resources synced by this provider
  const syncedResources = await db
    .select({
      id: resourcesTable.id,
      name: resourcesTable.name,
      content: resourcesTable.content,
      type: resourcesTable.type,
      metadata: resourcesTable.metadata,
    })
    .from(resourcesTable)
    .where(
      and(
        eq(resourcesTable.ownerId, actorId),
        sql`${resourcesTable.metadata}->'externalSync'->>'provider' = ${provider}`,
      ),
    )
    .limit(100);

  if (syncedResources.length === 0) {
    result.details.push("No synced resources found for this provider.");
    return result;
  }

  // Get existing KG docs for this scope to check for duplicates by source URI
  const existingDocs = await listDocs(SCOPE_TYPE, actorId);
  const existingBySourceUri = new Map(
    existingDocs
      .filter((d) => d.source_uri)
      .map((d) => [d.source_uri!, d]),
  );

  for (const resource of syncedResources) {
    const content = resource.content;
    if (!content || content.trim().length === 0) {
      result.skipped++;
      continue;
    }

    const meta = (resource.metadata ?? {}) as Record<string, unknown>;
    const externalSync = (meta.externalSync ?? {}) as Record<string, unknown>;
    const externalId = (externalSync.externalId as string) ?? resource.id;
    const sourceUri = `rivr:resource:${resource.id}`;
    const title = resource.name || `${provider} document ${externalId}`;

    // Content hash to detect changes
    const truncatedContent = content.slice(0, MAX_INGEST_CONTENT_LENGTH);
    const contentHash = createHash("sha256").update(truncatedContent).digest("hex");

    // Check if already ingested with same content
    const existing = existingBySourceUri.get(sourceUri);
    if (existing) {
      const existingHash = (existing.metadata as Record<string, unknown>)?.content_hash;
      if (existingHash === contentHash) {
        result.skipped++;
        continue;
      }
      // Content changed — will re-ingest below
    }

    try {
      const doc = await createDoc({
        title,
        doc_type: resource.type ?? "document",
        scope_type: SCOPE_TYPE,
        scope_id: actorId,
        content_hash: contentHash,
        source_uri: sourceUri,
        metadata: {
          provider,
          externalId,
          resourceId: resource.id,
          content_hash: contentHash,
          ingestedAt: new Date().toISOString(),
        },
      });

      await ingestDoc(doc.id, truncatedContent, "markdown", title);
      result.ingested++;
      result.details.push(`Ingested: ${title}`);
    } catch (err) {
      result.errors++;
      const msg = err instanceof Error ? err.message : "Unknown error";
      result.details.push(`Error ingesting "${title}": ${msg}`);
    }
  }

  return result;
}
