import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { discoverAgentProjects, type AgentWorkspace } from "@/lib/agent-hq";
import type { SiteFiles } from "@/lib/bespoke/site-files";

const DEPLOY_STATE_DIR = ".rivr-deploy";
const REQUEST_FILE = "request.json";
const RESULT_FILE = "result.json";
const MAX_FILE_BYTES = 400_000;
const MAX_WORKSPACE_BYTES = 2_000_000;

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

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".rivr-deploy",
  "node_modules",
  ".next",
  "dist",
]);

export interface WorkspaceDeployRequest {
  version: 1;
  requestId: string;
  workspaceId: string;
  requestedAt: string;
  sourceDigest: string;
}

export interface WorkspaceDeployResult {
  version?: number;
  requestId?: string;
  status?: "deployed" | "failed" | string;
  finishedAt?: string;
  release?: string;
  sourceSha256?: string;
  fileCount?: number;
  bytes?: number;
  url?: string;
  error?: string;
}

export async function resolveBuilderWorkspace(
  workspaceId: string,
  deployableOnly = false,
): Promise<AgentWorkspace | null> {
  const workspaces = await discoverAgentProjects();
  const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
  if (!workspace) return null;
  if (deployableOnly && (workspace.scope !== "app" || !workspace.deployRoot)) return null;
  return workspace;
}

function safeRelativePath(value: string, label: string): string {
  if (value.includes("\\") || path.isAbsolute(value)) {
    throw new Error(`${label} must be workspace-relative.`);
  }
  const normalized = path.posix.normalize(value || ".");
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} escapes the workspace boundary.`);
  }
  return normalized === "." ? "" : normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWorkspaceWriteRoot(workspace: AgentWorkspace, basePath = ""): string {
  const workspaceRoot = path.resolve(workspace.cwd);
  const relativeBase = safeRelativePath(basePath, "basePath");
  const writeRoot = path.resolve(workspaceRoot, relativeBase);
  if (!isInside(workspaceRoot, writeRoot)) {
    throw new Error("basePath escapes the workspace boundary.");
  }
  return writeRoot;
}

function resolveWorkspaceFile(writeRoot: string, filePath: string): string {
  const relativeFile = safeRelativePath(filePath, "File path");
  if (!relativeFile) throw new Error("A file path is required.");
  if (!ALLOWED_EXTENSIONS.has(path.extname(relativeFile).toLowerCase())) {
    throw new Error(`Unsupported builder file type: ${filePath}`);
  }
  const fullPath = path.resolve(writeRoot, relativeFile);
  if (!isInside(writeRoot, fullPath)) {
    throw new Error(`File path escapes the selected builder directory: ${filePath}`);
  }
  return fullPath;
}

export async function writeWorkspaceSiteFiles(
  workspace: AgentWorkspace,
  files: SiteFiles,
  basePath = "",
): Promise<{ filesWritten: number; bytesWritten: number }> {
  const entries = Object.entries(files);
  if (entries.length === 0) throw new Error("No files provided.");

  const totalBytes = entries.reduce((sum, [, content]) => {
    if (typeof content !== "string") throw new Error("Every file must contain text.");
    return sum + Buffer.byteLength(content, "utf8");
  }, 0);
  if (totalBytes > MAX_WORKSPACE_BYTES) {
    throw new Error(`Workspace exceeds the ${MAX_WORKSPACE_BYTES}-byte builder limit.`);
  }

  const writeRoot = resolveWorkspaceWriteRoot(workspace, basePath);
  const prepared = entries.map(([filePath, content]) => {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`${filePath} exceeds the ${MAX_FILE_BYTES}-byte builder limit.`);
    }
    return { content, fullPath: resolveWorkspaceFile(writeRoot, filePath) };
  });
  await mkdir(writeRoot, { recursive: true });
  const canonicalWriteRoot = await realpath(writeRoot);

  for (const { content, fullPath } of prepared) {
    await mkdir(path.dirname(fullPath), { recursive: true });
    const canonicalParent = await realpath(path.dirname(fullPath));
    if (!isInside(canonicalWriteRoot, canonicalParent)) {
      throw new Error("A workspace path resolves outside the selected builder directory.");
    }
    try {
      if ((await lstat(fullPath)).isSymbolicLink()) {
        throw new Error("Builder files cannot be symbolic links.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeFile(fullPath, content, "utf8");
  }

  return { filesWritten: entries.length, bytesWritten: totalBytes };
}

/**
 * Read the editable text files in one jailed Builder workspace. This is shared
 * by the browser file loader and per-app GitHub push so both surfaces operate
 * on the exact same bounded file set.
 */
export async function readWorkspaceSiteFiles(
  workspace: AgentWorkspace,
  basePath = "",
): Promise<{ files: SiteFiles; truncated: boolean }> {
  const readRoot = resolveWorkspaceWriteRoot(workspace, basePath);
  let canonicalReadRoot: string;
  try {
    canonicalReadRoot = await realpath(readRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { files: {}, truncated: false };
    }
    throw error;
  }

  const files: SiteFiles = {};
  let totalBytes = 0;
  let entryCount = 0;
  let truncated = false;

  async function visit(directory: string): Promise<void> {
    const canonicalDirectory = await realpath(directory);
    if (!isInside(canonicalReadRoot, canonicalDirectory)) {
      throw new Error("A workspace path resolves outside the selected builder directory.");
    }
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entryCount >= 300 || totalBytes >= MAX_WORKSPACE_BYTES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

      const content = await readFile(fullPath, "utf8");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > MAX_FILE_BYTES) {
        truncated = true;
        continue;
      }
      if (totalBytes + bytes > MAX_WORKSPACE_BYTES) {
        truncated = true;
        return;
      }
      const relative = path.relative(canonicalReadRoot, fullPath).replace(/\\/g, "/");
      files[relative] = content;
      totalBytes += bytes;
      entryCount += 1;
    }
  }

  await visit(canonicalReadRoot);
  return { files, truncated };
}

async function digestWorkspace(workspace: AgentWorkspace): Promise<string> {
  const hash = createHash("sha256");

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".git"))) {
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(workspace.cwd, fullPath).replace(/\\/g, "/");
      hash.update(relative);
      hash.update("\0");
      hash.update(await readFile(fullPath));
      hash.update("\0");
    }
  }

  await visit(workspace.cwd);
  return hash.digest("hex");
}

function deployStatePath(workspace: AgentWorkspace, file: string): string {
  return path.join(workspace.cwd, DEPLOY_STATE_DIR, file);
}

export async function queueWorkspaceDeployment(
  workspace: AgentWorkspace,
): Promise<WorkspaceDeployRequest> {
  if (workspace.scope !== "app" || !workspace.deployRoot) {
    throw new Error("The selected workspace is not deployable.");
  }
  const stateDir = path.join(workspace.cwd, DEPLOY_STATE_DIR);
  await mkdir(stateDir, { recursive: true });
  const request: WorkspaceDeployRequest = {
    version: 1,
    requestId: randomUUID(),
    workspaceId: workspace.id,
    requestedAt: new Date().toISOString(),
    sourceDigest: await digestWorkspace(workspace),
  };
  const tempPath = path.join(stateDir, `request.${request.requestId}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(request, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, deployStatePath(workspace, REQUEST_FILE));
  return request;
}

export async function readWorkspaceDeploymentResult(
  workspace: AgentWorkspace,
): Promise<WorkspaceDeployResult | null> {
  try {
    const raw = await readFile(deployStatePath(workspace, RESULT_FILE), "utf8");
    return JSON.parse(raw) as WorkspaceDeployResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function waitForWorkspaceDeployment(
  workspace: AgentWorkspace,
  requestId: string,
  timeoutMs = 30_000,
): Promise<WorkspaceDeployResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await readWorkspaceDeploymentResult(workspace);
    if (result?.requestId === requestId) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}
