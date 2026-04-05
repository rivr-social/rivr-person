import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { getDeployCapability } from "@/lib/deploy/capability";
import {
  pushSiteToGitHub,
  getGitHubConnection,
  getDeployStatus,
  GitHubDeployError,
} from "@/lib/deploy/github-deploy";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_INTERNAL = 500;

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeployRequestBody {
  files: Record<string, string>;
  commitMessage?: string;
}

// ---------------------------------------------------------------------------
// POST — deploy site files
// ---------------------------------------------------------------------------

/**
 * Deploy generated site files.
 *
 * - Sovereign instances: writes files directly to the public directory
 *   or triggers a Docker rebuild (depending on config).
 * - Shared instances: pushes files to the user's connected GitHub repo.
 *   The user's CI/CD handles actual deployment to their custom URL.
 *
 * SECURITY: Shared instances NEVER get direct host access. This is the
 * core isolation boundary for the site builder.
 */
export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const capability = getDeployCapability();

  let body: DeployRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  if (!body.files || typeof body.files !== "object" || Object.keys(body.files).length === 0) {
    return NextResponse.json(
      { error: "No files provided for deployment" },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const commitMessage = body.commitMessage || `Site update from Rivr Builder — ${new Date().toISOString()}`;

  // -------------------------------------------------------------------------
  // Sovereign instance: direct deploy
  // -------------------------------------------------------------------------
  if (capability.isSovereign && capability.deployMethod === "direct") {
    try {
      const { writeFileSync, mkdirSync, existsSync } = await import("fs");
      const { join, dirname } = await import("path");

      const publicDir = join(process.cwd(), "public", "site");

      for (const [filePath, content] of Object.entries(body.files)) {
        // Sanitize path to prevent directory traversal
        const sanitized = filePath.replace(/\.\./g, "").replace(/^\//, "");
        const fullPath = join(publicDir, sanitized);
        const dir = dirname(fullPath);

        // Ensure the target is still under publicDir
        if (!fullPath.startsWith(publicDir)) {
          continue;
        }

        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(fullPath, content, "utf-8");
      }

      return NextResponse.json(
        {
          success: true,
          method: "direct",
          filesDeployed: Object.keys(body.files).length,
          deployPath: "/site/",
        },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Direct deploy failed";
      return NextResponse.json(
        { error: message, method: "direct" },
        { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Shared instance: GitHub deploy
  // -------------------------------------------------------------------------
  if (capability.deployMethod === "github") {
    const connection = await getGitHubConnection(session.user.id);

    if (!connection) {
      return NextResponse.json(
        {
          error: "No GitHub repository connected. Connect a repository in Settings to deploy your site.",
          needsGitHubConnection: true,
        },
        { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    try {
      const result = await pushSiteToGitHub({
        repoOwner: connection.repoOwner,
        repoName: connection.repoName,
        branch: connection.branch,
        files: body.files,
        commitMessage,
        token: connection.token,
        basePath: connection.basePath,
      });

      if (!result.success) {
        return NextResponse.json(
          { error: result.error, method: "github" },
          { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
        );
      }

      return NextResponse.json(
        {
          success: true,
          method: "github",
          commitSha: result.commitSha,
          commitUrl: result.commitUrl,
          filesUpdated: result.filesUpdated,
          repo: `${connection.repoOwner}/${connection.repoName}`,
          branch: connection.branch,
        },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    } catch (err) {
      const message = err instanceof GitHubDeployError
        ? err.message
        : err instanceof Error
          ? err.message
          : "GitHub deploy failed";
      return NextResponse.json(
        { error: message, method: "github" },
        { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }
  }

  // -------------------------------------------------------------------------
  // No deploy method available
  // -------------------------------------------------------------------------
  return NextResponse.json(
    {
      error: "Deployment is not available for this instance configuration.",
      deployMethod: capability.deployMethod,
      isolationTier: capability.isolationTier,
    },
    { status: STATUS_FORBIDDEN, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}

// ---------------------------------------------------------------------------
// GET — deploy status
// ---------------------------------------------------------------------------

/**
 * Returns the current deploy status and capability information.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const capability = getDeployCapability();

  // For GitHub deploy, include connection and status info
  if (capability.deployMethod === "github") {
    const connection = await getGitHubConnection(session.user.id);

    if (!connection) {
      return NextResponse.json(
        {
          deployMethod: "github",
          isolationTier: capability.isolationTier,
          connected: false,
          message: "No GitHub repository connected.",
        },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    try {
      const status = await getDeployStatus({
        repoOwner: connection.repoOwner,
        repoName: connection.repoName,
        branch: connection.branch,
        token: connection.token,
      });

      return NextResponse.json(
        {
          deployMethod: "github",
          isolationTier: capability.isolationTier,
          connected: true,
          repo: `${connection.repoOwner}/${connection.repoName}`,
          branch: connection.branch,
          basePath: connection.basePath,
          connectedAt: connection.connectedAt,
          status,
        },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch deploy status";
      return NextResponse.json(
        {
          deployMethod: "github",
          isolationTier: capability.isolationTier,
          connected: true,
          repo: `${connection.repoOwner}/${connection.repoName}`,
          branch: connection.branch,
          error: message,
        },
        { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }
  }

  // For direct deploy
  return NextResponse.json(
    {
      deployMethod: capability.deployMethod,
      isolationTier: capability.isolationTier,
      isSovereign: capability.isSovereign,
      canSelfDeploy: capability.canSelfDeploy,
    },
    { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}
