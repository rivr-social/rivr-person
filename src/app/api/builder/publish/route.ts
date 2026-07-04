/**
 * @fileoverview Builder publish API — snapshots + stores the current workspace
 * site so it can be served on a custom domain (host-dispatch).
 *
 *   POST /api/builder/publish  { files, commitMessage?, theme? }
 *                              -> publishes: version snapshot + MinIO write +
 *                                 site_publications row.
 *   GET  /api/builder/publish  -> current publication state + app hostname.
 *
 * Owner-only. `/api/builder/*` is already gated to the instance owner by the
 * edge middleware; this route additionally derives the owner agent id from the
 * session and asserts it against `PRIMARY_AGENT_ID` when configured.
 */
import { NextResponse } from "next/server";

import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";
import { resolveBuilderOwner, isOwnerError } from "@/lib/builder/site-owner";
import {
  getAppHostname,
  getSitePublication,
  publishSite,
  SiteServiceError,
} from "@/lib/builder/site-publications";
import type { SiteFiles } from "@/lib/bespoke/site-files";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

interface PublishBody {
  files?: SiteFiles;
  commitMessage?: string;
  theme?: string;
}

export async function GET(): Promise<NextResponse> {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  const publication = await getSitePublication(owner.agentId);
  return NextResponse.json(
    { publication, appHostname: getAppHostname() },
    { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return owner.error;

  let body: PublishBody;
  try {
    body = (await request.json()) as PublishBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  if (!body.files || typeof body.files !== "object" || Object.keys(body.files).length === 0) {
    return NextResponse.json(
      { error: "No files provided to publish." },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const result = await publishSite(owner.agentId, body.files, {
      commitMessage: body.commitMessage,
      theme: body.theme,
    });
    return NextResponse.json(
      { success: true, ...result },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    if (error instanceof SiteServiceError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }
    const message = error instanceof Error ? error.message : "Publish failed.";
    console.error("[api/builder/publish] POST failed:", error);
    return NextResponse.json(
      { error: message },
      { status: STATUS_INTERNAL_ERROR, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
