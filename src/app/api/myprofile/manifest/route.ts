import { NextResponse } from "next/server";
import { getMyProfileModuleManifest } from "@/lib/bespoke/modules/myprofile";
import { resolveActiveActorAgentId } from "@/lib/persona";

export const dynamic = "force-dynamic";

/**
 * GET /api/myprofile/manifest
 *
 * Authenticated manifest describing the current user's bespoke profile module
 * surface: sections, fields, components, and allowed mutations.
 *
 * Persona-aware: the returned `actorId` reflects the active acting agent
 * (persona id when `X-Persona-Id` is asserted by the controller or when an
 * active-persona cookie is set). The manifest shape itself is identical for
 * all actors — only the bound actor id changes.
 */
export async function GET(request: Request) {
  const activeActor = await resolveActiveActorAgentId(request);
  if (!activeActor) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401, headers: noStoreHeaders() },
    );
  }

  return NextResponse.json(
    {
      success: true,
      actorId: activeActor.actorId,
      controllerId: activeActor.controllerId,
      isPersona: activeActor.isPersona,
      manifest: getMyProfileModuleManifest(),
    },
    { headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return {
    "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  };
}
