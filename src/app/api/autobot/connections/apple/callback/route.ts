import { handleConnectorOAuthCallback } from "@/lib/autobot-oauth-route";

export const dynamic = "force-dynamic";

async function parseAppleCallbackRequest(
  request: Request,
): Promise<{ code?: string | null; state?: string | null; error?: string | null }> {
  if (request.method === "POST") {
    const formData = await request.formData();
    return {
      code: typeof formData.get("code") === "string" ? String(formData.get("code")) : null,
      state: typeof formData.get("state") === "string" ? String(formData.get("state")) : null,
      error: typeof formData.get("error") === "string" ? String(formData.get("error")) : null,
    };
  }

  const url = new URL(request.url);
  return {
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
  };
}

export async function GET(request: Request) {
  return handleConnectorOAuthCallback(
    "apple",
    request,
    await parseAppleCallbackRequest(request),
  );
}

export async function POST(request: Request) {
  return handleConnectorOAuthCallback(
    "apple",
    request,
    await parseAppleCallbackRequest(request),
  );
}
