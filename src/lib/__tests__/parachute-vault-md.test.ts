import { describe, expect, it } from "vitest";
import {
  extractFrontmatterTags,
  extractInlineTags,
  parseFrontmatter,
  parseVaultMarkdown,
} from "@/lib/parachute-vault-md";

describe("parseFrontmatter", () => {
  it("parses simple key-value pairs and strips the block from the body", () => {
    const { frontmatter, content } = parseFrontmatter(
      "---\ntitle: My Note\nauthor: Aaron\n---\nNote content here.",
    );
    expect(frontmatter.title).toBe("My Note");
    expect(frontmatter.author).toBe("Aaron");
    expect(content).toBe("Note content here.");
  });

  it("parses block-array values", () => {
    const { frontmatter } = parseFrontmatter("---\ntags:\n  - daily\n  - voice\n---\nBody");
    expect(frontmatter.tags).toEqual(["daily", "voice"]);
  });

  it("parses inline-array values", () => {
    const { frontmatter } = parseFrontmatter("---\ntags: [daily, voice, project]\n---\nBody");
    expect(frontmatter.tags).toEqual(["daily", "voice", "project"]);
  });

  it("parses numbers and booleans", () => {
    const { frontmatter } = parseFrontmatter(
      "---\npriority: 3\ndraft: true\nrating: 4.5\n---\nBody",
    );
    expect(frontmatter.priority).toBe(3);
    expect(frontmatter.draft).toBe(true);
    expect(frontmatter.rating).toBe(4.5);
  });

  it("unquotes quoted strings", () => {
    const { frontmatter } = parseFrontmatter(
      "---\ntitle: \"My Title\"\nsubtitle: 'Sub Title'\n---\nBody",
    );
    expect(frontmatter.title).toBe("My Title");
    expect(frontmatter.subtitle).toBe("Sub Title");
  });

  it("returns empty frontmatter when the file has none", () => {
    const { frontmatter, content } = parseFrontmatter("Just content, no frontmatter.");
    expect(frontmatter).toEqual({});
    expect(content).toBe("Just content, no frontmatter.");
  });

  it("treats an empty value as an empty string, not an array", () => {
    const { frontmatter } = parseFrontmatter("---\ntitle: My Note\ndescription:\n---\nBody");
    expect(frontmatter.description).toBe("");
    expect(frontmatter.title).toBe("My Note");
  });

  it("returns raw content when the closing fence is missing", () => {
    const raw = "---\ntitle: Broken\nstill inside";
    const { frontmatter, content } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(content).toBe(raw);
  });
});

describe("extractInlineTags", () => {
  it("extracts simple and nested tags, lowercased", () => {
    const tags = extractInlineTags("A #Daily note in #projects/Parachute about voice.");
    expect(tags).toContain("daily");
    expect(tags).toContain("projects/parachute");
  });

  it("ignores tags inside fenced code blocks", () => {
    const tags = extractInlineTags("#real-tag\n```\n#not-a-tag\n```\n");
    expect(tags).toContain("real-tag");
    expect(tags).not.toContain("not-a-tag");
  });

  it("ignores tags inside inline code", () => {
    const tags = extractInlineTags("Use `#not-a-tag` but tag as #real-tag here.");
    expect(tags).toContain("real-tag");
    expect(tags).not.toContain("not-a-tag");
  });

  it("deduplicates repeated tags", () => {
    const tags = extractInlineTags("#daily and again #daily");
    expect(tags.filter((t) => t === "daily")).toHaveLength(1);
  });
});

describe("extractFrontmatterTags", () => {
  it("reads an array of tags, lowercased and trimmed", () => {
    expect(extractFrontmatterTags({ tags: ["Work", " Status/Draft "] })).toEqual([
      "work",
      "status/draft",
    ]);
  });

  it("reads a comma-separated string of tags", () => {
    expect(extractFrontmatterTags({ tags: "Work, projects/rivr" })).toEqual([
      "work",
      "projects/rivr",
    ]);
  });

  it("returns [] when there are no frontmatter tags", () => {
    expect(extractFrontmatterTags({})).toEqual([]);
    expect(extractFrontmatterTags({ tags: 42 })).toEqual([]);
  });
});

describe("parseVaultMarkdown", () => {
  it("merges frontmatter and inline tags, dropping the tags key from metadata", () => {
    const raw = [
      "---",
      "title: Spec",
      "tags: [work/projects/rivr, status/draft]",
      "---",
      "Body text with an inline #Roadmap tag and #status/draft again.",
    ].join("\n");

    const { body, frontmatter, tags } = parseVaultMarkdown(raw);

    expect(body).toBe("Body text with an inline #Roadmap tag and #status/draft again.");
    expect(frontmatter).toEqual({ title: "Spec" });
    expect(frontmatter.tags).toBeUndefined();
    // frontmatter tags first (in order), then any new inline tags; deduped.
    expect(tags).toEqual(["work/projects/rivr", "status/draft", "roadmap"]);
  });

  it("handles a note with no frontmatter and no tags", () => {
    const { body, frontmatter, tags } = parseVaultMarkdown("Plain note.");
    expect(body).toBe("Plain note.");
    expect(frontmatter).toEqual({});
    expect(tags).toEqual([]);
  });
});
