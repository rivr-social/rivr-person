import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { getDeployCapability } from "@/lib/deploy/capability";
import {
  connectGitHubRepo,
  disconnectGitHubRepo,
  getGitHubConnection,
  testGitHubConnection,
} from "@/lib/deploy/github-deploy";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_FORBIDDEN = 403;
const STATUS_INTERNAL = 500;

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

// ---------------------------------------------------------------------------
// GET — retrieve current GitHub connection
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

  // Sovereign instances don't need GitHub connections — they deploy directly
  if (capability.isSovereign) {
    return NextResponse.json(
      {
        connected: false,
        deployMethod: "direct",
        message: "This sovereign instance deploys directly. GitHub connection is not needed.",
      },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const connection = await getGitHubConnection(session.user.id);

  if (!connection) {
    return NextResponse.json(
      { connected: false, deployMethod: "github" },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  // Test the connection is still valid
  const testResult = await testGitHubConnection(connection);

  return NextResponse.json(
    {
      connected: true,
      deployMethod: "github",
      repo: `${connection.repoOwner}/${connection.repoName}`,
      branch: connection.branch,
      basePath: connection.basePath,
      connectedAt: connection.connectedAt,
      valid: testResult.valid,
      validationError: testResult.error,
    },
    { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
  );
}

// ---------------------------------------------------------------------------
// POST — connect a GitHub repository
// ---------------------------------------------------------------------------

interface ConnectRequestBody {
  repoUrl: string;
  branch?: string;
  token: string;
  basePath?: string;
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const capability = getDeployCapability();
  if (capability.isSovereign) {
    return NextResponse.json(
      {
        error: "Sovereign instances deploy directly and do not need GitHub connections.",
        deployMethod: "direct",
      },
      { status: STATUS_FORBIDDEN, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  let body: ConnectRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  if (!body.repoUrl || typeof body.repoUrl !== "string") {
    return NextResponse.json(
      { error: "repoUrl is required" },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  if (!body.token || typeof body.token !== "string") {
    return NextResponse.json(
      { error: "GitHub personal access token is required" },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const connection = await connectGitHubRepo({
      userId: session.user.id,
      repoUrl: body.repoUrl,
      branch: body.branch || "main",
      token: body.token,
      basePath: body.basePath,
    });

    return NextResponse.json(
      {
        success: true,
        connected: true,
        repo: `${connection.repoOwner}/${connection.repoName}`,
        branch: connection.branch,
        basePath: connection.basePath,
        connectedAt: connection.connectedAt,
      },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to connect GitHub repository";
    return NextResponse.json(
      { error: message },
      { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

// ---------------------------------------------------------------------------
// DELETE — disconnect GitHub repository
// ---------------------------------------------------------------------------

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    await disconnectGitHubRepo(session.user.id);
    return NextResponse.json(
      { success: true, connected: false },
      { status: STATUS_OK, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to disconnect";
    return NextResponse.json(
      { error: message },
      { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
