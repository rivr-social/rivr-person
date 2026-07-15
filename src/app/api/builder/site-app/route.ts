/**
 * @fileoverview POST /api/builder/site-app — deploy the current builder SITE
 * as its OWN ENVIRONMENT: a static app on the broker lane (own container +
 * own hostname), instead of the in-instance serve path.
 *
 *   POST { appId, name?, files }  -> writes the app workspace + queues a
 *                                    broker deploy; poll /api/builder/apps
 *                                    for phase/URL.
 *
 * Owner-only, same gates as `/api/builder/apps` (agent-hq access + builder
 * owner). The host broker re-validates the manifest and owns the real URL.
 */
import { NextResponse } from "next/server";

import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import { resolveBuilderOwner, isOwnerError } from "@/lib/builder/site-owner";
import { deploySiteAsApp, SiteAppBridgeError } from "@/lib/builder/site-app-bridge";
import { AppLifecycleError } from "@/lib/builder/app-lifecycle";
import type { SiteFiles } from "@/lib/bespoke/site-files";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

interface SiteAppBody {
  appId?: string;
  name?: string;
  files?: SiteFiles;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    await assertAgentHqAccess();
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Access denied" },
      { status: STATUS_FORBIDDEN, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  let body: SiteAppBody;
  try {
    body = (await request.json()) as SiteAppBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const appId = typeof body.appId === "string" ? body.appId.trim().toLowerCase() : "";
  const name =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim().slice(0, 80)
      : appId;

  try {
    const result = await deploySiteAsApp(appId, name, body.files ?? {});
    return NextResponse.json(
      { success: true, ...result },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    if (error instanceof SiteAppBridgeError || error instanceof AppLifecycleError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.statusCode, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }
    const message = error instanceof Error ? error.message : "Site deploy failed.";
    console.error("[api/builder/site-app] failed:", error);
    return NextResponse.json(
      { error: message },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
