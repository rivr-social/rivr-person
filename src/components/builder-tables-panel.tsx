"use client";

/**
 * @fileoverview Builder "Data" tab — the set of tables the builder defines for
 * the app/site it is working on (Wave 2 / T2.4 G2). Lists the direct agent's
 * builder-owned tables, lets the user create/delete tables with a typed column
 * schema, and edit a selected table's rows (add/delete) in a simple grid.
 *
 * All persistence goes through `/api/builder/tables` and
 * `/api/builder/tables/[tableId]/rows`, which scope every operation to the
 * caller's resolved direct agent. This component owns only view state.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BUILDER_COLUMN_TYPES,
  type BuilderColumn,
  type BuilderColumnType,
} from "@/lib/builder/tables";
import {
  Database,
  Loader2,
  Plus,
  Trash2,
  ChevronLeft,
  X,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TABLES_ENDPOINT = "/api/builder/tables";
const DEFAULT_COLUMN_TYPE: BuilderColumnType = "text";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface TableRowRecord {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface DraftColumn {
  label: string;
  type: BuilderColumnType;
}

function newDraftColumn(): DraftColumn {
  return { label: "", type: DEFAULT_COLUMN_TYPE };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BuilderTablesPanel(): React.ReactElement {
  const [tables, setTables] = useState<TableSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create-table form state
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [draftColumns, setDraftColumns] = useState<DraftColumn[]>([newDraftColumn()]);
  const [creating, setCreating] = useState(false);

  // Selected-table (row editor) state
  const [selected, setSelected] = useState<TableSummary | null>(null);
  const [rows, setRows] = useState<TableRowRecord[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [draftRow, setDraftRow] = useState<Record<string, string>>({});
  const [addingRow, setAddingRow] = useState(false);

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  const loadTables = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(TABLES_ENDPOINT, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load tables (${res.status})`);
      }
      const body = (await res.json()) as { tables: TableSummary[] };
      setTables(body.tables);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load tables");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRows = useCallback(async (tableId: string) => {
    setRowsLoading(true);
    try {
      const res = await fetch(`${TABLES_ENDPOINT}/${tableId}/rows`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load rows (${res.status})`);
      }
      const body = (await res.json()) as { rows: TableRowRecord[] };
      setRows(body.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rows");
    } finally {
      setRowsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  // -------------------------------------------------------------------------
  // Create / delete table
  // -------------------------------------------------------------------------

  const resetCreateForm = useCallback(() => {
    setShowCreate(false);
    setNewName("");
    setNewDescription("");
    setDraftColumns([newDraftColumn()]);
  }, []);

  const handleCreateTable = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      const columns = draftColumns
        .filter((c) => c.label.trim())
        .map((c) => ({ label: c.label.trim(), type: c.type }));
      const res = await fetch(TABLES_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          description: newDescription.trim() || undefined,
          columns,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to create table (${res.status})`);
      }
      resetCreateForm();
      await loadTables();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create table");
    } finally {
      setCreating(false);
    }
  }, [draftColumns, newName, newDescription, resetCreateForm, loadTables]);

  const handleDeleteTable = useCallback(
    async (tableId: string) => {
      setError(null);
      try {
        const res = await fetch(`${TABLES_ENDPOINT}?tableId=${encodeURIComponent(tableId)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Failed to delete table (${res.status})`);
        }
        if (selected?.id === tableId) setSelected(null);
        await loadTables();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete table");
      }
    },
    [selected, loadTables],
  );

  // -------------------------------------------------------------------------
  // Select table / row CRUD
  // -------------------------------------------------------------------------

  const handleSelectTable = useCallback(
    (table: TableSummary) => {
      setSelected(table);
      setDraftRow({});
      setRows([]);
      void loadRows(table.id);
    },
    [loadRows],
  );

  const handleAddRow = useCallback(async () => {
    if (!selected) return;
    setAddingRow(true);
    setError(null);
    try {
      const res = await fetch(`${TABLES_ENDPOINT}/${selected.id}/rows`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: draftRow }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to add row (${res.status})`);
      }
      setDraftRow({});
      await loadRows(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add row");
    } finally {
      setAddingRow(false);
    }
  }, [selected, draftRow, loadRows]);

  const handleDeleteRow = useCallback(
    async (rowId: string) => {
      if (!selected) return;
      setError(null);
      try {
        const res = await fetch(
          `${TABLES_ENDPOINT}/${selected.id}/rows?rowId=${encodeURIComponent(rowId)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Failed to delete row (${res.status})`);
        }
        await loadRows(selected.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to delete row");
      }
    },
    [selected, loadRows],
  );

  // -------------------------------------------------------------------------
  // Render — row editor (a table is selected)
  // -------------------------------------------------------------------------

  if (selected) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1 px-2"
            onClick={() => setSelected(null)}
          >
            <ChevronLeft className="h-3 w-3" />
            Tables
          </Button>
          <span className="text-sm font-medium truncate">{selected.name}</span>
        </div>

        {error && <p className="text-[10px] text-destructive px-1">{error}</p>}

        {/* Add-row form */}
        <Card>
          <CardContent className="py-3 space-y-2">
            <span className="text-xs font-medium">Add row</span>
            <div className="space-y-1.5">
              {selected.columns.map((col) => (
                <div key={col.key} className="space-y-0.5">
                  <Label className="text-[10px]">
                    {col.label}{" "}
                    <span className="text-muted-foreground">({col.type})</span>
                  </Label>
                  <Input
                    className="h-7 text-xs"
                    value={draftRow[col.key] ?? ""}
                    onChange={(e) =>
                      setDraftRow((prev) => ({ ...prev, [col.key]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
            <Button
              size="sm"
              className="h-7 text-xs gap-1"
              disabled={addingRow}
              onClick={() => void handleAddRow()}
            >
              {addingRow ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Add row
            </Button>
          </CardContent>
        </Card>

        {/* Rows grid */}
        {rowsLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-[10px] text-muted-foreground px-1">No rows yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b">
                  {selected.columns.map((col) => (
                    <th key={col.key} className="text-left font-medium py-1.5 pr-3">
                      {col.label}
                    </th>
                  ))}
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    {selected.columns.map((col) => (
                      <td key={col.key} className="py-1.5 pr-3 align-top">
                        {formatCell(row.data[col.key])}
                      </td>
                    ))}
                    <td className="py-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => void handleDeleteRow(row.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render — table list
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
          <h4 className="text-xs font-medium">Tables</h4>
          {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
          {showCreate ? "Cancel" : "New table"}
        </Button>
      </div>

      <p className="text-[10px] text-muted-foreground">
        Tables you define for the app or site you are building. Each table is a
        named set of typed columns; rows hold your structured data.
      </p>

      {error && <p className="text-[10px] text-destructive px-1">{error}</p>}

      {/* Create-table form */}
      {showCreate && (
        <Card>
          <CardContent className="py-3 space-y-2.5">
            <div className="space-y-0.5">
              <Label className="text-[10px]">Table name</Label>
              <Input
                className="h-7 text-xs"
                placeholder="e.g. Products"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div className="space-y-0.5">
              <Label className="text-[10px]">Description (optional)</Label>
              <Input
                className="h-7 text-xs"
                placeholder="What this table holds"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px]">Columns</Label>
              {draftColumns.map((col, idx) => (
                <div key={idx} className="flex items-center gap-1.5">
                  <Input
                    className="h-7 text-xs flex-1"
                    placeholder="Column label"
                    value={col.label}
                    onChange={(e) =>
                      setDraftColumns((prev) =>
                        prev.map((c, i) => (i === idx ? { ...c, label: e.target.value } : c)),
                      )
                    }
                  />
                  <Select
                    value={col.type}
                    onValueChange={(value) =>
                      setDraftColumns((prev) =>
                        prev.map((c, i) =>
                          i === idx ? { ...c, type: value as BuilderColumnType } : c,
                        ),
                      )
                    }
                  >
                    <SelectTrigger className="h-7 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BUILDER_COLUMN_TYPES.map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                    disabled={draftColumns.length <= 1}
                    onClick={() =>
                      setDraftColumns((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[10px] gap-1"
                onClick={() => setDraftColumns((prev) => [...prev, newDraftColumn()])}
              >
                <Plus className="h-3 w-3" />
                Add column
              </Button>
            </div>

            <Button
              size="sm"
              className="h-7 text-xs w-full"
              disabled={creating || !newName.trim() || !draftColumns.some((c) => c.label.trim())}
              onClick={() => void handleCreateTable()}
            >
              {creating ? <Loader2 className="h-3 w-3 animate-spin" /> : "Create table"}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Table list */}
      {!loading && tables.length === 0 && !showCreate && (
        <p className="text-[10px] text-muted-foreground px-1">
          No tables yet. Create one to start storing structured data for your site.
        </p>
      )}

      <div className="space-y-2">
        {tables.map((table) => (
          <Card key={table.id}>
            <CardContent className="py-2.5">
              <div className="flex items-center justify-between gap-2">
                <button
                  className="flex-1 text-left min-w-0"
                  onClick={() => handleSelectTable(table)}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium truncate">{table.name}</span>
                    <Badge variant="secondary" className="text-[10px] shrink-0">
                      {table.rowCount} {table.rowCount === 1 ? "row" : "rows"}
                    </Badge>
                  </div>
                  {table.description && (
                    <p className="text-[10px] text-muted-foreground line-clamp-1 mt-0.5">
                      {table.description}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1 mt-1">
                    {table.columns.slice(0, 6).map((col) => (
                      <Badge key={col.key} variant="outline" className="text-[10px]">
                        {col.label}
                      </Badge>
                    ))}
                  </div>
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => void handleDeleteTable(table.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Renders a coerced cell value for display; null/empty shows a muted dash. */
function formatCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
