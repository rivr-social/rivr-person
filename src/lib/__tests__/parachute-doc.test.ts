import { describe, expect, it } from "vitest";
import {
  FACETED_TAGS_METADATA_KEY,
  UNTAGGED_FACET_LABEL,
  buildFacetedTree,
  facetedTagsFromVaultPath,
  flattenFacetedTags,
  normalizeFacetedTags,
  parseFacetedTagsFromMetadata,
  serializeFacetedTagsToMetadata,
  type FacetFolderNode,
  type FacetTreeNode,
} from "@/lib/parachute-doc";

function folders(tree: FacetTreeNode[]): FacetFolderNode[] {
  return tree.filter((node): node is FacetFolderNode => node.type === "facet");
}

function folderNamed(tree: FacetTreeNode[], name: string): FacetFolderNode {
  const found = folders(tree).find((node) => node.name === name);
  if (!found) throw new Error(`folder "${name}" not found in [${folders(tree).map((f) => f.name).join(", ")}]`);
  return found;
}

function docIdsUnder(folder: FacetFolderNode): string[] {
  const ids = new Set<string>();
  const walk = (node: FacetTreeNode) => {
    if (node.type === "doc") ids.add(node.docId);
    else node.children.forEach(walk);
  };
  folder.children.forEach(walk);
  return [...ids].sort();
}

describe("normalizeFacetedTags", () => {
  it("accepts string[][] and trims, drops empties, sorts, and dedups", () => {
    const result = normalizeFacetedTags([
      ["  work ", "projects", ""],
      ["status", "active"],
      ["work", "projects"], // duplicate of the first after trimming
      ["status", "active"], // exact duplicate
    ]);
    expect(result).toEqual([
      ["status", "active"],
      ["work", "projects"],
    ]);
  });

  it("promotes a flat string[] of materialized paths into tag-paths", () => {
    expect(normalizeFacetedTags(["work/projects", "status/active"])).toEqual([
      ["status", "active"],
      ["work", "projects"],
    ]);
  });

  it("splits a single materialized path string", () => {
    expect(normalizeFacetedTags("a/b/c")).toEqual([["a", "b", "c"]]);
  });

  it("returns [] for null/undefined/non-string content", () => {
    expect(normalizeFacetedTags(null)).toEqual([]);
    expect(normalizeFacetedTags(undefined)).toEqual([]);
    expect(normalizeFacetedTags(42)).toEqual([]);
    expect(normalizeFacetedTags([[123, true]])).toEqual([]);
  });

  it("caps depth at MAX_TAG_DEPTH segments", () => {
    const deep = Array.from({ length: 30 }, (_, i) => `s${i}`);
    const [path] = normalizeFacetedTags([deep]);
    expect(path.length).toBe(12);
  });
});

describe("flattenFacetedTags", () => {
  it("emits both full materialized paths and bare segments, deduped + sorted", () => {
    expect(
      flattenFacetedTags([
        ["work", "projects"],
        ["work", "ideas"],
      ]),
    ).toEqual(["ideas", "projects", "work", "work/ideas", "work/projects"]);
  });

  it("returns [] for empty input", () => {
    expect(flattenFacetedTags([])).toEqual([]);
  });
});

describe("metadata round-trip", () => {
  it("serializes faceted tags under the canonical key and preserves other metadata", () => {
    const metadata = serializeFacetedTagsToMetadata(
      { category: "Notes" },
      [["work", "projects"]],
    );
    expect(metadata.category).toBe("Notes");
    expect(metadata[FACETED_TAGS_METADATA_KEY]).toEqual([["work", "projects"]]);
  });

  it("omits the key entirely when there are no tags", () => {
    const metadata = serializeFacetedTagsToMetadata({ category: "Notes" }, []);
    expect(FACETED_TAGS_METADATA_KEY in metadata).toBe(false);
  });

  it("parses faceted tags back out of metadata", () => {
    const metadata = serializeFacetedTagsToMetadata(null, [["a", "b"]]);
    expect(parseFacetedTagsFromMetadata(metadata)).toEqual([["a", "b"]]);
  });

  it("falls back to depth-1 facets from flat tags when metadata has none", () => {
    expect(parseFacetedTagsFromMetadata({}, ["alpha", "beta"])).toEqual([
      ["alpha"],
      ["beta"],
    ]);
  });

  it("prefers metadata facets over the flat-tag fallback", () => {
    const metadata = serializeFacetedTagsToMetadata(null, [["x", "y"]]);
    expect(parseFacetedTagsFromMetadata(metadata, ["ignored"])).toEqual([["x", "y"]]);
  });
});

describe("facetedTagsFromVaultPath", () => {
  it("uses the containing folders as the hierarchy and drops the filename", () => {
    expect(facetedTagsFromVaultPath("work/projects/rivr/spec.md")).toEqual([
      ["work", "projects", "rivr"],
    ]);
  });

  it("returns [] for a file at the vault root", () => {
    expect(facetedTagsFromVaultPath("readme.md")).toEqual([]);
  });

  it("ignores leading slashes and dot segments", () => {
    expect(facetedTagsFromVaultPath("/work/./notes/idea.md")).toEqual([
      ["work", "notes"],
    ]);
  });
});

describe("buildFacetedTree", () => {
  it("places a doc under multiple orthogonal hierarchies at once", () => {
    const tree = buildFacetedTree([
      {
        id: "doc1",
        name: "Spec",
        tags: [
          ["work", "projects"],
          ["status", "active"],
        ],
      },
    ]);

    const top = folders(tree).map((f) => f.name);
    expect(top).toEqual(["status", "work"]);

    expect(docIdsUnder(folderNamed(tree, "work"))).toEqual(["doc1"]);
    expect(docIdsUnder(folderNamed(tree, "status"))).toEqual(["doc1"]);
  });

  it("creates folder nodes for every prefix and nests the leaf at the deepest folder", () => {
    const tree = buildFacetedTree([
      { id: "doc1", name: "Spec", tags: [["work", "projects", "rivr"]] },
    ]);

    const work = folderNamed(tree, "work");
    expect(work.path).toBe("work");
    const projects = folderNamed(work.children, "projects");
    expect(projects.path).toBe("work/projects");
    const rivr = folderNamed(projects.children, "rivr");
    expect(rivr.path).toBe("work/projects/rivr");
    expect(rivr.children).toHaveLength(1);
    expect(rivr.children[0]).toMatchObject({ type: "doc", docId: "doc1" });
  });

  it("counts distinct docs per subtree even when shared across sub-folders", () => {
    const tree = buildFacetedTree([
      { id: "doc1", name: "A", tags: [["work", "projects"]] },
      { id: "doc2", name: "B", tags: [["work", "ideas"]] },
      { id: "doc3", name: "C", tags: [["work", "projects"]] },
    ]);

    const work = folderNamed(tree, "work");
    expect(work.docCount).toBe(3);
    expect(folderNamed(work.children, "projects").docCount).toBe(2);
    expect(folderNamed(work.children, "ideas").docCount).toBe(1);
  });

  it("collects untagged docs under the Untagged bucket", () => {
    const tree = buildFacetedTree([
      { id: "doc1", name: "Loose", tags: [] },
      { id: "doc2", name: "Filed", tags: [["work"]] },
    ]);

    const untagged = folderNamed(tree, UNTAGGED_FACET_LABEL);
    expect(docIdsUnder(untagged)).toEqual(["doc1"]);
    expect(docIdsUnder(folderNamed(tree, "work"))).toEqual(["doc2"]);
  });

  it("produces no Untagged bucket when every doc is filed", () => {
    const tree = buildFacetedTree([{ id: "doc1", name: "Filed", tags: [["work"]] }]);
    expect(folders(tree).map((f) => f.name)).toEqual(["work"]);
  });

  it("does not double-count a doc that lists the same hierarchy twice", () => {
    const tree = buildFacetedTree([
      { id: "doc1", name: "Spec", tags: [["work", "projects"], ["work", "projects"]] },
    ]);
    expect(folderNamed(tree, "work").docCount).toBe(1);
  });
});
