import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateMultiPageSite } from "@/lib/bespoke/site-generator";
import type { BespokeModuleManifest, MyProfileModuleBundle } from "@/lib/bespoke/types";
import type { SitePreferences } from "@/lib/bespoke/site-generator";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

interface GenerateSiteRequestBody {
  manifest: BespokeModuleManifest;
  bundle: MyProfileModuleBundle;
  preferences: SitePreferences;
}

interface GenerateSiteSuccessResponse {
  success: true;
  files: Record<string, string>;
  pages: string[];
}

interface GenerateSiteErrorResponse {
  success: false;
  error: string;
}

type GenerateSiteResponse = GenerateSiteSuccessResponse | GenerateSiteErrorResponse;

// ---------------------------------------------------------------------------
// POST /api/bespoke/generate-site
//
// Generates a full multi-page static site from profile bundle data.
// Returns the complete file map as JSON so consumers can deploy it.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse<GenerateSiteResponse>> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const body = (await request.json()) as GenerateSiteRequestBody;

    if (!body.manifest || !body.bundle || !body.preferences) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: manifest, bundle, preferences" },
        { status: 400, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const site = generateMultiPageSite(body.manifest, body.bundle, body.preferences);

    // Convert Map to a plain object for JSON serialization
    const filesObject: Record<string, string> = {};
    for (const [path, content] of site.files) {
      filesObject[path] = content;
    }

    return NextResponse.json(
      { success: true, files: filesObject, pages: site.pages },
      { headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/bespoke/generate-site] Generation failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate site",
      },
      { status: 500, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
