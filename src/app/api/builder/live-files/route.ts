import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { getDeployCapability } from "@/lib/deploy/capability";
import type { SiteFiles } from "@/lib/bespoke/site-files";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const STATUS_OK = 200;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL = 500;

/** File extensions considered safe to read into the builder. */
const ALLOWED_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".json",
  ".svg",
  ".xml",
  ".txt",
  ".md",
]);

/** Maximum individual file size to read (256 KB). */
const MAX_FILE_SIZE_BYTES = 256 * 1024;

/** Maximum total files to scan in a directory. */
const MAX_DIRECTORY_ENTRIES = 200;

// ---------------------------------------------------------------------------
// GET /api/builder/live-files
//
// Reads the currently deployed site files from the public/site directory
// on sovereign instances. Returns a SiteFiles map that the builder can
// load into its editor state.
//
// Only available on sovereign instances with direct deploy capability.
// Shared instances should use version history or GitHub as their source.
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const capability = getDeployCapability();

  if (!capability.isSovereign || capability.deployMethod !== "direct") {
    return NextResponse.json(
      {
        error: "Live file reading is only available on sovereign instances with direct deploy.",
        deployMethod: capability.deployMethod,
        isolationTier: capability.isolationTier,
      },
      { status: STATUS_FORBIDDEN, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const { readFileSync, readdirSync, statSync, existsSync } = await import("fs");
    const { join, extname, relative } = await import("path");

    const publicSiteDir = join(process.cwd(), "public", "site");

    if (!existsSync(publicSiteDir)) {
      return NextResponse.json(
        { files: {}, message: "No deployed site directory found." },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const files: SiteFiles = {};
    let entryCount = 0;

    function scanDirectory(dir: string): void {
      if (entryCount >= MAX_DIRECTORY_ENTRIES) return;

      const entries = readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entryCount >= MAX_DIRECTORY_ENTRIES) break;

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          // Skip hidden directories and node_modules
          if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
          scanDirectory(fullPath);
          continue;
        }

        if (!entry.isFile()) continue;

        const ext = extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) continue;

        const stat = statSync(fullPath);
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;

        entryCount++;
        const relativePath = relative(publicSiteDir, fullPath);
        // Normalize path separators for cross-platform consistency
        const normalizedPath = relativePath.replace(/\\/g, "/");

        try {
          files[normalizedPath] = readFileSync(fullPath, "utf-8");
        } catch {
          // Skip files that cannot be read
        }
      }
    }

    scanDirectory(publicSiteDir);

    return NextResponse.json(
      {
        files,
        fileCount: Object.keys(files).length,
        source: publicSiteDir,
      },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/live-files] Read failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read live site files" },
      { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
