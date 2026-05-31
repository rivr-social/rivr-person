/**
 * KG client (compatibility layer)
 *
 * Historically this was a thin HTTP client that proxied to the OpenClaw KG
 * token-server (`AUTOBOT_KG_URL` -> openclaw-web:3000). That backend has been
 * retired; the knowledge graph is now fully native over Postgres/pgvector.
 *
 * This module is kept as a stable import surface for the many existing
 * consumers — it simply re-exports the native implementation from
 * `@/lib/kg/native-kg`. New code should import from `native-kg` directly.
 */

export type {
  KgDoc,
  KgTriple,
  KgEntity,
  IngestResult,
  KgScopeStats,
} from "@/lib/kg/native-kg";

export {
  createDoc,
  listDocs,
  getDoc,
  ingestDoc,
  deleteDoc,
  queryScope,
  buildContext,
  listEntities,
  getScopeStats,
} from "@/lib/kg/native-kg";
