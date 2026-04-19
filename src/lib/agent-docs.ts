// ---------------------------------------------------------------------------
// Agent Docs — Per-agent folder structure for soul.md and context docs
//
// Runtime directory: /workspace/agents/{agentId}/
//   soul.md          — the agent's identity/personality doc
//   docs/            — additional context docs for this agent
//
// In development (non-Docker), falls back to {cwd}/.agent-docs/agents/
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, stat, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpProvenanceLog } from "@/db/schema";
import { listAgentSessions } from "@/lib/agent-hq";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCKER_AGENTS_ROOT = "/workspace/agents";
const LOCAL_AGENTS_ROOT = path.join(process.cwd(), ".agent-docs", "agents");

/**
 * Resolve the writable agents root directory.
 * Prefers the Docker /workspace/agents path if it exists, otherwise
 * falls back to a local dev directory under cwd.
 */
function resolveAgentsRoot(): string {
  if (process.env.AGENT_DOCS_ROOT) {
    return path.resolve(process.env.AGENT_DOCS_ROOT);
  }
  if (existsSync(DOCKER_AGENTS_ROOT)) {
    return DOCKER_AGENTS_ROOT;
  }
  return LOCAL_AGENTS_ROOT;
}

export const AGENTS_ROOT = resolveAgentsRoot();

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function agentDir(agentId: string): string {
  return path.join(AGENTS_ROOT, agentId);
}

function agentSoulPath(agentId: string): string {
  return path.join(AGENTS_ROOT, agentId, "soul.md");
}

function agentDocsDir(agentId: string): string {
  return path.join(AGENTS_ROOT, agentId, "docs");
}

/**
 * Resolve a relative path within an agent's folder.
 * Guards against path-traversal attacks.
 */
function resolveAgentFilePath(agentId: string, relativePath: string): string {
  const base = agentDir(agentId);
  const resolved = path.resolve(base, relativePath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error("Path traversal is not allowed.");
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Ensure folder structure
// ---------------------------------------------------------------------------

/**
 * Creates the agent folder and docs subfolder if they don't exist.
 * Does NOT create soul.md — that is user-managed.
 */
export async function ensureAgentDocsFolder(agentId: string): Promise<void> {
  const dir = agentDir(agentId);
  const docs = agentDocsDir(agentId);
  await mkdir(dir, { recursive: true });
  await mkdir(docs, { recursive: true });
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Check whether an agent has an on-disk folder.
 */
export function agentFolderExists(agentId: string): boolean {
  return existsSync(agentDir(agentId));
}

/**
 * Check whether an agent has a soul.md on disk.
 */
export function agentSoulExists(agentId: string): boolean {
  return existsSync(agentSoulPath(agentId));
}

/**
 * Read an agent's soul.md content. Returns null if it doesn't exist.
 */
export async function readAgentSoul(agentId: string): Promise<string | null> {
  try {
    const content = await readFile(agentSoulPath(agentId), "utf-8");
    return content;
  } catch {
    return null;
  }
}

/**
 * Read a file from an agent's folder by relative path.
 */
export async function readAgentFile(agentId: string, relativePath: string): Promise<string> {
  const filePath = resolveAgentFilePath(agentId, relativePath);
  return readFile(filePath, "utf-8");
}

/**
 * List the contents of an agent's folder (or a subfolder).
 */
export async function listAgentFolder(
  agentId: string,
  subPath = "",
): Promise<Array<{ name: string; type: "file" | "directory"; size: number }>> {
  const base = agentDir(agentId);
  const target = subPath ? resolveAgentFilePath(agentId, subPath) : base;

  if (!existsSync(target)) {
    return [];
  }

  const entries = await readdir(target, { withFileTypes: true });
  const results: Array<{ name: string; type: "file" | "directory"; size: number }> = [];

  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      results.push({ name: entry.name, type: "directory", size: 0 });
    } else if (entry.isFile()) {
      const fileStat = await stat(entryPath);
      results.push({ name: entry.name, type: "file", size: fileStat.size });
    }
  }

  return results.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Write content to a file in an agent's folder.
 * Creates the agent folder structure if needed.
 */
export async function writeAgentFile(agentId: string, relativePath: string, content: string): Promise<number> {
  await ensureAgentDocsFolder(agentId);
  const filePath = resolveAgentFilePath(agentId, relativePath);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, content, "utf-8");
  return Buffer.byteLength(content, "utf-8");
}

/**
 * Write an agent's soul.md.
 */
export async function writeAgentSoul(agentId: string, content: string): Promise<number> {
  return writeAgentFile(agentId, "soul.md", content);
}

/**
 * Delete a file from an agent's folder.
 */
export async function deleteAgentFile(agentId: string, relativePath: string): Promise<void> {
  const filePath = resolveAgentFilePath(agentId, relativePath);
  await unlink(filePath);
}

// ---------------------------------------------------------------------------
// List all agent folders on disk
// ---------------------------------------------------------------------------

/**
 * List all agent IDs that have folders on disk.
 */
export async function listAgentFolderIds(): Promise<string[]> {
  if (!existsSync(AGENTS_ROOT)) {
    return [];
  }
  const entries = await readdir(AGENTS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Session Context Folder — per-pane context files on disk
// ---------------------------------------------------------------------------

const CONTEXT_FOLDER_NAME = "context";

const CONTEXT_FOLDER_README = [
  "# Session Context",
  "",
  "This folder contains context files mounted by the user via Agent HQ.",
  "Read these files to understand the current context.",
  "",
].join("\n");

/**
 * Sanitize a session ID to prevent path traversal.
 * Strips anything that is not alphanumeric, dash, underscore, or dot.
 */
function sanitizeSessionId(sessionId: string): string {
  const sanitized = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error("Invalid session ID.");
  }
  return sanitized;
}

/**
 * Build the claude.md content for a session context folder.
 * Lists all mounted files (excluding CLAUDE.md and claude.md themselves).
 */
async function buildClaudeMdContent(contextDir: string): Promise<string> {
  let fileList = "- (none)";
  if (existsSync(contextDir)) {
    const entries = await readdir(contextDir, { withFileTypes: true });
    const files = entries
      .filter((e) => e.isFile() && e.name !== "CLAUDE.md" && e.name !== "claude.md")
      .map((e) => e.name)
      .sort();
    if (files.length > 0) {
      fileList = files.map((f) => `- ${f}`).join("\n");
    }
  }
  return [
    "# Session Context",
    "",
    "This folder contains context files mounted by the user via Agent HQ.",
    "",
    "## Mounted Files",
    fileList,
    "",
    "## Instructions",
    "- Read all files in this directory to understand the current context",
    "- These files represent the user's selected scope for this session",
    "- Files may include agent records, resource content, ledger entries, and transcripts",
    "",
  ].join("\n");
}

/**
 * Regenerate the claude.md file in a session context folder.
 */
async function regenerateClaudeMd(contextDir: string): Promise<void> {
  const claudeMdPath = path.join(contextDir, "claude.md");
  const content = await buildClaudeMdContent(contextDir);
  await writeFile(claudeMdPath, content, "utf-8");
}

/**
 * Returns the absolute path of the session context folder and creates it
 * (including a CLAUDE.md readme and claude.md scope file) if it does not already exist.
 */
export async function ensureSessionContextFolder(sessionId: string): Promise<string> {
  const safe = sanitizeSessionId(sessionId);
  const contextDir = path.join(AGENTS_ROOT, safe, CONTEXT_FOLDER_NAME);
  await mkdir(contextDir, { recursive: true });
  const readmePath = path.join(contextDir, "CLAUDE.md");
  if (!existsSync(readmePath)) {
    await writeFile(readmePath, CONTEXT_FOLDER_README, "utf-8");
  }
  // Always create/update claude.md (lowercase) with current file listing
  await regenerateClaudeMd(contextDir);
  return contextDir;
}

/**
 * Write a context file into a session's context folder.
 * Regenerates claude.md after writing so the file listing stays current.
 */
export async function writeContextFile(
  sessionId: string,
  fileName: string,
  content: string,
): Promise<string> {
  const contextDir = await ensureSessionContextFolder(sessionId);
  const safeName = path.basename(fileName); // strip any directory component
  if (!safeName || safeName === "." || safeName === "..") {
    throw new Error("Invalid context file name.");
  }
  const filePath = path.join(contextDir, safeName);
  await writeFile(filePath, content, "utf-8");
  // Regenerate claude.md with updated file listing
  await regenerateClaudeMd(contextDir);
  return filePath;
}

/**
 * Remove a context file from a session's context folder.
 * Regenerates claude.md after removal so the file listing stays current.
 */
export async function removeContextFile(
  sessionId: string,
  fileName: string,
): Promise<void> {
  const contextDir = await ensureSessionContextFolder(sessionId);
  const safeName = path.basename(fileName);
  const filePath = path.join(contextDir, safeName);
  if (existsSync(filePath)) {
    await rm(filePath);
  }
  // Regenerate claude.md with updated file listing
  await regenerateClaudeMd(contextDir);
}

/**
 * List all context files currently in a session's context folder.
 * Excludes the CLAUDE.md readme.
 */
export async function listContextFiles(sessionId: string): Promise<string[]> {
  const contextDir = await ensureSessionContextFolder(sessionId);
  if (!existsSync(contextDir)) {
    return [];
  }
  const entries = await readdir(contextDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name !== "CLAUDE.md" && e.name !== "claude.md")
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Heartbeat — auto-generated + user-editable status document per agent
// ---------------------------------------------------------------------------

const HEARTBEAT_FILE_NAME = "heartbeat.md";
const HEARTBEAT_NOTES_HEADER = "## Notes";
const HEARTBEAT_DEFAULT_NOTES = "No notes yet. Edit this section to add context about current focus or state.";

function agentHeartbeatPath(agentId: string): string {
  return path.join(AGENTS_ROOT, agentId, HEARTBEAT_FILE_NAME);
}

/**
 * Extract the user-written Notes section from an existing heartbeat.md on disk.
 * Returns the default placeholder if no heartbeat exists or the Notes section is missing.
 */
async function extractExistingNotes(agentId: string): Promise<string> {
  const heartbeatPath = agentHeartbeatPath(agentId);
  if (!existsSync(heartbeatPath)) {
    return HEARTBEAT_DEFAULT_NOTES;
  }
  try {
    const content = await readFile(heartbeatPath, "utf-8");
    const notesIdx = content.indexOf(HEARTBEAT_NOTES_HEADER);
    if (notesIdx === -1) {
      return HEARTBEAT_DEFAULT_NOTES;
    }
    const afterHeader = content.slice(notesIdx + HEARTBEAT_NOTES_HEADER.length).trim();
    return afterHeader.length > 0 ? afterHeader : HEARTBEAT_DEFAULT_NOTES;
  } catch {
    return HEARTBEAT_DEFAULT_NOTES;
  }
}

/**
 * Count session context folders that exist on disk for an agent.
 */
async function countSessionFolders(agentId: string): Promise<number> {
  const dir = agentDir(agentId);
  if (!existsSync(dir)) return 0;
  let count = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const contextDir = path.join(dir, entry.name, "context");
      if (existsSync(contextDir)) {
        count++;
      }
    }
  } catch {
    // ignore
  }
  // Also check the top-level context folder
  const topContext = path.join(dir, "context");
  if (existsSync(topContext)) {
    count++;
  }
  return count;
}

/**
 * Generate fresh heartbeat.md content for an agent.
 * Combines live runtime data with preserved user notes.
 */
export async function generateHeartbeat(agentId: string): Promise<string> {
  // 1. Gather agent name from DB
  let agentName = agentId;
  try {
    const { agents } = await import("@/db/schema");
    const row = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      columns: { name: true },
    });
    if (row?.name) agentName = row.name;
  } catch {
    // fall back to agentId
  }

  // 2. Check tmux sessions
  let sessions: Awaited<ReturnType<typeof listAgentSessions>> = [];
  try {
    sessions = await listAgentSessions();
  } catch {
    // tmux may not be available
  }

  // 3. Query recent provenance entries
  let recentProvenance: Array<{ toolName: string; resultStatus: string; createdAt: Date }> = [];
  try {
    recentProvenance = await db
      .select({
        toolName: mcpProvenanceLog.toolName,
        resultStatus: mcpProvenanceLog.resultStatus,
        createdAt: mcpProvenanceLog.createdAt,
      })
      .from(mcpProvenanceLog)
      .where(eq(mcpProvenanceLog.actorId, agentId))
      .orderBy(desc(mcpProvenanceLog.createdAt))
      .limit(5);
  } catch {
    // table may not exist yet
  }

  // 4. Check soul.md
  const hasSoul = agentSoulExists(agentId);

  // 5. Count session context folders
  const sessionFolderCount = await countSessionFolders(agentId);

  // 6. Preserve existing notes
  const notes = await extractExistingNotes(agentId);

  // 7. Determine status
  const hasActiveSessions = sessions.length > 0;
  const status = hasActiveSessions ? "active" : recentProvenance.length > 0 ? "idle" : "offline";

  // 8. Build sessions section
  let sessionsSection: string;
  if (sessions.length === 0) {
    sessionsSection = "No active sessions";
  } else {
    sessionsSection = sessions
      .map((s) => `- ${s.sessionName} (${s.metadata.role}, ${s.metadata.provider ?? "unknown"}) — ${s.dead ? "dead" : "alive"}`)
      .join("\n");
  }

  // 9. Build recent activity section
  let activitySection: string;
  if (recentProvenance.length === 0) {
    activitySection = "No recent activity";
  } else {
    activitySection = recentProvenance
      .map((p) => `- ${p.createdAt.toISOString()} — ${p.toolName} (${p.resultStatus})`)
      .join("\n");
  }

  // 10. Assemble markdown
  const now = new Date().toISOString();
  const markdown = [
    `# Heartbeat — ${agentName}`,
    "",
    `**Last updated:** ${now}`,
    `**Status:** ${status}`,
    "",
    "## Active Sessions",
    sessionsSection,
    "",
    "## Recent Activity",
    activitySection,
    "",
    "## Context",
    `- Soul: ${hasSoul ? "exists" : "missing"}`,
    `- Session folders: ${sessionFolderCount}`,
    "",
    HEARTBEAT_NOTES_HEADER,
    notes,
    "",
  ].join("\n");

  // Write the generated heartbeat to disk
  await ensureAgentDocsFolder(agentId);
  await writeFile(agentHeartbeatPath(agentId), markdown, "utf-8");

  return markdown;
}

/**
 * Read heartbeat.md for an agent — regenerates with fresh data on each read.
 */
export async function readHeartbeat(agentId: string): Promise<string> {
  return generateHeartbeat(agentId);
}

/**
 * Write only the Notes section of heartbeat.md for an agent.
 * Preserves all auto-generated sections; only the Notes content is updated.
 */
export async function writeHeartbeatNotes(agentId: string, content: string): Promise<void> {
  // Extract just the notes from the incoming content.
  // If the user writes the full heartbeat, pull out only the Notes section.
  // If the user writes plain text, treat it as the notes content.
  let notes: string;
  const notesIdx = content.indexOf(HEARTBEAT_NOTES_HEADER);
  if (notesIdx !== -1) {
    notes = content.slice(notesIdx + HEARTBEAT_NOTES_HEADER.length).trim();
  } else {
    notes = content.trim();
  }

  if (notes.length === 0) {
    notes = HEARTBEAT_DEFAULT_NOTES;
  }

  // Write a minimal heartbeat with just the notes so the next read regenerates correctly
  await ensureAgentDocsFolder(agentId);
  const placeholder = [
    "# Heartbeat",
    "",
    HEARTBEAT_NOTES_HEADER,
    notes,
    "",
  ].join("\n");
  await writeFile(agentHeartbeatPath(agentId), placeholder, "utf-8");
}
