import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { builderTables, builderTableRows } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { resolveDirectAgent } from "@/lib/assistant/resolve-direct-agent";
import { normalizeColumns, type BuilderColumn } from "@/lib/builder/tables";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const STATUS_OK = 200;
const STATUS_CREATED = 201;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL_ERROR = 500;

const DEFAULT_SITE_SLUG = "default";
const MAX_NAME_LENGTH = 120;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateTableBody {
  name?: unknown;
  description?: unknown;
  columns?: unknown;
  siteSlug?: unknown;
}

interface TableSummary {
  id: string;
  name: string;
  description: string | null;
  siteSlug: string;
  columns: BuilderColumn[];
  rowCount: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "Authentication required" },
    { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}

function asColumns(value: unknown): BuilderColumn[] {
  return (Array.isArray(value) ? value : []).map((c) => {
    const col = (c ?? {}) as Record<string, unknown>;
    return {
      key: String(col.key ?? ""),
      label: String(col.label ?? col.key ?? ""),
      type: (col.type as BuilderColumn["type"]) ?? "text",
    };
  });
}

// ---------------------------------------------------------------------------
// GET /api/builder/tables
//
// List the builder tables owned by the authenticated user's direct agent,
// each annotated with its current row count.
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  try {
    const { directAgentId } = await resolveDirectAgent(session.user.id);

    const rows = await db
      .select({
        id: builderTables.id,
        name: builderTables.name,
        description: builderTables.description,
        siteSlug: builderTables.siteSlug,
        columns: builderTables.columns,
        createdAt: builderTables.createdAt,
        updatedAt: builderTables.updatedAt,
        rowCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${builderTableRows}
          WHERE ${builderTableRows.tableId} = ${builderTables.id}
        )`,
      })
      .from(builderTables)
      .where(eq(builderTables.agentId, directAgentId))
      .orderBy(builderTables.createdAt);

    const tables: TableSummary[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      siteSlug: row.siteSlug,
      columns: asColumns(row.columns),
      rowCount: Number(row.rowCount ?? 0),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));

    return NextResponse.json(
      { tables },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/tables] GET failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list tables" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/builder/tables
//
// Create a new builder table with a normalized column schema.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  try {
    const body = (await request.json()) as CreateTableBody;

    const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_NAME_LENGTH) : "";
    if (!name) {
      return NextResponse.json(
        { error: "A table name is required" },
        { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    let columns: BuilderColumn[];
    try {
      columns = normalizeColumns(body.columns);
    } catch (columnError) {
      return NextResponse.json(
        { error: columnError instanceof Error ? columnError.message : "Invalid columns" },
        { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const description =
      typeof body.description === "string" && body.description.trim()
        ? body.description.trim()
        : null;
    const siteSlug =
      typeof body.siteSlug === "string" && body.siteSlug.trim()
        ? body.siteSlug.trim()
        : DEFAULT_SITE_SLUG;

    const { directAgentId } = await resolveDirectAgent(session.user.id);

    const [inserted] = await db
      .insert(builderTables)
      .values({ agentId: directAgentId, siteSlug, name, description, columns })
      .returning();

    const table: TableSummary = {
      id: inserted.id,
      name: inserted.name,
      description: inserted.description,
      siteSlug: inserted.siteSlug,
      columns: asColumns(inserted.columns),
      rowCount: 0,
      createdAt: inserted.createdAt.toISOString(),
      updatedAt: inserted.updatedAt.toISOString(),
    };

    return NextResponse.json(
      { table },
      { status: STATUS_CREATED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/tables] POST failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create table" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/builder/tables?tableId=...
//
// Delete a table (and its rows, via ON DELETE CASCADE) owned by the caller.
// ---------------------------------------------------------------------------

export async function DELETE(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  try {
    const tableId = new URL(request.url).searchParams.get("tableId");
    if (!tableId) {
      return NextResponse.json(
        { error: "tableId is required" },
        { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const { directAgentId } = await resolveDirectAgent(session.user.id);

    const deleted = await db
      .delete(builderTables)
      .where(and(eq(builderTables.id, tableId), eq(builderTables.agentId, directAgentId)))
      .returning({ id: builderTables.id });

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: "Table not found" },
        { status: STATUS_NOT_FOUND, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    return NextResponse.json(
      { ok: true, tableId: deleted[0].id },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/tables] DELETE failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete table" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
