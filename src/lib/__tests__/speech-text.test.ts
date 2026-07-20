import { describe, expect, it } from "vitest";
import { stripMarkdownForSpeech } from "@/lib/speech-text";

describe("stripMarkdownForSpeech", () => {
  it("strips headings, emphasis, and list markers", () => {
    const input = "# Hello\n\nThis is **bold** and _italic_.\n\n- item one\n- item two\n1. numbered";
    const output = stripMarkdownForSpeech(input);
    expect(output).toBe("Hello This is bold and italic. item one item two numbered");
  });

  it("replaces fenced code blocks with a spoken placeholder", () => {
    const output = stripMarkdownForSpeech("Before\n```js\nconst x = 1;\n```\nAfter");
    expect(output).toContain("code block omitted");
    expect(output).not.toContain("const x");
  });

  it("keeps link labels and drops URLs", () => {
    const output = stripMarkdownForSpeech("See [the docs](https://example.com/x) now");
    expect(output).toBe("See the docs now");
  });

  it("keeps inline code content without backticks", () => {
    expect(stripMarkdownForSpeech("Run `pnpm build` locally")).toBe(
      "Run pnpm build locally",
    );
  });

  it("drops tables and horizontal rules", () => {
    const output = stripMarkdownForSpeech("| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\ndone");
    expect(output).toBe("done");
  });

  it("collapses whitespace and trims", () => {
    expect(stripMarkdownForSpeech("  a\n\n\n  b  ")).toBe("a b");
  });

  it("caps output at the speech limit", () => {
    const output = stripMarkdownForSpeech("word ".repeat(1000));
    expect(output.length).toBeLessThanOrEqual(2000);
  });

  it("returns empty string for markdown-only input", () => {
    expect(stripMarkdownForSpeech("---\n\n| a |\n")).toBe("");
  });
});
