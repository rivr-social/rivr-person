import { auth } from "@/auth";
import { NextResponse } from "next/server";
import {
  getGitHubConnection,
  fetchFilesFromGitHub,
} from "@/lib/deploy/github-deploy";
import { getDeployCapability } from "@/lib/deploy/capability";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_OK = 200;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL = 500;

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

// ---------------------------------------------------------------------------
// GET — fetch current files from the connected GitHub repo
// ---------------------------------------------------------------------------

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const capability = getDeployCapability();

  // Sovereign instances deploy directly — no GitHub repo to pull from
  if (capability.isSovereign) {
    return NextResponse.json(
      { files: null, fileCount: 0, source: "sovereign" },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const connection = await getGitHubConnection(session.user.id);
  if (!connection) {
    return NextResponse.json(
      { files: null, fileCount: 0, source: "no-connection" },
      { status: STATUS_NOT_FOUND, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const { files, truncated } = await fetchFilesFromGitHub({
      repoOwner: connection.repoOwner,
      repoName: connection.repoName,
      branch: connection.branch,
      token: connection.token,
      basePath: connection.basePath,
    });

    const fileCount = Object.keys(files).length;

    return NextResponse.json(
      {
        files: fileCount > 0 ? files : null,
        fileCount,
        truncated,
        source: "github",
        repo: `${connection.repoOwner}/${connection.repoName}`,
        branch: connection.branch,
        basePath: connection.basePath || null,
      },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch files from GitHub";
    return NextResponse.json(
      { error: message, files: null, fileCount: 0, source: "github-error" },
      { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
