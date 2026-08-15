/**
 * Builder app registry — list registered apps and create new ones.
 *
 * GET  /api/builder/apps          → every app workspace + manifest + broker status
 * POST /api/builder/apps          → scaffold a new app workspace from a template
 *
 * Owner-only, sovereign-only. The session gets typed manifests and statuses;
 * it never receives or supplies Docker/Compose/host-path material.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { assertAgentHqAccess, getAgentAppWorkspaceRoot } from "@/lib/agent-hq";
import {
  hasPendingRequest,
  readAppManifest,
  readAppStatus,
} from "@/lib/builder/app-lifecycle";
import {
  APP_ID_DENYLIST,
  APP_ID_PATTERN,
  APP_NAME_MAX_LENGTH,
  APP_RUNTIMES,
  appSubdomain,
  type AppRuntime,
} from "@/lib/builder/app-manifest";
import { appTemplateFiles } from "@/lib/builder/app-templates";
import { isOwnerError, resolveBuilderOwner } from "@/lib/builder/site-owner";
import { listOwnerDnsProviders } from "@/lib/builder/site-publications";
import { getGitHubConnection } from "@/lib/deploy/github-deploy";
import {
  STATUS_BAD_REQUEST,
  STATUS_CONFLICT,
  STATUS_CREATED,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
  STATUS_OK,
} from "@/lib/http-status";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

/** Apps base domain for advisory URLs; the broker owns the real URL. */
function appsBaseDomain(): string | null {
  return process.env.BUILDER_APPS_BASE_DOMAIN ?? process.env.DOMAIN ?? null;
}

function response(body: unknown, status = STATUS_OK) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
  });
}

async function requireOwnerAccess(): Promise<{ agentId: string } | { error: NextResponse }> {
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
  return { agentId: owner.agentId };
}

export async function GET() {
  const owner = await requireOwnerAccess();
  if ("error" in owner) return owner.error;

  const root = getAgentAppWorkspaceRoot();
  const dnsProviders = await listOwnerDnsProviders(owner.agentId);
  const githubConnection = await getGitHubConnection(owner.agentId);
  const github = githubConnection
    ? {
        connected: true,
        repo: `${githubConnection.repoOwner}/${githubConnection.repoName}`,
        branch: githubConnection.branch,
        basePath: githubConnection.basePath,
      }
    : { connected: false };
  if (!existsSync(root)) return response({ success: true, apps: [], dnsProviders, github });

  try {
    const entries = await readdir(root, { withFileTypes: true });
    const apps = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const appId = entry.name;
      if (!APP_ID_PATTERN.test(appId)) continue;

      const manifest = await readAppManifest(appId).catch(() => null);
      const status = await readAppStatus(appId).catch(() => null);
      const pending = await hasPendingRequest(appId).catch(() => false);
      const baseDomain = appsBaseDomain();
      apps.push({
        appId,
        managed: manifest?.ok === true,
        manifest: manifest?.ok ? manifest.manifest : null,
        manifestErrors: manifest && !manifest.ok ? manifest.errors : null,
        status,
        pendingRequest: pending,
        expectedUrl:
          manifest?.ok && baseDomain
            ? `https://${appSubdomain(appId, baseDomain)}/`
            : null,
      });
    }
    apps.sort((a, b) => a.appId.localeCompare(b.appId));
    return response({ success: true, apps, dnsProviders, github });
  } catch (error) {
    return response(
      { error: `Failed to list apps: ${error instanceof Error ? error.message : "unknown"}` },
      STATUS_INTERNAL_ERROR,
    );
  }
}

export async function POST(request: Request) {
  const owner = await requireOwnerAccess();
  if ("error" in owner) return owner.error;

  let body: { appId?: unknown; name?: unknown; runtime?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return response({ error: "Invalid JSON body" }, STATUS_BAD_REQUEST);
  }

  const appId = typeof body.appId === "string" ? body.appId : "";
  const name =
    typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, APP_NAME_MAX_LENGTH)
      : appId;
  const runtime = body.runtime as AppRuntime;

  if (!APP_ID_PATTERN.test(appId)) {
    return response(
      { error: "appId must be 2-32 lowercase letters, digits, and hyphens" },
      STATUS_BAD_REQUEST,
    );
  }
  if (APP_ID_DENYLIST.has(appId) || appId.startsWith("mautrix")) {
    return response({ error: `appId "${appId}" is reserved` }, STATUS_BAD_REQUEST);
  }
  if (!APP_RUNTIMES.includes(runtime)) {
    return response(
      { error: `runtime must be one of: ${APP_RUNTIMES.join(", ")}` },
      STATUS_BAD_REQUEST,
    );
  }

  const workspaceDir = path.join(getAgentAppWorkspaceRoot(), appId);
  if (existsSync(workspaceDir)) {
    return response({ error: `App workspace "${appId}" already exists` }, STATUS_CONFLICT);
  }

  try {
    await mkdir(workspaceDir, { recursive: true, mode: 0o755 });
    for (const file of appTemplateFiles(runtime, appId, name)) {
      const target = path.join(workspaceDir, file.path);
      if (!target.startsWith(workspaceDir + path.sep)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, { encoding: "utf8", mode: 0o644 });
    }
  } catch (error) {
    return response(
      { error: `Failed to scaffold app: ${error instanceof Error ? error.message : "unknown"}` },
      STATUS_INTERNAL_ERROR,
    );
  }

  return response({ success: true, appId, runtime, name }, STATUS_CREATED);
}
