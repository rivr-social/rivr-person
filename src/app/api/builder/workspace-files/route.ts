import { auth } from "@/auth";
import { NextResponse } from "next/server";
import {
  assertAgentHqAccess,
  discoverAgentProjects,
  type AgentWorkspace,
} from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL = 500;

/** File extensions considered safe for the builder to read/write. */
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
  ".ts",
  ".tsx",
  ".jsx",
]);

/** Maximum individual file size to read (256 KB). */
const MAX_FILE_SIZE_BYTES = 256 * 1024;

/** Maximum total files to scan. */
const MAX_DIRECTORY_ENTRIES = 300;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonError(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}

async function resolveWorkspace(workspaceId: string): Promise<AgentWorkspace | null> {
  const workspaces = await discoverAgentProjects();
  return workspaces.find((w) => w.id === workspaceId) ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/builder/workspace-files?workspaceId=X&basePath=src
//
// Reads files from a workspace directory, returning them as a SiteFiles map.
// Uses the same scanning approach as live-files but targets any workspace.
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return jsonError("Authentication required", STATUS_UNAUTHORIZED);
  }

  try {
    await assertAgentHqAccess();
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Agent HQ access denied",
      STATUS_UNAUTHORIZED,
    );
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId");
  if (!workspaceId) {
    return jsonError("workspaceId query parameter is required", STATUS_BAD_REQUEST);
  }

  const basePath = url.searchParams.get("basePath") ?? "";

  const workspace = await resolveWorkspace(workspaceId);
  if (!workspace) {
    return jsonError(`Workspace not found: ${workspaceId}`, STATUS_NOT_FOUND);
  }

  try {
    const { readFileSync, readdirSync, statSync, existsSync } = await import("fs");
    const { join, extname, relative, resolve } = await import("path");

    const scanRoot = basePath
      ? resolve(workspace.cwd, basePath.replace(/\.\./g, "").replace(/^\//, ""))
      : workspace.cwd;

    if (!scanRoot.startsWith(resolve(workspace.cwd))) {
      return jsonError("basePath escapes workspace boundary", STATUS_BAD_REQUEST);
    }

    if (!existsSync(scanRoot)) {
      return NextResponse.json(
        {
          files: {},
          fileCount: 0,
          workspace: { id: workspace.id, name: workspace.name, label: workspace.label },
          basePath,
          message: "Directory does not exist.",
        },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const files: Record<string, string> = {};
    let entryCount = 0;

    function scanDirectory(dir: string): void {
      if (entryCount >= MAX_DIRECTORY_ENTRIES) return;

      let entries: import("fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as import("fs").Dirent[];
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entryCount >= MAX_DIRECTORY_ENTRIES) break;

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            entry.name === ".next" ||
            entry.name === "dist" ||
            entry.name === ".git"
          ) {
            continue;
          }
          scanDirectory(fullPath);
          continue;
        }

        if (!entry.isFile()) continue;

        const ext = extname(entry.name).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) continue;

        try {
          const fileStat = statSync(fullPath);
          if (fileStat.size > MAX_FILE_SIZE_BYTES) continue;
        } catch {
          continue;
        }

        entryCount++;
        const relativePath = relative(scanRoot, fullPath).replace(/\\/g, "/");

        try {
          files[relativePath] = readFileSync(fullPath, "utf-8");
        } catch {
          // Skip unreadable files
        }
      }
    }

    scanDirectory(scanRoot);

    return NextResponse.json(
      {
        files,
        fileCount: Object.keys(files).length,
        workspace: { id: workspace.id, name: workspace.name, label: workspace.label },
        basePath,
      },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/workspace-files] Read failed:", error);
    return jsonError(
      error instanceof Error ? error.message : "Failed to read workspace files",
      STATUS_INTERNAL,
    );
  }
}

// ---------------------------------------------------------------------------
// POST /api/builder/workspace-files
//
// Writes files into a workspace directory. Body:
// {
//   workspaceId: string,
//   files: Record<string, string>,
//   basePath?: string
// }
// ---------------------------------------------------------------------------

interface WriteRequestBody {
  workspaceId: string;
  files: Record<string, string>;
  basePath?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return jsonError("Authentication required", STATUS_UNAUTHORIZED);
  }

  try {
    await assertAgentHqAccess();
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Agent HQ access denied",
      STATUS_UNAUTHORIZED,
    );
  }

  let body: WriteRequestBody;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", STATUS_BAD_REQUEST);
  }

  if (!body.workspaceId) {
    return jsonError("workspaceId is required", STATUS_BAD_REQUEST);
  }
  if (!body.files || typeof body.files !== "object" || Object.keys(body.files).length === 0) {
    return jsonError("No files provided", STATUS_BAD_REQUEST);
  }

  const workspace = await resolveWorkspace(body.workspaceId);
  if (!workspace) {
    return jsonError(`Workspace not found: ${body.workspaceId}`, STATUS_NOT_FOUND);
  }

  try {
    const { writeFileSync, mkdirSync, existsSync } = await import("fs");
    const { join, dirname, resolve } = await import("path");

    const writeRoot = body.basePath
      ? resolve(workspace.cwd, body.basePath.replace(/\.\./g, "").replace(/^\//, ""))
      : workspace.cwd;

    if (!writeRoot.startsWith(resolve(workspace.cwd))) {
      return jsonError("basePath escapes workspace boundary", STATUS_BAD_REQUEST);
    }

    let filesWritten = 0;

    for (const [filePath, content] of Object.entries(body.files)) {
      const sanitized = filePath.replace(/\.\./g, "").replace(/^\//, "");
      const fullPath = join(writeRoot, sanitized);

      // Ensure target stays within workspace
      if (!fullPath.startsWith(resolve(workspace.cwd))) {
        continue;
      }

      const dir = dirname(fullPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(fullPath, content, "utf-8");
      filesWritten++;
    }

    return NextResponse.json(
      {
        success: true,
        filesWritten,
        workspace: { id: workspace.id, name: workspace.name, label: workspace.label },
        basePath: body.basePath ?? "",
      },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/builder/workspace-files] Write failed:", error);
    return jsonError(
      error instanceof Error ? error.message : "Failed to write workspace files",
      STATUS_INTERNAL,
    );
  }
}
