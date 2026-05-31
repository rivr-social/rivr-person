/**
 * Native Knowledge Graph
 *
 * Native pgvector/Postgres-backed implementation of the scoped knowledge graph.
 * This replaces the former OpenClaw HTTP proxy (openclaw-web:3000) entirely —
 * docs, entities, and triples now live in the local `kg_documents`,
 * `kg_entities`, and `kg_triples` tables, isolated per scope
 * (`scope_type` + `scope_id`).
 *
 * Two complementary KG surfaces feed `buildContext`:
 *   1. Uploaded/ingested docs + their rule-extracted triples for the scope.
 *   2. Hand-picked Rivr objects (`metadata.kgObjects` on the scope agent),
 *      resolved live and filtered by the asker's visibility so a public
 *      persona never leaks its owner's private objects to a guest.
 *
 * The public function surface mirrors the legacy client (snake_case record
 * shapes) so existing consumers keep working without changes.
 */

import { createHash } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  kgDocuments,
  kgEntities,
  kgTriples,
  resources as resourcesTable,
  agents as agentsTable,
  type KgDocumentRecord,
  type KgTripleRecord,
  type KgEntityRecord,
} from "@/db/schema";
import { readKgObjects, type KgObjectRef } from "@/lib/agent-roles";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOC_STATUS_PENDING = "pending";
const DOC_STATUS_COMPLETE = "complete";
const DEFAULT_DOC_TYPE = "document";
const EXTRACTION_METHOD = "local-rules";

const DEFAULT_QUERY_LIMIT = 200;
const DEFAULT_CONTEXT_CHARS = 3000;

/** Triple-extraction tuning. */
const MAX_INGEST_TRIPLES = 200;
const MAX_SUBJECT_LEN = 120;
const MAX_OBJECT_LEN = 200;
const MIN_TERM_LEN = 2;

/** Rivr-object snippet sizing for linked-object context. */
const MAX_LINKED_OBJECTS = 25;
const LINKED_SNIPPET_CHARS = 300;

/** Object visibility levels that are safe to surface to any signed-in asker. */
const PUBLICLY_VISIBLE_LEVELS = new Set(["public", "locale"]);

/** Copula-style predicates used by the rule-based triple extractor. */
const COPULA_PREDICATES = [
  "is",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "includes",
  "contains",
  "provides",
  "offers",
] as const;

// ---------------------------------------------------------------------------
// Public record shapes (snake_case — mirrors the legacy client contract)
// ---------------------------------------------------------------------------

export type KgDoc = {
  id: number;
  title: string;
  doc_type: string;
  scope_type: string;
  scope_id: string;
  status: string;
  triple_count: number;
  content_hash: string | null;
  source_uri: string | null;
  ingested_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type KgTriple = {
  id: number;
  subject: string;
  subject_type: string;
  predicate: string;
  object: string;
  object_type: string;
  confidence: number;
  source_doc_title: string | null;
  extraction_method: string;
  created_at: string;
};

export type KgEntity = {
  id: number;
  name: string;
  entity_type: string;
  canonical_name: string;
};

export type IngestResult = {
  source: string;
  format: string;
  classification: string;
  interpretationNote: string;
  sessionsCreated: number;
  transcriptLinesWritten: number;
  regexTriplesExtracted: number;
  llmChunksQueued: number;
  suppressedTriples: number;
  errors: string[];
  docId?: number;
};

export type KgScopeStats = {
  docCount: number;
  entityCount: number;
  tripleCount: number;
};

// ---------------------------------------------------------------------------
// Serializers (DB camelCase record -> public snake_case shape)
// ---------------------------------------------------------------------------

function toKgDoc(r: KgDocumentRecord): KgDoc {
  return {
    id: r.id,
    title: r.title,
    doc_type: r.docType,
    scope_type: r.scopeType,
    scope_id: r.scopeId,
    status: r.status,
    triple_count: r.tripleCount,
    content_hash: r.contentHash,
    source_uri: r.sourceUri,
    ingested_at: r.ingestedAt ? r.ingestedAt.toISOString() : null,
    metadata: r.metadata,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

function toKgTriple(r: KgTripleRecord): KgTriple {
  return {
    id: r.id,
    subject: r.subject,
    subject_type: r.subjectType,
    predicate: r.predicate,
    object: r.object,
    object_type: r.objectType,
    confidence: r.confidence,
    source_doc_title: r.sourceDocTitle,
    extraction_method: r.extractionMethod,
    created_at: r.createdAt.toISOString(),
  };
}

function toKgEntity(r: KgEntityRecord): KgEntity {
  return {
    id: r.id,
    name: r.name,
    entity_type: r.entityType,
    canonical_name: r.canonicalName,
  };
}

// ---------------------------------------------------------------------------
// Document ledger
// ---------------------------------------------------------------------------

export async function createDoc(params: {
  title: string;
  doc_type?: string;
  scope_type: string;
  scope_id: string;
  content_hash?: string;
  source_uri?: string;
  metadata?: Record<string, unknown>;
}): Promise<KgDoc> {
  const [row] = await db
    .insert(kgDocuments)
    .values({
      title: params.title,
      docType: params.doc_type ?? DEFAULT_DOC_TYPE,
      scopeType: params.scope_type,
      scopeId: params.scope_id,
      status: DOC_STATUS_PENDING,
      contentHash: params.content_hash ?? null,
      sourceUri: params.source_uri ?? null,
      metadata: params.metadata ?? {},
    })
    .returning();
  return toKgDoc(row);
}

export async function listDocs(
  scopeType: string,
  scopeId: string,
  status?: string,
): Promise<KgDoc[]> {
  const conditions = [
    eq(kgDocuments.scopeType, scopeType),
    eq(kgDocuments.scopeId, scopeId),
  ];
  if (status) conditions.push(eq(kgDocuments.status, status));

  const rows = await db
    .select()
    .from(kgDocuments)
    .where(and(...conditions))
    .orderBy(desc(kgDocuments.createdAt));
  return rows.map(toKgDoc);
}

export async function getDoc(
  docId: number,
): Promise<KgDoc & { live_triple_count: number }> {
  const row = await db.query.kgDocuments.findFirst({
    where: eq(kgDocuments.id, docId),
  });
  if (!row) throw new Error(`KG getDoc failed: doc ${docId} not found`);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(kgTriples)
    .where(eq(kgTriples.docId, docId));

  return { ...toKgDoc(row), live_triple_count: Number(count) };
}

export async function deleteDoc(docId: number): Promise<void> {
  // kg_entities/kg_triples cascade on doc_id FK.
  await db.delete(kgDocuments).where(eq(kgDocuments.id, docId));
}

// ---------------------------------------------------------------------------
// Native rule-based triple extraction
// ---------------------------------------------------------------------------

interface ExtractedTriple {
  subject: string;
  subjectType: string;
  predicate: string;
  object: string;
  objectType: string;
  confidence: number;
}

function normalizePredicate(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

function isUsableTerm(term: string, maxLen: number): boolean {
  const t = term.trim();
  return t.length >= MIN_TERM_LEN && t.length <= maxLen;
}

/**
 * Extracts subject-predicate-object triples from free text using deterministic
 * local rules (no LLM). Two patterns are recognized:
 *   1. "Key: Value" lines      -> (docTitle, key, value)
 *   2. "Subject <copula> Rest" -> (subject, copula, rest)
 */
function extractTriplesFromContent(
  content: string,
  docTitle: string,
): { triples: ExtractedTriple[]; suppressed: number } {
  const triples: ExtractedTriple[] = [];
  let suppressed = 0;

  const copulaPattern = new RegExp(
    `\\s+(${COPULA_PREDICATES.join("|")})\\s+`,
    "i",
  );

  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    if (triples.length >= MAX_INGEST_TRIPLES) break;
    const line = rawLine.trim();
    if (line.length === 0) continue;

    // Pattern 1: "Key: Value"
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0 && colonIdx < MAX_SUBJECT_LEN) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (isUsableTerm(key, MAX_SUBJECT_LEN) && isUsableTerm(value, MAX_OBJECT_LEN)) {
        triples.push({
          subject: docTitle.slice(0, MAX_SUBJECT_LEN),
          subjectType: "document",
          predicate: normalizePredicate(key) || "has_attribute",
          object: value.slice(0, MAX_OBJECT_LEN),
          objectType: "text",
          confidence: 0.9,
        });
        continue;
      }
    }

    // Pattern 2: copula sentences (one triple per sentence, first copula wins)
    const sentences = line.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (triples.length >= MAX_INGEST_TRIPLES) break;
      const match = copulaPattern.exec(sentence);
      if (!match || match.index <= 0) continue;
      const subject = sentence.slice(0, match.index).trim();
      const predicate = match[1].toLowerCase();
      const object = sentence
        .slice(match.index + match[0].length)
        .replace(/[.!?]+$/, "")
        .trim();
      if (isUsableTerm(subject, MAX_SUBJECT_LEN) && isUsableTerm(object, MAX_OBJECT_LEN)) {
        triples.push({
          subject,
          subjectType: "entity",
          predicate,
          object,
          objectType: "text",
          confidence: 0.6,
        });
      } else {
        suppressed += 1;
      }
    }
  }

  return { triples, suppressed };
}

export async function ingestDoc(
  docId: number,
  content: string,
  format?: string,
  title?: string,
): Promise<IngestResult> {
  const doc = await db.query.kgDocuments.findFirst({
    where: eq(kgDocuments.id, docId),
  });
  if (!doc) throw new Error(`KG ingestDoc failed: doc ${docId} not found`);

  const docTitle = title ?? doc.title;
  const contentHash = createHash("sha256").update(content).digest("hex");
  const { triples, suppressed } = extractTriplesFromContent(content, docTitle);

  // Re-ingest is idempotent: clear prior extraction for this doc first.
  await db.delete(kgTriples).where(eq(kgTriples.docId, docId));
  await db.delete(kgEntities).where(eq(kgEntities.docId, docId));

  // Distinct entity names: the doc itself plus every triple subject.
  const entityNames = new Map<string, string>();
  entityNames.set(docTitle.toLowerCase(), docTitle);
  for (const t of triples) {
    if (t.subjectType === "entity") {
      entityNames.set(t.subject.toLowerCase(), t.subject);
    }
  }

  if (entityNames.size > 0) {
    await db.insert(kgEntities).values(
      Array.from(entityNames.entries()).map(([canonical, name]) => ({
        scopeType: doc.scopeType,
        scopeId: doc.scopeId,
        docId,
        name,
        entityType: name === docTitle ? "document" : "entity",
        canonicalName: canonical,
      })),
    );
  }

  if (triples.length > 0) {
    await db.insert(kgTriples).values(
      triples.map((t) => ({
        scopeType: doc.scopeType,
        scopeId: doc.scopeId,
        docId,
        subject: t.subject,
        subjectType: t.subjectType,
        predicate: t.predicate,
        object: t.object,
        objectType: t.objectType,
        confidence: t.confidence,
        sourceDocTitle: docTitle,
        extractionMethod: EXTRACTION_METHOD,
      })),
    );
  }

  await db
    .update(kgDocuments)
    .set({
      content,
      contentHash,
      status: DOC_STATUS_COMPLETE,
      ingestedAt: new Date(),
      tripleCount: triples.length,
      updatedAt: new Date(),
    })
    .where(eq(kgDocuments.id, docId));

  return {
    source: docTitle,
    format: format ?? "text",
    classification: doc.docType,
    interpretationNote: "Native rule-based extraction (no external service).",
    sessionsCreated: 0,
    transcriptLinesWritten: 0,
    regexTriplesExtracted: triples.length,
    llmChunksQueued: 0,
    suppressedTriples: suppressed,
    errors: [],
    docId,
  };
}

// ---------------------------------------------------------------------------
// Triple querying
// ---------------------------------------------------------------------------

export async function queryScope(
  scopeType: string,
  scopeId: string,
  filters?: { entity?: string; predicate?: string; max_results?: number },
): Promise<{ triples: KgTriple[]; count: number }> {
  const conditions = [
    eq(kgTriples.scopeType, scopeType),
    eq(kgTriples.scopeId, scopeId),
  ];

  if (filters?.entity) {
    const needle = `%${filters.entity}%`;
    conditions.push(
      sql`(${kgTriples.subject} ILIKE ${needle} OR ${kgTriples.object} ILIKE ${needle})`,
    );
  }
  if (filters?.predicate) {
    conditions.push(eq(kgTriples.predicate, filters.predicate));
  }

  const whereClause = and(...conditions);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(kgTriples)
    .where(whereClause);

  // max_results === 0 is the stats-only path: return the count, no rows.
  const limit =
    filters?.max_results === undefined
      ? DEFAULT_QUERY_LIMIT
      : Math.max(0, filters.max_results);

  if (limit === 0) {
    return { triples: [], count: Number(count) };
  }

  const rows = await db
    .select()
    .from(kgTriples)
    .where(whereClause)
    .orderBy(desc(kgTriples.confidence), desc(kgTriples.createdAt))
    .limit(limit);

  return { triples: rows.map(toKgTriple), count: Number(count) };
}

export async function listEntities(
  scopeType?: string,
  scopeId?: string,
): Promise<KgEntity[]> {
  const conditions = [];
  if (scopeType) conditions.push(eq(kgEntities.scopeType, scopeType));
  if (scopeId) conditions.push(eq(kgEntities.scopeId, scopeId));

  const rows = await db
    .select()
    .from(kgEntities)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(kgEntities.createdAt));
  return rows.map(toKgEntity);
}

export async function getScopeStats(
  scopeType: string,
  scopeId: string,
): Promise<KgScopeStats> {
  const [docs, entities, triples] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(kgDocuments)
      .where(
        and(
          eq(kgDocuments.scopeType, scopeType),
          eq(kgDocuments.scopeId, scopeId),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(kgEntities)
      .where(
        and(
          eq(kgEntities.scopeType, scopeType),
          eq(kgEntities.scopeId, scopeId),
        ),
      ),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(kgTriples)
      .where(
        and(eq(kgTriples.scopeType, scopeType), eq(kgTriples.scopeId, scopeId)),
      ),
  ]);

  return {
    docCount: Number(docs[0]?.count ?? 0),
    entityCount: Number(entities[0]?.count ?? 0),
    tripleCount: Number(triples[0]?.count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Hand-picked Rivr-object resolution (visibility-aware)
// ---------------------------------------------------------------------------

/**
 * Resolves the hand-picked KG objects (`metadata.kgObjects`) for a scope agent
 * into context snippets, dropping any object the asker is not allowed to see.
 *
 * Visibility rule (mirrors `semanticSearch`): an object is included when the
 * asker owns it, the asker is the scope's controller, or the object's
 * visibility is `public`/`locale`. `members`/`private`/`hidden` objects are
 * surfaced only to the owner so a public persona never leaks private objects
 * to guests.
 */
async function resolveLinkedObjectSnippets(
  scopeType: string,
  scopeId: string,
  askerId?: string | null,
): Promise<string[]> {
  // Only person/persona scopes carry an agent record with kgObjects metadata.
  if (scopeType !== "person" && scopeType !== "persona") return [];

  const scopeAgent = await db.query.agents.findFirst({
    where: eq(agentsTable.id, scopeId),
  });
  if (!scopeAgent) return [];

  const refs = readKgObjects(
    (scopeAgent.metadata ?? {}) as Record<string, unknown>,
  );
  if (refs.length === 0) return [];

  const ownerId =
    scopeType === "persona"
      ? scopeAgent.parentAgentId ?? scopeAgent.id
      : scopeAgent.id;
  const askerIsOwner = Boolean(askerId) && askerId === ownerId;

  const groupRefs: KgObjectRef[] = [];
  const resourceRefs: KgObjectRef[] = [];
  for (const ref of refs.slice(0, MAX_LINKED_OBJECTS)) {
    if (ref.type === "group") groupRefs.push(ref);
    else resourceRefs.push(ref);
  }

  const snippets: string[] = [];

  if (resourceRefs.length > 0) {
    const rows = await db
      .select({
        id: resourcesTable.id,
        name: resourcesTable.name,
        description: resourcesTable.description,
        content: resourcesTable.content,
        type: resourcesTable.type,
        visibility: resourcesTable.visibility,
        ownerId: resourcesTable.ownerId,
        deletedAt: resourcesTable.deletedAt,
      })
      .from(resourcesTable)
      .where(
        inArray(
          resourcesTable.id,
          resourceRefs.map((r) => r.id),
        ),
      );

    for (const row of rows) {
      if (row.deletedAt) continue;
      const visible =
        askerIsOwner ||
        (askerId && row.ownerId === askerId) ||
        (row.visibility !== null &&
          PUBLICLY_VISIBLE_LEVELS.has(row.visibility));
      if (!visible) continue;
      const body = (row.description || row.content || "").slice(
        0,
        LINKED_SNIPPET_CHARS,
      );
      snippets.push(`(${row.type}) ${row.name}${body ? `: ${body}` : ""}`);
    }
  }

  if (groupRefs.length > 0) {
    const rows = await db
      .select({
        id: agentsTable.id,
        name: agentsTable.name,
        description: agentsTable.description,
        type: agentsTable.type,
        visibility: agentsTable.visibility,
        deletedAt: agentsTable.deletedAt,
      })
      .from(agentsTable)
      .where(
        inArray(
          agentsTable.id,
          groupRefs.map((r) => r.id),
        ),
      );

    for (const row of rows) {
      if (row.deletedAt) continue;
      const visible =
        askerIsOwner ||
        (row.visibility !== null && PUBLICLY_VISIBLE_LEVELS.has(row.visibility));
      if (!visible) continue;
      const body = (row.description || "").slice(0, LINKED_SNIPPET_CHARS);
      snippets.push(`(group) ${row.name}${body ? `: ${body}` : ""}`);
    }
  }

  return snippets;
}

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/**
 * Builds a compact KG context block for a scope, combining:
 *   - extracted triples (highest-confidence first),
 *   - ingested document summaries,
 *   - hand-picked Rivr objects filtered by the asker's visibility.
 *
 * @param askerId Pass the chatting user's agent id so private linked objects
 *   are excluded for non-owners. Omit (owner context) to include everything.
 */
export async function buildContext(
  scopeType: string,
  scopeId: string,
  maxChars?: number,
  askerId?: string | null,
): Promise<{ context: string; length: number }> {
  const budget = maxChars && maxChars > 0 ? maxChars : DEFAULT_CONTEXT_CHARS;

  const [{ triples }, docs, linkedObjects] = await Promise.all([
    queryScope(scopeType, scopeId, { max_results: MAX_INGEST_TRIPLES }),
    listDocs(scopeType, scopeId, DOC_STATUS_COMPLETE),
    resolveLinkedObjectSnippets(scopeType, scopeId, askerId),
  ]);

  const sections: string[] = [];

  if (triples.length > 0) {
    const factLines = triples.map(
      (t) => `- ${t.subject} ${t.predicate} ${t.object}`,
    );
    sections.push(`[Knowledge Graph Facts]\n${factLines.join("\n")}`);
  }

  if (docs.length > 0) {
    const docLines = docs.map((d) => {
      const snippet = (d.metadata?.summary as string | undefined) || "";
      return `- ${d.title}${snippet ? `: ${snippet}` : ""}`;
    });
    sections.push(`[Documents]\n${docLines.join("\n")}`);
  }

  if (linkedObjects.length > 0) {
    sections.push(`[Linked Rivr Objects]\n${linkedObjects.map((s) => `- ${s}`).join("\n")}`);
  }

  let context = sections.join("\n\n");
  if (context.length > budget) {
    context = context.slice(0, budget);
  }

  return { context, length: context.length };
}
