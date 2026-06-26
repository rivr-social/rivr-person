import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { check } from "@/lib/permissions";
import { createPostResource } from "@/app/actions/resource-creation/posts";
import { shapeShareEmbed, type ShareableFileResource } from "@/lib/agent-hq/file-resources";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function stringArray(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out = input.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * POST /api/agent-hq/resources/[id]/share
 *
 * Shares a stored file/document Resource as a post, optionally with an embedded
 * offering. Body: `{ caption?, linkedOfferingId?, isGlobal?, scopedLocaleIds?,
 * scopedRegionIds?, scopedGroupIds?, scopedUserIds?, ownerId? }`. The actor must
 * hold `share` on the resource (owners short-circuit). The file's public URL is
 * surfaced as the post embed; images additionally set the post image so the
 * card renders inline.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await context.params;

    const [resource] = await db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
        url: resources.url,
        contentType: resources.contentType,
        metadata: resources.metadata,
      })
      .from(resources)
      .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
      .limit(1);
    if (!resource) return NextResponse.json({ error: "Resource not found" }, { status: 404 });

    const canShare = await check(userId, "share", id, "resource");
    if (!canShare.allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const meta =
      resource.metadata && typeof resource.metadata === "object"
        ? (resource.metadata as Record<string, unknown>)
        : null;
    const fileResource: ShareableFileResource = {
      name: resource.name,
      type: resource.type,
      url: resource.url ?? (meta && typeof meta.url === "string" ? meta.url : null),
      contentType:
        resource.contentType ?? (meta && typeof meta.contentType === "string" ? meta.contentType : null),
    };
    const embed = shapeShareEmbed(fileResource);
    if (!embed) {
      return NextResponse.json(
        { error: "This resource has no shareable file to attach" },
        { status: 400 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      caption?: unknown;
      linkedOfferingId?: unknown;
      isGlobal?: unknown;
      scopedLocaleIds?: unknown;
      scopedRegionIds?: unknown;
      scopedGroupIds?: unknown;
      scopedUserIds?: unknown;
      ownerId?: unknown;
    };

    const caption =
      typeof body.caption === "string" && body.caption.trim()
        ? body.caption.trim()
        : `Shared: ${resource.name ?? "a file"}`;
    const linkedOfferingId =
      typeof body.linkedOfferingId === "string" && body.linkedOfferingId.trim()
        ? body.linkedOfferingId.trim()
        : null;
    const ownerId =
      typeof body.ownerId === "string" && body.ownerId.trim() ? body.ownerId.trim() : undefined;

    const result = await createPostResource({
      content: caption,
      embeds: [embed],
      imageUrl: embed.kind === "image" ? embed.url : null,
      linkedOfferingId,
      ownerId,
      isGlobal: body.isGlobal !== false,
      scopedLocaleIds: stringArray(body.scopedLocaleIds),
      scopedRegionIds: stringArray(body.scopedRegionIds),
      scopedGroupIds: stringArray(body.scopedGroupIds),
      scopedUserIds: stringArray(body.scopedUserIds),
    });

    if (!result.success) {
      const status = result.error?.code === "FORBIDDEN" ? 403 : 400;
      return NextResponse.json({ error: result.message }, { status });
    }

    return NextResponse.json({ ok: true, postId: result.resourceId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to share resource";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
