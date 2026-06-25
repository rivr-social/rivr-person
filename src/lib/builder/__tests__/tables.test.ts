import { describe, expect, it } from "vitest";
import {
  BUILDER_COLUMN_TYPES,
  coerceCellValue,
  normalizeColumns,
  slugifyColumnKey,
  validateRow,
  type BuilderColumn,
} from "@/lib/builder/tables";

describe("slugifyColumnKey", () => {
  it("lowercases, collapses non-alnum to underscores, and trims", () => {
    expect(slugifyColumnKey("First Name")).toBe("first_name");
    expect(slugifyColumnKey("  Email Address!! ")).toBe("email_address");
    expect(slugifyColumnKey("price ($)")).toBe("price");
  });

  it("returns empty string when nothing usable remains", () => {
    expect(slugifyColumnKey("   ")).toBe("");
    expect(slugifyColumnKey("!!!")).toBe("");
  });
});

describe("normalizeColumns", () => {
  it("normalizes keys, defaults type to text, and fills missing labels", () => {
    const cols = normalizeColumns([
      { label: "First Name", type: "text" },
      { key: "Age", type: "number" },
      { key: "active" },
    ]);
    expect(cols).toEqual<BuilderColumn[]>([
      { key: "first_name", label: "First Name", type: "text" },
      { key: "age", label: "age", type: "number" },
      { key: "active", label: "active", type: "text" },
    ]);
  });

  it("drops invalid/keyless entries and de-duplicates by key (first wins)", () => {
    const cols = normalizeColumns([
      { label: "Name", type: "text" },
      { key: "name", type: "number" },
      null,
      "nope",
      { label: "!!!" },
    ]);
    expect(cols).toEqual<BuilderColumn[]>([{ key: "name", label: "Name", type: "text" }]);
  });

  it("falls back unknown types to text", () => {
    expect(normalizeColumns([{ key: "x", type: "json" }])[0].type).toBe("text");
  });

  it("throws when no valid column remains", () => {
    expect(() => normalizeColumns([])).toThrow(/at least one valid column/);
    expect(() => normalizeColumns([{ label: "###" }])).toThrow();
  });

  it("only exposes the four supported column types", () => {
    expect(BUILDER_COLUMN_TYPES).toEqual(["text", "number", "boolean", "date"]);
  });
});

describe("coerceCellValue", () => {
  it("maps empty-ish input to null for every type", () => {
    for (const type of BUILDER_COLUMN_TYPES) {
      expect(coerceCellValue(type, "")).toBeNull();
      expect(coerceCellValue(type, "   ")).toBeNull();
      expect(coerceCellValue(type, null)).toBeNull();
      expect(coerceCellValue(type, undefined)).toBeNull();
    }
  });

  it("coerces numbers and rejects non-numeric", () => {
    expect(coerceCellValue("number", "42")).toBe(42);
    expect(coerceCellValue("number", 3.5)).toBe(3.5);
    expect(coerceCellValue("number", "abc")).toBeNull();
  });

  it("coerces booleans from common truthy/falsy spellings", () => {
    expect(coerceCellValue("boolean", true)).toBe(true);
    expect(coerceCellValue("boolean", "true")).toBe(true);
    expect(coerceCellValue("boolean", "1")).toBe(true);
    expect(coerceCellValue("boolean", "false")).toBe(false);
    expect(coerceCellValue("boolean", "0")).toBe(false);
    expect(coerceCellValue("boolean", "maybe")).toBeNull();
  });

  it("normalizes dates to ISO and rejects unparseable", () => {
    expect(coerceCellValue("date", "2026-01-02")).toBe(new Date("2026-01-02").toISOString());
    expect(coerceCellValue("date", "not-a-date")).toBeNull();
  });

  it("stringifies for text", () => {
    expect(coerceCellValue("text", 5)).toBe("5");
    expect(coerceCellValue("text", "hi")).toBe("hi");
  });
});

describe("validateRow", () => {
  const columns: BuilderColumn[] = [
    { key: "name", label: "Name", type: "text" },
    { key: "age", label: "Age", type: "number" },
    { key: "active", label: "Active", type: "boolean" },
  ];

  it("keeps only known columns, coerced, and ignores unknown keys", () => {
    const row = validateRow(columns, { name: "Ada", age: "36", active: "true", extra: "x" });
    expect(row).toEqual({ name: "Ada", age: 36, active: true });
    expect(row).not.toHaveProperty("extra");
  });

  it("fills missing columns with null", () => {
    expect(validateRow(columns, {})).toEqual({ name: null, age: null, active: null });
  });

  it("tolerates non-object input", () => {
    expect(validateRow(columns, null)).toEqual({ name: null, age: null, active: null });
  });
});
