import { NextResponse } from "next/server";

import { assertAgentHqAccess } from "@/lib/agent-hq";
import { APP_ID_PATTERN } from "@/lib/builder/app-manifest";
import { isOwnerError, resolveBuilderOwner } from "@/lib/builder/site-owner";
import {
  readWorkspaceSiteFiles,
  resolveBuilderWorkspace,
  writeWorkspaceSiteFiles,
} from "@/lib/builder/workspace-site";
import {
  fetchFilesFromGitHub,
  getGitHubConnection,
  normalizeGitHubBasePath,
  pushSiteToGitHub,
} from "@/lib/deploy/github-deploy";
import {
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
  STATUS_NOT_FOUND,
  STATUS_OK,
} from "@/lib/http-status";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

function response(body: unknown, status = STATUS_OK) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
  });
}

function appRepoPath(basePath: string, appId: string): string {
  const prefix = normalizeGitHubBasePath(basePath);
  return prefix ? `${prefix}/${appId}` : appId;
}

async function requireApp(appId: string) {
  try {
    await assertAgentHqAccess();
  } catch (error) {
    return {
      error: response(
        { error: error instanceof Error ? error.message : "Access denied" },
        STATUS_FORBIDDEN,
      ),
    };
  }
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return { error: owner.error };
  if (!APP_ID_PATTERN.test(appId)) {
    return { error: response({ error: "Invalid app id" }, STATUS_BAD_REQUEST) };
  }
  // Broker-managed sibling apps deliberately have no host `deployRoot`; that
  // field is reserved for fixed workers. GitHub sync still targets them, but
  // only after positively checking the discovered workspace's app scope/name.
  const workspace = await resolveBuilderWorkspace(`app-${appId}`);
  if (!workspace || workspace.scope !== "app" || workspace.name !== appId) {
    return {
      error: response({ error: `App workspace "${appId}" not found` }, STATUS_NOT_FOUND),
    };
  }
  const connection = await getGitHubConnection(owner.agentId);
  if (!connection) {
    return {
      error: response(
        { error: "Connect a GitHub repository in Connectors first." },
        STATUS_BAD_REQUEST,
      ),
    };
  }
  return { owner, workspace, connection };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ appId: string }> },
) {
  const { appId } = await context.params;
  const resolved = await requireApp(appId);
  if ("error" in resolved) return resolved.error;

  let body: { action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return response({ error: "Invalid JSON body" }, STATUS_BAD_REQUEST);
  }
  if (body.action !== "push" && body.action !== "pull") {
    return response({ error: "action must be push or pull" }, STATUS_BAD_REQUEST);
  }

  const { workspace, connection } = resolved;
  try {
    const basePath = appRepoPath(connection.basePath, appId);
    if (body.action === "push") {
      const { files, truncated } = await readWorkspaceSiteFiles(workspace);
      if (truncated) {
        return response(
          { error: "The app is larger than the Builder GitHub safety limits." },
          STATUS_BAD_REQUEST,
        );
      }
      const result = await pushSiteToGitHub({
        repoOwner: connection.repoOwner,
        repoName: connection.repoName,
        branch: connection.branch,
        token: connection.token,
        basePath,
        files,
        commitMessage: `Update ${appId} from RIVR Builder`,
      });
      if (!result.success) {
        return response({ error: result.error ?? "GitHub push failed" }, STATUS_INTERNAL_ERROR);
      }
      return response({
        success: true,
        action: "push",
        appId,
        repo: `${connection.repoOwner}/${connection.repoName}`,
        branch: connection.branch,
        basePath,
        filesUpdated: result.filesUpdated,
        commitSha: result.commitSha,
        commitUrl: result.commitUrl,
      });
    }

    const pulled = await fetchFilesFromGitHub({
      repoOwner: connection.repoOwner,
      repoName: connection.repoName,
      branch: connection.branch,
      token: connection.token,
      basePath,
    });
    if (pulled.truncated) {
      return response(
        { error: "The repository app directory exceeds the Builder pull safety limits." },
        STATUS_BAD_REQUEST,
      );
    }
    if (Object.keys(pulled.files).length === 0) {
      return response(
        { error: `No editable files found at ${basePath} on GitHub.` },
        STATUS_NOT_FOUND,
      );
    }
    const written = await writeWorkspaceSiteFiles(workspace, pulled.files);
    return response({
      success: true,
      action: "pull",
      appId,
      repo: `${connection.repoOwner}/${connection.repoName}`,
      branch: connection.branch,
      basePath,
      filesUpdated: written.filesWritten,
    });
  } catch (error) {
    return response(
      { error: error instanceof Error ? error.message : `GitHub ${body.action} failed` },
      STATUS_INTERNAL_ERROR,
    );
  }
}
