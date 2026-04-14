import { handleConnectorOAuthCallback } from "@/lib/autobot-oauth-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  return handleConnectorOAuthCallback("slack", request, {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
  });
}
