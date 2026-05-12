/**
 * Admin endpoint to reconcile orphaned Matrix room mappings.
 *
 * Walks every live row in `group_matrix_rooms` (and `dmRooms`), probes Synapse
 * for the underlying room, and soft-deletes rows whose rooms have been purged.
 * Synapse errors that aren't 404 are surfaced in the response so an operator
 * can decide whether to retry; the rows themselves are left alive.
 *
 * Auth: gated by `metadata.siteRole === "admin"` on the calling agent, the same
 * pattern used by `apps/global/src/app/api/admin/smtp-config/route.ts`.
 */

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import {
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
  STATUS_OK,
  STATUS_UNAUTHORIZED,
} from "@/lib/http-status";
import { reconcileGroupMatrixRooms, reconcileDmRooms } from "@/lib/matrix-groups";

const ADMIN_FORBIDDEN_MESSAGE = "Forbidden: admin privileges required";
const UNAUTHORIZED_MESSAGE = "Authentication required";

async function requireAdminOrRespond(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: UNAUTHORIZED_MESSAGE },
      { status: STATUS_UNAUTHORIZED },
    );
  }

  const [agent] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, session.user.id))
    .limit(1);

  const metadata =
    agent?.metadata && typeof agent.metadata === "object" && !Array.isArray(agent.metadata)
      ? (agent.metadata as Record<string, unknown>)
      : {};

  if (metadata.siteRole !== "admin") {
    return NextResponse.json(
      { error: ADMIN_FORBIDDEN_MESSAGE },
      { status: STATUS_FORBIDDEN },
    );
  }

  return null;
}

/**
 * POST /api/admin/matrix/reconcile
 *
 * Body: none (request body is ignored).
 * Returns: `{ ok: true, groups: {...}, dms: {...} }` on success.
 */
export async function POST(_request: NextRequest): Promise<NextResponse> {
  void _request;

  const denied = await requireAdminOrRespond();
  if (denied) return denied;

  try {
    const groups = await reconcileGroupMatrixRooms();
    const dms = await reconcileDmRooms();

    return NextResponse.json(
      {
        ok: true,
        groups,
        dms,
      },
      { status: STATUS_OK },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[admin/matrix/reconcile] failed: ${message}`);
    return NextResponse.json(
      { ok: false, error: "Reconciliation failed", detail: message },
      { status: STATUS_INTERNAL_ERROR },
    );
  }
}
