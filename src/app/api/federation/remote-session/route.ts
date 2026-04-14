import { NextResponse } from "next/server";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { REMOTE_VIEWER_COOKIE_NAME, validateRemoteViewerToken } from "@/lib/federation-remote-session";

export async function GET(request: Request) {
  const cookieToken = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${REMOTE_VIEWER_COOKIE_NAME}=`))
    ?.slice(`${REMOTE_VIEWER_COOKIE_NAME}=`.length);

  if (!cookieToken) {
    return NextResponse.json({ success: false, error: "No remote session cookie" }, { status: 401 });
  }

  const config = getInstanceConfig();
  const session = validateRemoteViewerToken(cookieToken, config.instanceId);
  if (!session) {
    return NextResponse.json({ success: false, error: "Invalid remote session cookie" }, { status: 401 });
  }

  return NextResponse.json({
    success: true,
    viewerState: "remotely_authenticated",
    actorId: session.actorId,
    homeBaseUrl: session.homeBaseUrl,
    sessionToken: cookieToken,
  });
}
