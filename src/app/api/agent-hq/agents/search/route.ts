import { NextResponse } from "next/server";
import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { assertAgentHqAccess } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

const RESULT_LIMIT = 20;

/**
 * GET /api/agent-hq/agents/search?q=<term>
 *
 * Searches the agent graph for permission-grant targets. Unlike
 * `/api/agent-hq/personas` (owner's personas only), this returns ANY agent so
 * a resource can be shared with any agent/persona/group — the permission model
 * is not limited to the owner's own personas. Matches on name/email/id
 * (case-insensitive), newest-relevant first, capped at {@link RESULT_LIMIT}.
 * Personas of the operating user are flagged for the picker.
 */
export async function GET(request: Request) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const term = new URL(request.url).searchParams.get("q")?.trim() ?? "";

    const filters = [isNull(agents.deletedAt)];
    if (term.length > 0) {
      const like = `%${term}%`;
      const match = or(
        ilike(agents.name, like),
        ilike(agents.email, like),
        ilike(agents.id, like),
      );
      if (match) filters.push(match);
    }

    const rows = await db
      .select({
        id: agents.id,
        name: agents.name,
        image: agents.image,
        type: agents.type,
        parentAgentId: agents.parentAgentId,
      })
      .from(agents)
      .where(and(...filters))
      .limit(RESULT_LIMIT);

    return NextResponse.json({
      agents: rows
        .map((row) => ({
          id: row.id,
          name: row.name,
          image: row.image ?? null,
          type: row.type,
          isPersona: row.parentAgentId === userId,
          isSelf: row.id === userId,
        }))
        .sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to search agents";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
