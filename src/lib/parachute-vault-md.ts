/**
 * @fileoverview Dependency-free Parachute/Obsidian markdown parser (person-app port).
 *
 * A Parachute vault exported to Obsidian markdown is a folder of `.md` files: YAML
 * frontmatter, a markdown body, inline `#tags` (including `#nested/tag`), and
 * frontmatter `tags:` arrays. The server (camalot) can only ingest these portable
 * markdown files — it cannot read a user's laptop vault DB — so this module turns a
 * single `.md` file's raw text into the `{ path, content, tags, frontmatter }` shape
 * the import pipeline (`autobot-parachute-sync.ts`) consumes.
 *
 * It is a faithful, minimal port of the upstream parser at
 * `repos/parachute/core/src/obsidian.ts` (`parseFrontmatter`, `extractInlineTags`,
 * `extractFrontmatterTags`). Only the parse path is ported — the upstream file also
 * walks the filesystem (`readdirSync`/`statSync`) and re-exports to Obsidian, neither
 * of which the server needs. This module is PURE: no filesystem, no Node-only APIs,
 * so it is safe to import from either client or server code.
 *
 * The `#nested/tag` and slash-nested frontmatter tags are emitted verbatim (e.g.
 * `"work/projects/rivr"`) so they feed `normalizeFacetedTags` in `parachute-doc.ts`
 * cleanly — that function promotes any `"a/b/c"` string into a faceted TagPath.
 */

/** Result of parsing one Parachute/Obsidian markdown file. */
export interface ParsedVaultMarkdown {
  /** Markdown body with the YAML frontmatter block stripped. */
  body: string;
  /** Parsed YAML frontmatter (with the `tags` key removed — tags are surfaced separately). */
  frontmatter: Record<string, unknown>;
  /** Merged, deduped tags from both frontmatter `tags:` and inline `#tags`, lowercased. */
  tags: string[];
}

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter, content } where content has frontmatter stripped.
 *
 * Uses a simple parser — no dependency on a YAML library. Handles the common
 * frontmatter patterns Obsidian/Parachute emit: strings, inline `[a, b]` arrays,
 * `- item` block arrays, numbers, booleans, and empty values.
 */
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  content: string;
} {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, content: raw };
  }

  const endIdx = raw.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: {}, content: raw };
  }

  const yamlBlock = raw.slice(4, endIdx); // skip opening "---\n"
  const content = raw.slice(endIdx + 4).replace(/^\n/, ""); // skip closing "---\n"

  const frontmatter: Record<string, unknown> = {};
  let currentKey = "";
  let currentArray: string[] | null = null;

  for (const line of yamlBlock.split("\n")) {
    // Array item (continuation of previous key)
    if (currentArray !== null && /^\s+-\s+/.test(line)) {
      const val = line.replace(/^\s+-\s+/, "").trim();
      currentArray.push(unquote(val));
      continue;
    }

    // If we were building an array, save it (or save empty string if no items found)
    if (currentArray !== null) {
      frontmatter[currentKey] = currentArray.length > 0 ? currentArray : "";
      currentArray = null;
    }

    // Key: value pair — keys must be YAML-valid (word chars and hyphens, no spaces)
    const kvMatch = line.match(/^([\w][\w-]*):\s*(.*)/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();

      if (value === "[]") {
        frontmatter[key] = [];
      } else if (value === "") {
        // Empty value: could be start of array (next lines are "- item")
        // or genuinely empty string. We start array accumulation and
        // handle the empty case when a non-array line follows.
        currentKey = key;
        currentArray = [];
      } else if (value.startsWith("[") && value.endsWith("]")) {
        // Inline array: [item1, item2]
        const items = value
          .slice(1, -1)
          .split(",")
          .map((s) => unquote(s.trim()))
          .filter(Boolean);
        frontmatter[key] = items;
      } else {
        frontmatter[key] = parseValue(value);
      }
    }
  }

  // Save any trailing array (or empty string if no items)
  if (currentArray !== null) {
    frontmatter[currentKey] = currentArray.length > 0 ? currentArray : "";
  }

  return { frontmatter, content };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseValue(s: string): unknown {
  s = unquote(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// ---------------------------------------------------------------------------
// Tag extraction
// ---------------------------------------------------------------------------

/** Extract inline #tags from markdown content. Excludes tags in code blocks. */
export function extractInlineTags(content: string): string[] {
  // Strip fenced code blocks and inline code so `#hashes` in code aren't tags.
  let stripped = content.replace(/```[\s\S]*?```/g, "");
  stripped = stripped.replace(/`[^`\n]+`/g, "");

  const tags = new Set<string>();
  // Match #tag and #nested/tag — must be preceded by whitespace or start of line.
  const regex = /(?:^|\s)#([\w][\w/-]*[\w]|[\w])/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(stripped)) !== null) {
    tags.add(match[1].toLowerCase());
  }
  return [...tags];
}

/** Extract tags from frontmatter (handles both array and comma-separated string formats). */
export function extractFrontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter.tags;
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((t) => t.toLowerCase().trim())
      .filter(Boolean);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse one Parachute/Obsidian markdown file into the import shape.
 *
 * Frontmatter `tags:` and inline `#tags` are merged and deduped (frontmatter
 * first, preserving order); the `tags` key is stripped from the returned
 * frontmatter because tags are carried separately (they become faceted tag-paths,
 * not passthrough metadata). This mirrors `parseObsidianFile` upstream, minus the
 * filesystem read.
 */
export function parseVaultMarkdown(raw: string): ParsedVaultMarkdown {
  const { frontmatter, content } = parseFrontmatter(raw);

  const fmTags = extractFrontmatterTags(frontmatter);
  const inlineTags = extractInlineTags(content);
  const tags = [...new Set([...fmTags, ...inlineTags])];

  // Tags live in the tags[] output, not in passthrough frontmatter metadata.
  const metadata = { ...frontmatter };
  delete metadata.tags;

  return { body: content, frontmatter: metadata, tags };
}
