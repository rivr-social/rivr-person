/**
 * @fileoverview Owner-gate shared by the builder publish/domain routes.
 *
 * `/api/builder/*` is already restricted to the instance owner by the edge
 * middleware; this resolves the owner agent id from the `auth()` session and
 * additionally asserts it against `PRIMARY_AGENT_ID` when configured, so the
 * owner check is enforced defense-in-depth at the handler too. Identity is
 * ALWAYS derived server-side — never accepted from the client.
 */
import { NextResponse } from "next/server";

import { resolveSovereignOwner } from "@/lib/auth/sovereign-owner";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

/** Resolved builder owner, or a ready-to-return error response. */
export type BuilderOwner = { agentId: string } | { error: NextResponse };

/** Returns true when the resolution failed (narrows to the error branch). */
export function isOwnerError(owner: BuilderOwner): owner is { error: NextResponse } {
  return "error" in owner;
}

/** Resolves the authenticated builder owner agent id, or an error response. */
export async function resolveBuilderOwner(): Promise<BuilderOwner> {
  const result = await resolveSovereignOwner();
  if (!result.ok) {
    return {
      error: NextResponse.json(
        { error: result.error },
        { status: result.status, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      ),
    };
  }
  return { agentId: result.owner.agentId };
}
