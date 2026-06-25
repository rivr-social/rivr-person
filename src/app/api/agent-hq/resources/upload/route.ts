import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { createResourceWithLedger } from "@/app/actions/resource-creation/helpers";
import { resourceTypeForMime } from "@/lib/agent-hq/file-resources";
import type { VisibilityLevel } from "@/db/schema";

export const dynamic = "force-dynamic";

const VISIBILITY_LEVELS = new Set<VisibilityLevel>([
  "public",
  "locale",
  "members",
  "private",
  "hidden",
]);

function asVisibility(value: unknown): VisibilityLevel | undefined {
  return typeof value === "string" && VISIBILITY_LEVELS.has(value as VisibilityLevel)
    ? (value as VisibilityLevel)
    : undefined;
}

/**
 * POST /api/agent-hq/resources/upload
 *
 * Promotes an already-uploaded object (stored via `POST /api/upload`) into a
 * first-class file Resource in the unified filesystem. Body:
 * `{ name, url, storageKey, contentType, fileSize?, description?, tags?,
 * visibility?, ownerId? }`. The resource type is derived from the MIME type so
 * arbitrary filetypes land in the right bucket (image/video/audio/document/
 * file). Visibility defaults to `private`; `createResourceWithLedger` enforces
 * auth, rate limits, and group-write checks when `ownerId` is set.
 */
export async function POST(request: Request) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      url?: unknown;
      storageKey?: unknown;
      storageProvider?: unknown;
      contentType?: unknown;
      fileSize?: unknown;
      description?: unknown;
      tags?: unknown;
      visibility?: unknown;
      ownerId?: unknown;
    };

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const url = typeof body.url === "string" ? body.url.trim() : "";
    const storageKey = typeof body.storageKey === "string" ? body.storageKey.trim() : "";
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    if (!url || !storageKey) {
      return NextResponse.json(
        { error: "url and storageKey are required (upload the file via /api/upload first)" },
        { status: 400 },
      );
    }

    const contentType =
      typeof body.contentType === "string" && body.contentType.trim()
        ? body.contentType.trim()
        : undefined;
    const fileSize =
      typeof body.fileSize === "number" && Number.isFinite(body.fileSize) && body.fileSize >= 0
        ? Math.floor(body.fileSize)
        : undefined;
    const storageProvider =
      typeof body.storageProvider === "string" && body.storageProvider.trim()
        ? body.storageProvider.trim()
        : undefined;
    const description =
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : undefined;
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === "string")
      : undefined;
    const visibility = asVisibility(body.visibility) ?? "private";
    const ownerId =
      typeof body.ownerId === "string" && body.ownerId.trim() ? body.ownerId.trim() : undefined;

    const result = await createResourceWithLedger({
      name,
      type: resourceTypeForMime(contentType),
      description,
      tags,
      visibility,
      ownerId,
      file: { url, storageKey, storageProvider, contentType, fileSize },
      metadata: { entityType: "file", source: "agent-hq-upload", contentType: contentType ?? null },
    });

    if (!result.success) {
      const status = result.error?.code === "FORBIDDEN" ? 403 : 400;
      return NextResponse.json({ error: result.message }, { status });
    }

    return NextResponse.json({ ok: true, resourceId: result.resourceId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create file resource";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
