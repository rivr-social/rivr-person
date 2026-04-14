import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { builderDataSources } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import type { DataSourceKind, DataSourceConfig } from "@/lib/bespoke/types";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const STATUS_OK = 200;
const STATUS_CREATED = 201;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_INTERNAL_ERROR = 500;

const VALID_KINDS: readonly DataSourceKind[] = [
  "myprofile",
  "public-profile",
  "solid-pod",
  "universal-manifest",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpsertRequestBody {
  kind: DataSourceKind;
  label?: string;
  enabled?: boolean;
  config?: DataSourceConfig;
}

// ---------------------------------------------------------------------------
// GET /api/builder/data-sources
//
// List all data source bindings for the authenticated user.
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const rows = await db
      .select()
      .from(builderDataSources)
      .where(eq(builderDataSources.agentId, session.user.id));

    const sources = rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      kind: row.kind,
      label: row.label,
      enabled: row.enabled,
      config: row.config,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    return NextResponse.json(
      { sources },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/data-sources] GET failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list data sources" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

// ---------------------------------------------------------------------------
// PUT /api/builder/data-sources
//
// Upsert a data source binding. If a binding with the same agentId + kind
// already exists, update it; otherwise insert a new row.
// ---------------------------------------------------------------------------

export async function PUT(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const body = (await request.json()) as UpsertRequestBody;

    if (!body.kind || !VALID_KINDS.includes(body.kind)) {
      return NextResponse.json(
        { error: `Invalid or missing kind. Must be one of: ${VALID_KINDS.join(", ")}` },
        { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const agentId = session.user.id;
    const kind = body.kind;
    const label = body.label ?? kind;
    const enabled = body.enabled ?? true;
    const config = (body.config ?? {}) as Record<string, unknown>;

    // Check if a binding already exists for this agent + kind
    const existing = await db
      .select({ id: builderDataSources.id })
      .from(builderDataSources)
      .where(
        and(
          eq(builderDataSources.agentId, agentId),
          eq(builderDataSources.kind, kind),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      // Update existing
      const [updated] = await db
        .update(builderDataSources)
        .set({
          label,
          enabled,
          config,
          updatedAt: new Date(),
        })
        .where(eq(builderDataSources.id, existing[0].id))
        .returning();

      return NextResponse.json(
        {
          source: {
            id: updated.id,
            agentId: updated.agentId,
            kind: updated.kind,
            label: updated.label,
            enabled: updated.enabled,
            config: updated.config,
            createdAt: updated.createdAt.toISOString(),
            updatedAt: updated.updatedAt.toISOString(),
          },
        },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    // Insert new
    const [inserted] = await db
      .insert(builderDataSources)
      .values({
        agentId,
        kind,
        label,
        enabled,
        config,
      })
      .returning();

    return NextResponse.json(
      {
        source: {
          id: inserted.id,
          agentId: inserted.agentId,
          kind: inserted.kind,
          label: inserted.label,
          enabled: inserted.enabled,
          config: inserted.config,
          createdAt: inserted.createdAt.toISOString(),
          updatedAt: inserted.updatedAt.toISOString(),
        },
      },
      { status: STATUS_CREATED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/data-sources] PUT failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upsert data source" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
