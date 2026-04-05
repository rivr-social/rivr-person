import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { siteVersions } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import type { SiteFiles } from "@/lib/bespoke/site-files";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";
const MAX_VERSIONS_RETURNED = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateVersionRequestBody {
  files: SiteFiles;
  commitMessage?: string;
  trigger?: "deploy" | "save" | "manual";
}

interface VersionListItem {
  id: string;
  versionNumber: number;
  commitMessage: string | null;
  trigger: string;
  fileCount: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// GET /api/builder/versions
//
// List all version snapshots for the authenticated user's site, ordered by
// most recent first.
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const rows = await db
      .select({
        id: siteVersions.id,
        versionNumber: siteVersions.versionNumber,
        commitMessage: siteVersions.commitMessage,
        trigger: siteVersions.trigger,
        filesSnapshot: siteVersions.filesSnapshot,
        createdAt: siteVersions.createdAt,
      })
      .from(siteVersions)
      .where(eq(siteVersions.agentId, session.user.id))
      .orderBy(desc(siteVersions.versionNumber))
      .limit(MAX_VERSIONS_RETURNED);

    const versions: VersionListItem[] = rows.map((row) => ({
      id: row.id,
      versionNumber: row.versionNumber,
      commitMessage: row.commitMessage,
      trigger: row.trigger,
      fileCount: row.filesSnapshot ? Object.keys(row.filesSnapshot).length : 0,
      createdAt: row.createdAt.toISOString(),
    }));

    return NextResponse.json(
      { versions },
      { headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/versions] List failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list versions" },
      { status: 500, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/builder/versions
//
// Create a new version snapshot of the current site files.
// Automatically determines the next version number.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: 401, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const body = (await request.json()) as CreateVersionRequestBody;

    if (!body.files || typeof body.files !== "object" || Object.keys(body.files).length === 0) {
      return NextResponse.json(
        { error: "Missing or empty files object" },
        { status: 400, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    // Determine next version number
    const maxResult = await db
      .select({ maxVersion: sql<number>`COALESCE(MAX(${siteVersions.versionNumber}), 0)` })
      .from(siteVersions)
      .where(eq(siteVersions.agentId, session.user.id));

    const nextVersion = (maxResult[0]?.maxVersion ?? 0) + 1;

    const trigger = body.trigger || "manual";
    const commitMessage = body.commitMessage || null;

    const [inserted] = await db
      .insert(siteVersions)
      .values({
        agentId: session.user.id,
        versionNumber: nextVersion,
        commitMessage,
        filesSnapshot: body.files,
        trigger,
      })
      .returning({
        id: siteVersions.id,
        versionNumber: siteVersions.versionNumber,
        createdAt: siteVersions.createdAt,
      });

    console.log(
      `[api/builder/versions] Created version ${nextVersion} for agent ${session.user.id} (trigger: ${trigger}, files: ${Object.keys(body.files).length})`,
    );

    return NextResponse.json(
      {
        id: inserted.id,
        versionNumber: inserted.versionNumber,
        fileCount: Object.keys(body.files).length,
        trigger,
        commitMessage,
        createdAt: inserted.createdAt.toISOString(),
      },
      { status: 201, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/versions] Create failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create version" },
      { status: 500, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
