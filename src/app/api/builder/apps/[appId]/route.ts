/**
 * Builder app detail — manifest, broker status, and pending-request state
 * for a single registered app.
 *
 * GET /api/builder/apps/[appId]
 */

import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import {
  appWorkspaceDir,
  hasPendingRequest,
  readAppManifest,
  readAppStatus,
} from "@/lib/builder/app-lifecycle";
import { APP_ID_PATTERN, appSubdomain } from "@/lib/builder/app-manifest";
import { isOwnerError, resolveBuilderOwner } from "@/lib/builder/site-owner";
import {
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
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

export async function GET(
  _request: Request,
  context: { params: Promise<{ appId: string }> },
) {
  try {
    await assertAgentHqAccess();
  } catch (error) {
    return response(
      { error: error instanceof Error ? error.message : "Access denied" },
      STATUS_FORBIDDEN,
    );
  }
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  const { appId } = await context.params;
  if (!APP_ID_PATTERN.test(appId)) {
    return response({ error: "Invalid app id" }, STATUS_BAD_REQUEST);
  }
  if (!existsSync(appWorkspaceDir(appId))) {
    return response({ error: `App workspace "${appId}" not found` }, STATUS_NOT_FOUND);
  }

  const manifest = await readAppManifest(appId);
  const status = await readAppStatus(appId).catch(() => null);
  const pending = await hasPendingRequest(appId).catch(() => false);
  const baseDomain = process.env.BUILDER_APPS_BASE_DOMAIN ?? process.env.DOMAIN ?? null;

  return response({
    success: true,
    appId,
    managed: manifest.ok,
    manifest: manifest.ok ? manifest.manifest : null,
    manifestErrors: manifest.ok ? null : manifest.errors,
    status,
    pendingRequest: pending,
    expectedUrl:
      manifest.ok && baseDomain ? `https://${appSubdomain(appId, baseDomain)}/` : null,
  });
}
