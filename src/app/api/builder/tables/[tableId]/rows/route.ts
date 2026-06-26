import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { builderTables, builderTableRows } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { resolveDirectAgent } from "@/lib/assistant/resolve-direct-agent";
import { validateRow, type BuilderColumn } from "@/lib/builder/tables";

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RouteContext {
  params: Promise<{ tableId: string }>;
}

interface AddRowBody {
  data?: unknown;
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

function tableNotFound(): NextResponse {
  return NextResponse.json(
    { error: "Table not found" },
    { status: STATUS_NOT_FOUND, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
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

/**
 * Loads a table only if it belongs to the caller's direct agent. Returns the
 * table's column schema or null when the table is missing / not owned.
 */
async function loadOwnedTable(
  tableId: string,
  directAgentId: string,
): Promise<{ columns: BuilderColumn[] } | null> {
  const [row] = await db
    .select({ columns: builderTables.columns })
    .from(builderTables)
    .where(and(eq(builderTables.id, tableId), eq(builderTables.agentId, directAgentId)))
    .limit(1);
  if (!row) return null;
  return { columns: asColumns(row.columns) };
}

// ---------------------------------------------------------------------------
// GET /api/builder/tables/[tableId]/rows
//
// List the rows of a table owned by the authenticated user's direct agent.
// ---------------------------------------------------------------------------

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  try {
    const { tableId } = await context.params;
    const { directAgentId } = await resolveDirectAgent(session.user.id);

    const owned = await loadOwnedTable(tableId, directAgentId);
    if (!owned) return tableNotFound();

    const rows = await db
      .select({
        id: builderTableRows.id,
        data: builderTableRows.data,
        createdAt: builderTableRows.createdAt,
        updatedAt: builderTableRows.updatedAt,
      })
      .from(builderTableRows)
      .where(eq(builderTableRows.tableId, tableId))
      .orderBy(builderTableRows.createdAt);

    return NextResponse.json(
      {
        columns: owned.columns,
        rows: rows.map((row) => ({
          id: row.id,
          data: row.data,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/tables/:id/rows] GET failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list rows" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/builder/tables/[tableId]/rows
//
// Append a row, coerced against the table's column schema.
// ---------------------------------------------------------------------------

export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  try {
    const { tableId } = await context.params;
    const body = (await request.json()) as AddRowBody;
    const { directAgentId } = await resolveDirectAgent(session.user.id);

    const owned = await loadOwnedTable(tableId, directAgentId);
    if (!owned) return tableNotFound();

    const data = validateRow(owned.columns, body.data);

    const [inserted] = await db
      .insert(builderTableRows)
      .values({ tableId, data })
      .returning();

    return NextResponse.json(
      {
        row: {
          id: inserted.id,
          data: inserted.data,
          createdAt: inserted.createdAt.toISOString(),
          updatedAt: inserted.updatedAt.toISOString(),
        },
      },
      { status: STATUS_CREATED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/tables/:id/rows] POST failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to add row" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/builder/tables/[tableId]/rows?rowId=...
//
// Delete a single row, verifying the parent table belongs to the caller.
// ---------------------------------------------------------------------------

export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) return unauthorized();

  try {
    const { tableId } = await context.params;
    const rowId = new URL(request.url).searchParams.get("rowId");
    if (!rowId) {
      return NextResponse.json(
        { error: "rowId is required" },
        { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const { directAgentId } = await resolveDirectAgent(session.user.id);

    const owned = await loadOwnedTable(tableId, directAgentId);
    if (!owned) return tableNotFound();

    const deleted = await db
      .delete(builderTableRows)
      .where(and(eq(builderTableRows.id, rowId), eq(builderTableRows.tableId, tableId)))
      .returning({ id: builderTableRows.id });

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: "Row not found" },
        { status: STATUS_NOT_FOUND, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    return NextResponse.json(
      { ok: true, rowId: deleted[0].id },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/tables/:id/rows] DELETE failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete row" },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
