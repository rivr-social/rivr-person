import { NextResponse } from "next/server";
import { and, eq, isNull, desc } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { assertAgentHqAccess } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent-hq/personas
 *
 * Lists the operating agent's personas (agents whose `parentAgentId` is the
 * owner). These are valid ACL targets for the filesystem organizer's per-node
 * sharing panel (T2.1) — an owner can grant a persona access to a resource.
 */
export async function GET() {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const ownerId = process.env.PRIMARY_AGENT_ID ?? userId;

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        image: agents.image,
        description: agents.description,
      })
      .from(agents)
      .where(and(eq(agents.parentAgentId, ownerId), isNull(agents.deletedAt)))
      .orderBy(desc(agents.createdAt));

    return NextResponse.json({
      personas: rows.map((row) => ({
        id: row.id,
        name: row.name,
        image: row.image ?? null,
        description: row.description ?? null,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list personas";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
