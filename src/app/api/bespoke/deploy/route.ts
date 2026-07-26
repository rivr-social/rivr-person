import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { generateMultiPageSite } from "@/lib/bespoke/site-generator";
import type { BespokeModuleManifest, MyProfileModuleBundle } from "@/lib/bespoke/types";
import type { SitePreferences } from "@/lib/bespoke/site-generator";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, posix, relative, resolve } from "node:path";
import { resolveBuilderOwner, isOwnerError } from "@/lib/builder/site-owner";
import {
  MAX_FILE_BYTES,
  MAX_WORKSPACE_BYTES,
  MAX_WORKSPACE_FILES,
  validateSitePath,
} from "@/lib/builder/assistant-tools";

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
// Request / Response types
// ---------------------------------------------------------------------------

interface DeployRequestBody {
  manifest: BespokeModuleManifest;
  bundle: MyProfileModuleBundle;
  preferences: SitePreferences;
  mode?: "local" | "ssh";
}

interface DeploySuccessResponse {
  success: true;
  deployedFiles: string[];
  deployPath: string;
  mode: string;
}

interface DeployErrorResponse {
  success: false;
  error: string;
}

type DeployResponse = DeploySuccessResponse | DeployErrorResponse;

function validateGeneratedFiles(files: Map<string, string>): void {
  if (files.size === 0 || files.size > MAX_WORKSPACE_FILES) {
    throw new Error(`Generated site must contain 1-${MAX_WORKSPACE_FILES} files`);
  }
  let totalBytes = 0;
  for (const [filePath, content] of files) {
    const pathError = validateSitePath(filePath);
    if (pathError) throw new Error(`${filePath}: ${pathError}`);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES) {
      throw new Error(`${filePath}: File exceeds ${MAX_FILE_BYTES} bytes`);
    }
    totalBytes += bytes;
  }
  if (totalBytes > MAX_WORKSPACE_BYTES) {
    throw new Error(`Generated site exceeds ${MAX_WORKSPACE_BYTES} bytes`);
  }
}

function validateSshConfig(host: string, user: string, deployDir: string): void {
  if (!SSH_HOST_RE.test(host)) throw new Error("Invalid SSH deployment host");
  if (!SSH_USER_RE.test(user)) throw new Error("Invalid SSH deployment user");
  if (!REMOTE_PATH_RE.test(deployDir) || deployDir.split("/").includes("..")) {
    throw new Error("Invalid SSH deployment directory");
  }
}

function runSsh(host: string, user: string, command: string[], input?: string): void {
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

async function deployLocal(files: Map<string, string>, deployDir: string): Promise<string[]> {
  const root = resolve(deployDir);
  await mkdir(root, { recursive: true });

  const deployedFiles: string[] = [];
  for (const [filePath, content] of files) {
    const fullPath = resolve(root, filePath);
    const rel = relative(root, fullPath);
    if (!rel || rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\")) {
      throw new Error(`Path escapes deployment root: ${filePath}`);
    }
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    deployedFiles.push(filePath);
  }

  return deployedFiles;
}

// ---------------------------------------------------------------------------
// SSH deploy (writes files via ssh + cat)
// ---------------------------------------------------------------------------

async function deploySSH(
  files: Map<string, string>,
  host: string,
  user: string,
  deployDir: string,
): Promise<string[]> {
  validateSshConfig(host, user, deployDir);
  runSsh(host, user, ["mkdir", "-p", "--", deployDir]);

  const deployedFiles: string[] = [];
  for (const [filePath, content] of files) {
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
// POST /api/bespoke/deploy
//
// Generates the full multi-page site and deploys it to the configured
// directory. Supports two modes:
//
// - "local": Writes files directly to the local filesystem (for when the
//   API server has direct access to the nginx volume).
// - "ssh": Writes files via SSH to a remote host.
//
// The mode is auto-detected based on whether BESPOKE_SITE_DEPLOY_HOST is set.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  try {
    const body = (await request.json()) as DeployRequestBody;

    if (!body.manifest || !body.bundle || !body.preferences) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: manifest, bundle, preferences" },
        { status: 400, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    // Merge saved overrides from agent metadata into preferences so the
    // deploy always includes persisted overrides even when the client
    // didn't send them explicitly.
    const [agentRow] = await db
      .select({ metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, owner.agentId))
      .limit(1);

    const agentMeta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
    const savedOverrides = (agentMeta.siteOverrides ?? {}) as Record<string, string>;
    const mergedPreferences: SitePreferences = {
      ...body.preferences,
      overrides: { ...savedOverrides, ...(body.preferences.overrides ?? {}) },
    };

    // Generate the site
    const site = generateMultiPageSite(body.manifest, body.bundle, mergedPreferences);
    validateGeneratedFiles(site.files);

    // Determine deploy mode
    const mode = body.mode || (DEPLOY_HOST ? "ssh" : "local");
    if (mode !== "local" && mode !== "ssh") {
      throw new Error("Invalid deployment mode");
    }
    if (mode === "ssh" && !DEPLOY_HOST) {
      throw new Error("SSH deployment is not configured");
    }
    let deployedFiles: string[];

    if (mode === "ssh") {
      deployedFiles = await deploySSH(site.files, DEPLOY_HOST, DEPLOY_USER, DEPLOY_DIR);
    } else {
      deployedFiles = await deployLocal(site.files, DEPLOY_DIR);
    }

    console.log(
      `[api/bespoke/deploy] Deployed ${deployedFiles.length} files to ${DEPLOY_DIR} (mode: ${mode})`,
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
    console.error("[api/bespoke/deploy] Deploy failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Deploy failed",
      },
      { status: 500, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
