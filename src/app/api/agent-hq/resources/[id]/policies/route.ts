import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources, type VerbType } from "@/db/schema";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import {
  check,
  createPermissionPolicy,
  deletePermissionPolicy,
  getPoliciesForTarget,
  type AttributeCondition,
  type PermissionPolicyMetadata,
} from "@/lib/permissions";
import { GRANTABLE_VERBS, isGrantableVerb } from "@/lib/agent-hq/resource-access";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const CONDITION_OPERATORS = new Set(["equals", "contains", "in", "exists"]);

function parseConditions(input: unknown): AttributeCondition[] {
  if (!Array.isArray(input)) return [];
  const out: AttributeCondition[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const key = typeof c.key === "string" ? c.key.trim() : "";
    const operator = typeof c.operator === "string" ? c.operator : "";
    if (!key || !CONDITION_OPERATORS.has(operator)) continue;
    const value = Array.isArray(c.value)
      ? c.value.filter((v): v is string => typeof v === "string")
      : typeof c.value === "string"
        ? c.value
        : "";
    out.push({ key, operator: operator as AttributeCondition["operator"], value });
  }
  return out;
}

/**
 * GET /api/agent-hq/resources/[id]/policies
 *
 * Lists the ABAC permission policies protecting a resource (attribute-based
 * access — the "context"/"role" dimension beyond direct grants). Restricted to
 * agents who can `grant` on the resource, mirroring the ACL panel boundary.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await context.params;

    const [resource] = await db
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
      .limit(1);
    if (!resource) return NextResponse.json({ error: "Resource not found" }, { status: 404 });

    const canManage = await check(userId, "grant", id, "resource");
    if (!canManage.allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const rows = await getPoliciesForTarget(id, "resource");
    const policies = rows.map((row) => {
      const meta = (row.metadata ?? {}) as unknown as PermissionPolicyMetadata;
      return {
        id: row.id,
        label: meta.label ?? row.name ?? "Policy",
        allowedActions: meta.allowedActions ?? [],
        conditions: meta.conditions ?? [],
        logicalOperator: meta.logicalOperator ?? "AND",
        localeScope: meta.localeScope ?? null,
      };
    });

    return NextResponse.json({ policies, grantableVerbs: GRANTABLE_VERBS });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read policies";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * POST /api/agent-hq/resources/[id]/policies
 *
 * Creates an ABAC policy on the resource. Body:
 * `{ allowedActions, conditions: [{key, operator, value}], logicalOperator,
 * localeScope?, label? }`. Delegates to `createPermissionPolicy`, which
 * re-verifies the actor holds `manage` on the resource.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      allowedActions?: unknown;
      conditions?: unknown;
      logicalOperator?: unknown;
      localeScope?: unknown;
      label?: unknown;
    };

    const allowedActions = (Array.isArray(body.allowedActions) ? body.allowedActions : []).filter(
      isGrantableVerb,
    ) as VerbType[];
    if (allowedActions.length === 0) {
      return NextResponse.json(
        { error: `allowedActions must include at least one of: ${GRANTABLE_VERBS.join(", ")}` },
        { status: 400 },
      );
    }

    const conditions = parseConditions(body.conditions);
    if (conditions.length === 0) {
      return NextResponse.json(
        { error: "At least one valid condition (key + operator) is required" },
        { status: 400 },
      );
    }

    const logicalOperator = body.logicalOperator === "OR" ? "OR" : "AND";
    const localeScope =
      typeof body.localeScope === "string" && body.localeScope.trim()
        ? body.localeScope.trim()
        : undefined;
    const label =
      typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined;

    try {
      const policyId = await createPermissionPolicy({
        creatorId: userId,
        targetId: id,
        targetType: "resource",
        allowedActions,
        conditions,
        logicalOperator,
        localeScope,
        label,
      });
      return NextResponse.json({ ok: true, policyId });
    } catch (policyError) {
      const message = policyError instanceof Error ? policyError.message : "Policy denied";
      return NextResponse.json({ error: message }, { status: 403 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create policy";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * DELETE /api/agent-hq/resources/[id]/policies?policyId=<id>
 *
 * Soft-deletes an ABAC policy. `deletePermissionPolicy` re-verifies the actor
 * holds `manage` on the policy's target.
 */
export async function DELETE(request: Request, context: RouteContext) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    await context.params;
    const policyId = new URL(request.url).searchParams.get("policyId")?.trim();
    if (!policyId) {
      return NextResponse.json({ error: "policyId is required" }, { status: 400 });
    }

    try {
      await deletePermissionPolicy(userId, policyId);
      return NextResponse.json({ ok: true });
    } catch (policyError) {
      const message = policyError instanceof Error ? policyError.message : "Delete denied";
      return NextResponse.json({ error: message }, { status: 403 });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete policy";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
