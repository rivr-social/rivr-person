import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { generateMultiPageSite } from "@/lib/bespoke/site-generator";
import type { BespokeModuleManifest, MyProfileModuleBundle } from "@/lib/bespoke/types";
import type { SitePreferences } from "@/lib/bespoke/site-generator";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const DEFAULT_DEPLOY_DIR = "/opt/camalot";
const DEPLOY_DIR = process.env.BESPOKE_SITE_DEPLOY_DIR || DEFAULT_DEPLOY_DIR;
const DEPLOY_HOST = process.env.BESPOKE_SITE_DEPLOY_HOST || "";
const DEPLOY_USER = process.env.BESPOKE_SITE_DEPLOY_USER || "root";

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

// ---------------------------------------------------------------------------
// Local filesystem deploy
// ---------------------------------------------------------------------------

async function deployLocal(files: Map<string, string>, deployDir: string): Promise<string[]> {
  await mkdir(deployDir, { recursive: true });

  const deployedFiles: string[] = [];
  for (const [filePath, content] of files) {
    const fullPath = join(deployDir, filePath);
    // Ensure subdirectories exist (in case we add nested paths later)
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir !== deployDir) {
      await mkdir(dir, { recursive: true });
    }
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
  const { execSync } = await import("node:child_process");

  // Ensure deploy directory exists
  execSync(`ssh ${user}@${host} "mkdir -p ${deployDir}"`, {
    timeout: 10_000,
    stdio: "pipe",
  });

  const deployedFiles: string[] = [];
  for (const [filePath, content] of files) {
    const remotePath = `${deployDir}/${filePath}`;
    const remoteDir = remotePath.substring(0, remotePath.lastIndexOf("/"));

    if (remoteDir !== deployDir) {
      execSync(`ssh ${user}@${host} "mkdir -p ${remoteDir}"`, {
        timeout: 10_000,
        stdio: "pipe",
      });
    }

    // Write content via stdin to avoid shell escaping issues
    execSync(`ssh ${user}@${host} "cat > ${remotePath}"`, {
      input: content,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

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

export async function POST(request: Request): Promise<NextResponse<DeployResponse>> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

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
      .where(eq(agents.id, session.user.id))
      .limit(1);

    const agentMeta = (agentRow?.metadata ?? {}) as Record<string, unknown>;
    const savedOverrides = (agentMeta.siteOverrides ?? {}) as Record<string, string>;
    const mergedPreferences: SitePreferences = {
      ...body.preferences,
      overrides: { ...savedOverrides, ...(body.preferences.overrides ?? {}) },
    };

    // Generate the site
    const site = generateMultiPageSite(body.manifest, body.bundle, mergedPreferences);

    // Determine deploy mode
    const mode = body.mode || (DEPLOY_HOST ? "ssh" : "local");
    let deployedFiles: string[];

    if (mode === "ssh" && DEPLOY_HOST) {
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
