import { NextResponse } from "next/server";
import { and, ilike, isNull, or, sql } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { couldMatchAgentId } from "@/lib/agent-search";
import { assertAgentHqAccess } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

const RESULT_LIMIT = 20;
// Require a real query fragment. A blank/1-char query would otherwise
// enumerate the entire agent graph, and matching on email turned the search
// into an email-existence oracle (DBR-SEC-004). Share targets must be looked
// up by a meaningful name/id fragment.
const MIN_TERM_LENGTH = 2;

/**
 * GET /api/agent-hq/agents/search?q=<term>
 *
 * Searches the agent graph for permission-grant targets. Unlike
 * `/api/agent-hq/personas` (owner's personas only), this returns ANY agent so
 * a resource can be shared with any agent/persona/group — the permission model
 * is not limited to the owner's own personas. Matches on name/id only
 * (case-insensitive) — email is intentionally NOT a match predicate (no
 * email-enumeration oracle) and never returned. Requires a query of at least
 * {@link MIN_TERM_LENGTH} characters, capped at {@link RESULT_LIMIT}. Personas
 * of the operating user are flagged for the picker.
 *
 * The id predicate casts to text explicitly. `agents.id` is a `uuid` column and
 * Postgres has no `uuid ~~* text` operator, so `ilike(agents.id, ...)` made the
 * route throw `operator does not exist: uuid ~~* unknown` on EVERY search past
 * the minimum length — the grant-target picker in the ACL panel was returning a
 * 500 for every query, not just id-shaped ones, because `or()` evaluates the
 * whole predicate.
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

    // Short-circuit on too-short queries rather than enumerating all agents.
    if (term.length < MIN_TERM_LENGTH) {
      return NextResponse.json({ agents: [] });
    }

    const filters = [isNull(agents.deletedAt)];
    const like = `%${term}%`;

    // A uuid contains only hex digits and dashes, so a term with any other
    // character provably cannot match an id. Skipping the cast for those keeps
    // ordinary name searches off a full-table `::text` conversion without
    // changing a single result.
    const match = couldMatchAgentId(term)
      ? or(ilike(agents.name, like), sql`${agents.id}::text ILIKE ${like}`)
      : ilike(agents.name, like);
    if (match) filters.push(match);

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
