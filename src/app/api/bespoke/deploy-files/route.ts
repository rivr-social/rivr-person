import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SiteFiles } from "@/lib/bespoke/site-files";

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

// ---------------------------------------------------------------------------
// Local filesystem deploy
// ---------------------------------------------------------------------------

async function deployLocal(files: SiteFiles, deployDir: string): Promise<string[]> {
  await mkdir(deployDir, { recursive: true });

  const deployedFiles: string[] = [];
  for (const [filePath, content] of Object.entries(files)) {
    // Sanitize path to prevent directory traversal
    const safePath = filePath.replace(/\.\./g, "").replace(/^\//, "");
    const fullPath = join(deployDir, safePath);

    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir !== deployDir) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(fullPath, content, "utf-8");
    deployedFiles.push(safePath);
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
  const { execSync } = await import("node:child_process");

  execSync(`ssh ${user}@${host} "mkdir -p ${deployDir}"`, {
    timeout: 10_000,
    stdio: "pipe",
  });

  const deployedFiles: string[] = [];
  for (const [filePath, content] of Object.entries(files)) {
    const safePath = filePath.replace(/\.\./g, "").replace(/^\//, "");
    const remotePath = `${deployDir}/${safePath}`;
    const remoteDir = remotePath.substring(0, remotePath.lastIndexOf("/"));

    if (remoteDir !== deployDir) {
      execSync(`ssh ${user}@${host} "mkdir -p ${remoteDir}"`, {
        timeout: 10_000,
        stdio: "pipe",
      });
    }

    execSync(`ssh ${user}@${host} "cat > ${remotePath}"`, {
      input: content,
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    deployedFiles.push(safePath);
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

export async function POST(request: Request): Promise<NextResponse<DeployFilesResponse>> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const body = (await request.json()) as DeployFilesRequestBody;

    if (!body.files || typeof body.files !== "object" || Object.keys(body.files).length === 0) {
      return NextResponse.json(
        { success: false, error: "Missing or empty files object" },
        { status: 400, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const mode = body.mode || (DEPLOY_HOST ? "ssh" : "local");
    let deployedFiles: string[];

    if (mode === "ssh" && DEPLOY_HOST) {
      deployedFiles = await deploySSH(body.files, DEPLOY_HOST, DEPLOY_USER, DEPLOY_DIR);
    } else {
      deployedFiles = await deployLocal(body.files, DEPLOY_DIR);
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
