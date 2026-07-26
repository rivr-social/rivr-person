import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, relative, resolve, posix } from "node:path";
import type { SiteFiles } from "@/lib/bespoke/site-files";
import {
  MAX_FILE_BYTES,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACE_FILES,
  validateSitePath,
} from "@/lib/builder/assistant-tools";
import { resolveBuilderOwner, isOwnerError } from "@/lib/builder/site-owner";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const DEFAULT_DEPLOY_DIR = "/opt/camalot";
const DEPLOY_DIR = process.env.BESPOKE_SITE_DEPLOY_DIR || DEFAULT_DEPLOY_DIR;
const DEPLOY_HOST = process.env.BESPOKE_SITE_DEPLOY_HOST || "";
const DEPLOY_USER = process.env.BESPOKE_SITE_DEPLOY_USER || "root";
const SSH_HOST_RE = /^[a-z0-9.-]+$/i;
const SSH_USER_RE = /^[a-z_][a-z0-9_-]*$/i;
const REMOTE_PATH_RE = /^\/[a-z0-9._/-]+$/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeployFilesRequestBody {
  files: SiteFiles;
  mode?: "local" | "ssh";
}

interface DeployFilesSuccessResponse {
  success: true;
  deployedFiles: string[];
  deployPath: string;
  mode: string;
}

interface DeployFilesErrorResponse {
  success: false;
  error: string;
}

type DeployFilesResponse = DeployFilesSuccessResponse | DeployFilesErrorResponse;

function validateFiles(files: unknown): SiteFiles {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Missing or invalid files object");
  }

  const entries = Object.entries(files);
  if (entries.length === 0) throw new Error("Missing or empty files object");
  if (entries.length > MAX_WORKSPACE_FILES) {
    throw new Error(`Too many files (max ${MAX_WORKSPACE_FILES})`);
  }

  let totalBytes = 0;
  for (const [filePath, content] of entries) {
    const pathError = validateSitePath(filePath);
    if (pathError) throw new Error(`${filePath}: ${pathError}`);
    if (typeof content !== "string") {
      throw new Error(`${filePath}: File content must be text`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`${filePath}: File exceeds ${MAX_FILE_BYTES} bytes`);
    }
    totalBytes += bytes;
  }

  if (totalBytes > MAX_WORKSPACE_BYTES) {
    throw new Error(`Site exceeds ${MAX_WORKSPACE_BYTES} bytes`);
  }
  return Object.fromEntries(entries) as SiteFiles;
}

function resolveContainedPath(root: string, filePath: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, filePath);
  const rel = relative(resolvedRoot, target);
  if (!rel || rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) {
    throw new Error(`Path escapes deployment root: ${filePath}`);
  }
  return target;
}

function validateSshConfig(host: string, user: string, deployDir: string): void {
  if (!SSH_HOST_RE.test(host)) throw new Error("Invalid SSH deployment host");
  if (!SSH_USER_RE.test(user)) throw new Error("Invalid SSH deployment user");
  if (
    !REMOTE_PATH_RE.test(deployDir) ||
    deployDir.split("/").includes("..")
  ) {
    throw new Error("Invalid SSH deployment directory");
  }
}

function runSsh(
  host: string,
  user: string,
  command: string[],
  input?: string,
): void {
  const result = spawnSync("ssh", ["--", `${user}@${host}`, ...command], {
    input,
    timeout: input === undefined ? 10_000 : 30_000,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: MAX_FILE_BYTES + 64_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `SSH exited with status ${result.status}`);
  }
}

// ---------------------------------------------------------------------------
// Local filesystem deploy
// ---------------------------------------------------------------------------

async function deployLocal(files: SiteFiles, deployDir: string): Promise<string[]> {
  const root = resolve(deployDir);
  await mkdir(root, { recursive: true });

  const deployedFiles: string[] = [];
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = resolveContainedPath(root, filePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    deployedFiles.push(filePath);
  }

  return deployedFiles;
}

// ---------------------------------------------------------------------------
// SSH deploy
// ---------------------------------------------------------------------------

async function deploySSH(
  files: SiteFiles,
  host: string,
  user: string,
  deployDir: string,
): Promise<string[]> {
  validateSshConfig(host, user, deployDir);
  runSsh(host, user, ["mkdir", "-p", "--", deployDir]);

  const deployedFiles: string[] = [];
  for (const [filePath, content] of Object.entries(files)) {
    const remotePath = posix.join(deployDir, filePath);
    const remoteDir = posix.dirname(remotePath);

    if (remoteDir !== deployDir) {
      runSsh(host, user, ["mkdir", "-p", "--", remoteDir]);
    }

    runSsh(host, user, ["tee", "--", remotePath], content);
    deployedFiles.push(filePath);
  }

  return deployedFiles;
}

// ---------------------------------------------------------------------------
// POST /api/bespoke/deploy-files
//
// Accepts raw file contents (SiteFiles map) and deploys them directly.
// This is the AI builder's deploy endpoint — it writes whatever files
// are provided without re-generating from templates.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  try {
    const body = (await request.json()) as DeployFilesRequestBody;
    const files = validateFiles(body.files);

    const mode = body.mode || (DEPLOY_HOST ? "ssh" : "local");
    if (mode !== "local" && mode !== "ssh") {
      throw new Error("Invalid deployment mode");
    }
    if (mode === "ssh" && !DEPLOY_HOST) {
      throw new Error("SSH deployment is not configured");
    }
    let deployedFiles: string[];

    if (mode === "ssh") {
      deployedFiles = await deploySSH(files, DEPLOY_HOST, DEPLOY_USER, DEPLOY_DIR);
    } else {
      deployedFiles = await deployLocal(files, DEPLOY_DIR);
    }

    console.log(
      `[api/bespoke/deploy-files] Deployed ${deployedFiles.length} files to ${DEPLOY_DIR} (mode: ${mode})`,
    );

    return NextResponse.json(
      {
        success: true,
        deployedFiles,
        deployPath: DEPLOY_DIR,
        mode,
      },
      { headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/bespoke/deploy-files] Deploy failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Deploy failed",
      },
      { status: 500, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
