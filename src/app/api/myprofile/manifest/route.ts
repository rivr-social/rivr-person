import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getMyProfileModuleManifest } from "@/lib/bespoke/modules/myprofile";

export const dynamic = "force-dynamic";

/**
 * GET /api/myprofile/manifest
 *
 * Authenticated manifest describing the current user's bespoke profile module
 * surface: sections, fields, components, and allowed mutations.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401, headers: noStoreHeaders() },
    );
  }

  return NextResponse.json(
    {
      success: true,
      actorId: session.user.id,
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
