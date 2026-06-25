import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import {
  filterViewableAgents,
  filterViewableResources,
} from "@/app/actions/graph/helpers";
import { canViewPredicate } from "@/lib/permissions";
import {
  isReaDataSourceKind,
  type ReaDataSourceKind,
} from "@/lib/bespoke/types";
import { resolveDirectAgent } from "@/lib/assistant/resolve-direct-agent";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Builder REA data source
//
// Runtime read endpoint the BUILT site hits to display SCOPED slices of the
// owner's own Agents / Ledger / Resources. The scope is authored in the
// builder Data → Sources tab and stored on the `builder_data_sources` binding
// (`config.scopeTypes` + `config.scopeIds`).
//
// SECURITY: scope can only ever NARROW. Every row is first bounded by the
// builder/direct agent's OWN view-permissions (filterViewable* / canViewPredicate),
// then narrowed to the requested kinds + ids. A scope can never widen access
// beyond what the owner can already see.
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_INTERNAL_ERROR = 500;

/** Hard ceiling on rows returned per request, before view-filtering. */
const MAX_ROWS = 500;

function parseCsvParam(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function noStore(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
  });
}

export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return noStore({ error: "Authentication required" }, STATUS_UNAUTHORIZED);
  }

  const url = new URL(request.url);
  const kindParam = url.searchParams.get("kind");

  if (!kindParam || !isReaDataSourceKind(kindParam as never)) {
    return noStore(
      { error: "Invalid or missing kind. Must be one of: rivr-agents, rivr-ledger, rivr-resources" },
      STATUS_BAD_REQUEST,
    );
  }

  const kind = kindParam as ReaDataSourceKind;
  const scopeTypes = parseCsvParam(url.searchParams.get("types"));
  const scopeIds = parseCsvParam(url.searchParams.get("ids"));

  try {
    // The self-facing assistant/builder always resolves to the account itself;
    // permission checks run as that direct agent id.
    const { directAgentId: actorId } = await resolveDirectAgent(session.user.id);

    if (kind === "rivr-resources") {
      const conditions = [isNull(resources.deletedAt)];
      if (scopeTypes.length > 0) {
        conditions.push(
          inArray(resources.type, scopeTypes as (typeof resources.type.enumValues)[number][]),
        );
      }
      if (scopeIds.length > 0) {
        conditions.push(inArray(resources.id, scopeIds));
      }

      const rows = await db
        .select()
        .from(resources)
        .where(and(...conditions))
        .orderBy(desc(resources.updatedAt))
        .limit(MAX_ROWS);

      const viewable = await filterViewableResources(actorId, rows);
      const data = viewable.map((r) => ({
        id: r.id,
        type: r.type,
        name: r.name,
        description: r.description,
        content: r.content,
        visibility: r.visibility,
        tags: r.tags,
        ownerId: r.ownerId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));

      return noStore({ kind, count: data.length, items: data }, STATUS_OK);
    }

    if (kind === "rivr-agents") {
      const conditions = [isNull(agents.deletedAt)];
      if (scopeTypes.length > 0) {
        conditions.push(
          inArray(agents.type, scopeTypes as (typeof agents.type.enumValues)[number][]),
        );
      }
      if (scopeIds.length > 0) {
        conditions.push(inArray(agents.id, scopeIds));
      }

      const rows = await db
        .select()
        .from(agents)
        .where(and(...conditions))
        .orderBy(agents.name)
        .limit(MAX_ROWS);

      const viewable = await filterViewableAgents(actorId, rows);
      const data = viewable.map((a) => ({
        id: a.id,
        type: a.type,
        name: a.name,
        description: a.description,
        image: a.image,
        website: a.website,
        location: a.location,
        visibility: a.visibility,
        createdAt: a.createdAt,
      }));

      return noStore({ kind, count: data.length, items: data }, STATUS_OK);
    }

    // kind === "rivr-ledger"
    const conditions = [eq(ledger.isActive, true)];
    if (scopeTypes.length > 0) {
      conditions.push(
        inArray(ledger.verb, scopeTypes as (typeof ledger.verb.enumValues)[number][]),
      );
    }
    if (scopeIds.length > 0) {
      // A specific ledger scope id may reference either side of the triple.
      conditions.push(
        or(inArray(ledger.subjectId, scopeIds), inArray(ledger.objectId, scopeIds))!,
      );
    }

    const rows = await db
      .select()
      .from(ledger)
      .where(and(...conditions))
      .orderBy(desc(ledger.timestamp))
      .limit(MAX_ROWS);

    // Predicate privacy: only return ledger edges this actor is allowed to see.
    const visibility = await Promise.all(
      rows.map((row) => canViewPredicate(actorId, row.id)),
    );
    const viewable = rows.filter((_, i) => visibility[i].allowed);
    const data = viewable.map((l) => ({
      id: l.id,
      verb: l.verb,
      subjectId: l.subjectId,
      objectId: l.objectId,
      objectType: l.objectType,
      role: l.role,
      timestamp: l.timestamp,
      resourceId: l.resourceId,
    }));

    return noStore({ kind, count: data.length, items: data }, STATUS_OK);
  } catch (error) {
    console.error("[api/builder/rea-source] GET failed:", error);
    return noStore(
      { error: error instanceof Error ? error.message : "Failed to read REA source" },
      STATUS_INTERNAL_ERROR,
    );
  }
}
