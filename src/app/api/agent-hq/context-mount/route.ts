import { NextResponse } from "next/server";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { readDbFile, listDbEntries } from "@/lib/agent-hq-db-explorer";
import {
  ensureSessionContextFolder,
  writeContextFile,
  removeContextFile,
  listContextFiles,
} from "@/lib/agent-docs";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum files to write when adding a directory recursively. */
const MAX_DIR_FILES = 20;

/** Maximum bytes of content per file to write to the context folder. */
const MAX_FILE_BYTES = 8_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collect all file entries under a directory path in the DB
 * explorer, up to a cap.
 */
async function collectAllFiles(
  dirPath: string,
  cap: number,
): Promise<Array<{ path: string; name: string }>> {
  const result: Array<{ path: string; name: string }> = [];

  async function walk(currentPath: string) {
    if (result.length >= cap) return;
    const data = await listDbEntries(currentPath);
    for (const entry of data.entries) {
      if (result.length >= cap) return;
      if (entry.type === "file") {
        result.push({ path: entry.path, name: entry.name });
      } else if (entry.type === "directory") {
        await walk(entry.path);
      }
    }
  }

  await walk(dirPath);
  return result;
}

/**
 * Derive a human-readable file name from an explorer path.
 * Uses the last segment of the path. If that would collide with another
 * file name, prepend the parent segment with an underscore.
 */
function deriveFileName(explorerPath: string, nodeName: string): string {
  // Use the node name if provided and reasonable
  let candidate = nodeName.trim();
  if (!candidate) {
    const segments = explorerPath.split("/").filter(Boolean);
    candidate = segments[segments.length - 1] ?? "context";
  }
  // Ensure it has a file extension for readability
  if (!candidate.includes(".")) {
    candidate = `${candidate}.txt`;
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// POST — add or remove a context file
// ---------------------------------------------------------------------------

interface PostBody {
  sessionId?: string;
  path?: string;
  action?: "add" | "remove";
}

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { sessionId, path: explorerPath, action } = body;

  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }
  if (!explorerPath || typeof explorerPath !== "string") {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (action !== "add" && action !== "remove") {
    return NextResponse.json(
      { error: 'action must be "add" or "remove"' },
      { status: 400 },
    );
  }

  try {
    await assertAgentHqAccess();
    await ensureSessionContextFolder(sessionId);

    if (action === "remove") {
      // For remove, derive file name and delete it
      const segments = explorerPath.split("/").filter(Boolean);
      const fileName = segments[segments.length - 1] ?? explorerPath;
      await removeContextFile(sessionId, deriveFileName(explorerPath, fileName));
      const contextFiles = await listContextFiles(sessionId);
      return NextResponse.json({ ok: true, contextFiles });
    }

    // action === "add"
    // Determine if the path is a file or directory by trying to read it as a file first
    // If that fails, treat it as a directory.
    let isDirectory = false;
    try {
      const fileData = await readDbFile(explorerPath);
      const content =
        typeof fileData.content === "string"
          ? fileData.content
          : JSON.stringify(fileData.content, null, 2);
      const segments = explorerPath.split("/").filter(Boolean);
      const nodeName = segments[segments.length - 1] ?? "context";
      const fileName = deriveFileName(explorerPath, nodeName);
      await writeContextFile(
        sessionId,
        fileName,
        content.slice(0, MAX_FILE_BYTES),
      );
    } catch {
      // If readDbFile throws, it might be a directory
      isDirectory = true;
    }

    if (isDirectory) {
      try {
        const files = await collectAllFiles(explorerPath, MAX_DIR_FILES);
        for (const file of files) {
          try {
            const fileData = await readDbFile(file.path);
            const content =
              typeof fileData.content === "string"
                ? fileData.content
                : JSON.stringify(fileData.content, null, 2);
            await writeContextFile(
              sessionId,
              deriveFileName(file.path, file.name),
              content.slice(0, MAX_FILE_BYTES),
            );
          } catch {
            // Skip files that cannot be read
          }
        }
      } catch {
        // Path is neither a readable file nor a listable directory — skip silently
      }
    }

    const contextFiles = await listContextFiles(sessionId);
    return NextResponse.json({ ok: true, contextFiles });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to manage context";
    const status = message === "Authentication required" ? 401 : 500;
    console.error("[agent-hq/context-mount] POST failed:", message);
    return NextResponse.json({ error: message }, { status });
  }
}

// ---------------------------------------------------------------------------
// GET — list current context files
// ---------------------------------------------------------------------------

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    await assertAgentHqAccess();
    const contextFiles = await listContextFiles(sessionId);
    return NextResponse.json({ contextFiles });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to list context";
    const status = message === "Authentication required" ? 401 : 500;
    console.error("[agent-hq/context-mount] GET failed:", message);
    return NextResponse.json({ error: message }, { status });
  }
}
