import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { check } from "@/lib/permissions";
import {
  shapeLedgerHistory,
  type AgentIdentity,
  type RawLedgerRow,
} from "@/lib/agent-hq/resource-access";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const HISTORY_LIMIT = 100;

/**
 * Builds an id→identity lookup for the supplied agent ids (subjects of ledger
 * rows), flagging which are personas of `ownerId`.
 */
async function loadIdentities(
  ids: string[],
  ownerId: string,
): Promise<Map<string, AgentIdentity>> {
  const lookup = new Map<string, AgentIdentity>();
  if (ids.length === 0) return lookup;
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      image: agents.image,
      parentAgentId: agents.parentAgentId,
    })
    .from(agents)
    .where(inArray(agents.id, ids));
  for (const row of rows) {
    lookup.set(row.id, {
      id: row.id,
      name: row.name,
      image: row.image ?? null,
      isPersona: row.parentAgentId === ownerId,
    });
  }
  return lookup;
}

/**
 * GET /api/agent-hq/resources/[id]/ledger
 *
 * Read-only audit history for a resource. Restricted to agents who can `grant`
 * on the resource (owner / group write) so the history panel mirrors the ACL
 * panel's access boundary. Returns the most recent {@link HISTORY_LIMIT} ledger
 * rows tied to the resource (by `objectId` or `resourceId`), newest first.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;

    const [resource] = await db
      .select({ id: resources.id, ownerId: resources.ownerId })
      .from(resources)
      .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
      .limit(1);

    if (!resource) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }

    const canManage = await check(userId, "grant", id, "resource");
    if (!canManage.allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const rows = await db
      .select({
        id: ledger.id,
        verb: ledger.verb,
        subjectId: ledger.subjectId,
        objectType: ledger.objectType,
        metadata: ledger.metadata,
        timestamp: ledger.timestamp,
      })
      .from(ledger)
      .where(eq(ledger.objectId, id))
      .orderBy(desc(ledger.timestamp))
      .limit(HISTORY_LIMIT);

    const subjectIds = [...new Set(rows.map((r) => r.subjectId))];
    const lookup = await loadIdentities(subjectIds, resource.ownerId);

    const raw: RawLedgerRow[] = rows.map((row) => ({
      id: row.id,
      verb: row.verb,
      subjectId: row.subjectId,
      objectType: row.objectType,
      metadata:
        row.metadata && typeof row.metadata === "object"
          ? (row.metadata as Record<string, unknown>)
          : null,
      timestamp: row.timestamp,
    }));

    return NextResponse.json({ history: shapeLedgerHistory(raw, lookup) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read ledger";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
