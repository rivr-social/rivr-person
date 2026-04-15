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
 * Returns the absolute path of the session context folder and creates it
 * (including a CLAUDE.md readme) if it does not already exist.
 */
export async function ensureSessionContextFolder(sessionId: string): Promise<string> {
  const safe = sanitizeSessionId(sessionId);
  const contextDir = path.join(AGENTS_ROOT, safe, CONTEXT_FOLDER_NAME);
  await mkdir(contextDir, { recursive: true });
  const readmePath = path.join(contextDir, "CLAUDE.md");
  if (!existsSync(readmePath)) {
    await writeFile(readmePath, CONTEXT_FOLDER_README, "utf-8");
  }
  return contextDir;
}

/**
 * Write a context file into a session's context folder.
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
  return filePath;
}

/**
 * Remove a context file from a session's context folder.
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
    .filter((e) => e.isFile() && e.name !== "CLAUDE.md")
    .map((e) => e.name)
    .sort();
}
