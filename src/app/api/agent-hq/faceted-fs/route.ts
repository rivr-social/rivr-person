import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull, desc } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import {
  buildFacetedTree,
  parseFacetedTagsFromMetadata,
  type FacetedDoc,
} from "@/lib/parachute-doc";

export const dynamic = "force-dynamic";

/**
 * Resource types treated as faceted-FS "doc / data Resources". These carry a
 * markdown/text body and participate in the faceted virtual filesystem.
 */
const DOC_RESOURCE_TYPES = ["document", "note", "dataset"] as const;

type Scope = "self" | "persona" | "group";

const VALID_SCOPES = new Set<Scope>(["self", "persona", "group"]);

/**
 * GET /api/agent-hq/faceted-fs
 *
 * Returns the agent's doc Resources arranged as a faceted virtual filesystem
 * (T2.5). Each doc's `metadata.facetedTags` tag-paths place it under multiple
 * orthogonal folder hierarchies at once; docs with no faceted tags fall back to
 * depth-1 facets derived from their flat `tags`, and otherwise land in an
 * "Untagged" bucket. The tags are an overlay/index only — visibility and
 * ownership are unaffected.
 *
 * Query params:
 *   scope    — "self" | "persona" | "group" (default: "self")
 *   agentId  — UUID of the agent whose docs to fetch (required for persona/group)
 */
export async function GET(request: NextRequest) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const scopeParam = (searchParams.get("scope") ?? "self") as Scope;
    const agentIdParam = searchParams.get("agentId");

    if (!VALID_SCOPES.has(scopeParam)) {
      return NextResponse.json(
        { error: `Invalid scope: ${scopeParam}. Must be one of: ${[...VALID_SCOPES].join(", ")}` },
        { status: 400 },
      );
    }

    let ownerId: string;
    if (scopeParam === "self") {
      ownerId = process.env.PRIMARY_AGENT_ID ?? userId;
    } else {
      if (!agentIdParam) {
        return NextResponse.json(
          { error: "agentId query parameter is required for persona and group scopes" },
          { status: 400 },
        );
      }
      ownerId = agentIdParam;
    }

    const rows = await db
      .select({
        id: resources.id,
        name: resources.name,
        tags: resources.tags,
        metadata: resources.metadata,
      })
      .from(resources)
      .where(
        and(
          eq(resources.ownerId, ownerId),
          isNull(resources.deletedAt),
          inArray(resources.type, [...DOC_RESOURCE_TYPES]),
        ),
      )
      .orderBy(desc(resources.createdAt));

    const docs: FacetedDoc[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      tags: parseFacetedTagsFromMetadata(row.metadata, row.tags),
    }));

    const tree = buildFacetedTree(docs);

    return NextResponse.json({ tree, docCount: docs.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to build faceted filesystem";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
