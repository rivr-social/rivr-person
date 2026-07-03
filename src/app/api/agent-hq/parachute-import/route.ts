import type { NextRequest } from "next/server";
import { auth } from "@/auth";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { safeOutboundUrlString } from "@/lib/safe-outbound-url";
import {
  importParachuteBatch,
  type ParachuteImportFile,
  type ParachuteLink,
} from "@/lib/autobot-parachute-sync";
import { parseVaultMarkdown } from "@/lib/parachute-vault-md";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

/** Maximum number of notes accepted in one import (upload batch or daemon pull). */
const MAX_FILES = 5_000;

/** Maximum bytes for a single note's markdown body. */
const MAX_FILE_BYTES = 512 * 1024;

/** Maximum total bytes across all notes in one import. */
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/** Extensions accepted from an uploaded vault folder. */
const ALLOWED_UPLOAD_EXTENSIONS = [".md", ".markdown", ".txt"] as const;

/** Maximum response body size read from the daemon per page (8 MB). */
const MAX_DAEMON_PAGE_BYTES = 8 * 1024 * 1024;

/** Fetch timeout for a single daemon page request. */
const DAEMON_FETCH_TIMEOUT_MS = 10_000;

/** Notes requested per daemon page (matches the HTTP API default). */
const DAEMON_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UploadedFile {
  path: string;
  content: string;
}

interface FilesImportBody {
  mode: "files";
  files: UploadedFile[];
}

interface DaemonImportBody {
  mode: "daemon";
  url: string;
  token: string;
  vaultName?: string;
}

type ImportBody = FilesImportBody | DaemonImportBody;

interface ImportErrorResponse {
  success: false;
  error: string;
}

interface ImportSuccessResponse {
  success: true;
  imported: number;
  updated: number;
  skipped: number;
  message: string;
}

/** A `Note` as returned by the Parachute daemon `GET /notes?include_content=true`. */
interface DaemonNote {
  id: string;
  content?: string;
  path?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  links?: Array<{ targetId?: string; relationship?: string }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorResponse(error: string, status: number): Response {
  return Response.json({ success: false, error } satisfies ImportErrorResponse, {
    status,
    headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
  });
}

function hasAllowedExtension(path: string): boolean {
  const lower = path.toLowerCase();
  return ALLOWED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * SSRF-guard a daemon base URL. Localhost / private IPs are allowed only outside
 * production, matching the Solid-pod import route — a self-hosted parachute daemon
 * typically lives on `127.0.0.1:1940` in dev, but a tunneled public host in prod.
 */
function safeDaemonBase(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  return safeOutboundUrlString(parsed, {
    protocols: ["https:", "http:"],
    allowLocalhost: process.env.NODE_ENV !== "production",
    allowPrivateIpLiterals: process.env.NODE_ENV !== "production",
  });
}

/** Build the `/notes` URL for a page against the default or a named vault. */
function daemonNotesUrl(base: string, vaultName: string | undefined, offset: number): string {
  const root = base.replace(/\/+$/, "");
  const vaultSegment = vaultName ? `/vaults/${encodeURIComponent(vaultName)}` : "";
  const params = new URLSearchParams({
    include_content: "true",
    limit: String(DAEMON_PAGE_SIZE),
    offset: String(offset),
    sort: "asc",
  });
  return `${root}${vaultSegment}/api/notes?${params.toString()}`;
}

/** Read a fetch response body up to a byte cap, aborting if it overruns. */
async function readCappedText(response: Response, capBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Empty response from daemon");
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > capBytes) {
      await reader.cancel();
      throw new Error("Daemon response too large");
    }
    chunks.push(value);
  }
  return chunks.map((c) => decoder.decode(c, { stream: true })).join("") + decoder.decode();
}

/** Convert a daemon note into the import shape. Path defaults to the note id. */
function daemonNoteToFile(note: DaemonNote): ParachuteImportFile {
  const links: ParachuteLink[] = (note.links ?? [])
    .filter((link): link is { targetId: string; relationship?: string } =>
      typeof link.targetId === "string" && link.targetId.length > 0,
    )
    .map((link) => ({ target: link.targetId, relationship: link.relationship }));

  return {
    path: note.path && note.path.trim() ? note.path : note.id,
    content: note.content ?? "",
    mimeType: "text/markdown",
    tags: Array.isArray(note.tags) ? note.tags : [],
    frontmatter: note.metadata && typeof note.metadata === "object" ? note.metadata : undefined,
    links: links.length > 0 ? links : undefined,
  };
}

// ---------------------------------------------------------------------------
// Ingress: uploaded folder of markdown files
// ---------------------------------------------------------------------------

function parseUploadedFiles(files: UploadedFile[]): {
  parsed: ParachuteImportFile[];
  error?: { message: string; status: number };
} {
  if (files.length > MAX_FILES) {
    return { parsed: [], error: { message: `Too many files (max ${MAX_FILES})`, status: 413 } };
  }

  const parsed: ParachuteImportFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      return { parsed: [], error: { message: "Each file needs a string path and content", status: 400 } };
    }
    if (!hasAllowedExtension(file.path)) {
      // Silently skip non-markdown entries (a folder may carry assets/config).
      continue;
    }
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      return {
        parsed: [],
        error: { message: `File "${file.path}" exceeds the ${MAX_FILE_BYTES / 1024} KB per-file limit`, status: 413 },
      };
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      return { parsed: [], error: { message: "Import exceeds the total size limit", status: 413 } };
    }

    const { body, frontmatter, tags } = parseVaultMarkdown(file.content);
    parsed.push({
      path: file.path,
      content: body,
      mimeType: "text/markdown",
      tags,
      frontmatter: Object.keys(frontmatter).length > 0 ? frontmatter : undefined,
    });
  }

  return { parsed };
}

// ---------------------------------------------------------------------------
// Ingress: live daemon pull
// ---------------------------------------------------------------------------

async function pullFromDaemon(
  base: string,
  token: string,
  vaultName: string | undefined,
): Promise<{ files: ParachuteImportFile[]; error?: { message: string; status: number } }> {
  const files: ParachuteImportFile[] = [];
  let offset = 0;

  while (files.length < MAX_FILES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DAEMON_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(daemonNotesUrl(base, vaultName, offset), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof Error && err.name === "AbortError") {
        return { files: [], error: { message: "Daemon request timed out", status: 504 } };
      }
      const message = err instanceof Error ? err.message : "Unknown error";
      return { files: [], error: { message: `Failed to reach daemon: ${message}`, status: 502 } };
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      return { files: [], error: { message: "Daemon rejected the token (check the pvt_ key)", status: 401 } };
    }
    if (!response.ok) {
      return {
        files: [],
        error: { message: `Daemon returned ${response.status} ${response.statusText || ""}`.trim(), status: 502 },
      };
    }

    let pageText: string;
    try {
      pageText = await readCappedText(response, MAX_DAEMON_PAGE_BYTES);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { files: [], error: { message, status: 502 } };
    }

    let notes: DaemonNote[];
    try {
      const payload = JSON.parse(pageText) as unknown;
      if (!Array.isArray(payload)) {
        return { files: [], error: { message: "Daemon /notes did not return an array", status: 502 } };
      }
      notes = payload as DaemonNote[];
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown parse error";
      return { files: [], error: { message: `Failed to parse daemon response: ${message}`, status: 502 } };
    }

    for (const note of notes) {
      if (note && typeof note.id === "string") {
        files.push(daemonNoteToFile(note));
      }
    }

    // A short page means we've reached the end of the vault.
    if (notes.length < DAEMON_PAGE_SIZE) break;
    offset += DAEMON_PAGE_SIZE;
  }

  return { files };
}

// ---------------------------------------------------------------------------
// POST /api/agent-hq/parachute-import
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<Response> {
  // Gate: sovereign-only (assertAgentHqAccess) AND owner-only. This endpoint
  // writes the owner's private docs, so only PRIMARY_AGENT_ID may call it.
  let userId: string;
  try {
    await assertAgentHqAccess();
    const session = await auth();
    if (!session?.user?.id) {
      return errorResponse("Authentication required", 401);
    }
    userId = session.user.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Access denied";
    const status = message === "Authentication required" ? 401 : 403;
    return errorResponse(message, status);
  }

  const primaryAgentId = process.env.PRIMARY_AGENT_ID;
  if (primaryAgentId && userId !== primaryAgentId) {
    return errorResponse("Only the instance owner can import a vault.", 403);
  }
  const ownerId = primaryAgentId ?? userId;

  let body: ImportBody;
  try {
    body = (await request.json()) as ImportBody;
  } catch {
    return errorResponse("Invalid request body", 400);
  }

  if (!body || (body.mode !== "files" && body.mode !== "daemon")) {
    return errorResponse('Missing or invalid "mode" (expected "files" or "daemon")', 400);
  }

  let files: ParachuteImportFile[];
  let vaultPath: string;

  if (body.mode === "files") {
    if (!Array.isArray(body.files) || body.files.length === 0) {
      return errorResponse("No files supplied for import", 400);
    }
    const { parsed, error } = parseUploadedFiles(body.files);
    if (error) return errorResponse(error.message, error.status);
    if (parsed.length === 0) {
      return errorResponse("No markdown/text notes found in the upload", 422);
    }
    files = parsed;
    vaultPath = "upload";
  } else {
    if (typeof body.url !== "string" || typeof body.token !== "string" || !body.url || !body.token) {
      return errorResponse("Daemon import requires a url and token", 400);
    }
    if (!body.token.startsWith("pvt_")) {
      return errorResponse("Daemon token must be a pvt_ key", 400);
    }
    let base: string;
    try {
      base = safeDaemonBase(body.url);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid daemon URL";
      return errorResponse(message, 400);
    }
    const vaultName = typeof body.vaultName === "string" && body.vaultName.trim() ? body.vaultName.trim() : undefined;
    const { files: pulled, error } = await pullFromDaemon(base, body.token, vaultName);
    if (error) return errorResponse(error.message, error.status);
    if (pulled.length === 0) {
      return errorResponse("The daemon vault has no notes to import", 422);
    }
    files = pulled;
    vaultPath = vaultName ? `${new URL(base).host}/${vaultName}` : new URL(base).host;
  }

  try {
    const result = await importParachuteBatch(ownerId, files, { vaultPath });
    return Response.json(
      {
        success: true,
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        message: result.message,
      } satisfies ImportSuccessResponse,
      { status: 200, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to import vault";
    return errorResponse(message, 500);
  }
}
