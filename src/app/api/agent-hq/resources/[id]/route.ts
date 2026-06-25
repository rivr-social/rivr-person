import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources, type VisibilityLevel } from "@/db/schema";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { check } from "@/lib/permissions";
import { canModifyResource, updateResource } from "@/app/actions/create-resources";
import {
  flattenFacetedTags,
  normalizeFacetedTags,
  parseFacetedTagsFromMetadata,
} from "@/lib/parachute-doc";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const EDITABLE_VISIBILITIES = new Set<VisibilityLevel>([
  "public",
  "locale",
  "members",
  "private",
  "hidden",
]);

/**
 * GET /api/agent-hq/resources/[id]
 *
 * Reads a single resource for the organizer's slide-in editor (T2.1). Requires
 * `view` permission. Returns the body/metadata, parsed faceted tag-paths, and an
 * `editable` flag (owner-only Resource edits per the spec).
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

    const [row] = await db
      .select()
      .from(resources)
      .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }

    const viewable = await check(userId, "view", id, "resource");
    if (!viewable.allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const editable = row.ownerId === userId
      ? true
      : (await canModifyResource(userId, id)).allowed;

    return NextResponse.json({
      resource: shapeResource(row),
      editable,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read resource";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * PATCH /api/agent-hq/resources/[id]
 *
 * Owner-only edit of a resource's name/description/body/visibility and faceted
 * tags. Delegates to the canonical `updateResource` action (which enforces the
 * permission gate, audits to the ledger, re-embeds, and handles federation
 * routing). When `facetedTags` is supplied it is normalized into
 * `metadata.facetedTags` and projected into the flat `tags` column.
 */
export async function PATCH(request: Request, context: RouteContext) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      name?: string;
      description?: string | null;
      content?: string | null;
      tags?: string[];
      visibility?: string;
      facetedTags?: unknown;
    };

    const update: Parameters<typeof updateResource>[0] = { resourceId: id };

    if (typeof body.name === "string") update.name = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.content !== undefined) update.content = body.content;

    if (body.visibility !== undefined) {
      if (!EDITABLE_VISIBILITIES.has(body.visibility as VisibilityLevel)) {
        return NextResponse.json(
          { error: `Invalid visibility: ${body.visibility}` },
          { status: 400 },
        );
      }
      update.visibility = body.visibility as VisibilityLevel;
    }

    if (body.facetedTags !== undefined) {
      const normalized = normalizeFacetedTags(body.facetedTags);
      update.metadataPatch = { facetedTags: normalized };
      update.tags = flattenFacetedTags(normalized);
    } else if (body.tags !== undefined) {
      update.tags = body.tags;
    }

    const result = await updateResource(update);
    if (!result.success) {
      const status = result.error?.code === "FORBIDDEN" ? 403 : 400;
      return NextResponse.json(
        { error: result.message, code: result.error?.code },
        { status },
      );
    }

    const [row] = await db
      .select()
      .from(resources)
      .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
      .limit(1);

    return NextResponse.json({ ok: true, resource: row ? shapeResource(row) : null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update resource";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function shapeResource(row: typeof resources.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    description: row.description,
    content: row.content,
    contentType: row.contentType,
    url: row.url,
    ownerId: row.ownerId,
    visibility: row.visibility,
    tags: row.tags ?? [],
    facetedTags: parseFacetedTagsFromMetadata(row.metadata, row.tags),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
