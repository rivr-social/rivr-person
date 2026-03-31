import { NextResponse } from "next/server";
import { getPublicProfileModuleManifest } from "@/lib/bespoke/modules/public-profile";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ username: string }> },
) {
  const { username } = await params;

  return NextResponse.json(
    {
      success: true,
      manifest: getPublicProfileModuleManifest(username),
    },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      },
    },
  );
}
