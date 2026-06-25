import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { check, grantPermission, revokePermission } from "@/lib/permissions";
import {
  GRANTABLE_VERBS,
  isGrantableVerb,
  shapeAccessGrants,
  type AgentIdentity,
  type RawGrantRow,
} from "@/lib/agent-hq/resource-access";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Builds an id→identity lookup for the supplied agent ids, flagging which are
 * personas of `ownerId`.
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
 * GET /api/agent-hq/resources/[id]/access
 *
 * Returns the resource's visibility and its active explicit grants (the ACL
 * panel). Restricted to agents who can `grant` on the resource (owner / group
 * write). Visibility is the implicit-access fallback; grants layer on top.
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
      .select({ id: resources.id, ownerId: resources.ownerId, visibility: resources.visibility })
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

    const grantRows = await db
      .select({
        subjectId: ledger.subjectId,
        metadata: ledger.metadata,
        role: ledger.role,
        timestamp: ledger.timestamp,
      })
      .from(ledger)
      .where(
        and(
          eq(ledger.verb, "grant"),
          eq(ledger.objectId, id),
          eq(ledger.isActive, true),
        ),
      );

    const raw: RawGrantRow[] = grantRows.map((row) => ({
      subjectId: row.subjectId,
      action:
        row.metadata && typeof row.metadata === "object" && "action" in row.metadata
          ? String((row.metadata as Record<string, unknown>).action ?? "")
          : null,
      role: row.role,
      grantedAt: row.timestamp,
    }));

    const lookup = await loadIdentities(
      [...new Set(raw.map((r) => r.subjectId))],
      resource.ownerId,
    );

    return NextResponse.json({
      visibility: resource.visibility,
      grantableVerbs: GRANTABLE_VERBS,
      grants: shapeAccessGrants(raw, lookup),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read access";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * POST /api/agent-hq/resources/[id]/access
 *
 * Grants or revokes a permission for an agent/persona on the resource. Body:
 * `{ action: "grant" | "revoke", subjectId, verb }`. The underlying
 * grant/revoke helpers re-verify the actor holds `grant` on the resource, so a
 * non-owner is rejected with 403.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      subjectId?: string;
      verb?: string;
    };

    if (body.action !== "grant" && body.action !== "revoke") {
      return NextResponse.json(
        { error: 'action must be "grant" or "revoke"' },
        { status: 400 },
      );
    }
    if (!body.subjectId?.trim()) {
      return NextResponse.json({ error: "subjectId is required" }, { status: 400 });
    }
    if (!isGrantableVerb(body.verb)) {
      return NextResponse.json(
        { error: `verb must be one of: ${GRANTABLE_VERBS.join(", ")}` },
        { status: 400 },
      );
    }

    try {
      if (body.action === "grant") {
        await grantPermission({
          grantorId: userId,
          subjectId: body.subjectId,
          verb: body.verb,
          targetId: id,
          targetType: "resource",
        });
      } else {
        await revokePermission({
          revokerId: userId,
          subjectId: body.subjectId,
          verb: body.verb,
          targetId: id,
          targetType: "resource",
        });
      }
    } catch (permissionError) {
      const message =
        permissionError instanceof Error ? permissionError.message : "Permission denied";
      return NextResponse.json({ error: message }, { status: 403 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update access";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
