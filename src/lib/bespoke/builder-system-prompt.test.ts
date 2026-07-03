import { describe, expect, it } from "vitest";

import {
  BUILDER_CAPABILITIES_BLOCK,
  BUILDER_OUTPUT_CONTRACT,
  BUILDER_ARCHETYPES,
  BUILDER_AESTHETIC_GUIDE,
  buildSystemPrompt,
} from "./builder-system-prompt";
import type { SiteFiles } from "./site-files";

// ---------------------------------------------------------------------------
// Shared craft blocks
// ---------------------------------------------------------------------------

describe("builder shared craft blocks", () => {
  it("names the concrete site archetypes so the model builds to the job", () => {
    for (const archetype of [
      "Landing",
      "Portfolio",
      "Shop",
      "Blog",
      "Docs",
      "dashboard",
    ]) {
      expect(BUILDER_ARCHETYPES).toContain(archetype);
    }
  });

  it("gives real aesthetic craft direction incl. light AND dark", () => {
    expect(BUILDER_AESTHETIC_GUIDE).toMatch(/Typography/i);
    expect(BUILDER_AESTHETIC_GUIDE).toMatch(/Spacing/i);
    expect(BUILDER_AESTHETIC_GUIDE).toMatch(/Light AND dark/i);
    expect(BUILDER_AESTHETIC_GUIDE).toMatch(/contrast/i);
  });

  it("states the targeted-edit protocol (only emit changed files)", () => {
    expect(BUILDER_OUTPUT_CONTRACT).toMatch(/only the files you actually modify/i);
    expect(BUILDER_OUTPUT_CONTRACT).toMatch(/PRESERVES every file you do not re-emit/i);
    expect(BUILDER_OUTPUT_CONTRACT).toMatch(/language:path/i);
  });

  it("does NOT hard-bias every site to dark (the old default)", () => {
    expect(BUILDER_AESTHETIC_GUIDE).not.toMatch(/Default to a dark, modern aesthetic/i);
  });

  it("capabilities block composes the shared craft blocks (no drift)", () => {
    expect(BUILDER_CAPABILITIES_BLOCK).toContain(BUILDER_OUTPUT_CONTRACT);
    expect(BUILDER_CAPABILITIES_BLOCK).toContain(BUILDER_ARCHETYPES);
    expect(BUILDER_CAPABILITIES_BLOCK).toContain(BUILDER_AESTHETIC_GUIDE);
  });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe("buildSystemPrompt", () => {
  const profileBundle = {
    profile: {
      agent: {
        name: "Ada Lovelace",
        metadata: { tagline: "Computing pioneer", bio: "First programmer.", skills: ["math"] },
      },
    },
  };

  it("embeds the archetype + targeted-edit guidance and real profile data", () => {
    const prompt = buildSystemPrompt(profileBundle, {});
    expect(prompt).toContain(BUILDER_ARCHETYPES);
    expect(prompt).toContain(BUILDER_OUTPUT_CONTRACT);
    expect(prompt).toContain("Ada Lovelace");
    expect(prompt).toMatch(/AUTO-PRESERVES every file you don't re-emit/i);
  });

  it("tells a fresh site to generate everything from scratch", () => {
    const prompt = buildSystemPrompt(profileBundle, {});
    expect(prompt).toMatch(/No files exist yet/i);
  });

  it("always emits a full file tree even when bodies are omitted for length", () => {
    // A file whose body exceeds the embed budget must still appear in the tree,
    // so the model never edits blind or drops a file it can't see.
    const huge = "x".repeat(40_000);
    const files: SiteFiles = { "index.html": "<h1>hi</h1>", "big.css": huge };
    const prompt = buildSystemPrompt(profileBundle, files);
    expect(prompt).toMatch(/File tree \(2 files/);
    expect(prompt).toContain("big.css");
    expect(prompt).toContain("index.html");
    // The oversized body is omitted, not embedded whole.
    expect(prompt).toContain("content omitted");
  });
});
