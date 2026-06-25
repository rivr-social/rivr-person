/**
 * @fileoverview Pure helpers for builder-owned tables (Wave 2 / T2.4 — the
 * "Data" tab is the set of tables the builder defines for the app/site it is
 * working on).
 *
 * No database access and no Node-only APIs: the route layer resolves the agent,
 * persists rows, and calls these helpers to validate/normalize a table's column
 * schema and to coerce a submitted row against that schema. Keeping the
 * schema/coercion logic here makes it unit-testable and keeps the routes thin.
 *
 * A builder table is `{ name, columns: BuilderColumn[] }`; a row is an object
 * keyed by the columns' `key`s with type-coerced values. Columns and rows are
 * stored as JSONB on `builder_tables` / `builder_table_rows`.
 */

/** Cell value types a builder column may hold. */
export const BUILDER_COLUMN_TYPES = ["text", "number", "boolean", "date"] as const;
export type BuilderColumnType = (typeof BUILDER_COLUMN_TYPES)[number];

const COLUMN_TYPE_SET = new Set<string>(BUILDER_COLUMN_TYPES);

/** Coerced cell value: a primitive or null (empty). */
export type BuilderCellValue = string | number | boolean | null;

/** A single column definition in a builder table's schema. */
export interface BuilderColumn {
  /** Stable machine key used as the row object key (a-z0-9_). */
  key: string;
  /** Human label for the column header. */
  label: string;
  type: BuilderColumnType;
}

/** A validated row keyed by column key. */
export type BuilderRow = Record<string, BuilderCellValue>;

const MAX_COLUMNS = 50;
const MAX_KEY_LENGTH = 64;

/**
 * Derives a safe column key from a raw key or label: lowercased, non-alnum
 * collapsed to underscores, trimmed of leading/trailing underscores, length
 * capped. Returns "" when nothing usable remains (caller drops the column).
 */
export function slugifyColumnKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH);
}

/**
 * Validates and normalizes raw column input into a clean `BuilderColumn[]`.
 * Drops entries without a usable key, defaults an unknown/missing type to
 * "text", fills a missing label from the key, de-duplicates by key (first
 * wins), and caps the count. Throws when no valid column remains so a table is
 * never created with an empty schema.
 */
export function normalizeColumns(input: unknown): BuilderColumn[] {
  const list = Array.isArray(input) ? input : [];
  const out: BuilderColumn[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const keySource = typeof c.key === "string" && c.key.trim() ? c.key : typeof c.label === "string" ? c.label : "";
    const key = slugifyColumnKey(String(keySource));
    if (!key || seen.has(key)) continue;
    const type =
      typeof c.type === "string" && COLUMN_TYPE_SET.has(c.type) ? (c.type as BuilderColumnType) : "text";
    const label = typeof c.label === "string" && c.label.trim() ? c.label.trim() : key;
    seen.add(key);
    out.push({ key, label, type });
    if (out.length >= MAX_COLUMNS) break;
  }
  if (out.length === 0) {
    throw new Error("A table needs at least one valid column");
  }
  return out;
}

/**
 * Coerces a raw submitted value to the target column type. Empty/whitespace,
 * null, and undefined become `null`. Numbers that don't parse and dates that
 * don't parse also become `null`; dates are normalized to ISO strings; booleans
 * accept true/false, "true"/"false", and 1/0.
 */
export function coerceCellValue(type: BuilderColumnType, value: unknown): BuilderCellValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;

  switch (type) {
    case "number": {
      const n = typeof value === "number" ? value : Number(String(value).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const v = String(value).trim().toLowerCase();
      if (v === "true" || v === "1") return true;
      if (v === "false" || v === "0") return false;
      return null;
    }
    case "date": {
      const d = new Date(typeof value === "number" ? value : String(value).trim());
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    case "text":
    default:
      return String(value);
  }
}

/**
 * Builds a clean row from raw input against a table's columns: only known
 * columns are kept, each value coerced to its column type. Unknown keys in the
 * input are ignored.
 */
export function validateRow(columns: readonly BuilderColumn[], data: unknown): BuilderRow {
  const source = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const row: BuilderRow = {};
  for (const column of columns) {
    row[column.key] = coerceCellValue(column.type, source[column.key]);
  }
  return row;
}
