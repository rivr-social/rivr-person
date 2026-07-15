/**
 * @fileoverview One-shot CLI: import an existing directory of static site files
 * into an agent's builder site — snapshot a version, write the files to MinIO,
 * upsert the publication, and (optionally) bind a custom domain.
 *
 * This is the administrative counterpart of the in-app "Publish" button for
 * seeding a builder from a site that already exists outside the app (e.g. a
 * hand-authored GitHub-Pages tree). It reuses the REAL service functions
 * (`publishSite`, `bindCustomDomain`) so the result is byte-identical to a
 * normal publish: the site then loads as the owner's default builder workspace
 * (version fallback) AND serves on the bound domain via host-dispatch.
 *
 * Usage:
 *   tsx src/scripts/import-static-site.ts \
 *     --dir <path-to-static-site> \
 *     --agent <owner-agent-id> \
 *     [--bind <custom-domain>] \
 *     [--commit "<message>"] \
 *     [--include-ext html,htm,css,js,json,svg,xml,txt,md]
 *
 * Requires DATABASE_URL + MINIO_* in the environment (run inside the instance's
 * network so `postgres`/`minio` resolve).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, extname } from "node:path";

import type { SiteFiles } from "@/lib/bespoke/site-files";
import {
  publishSite,
  bindCustomDomain,
  SiteServiceError,
} from "@/lib/builder/site-publications";
import { closeDatabase } from "@/db";

/** Extensions imported by default (the builder's servable text/web set). */
const DEFAULT_INCLUDE_EXTENSIONS = new Set([
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "json",
  "svg",
  "xml",
  "txt",
  "md",
]);

/** Per-file byte ceiling (matches the builder's live-files read limit). */
const MAX_FILE_BYTES = 256 * 1024;

/** Directories never descended into. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

interface CliArgs {
  dir: string;
  agent: string;
  bind?: string;
  commit: string;
  includeExtensions: Set<string>;
}

/** Parses `--flag value` argv into typed options; throws on missing required. */
function parseArgs(argv: string[]): CliArgs {
  const map = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag --${key} requires a value.`);
      }
      map.set(key, value);
      i += 1;
    }
  }

  const dir = map.get("dir");
  const agent = map.get("agent");
  if (!dir) throw new Error("Missing required --dir <path>.");
  if (!agent) throw new Error("Missing required --agent <agentId>.");

  const includeRaw = map.get("include-ext");
  const includeExtensions = includeRaw
    ? new Set(
        includeRaw
          .split(",")
          .map((ext) => ext.trim().replace(/^\./, "").toLowerCase())
          .filter(Boolean),
      )
    : DEFAULT_INCLUDE_EXTENSIONS;

  return {
    dir,
    agent,
    bind: map.get("bind"),
    commit: map.get("commit") ?? "Imported existing site",
    includeExtensions,
  };
}

/**
 * Recursively reads `dir` into a `SiteFiles` map keyed by POSIX-relative path,
 * including only allowed extensions and files under the size ceiling.
 */
function readSiteFiles(dir: string, includeExtensions: Set<string>): SiteFiles {
  const files: SiteFiles = {};

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        walk(join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).slice(1).toLowerCase();
      if (!includeExtensions.has(ext)) continue;

      const fullPath = join(current, entry.name);
      if (statSync(fullPath).size > MAX_FILE_BYTES) {
        console.warn(`  skip (too large): ${fullPath}`);
        continue;
      }

      const relPath = relative(dir, fullPath).split(sep).join("/");
      files[relPath] = readFileSync(fullPath, "utf-8");
    }
  }

  walk(dir);
  return files;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`Reading static site from: ${args.dir}`);
  const files = readSiteFiles(args.dir, args.includeExtensions);
  const paths = Object.keys(files).sort();
  if (paths.length === 0) {
    throw new Error(`No importable files found under ${args.dir}.`);
  }
  console.log(`Found ${paths.length} files:`);
  for (const path of paths) console.log(`  - ${path} (${files[path].length} bytes)`);
  if (!files["index.html"]) {
    console.warn("WARNING: no index.html — the site root will 404 until one exists.");
  }

  console.log(`\nPublishing to agent ${args.agent} ...`);
  const result = await publishSite(args.agent, files, { commitMessage: args.commit });
  console.log(
    `Published version ${result.versionNumber} (${result.fileCount} files) ` +
      `to ${result.publication.publishedVersionId}.`,
  );

  if (args.bind) {
    console.log(`\nBinding custom domain ${args.bind} ...`);
    const publication = await bindCustomDomain(args.agent, args.bind);
    console.log(
      `Bound ${publication.customDomain} (status: ${publication.domainStatus}).`,
    );
  }

  console.log("\nDone.");
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error) => {
    if (error instanceof SiteServiceError) {
      console.error(`SiteServiceError [${error.code}]: ${error.message}`);
    } else {
      console.error(error);
    }
    await closeDatabase().catch(() => {});
    process.exit(1);
  });
