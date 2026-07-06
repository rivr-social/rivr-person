/**
 * Builder app lifecycle — queue a typed lifecycle request for the host broker.
 *
 * POST /api/builder/apps/[appId]/lifecycle
 * Body: { action: "deploy"|"stop"|"start"|"rollback"|"archive"|"delete",
 *         confirmToken?: string }
 *
 * The request is written to the broker spool; the host worker validates and
 * executes it independently. Delete is two-phase: the app must already be
 * archived AND the caller must echo the appId as `confirmToken`.
 */

import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import {
  APP_LIFECYCLE_ACTIONS,
  AppLifecycleError,
  appWorkspaceDir,
  queueAppLifecycleRequest,
  readAppStatus,
  type AppLifecycleAction,
} from "@/lib/builder/app-lifecycle";
import { APP_ID_PATTERN } from "@/lib/builder/app-manifest";
import { isOwnerError, resolveBuilderOwner } from "@/lib/builder/site-owner";
import {
  STATUS_ACCEPTED,
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

export async function POST(
  request: Request,
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

  let body: { action?: unknown; confirmToken?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return response({ error: "Invalid JSON body" }, STATUS_BAD_REQUEST);
  }

  const action = body.action as AppLifecycleAction;
  if (!APP_LIFECYCLE_ACTIONS.includes(action)) {
    return response(
      { error: `action must be one of: ${APP_LIFECYCLE_ACTIONS.join(", ")}` },
      STATUS_BAD_REQUEST,
    );
  }

  if (action === "delete") {
    const status = await readAppStatus(appId).catch(() => null);
    if (status?.phase !== "archived") {
      return response(
        { error: "Delete is two-phase: archive the app first, then confirm delete" },
        STATUS_BAD_REQUEST,
      );
    }
  }

  try {
    const queued = await queueAppLifecycleRequest({
      appId,
      action,
      confirmToken: typeof body.confirmToken === "string" ? body.confirmToken : undefined,
    });
    return response({ success: true, queued: true, request: queued }, STATUS_ACCEPTED);
  } catch (error) {
    if (error instanceof AppLifecycleError) {
      return response({ error: error.message }, error.statusCode);
    }
    return response(
      { error: `Failed to queue lifecycle request: ${error instanceof Error ? error.message : "unknown"}` },
      STATUS_INTERNAL_ERROR,
    );
  }
}
