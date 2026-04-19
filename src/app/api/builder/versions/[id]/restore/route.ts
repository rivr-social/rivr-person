import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { siteVersions } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

// ---------------------------------------------------------------------------
// POST /api/builder/versions/[id]/restore
//
// Restore a specific version's file snapshot. Returns the full file set
// so the client can replace its current state. Does NOT automatically
// deploy -- that is left to the user's explicit action.
// ---------------------------------------------------------------------------

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const { id: versionId } = await params;

  if (!versionId) {
    return NextResponse.json(
      { error: "Missing version ID" },
      { status: 400, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    // Fetch the version, ensuring it belongs to the authenticated user
    const rows = await db
      .select({
        id: siteVersions.id,
        versionNumber: siteVersions.versionNumber,
        commitMessage: siteVersions.commitMessage,
        filesSnapshot: siteVersions.filesSnapshot,
        trigger: siteVersions.trigger,
        createdAt: siteVersions.createdAt,
      })
      .from(siteVersions)
      .where(
        and(
          eq(siteVersions.id, versionId),
          eq(siteVersions.agentId, session.user.id),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Version not found" },
        { status: 404, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const version = rows[0];

    console.log(
      `[api/builder/versions/restore] Restoring version ${version.versionNumber} for agent ${session.user.id}`,
    );

    return NextResponse.json(
      {
        id: version.id,
        versionNumber: version.versionNumber,
        commitMessage: version.commitMessage,
        trigger: version.trigger,
        files: version.filesSnapshot,
        fileCount: version.filesSnapshot ? Object.keys(version.filesSnapshot).length : 0,
        createdAt: version.createdAt.toISOString(),
      },
      { headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/versions/restore] Restore failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to restore version" },
      { status: 500, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
