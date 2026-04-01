import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { generateMultiPageSite, generateSiteHtml } from "@/lib/bespoke/site-generator";
import type { BespokeModuleManifest, MyProfileModuleBundle } from "@/lib/bespoke/types";
import type { SitePreferences } from "@/lib/bespoke/site-generator";
import type { SiteFiles } from "@/lib/bespoke/site-files";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GenerateRequestBody {
  manifest: BespokeModuleManifest;
  bundle: MyProfileModuleBundle;
  preferences: SitePreferences & { previewPage?: string };
}

interface GenerateSuccessResponse {
  success: true;
  html: string;
  files: SiteFiles;
}

interface GenerateErrorResponse {
  success: false;
  error: string;
}

type GenerateResponse = GenerateSuccessResponse | GenerateErrorResponse;

// ---------------------------------------------------------------------------
// POST /api/bespoke/generate
//
// Accepts manifest, bundle, and preferences, then returns generated HTML
// for a single page preview. Supports a `previewPage` field in preferences
// to select which page to render (defaults to "index.html").
//
// Requires authentication since it operates on the user's profile data.
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<NextResponse<GenerateResponse>> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const body = (await request.json()) as GenerateRequestBody;

    if (!body.manifest || !body.bundle || !body.preferences) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: manifest, bundle, preferences" },
        { status: 400, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const generated = generateMultiPageSite(body.manifest, body.bundle, body.preferences);
    const files = Object.fromEntries(generated.files.entries());
    const html = generateSiteHtml(body.manifest, body.bundle, body.preferences);

    return NextResponse.json(
      { success: true, html, files },
      { headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (error) {
    console.error("[api/bespoke/generate] Generation failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to generate site",
      },
      { status: 500, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
