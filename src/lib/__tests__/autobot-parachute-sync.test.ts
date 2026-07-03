import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Unit tests for the Parachute import mapping upgrade
 * (`importParachuteFile` / `importParachuteBatch`).
 *
 * Verifies the faithful faceted-tag mapping (folder path MERGED with explicit
 * slash-nested note tags), the provenance + idempotency `metadata.parachute`
 * block, and the `"created" | "updated" | "skipped"` status contract.
 *
 * The database is fully mocked: `select().from().where().limit()` returns a
 * configurable existing-row set, and `insert`/`update` capture the written values
 * so we can assert on the resulting resource shape without a live Postgres.
 */

// Mutable mock state — reset per test.
const selectResult: { rows: Array<{ id: string; sourceHash: string | null }> } = { rows: [] };
const captured: { inserted: Record<string, any> | null; updated: Record<string, any> | null } = {
  inserted: null,
  updated: null,
};

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectResult.rows,
        }),
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        captured.inserted = values as Record<string, any>;
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          captured.updated = values as Record<string, any>;
        },
      }),
    }),
  },
}));

// Import AFTER the mock so the module binds the mocked db.
import {
  importParachuteFile,
  importParachuteBatch,
  type ParachuteImportFile,
} from "@/lib/autobot-parachute-sync";

const OWNER = "11111111-1111-1111-1111-111111111111";

const SPEC_FILE: ParachuteImportFile = {
  path: "work/projects/rivr/spec.md",
  content: "The spec body.",
  tags: ["status/draft"],
  frontmatter: { title: "Spec" },
};

describe("importParachuteFile mapping", () => {
  beforeEach(() => {
    selectResult.rows = [];
    captured.inserted = null;
    captured.updated = null;
  });

  it("creates a doc merging folder-path facets with explicit note tags", async () => {
    const status = await importParachuteFile(OWNER, SPEC_FILE, "upload");

    expect(status).toBe("created");
    expect(captured.inserted).not.toBeNull();

    const inserted = captured.inserted!;
    // Path yields ["work","projects","rivr"]; the note tag adds ["status","draft"].
    expect(inserted.metadata.facetedTags).toEqual([
      ["status", "draft"],
      ["work", "projects", "rivr"],
    ]);
    // Provider markers + flattened facets project into the flat search column.
    expect(inserted.tags).toEqual(
      expect.arrayContaining([
        "parachute",
        "vault",
        "imported",
        "status/draft",
        "work/projects/rivr",
      ]),
    );
    // Imported docs are private documents owned by the caller.
    expect(inserted.type).toBe("document");
    expect(inserted.visibility).toBe("private");
    expect(inserted.ownerId).toBe(OWNER);
    // Dedup key + provenance both present.
    expect(inserted.metadata.externalSync).toMatchObject({
      provider: "parachute",
      externalId: "work/projects/rivr/spec.md",
      vaultPath: "upload",
    });
    expect(inserted.metadata.parachute.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inserted.metadata.parachute.frontmatter).toEqual({ title: "Spec" });
  });

  it("skips an unchanged re-import and updates a changed one", async () => {
    // 1) Initial create — capture the stamped sourceHash.
    await importParachuteFile(OWNER, SPEC_FILE, "upload");
    const originalHash = captured.inserted!.metadata.parachute.sourceHash as string;

    // 2) Re-import identical content — existing row carries the same hash → skip.
    selectResult.rows = [{ id: "existing-1", sourceHash: originalHash }];
    captured.inserted = null;
    captured.updated = null;
    const skipped = await importParachuteFile(OWNER, SPEC_FILE, "upload");
    expect(skipped).toBe("skipped");
    expect(captured.updated).toBeNull();
    expect(captured.inserted).toBeNull();

    // 3) Changed body — hash differs → update in place with a new hash.
    const updated = await importParachuteFile(
      OWNER,
      { ...SPEC_FILE, content: "A different body." },
      "upload",
    );
    expect(updated).toBe("updated");
    expect(captured.updated).not.toBeNull();
    expect(captured.updated!.metadata.parachute.sourceHash).not.toBe(originalHash);
  });

  it("changes the sourceHash when only the tags change", async () => {
    await importParachuteFile(OWNER, SPEC_FILE, "upload");
    const originalHash = captured.inserted!.metadata.parachute.sourceHash as string;

    selectResult.rows = [{ id: "existing-1", sourceHash: originalHash }];
    captured.updated = null;
    const status = await importParachuteFile(
      OWNER,
      { ...SPEC_FILE, tags: ["status/published"] },
      "upload",
    );
    expect(status).toBe("updated");
    expect(captured.updated!.metadata.parachute.sourceHash).not.toBe(originalHash);
  });
});

describe("importParachuteBatch", () => {
  beforeEach(() => {
    selectResult.rows = [];
    captured.inserted = null;
    captured.updated = null;
  });

  it("counts created / updated / skipped across a batch and resolves the vault path", async () => {
    const files: ParachuteImportFile[] = [
      { path: "a/one.md", content: "one" },
      { path: "b/two.md", content: "two" },
    ];

    const result = await importParachuteBatch(OWNER, files, { vaultPath: "upload" });

    expect(result.provider).toBe("parachute_vault");
    expect(result.imported).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.externalAccountId).toBe("upload");
    expect(result.message).toContain("2 created");
  });
});
