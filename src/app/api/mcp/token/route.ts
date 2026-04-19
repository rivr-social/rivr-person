import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { signPackedPayload } from "@/lib/federation-remote-session";

export const dynamic = "force-dynamic";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_SCOPES = [
  "mcp:tools",
  "profile:read",
  "profile:write",
  "post:create",
  "event:create",
  "offering:create",
  "group:write",
  "federation:write",
];

type ScopedMcpTokenPayload = {
  type: "rivr_mcp_token";
  actorId: string;
  controllerId: string;
  actorType: "human";
  issuer: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
  scopes: string[];
};

export async function GET(request: Request) {
  const session = await auth();
  const config = getInstanceConfig();
  if (!session?.user?.id) {
    const url = new URL(request.url);
    const callbackUrl = new URL(`${url.pathname}${url.search}`, config.baseUrl).toString();
    return NextResponse.redirect(
      new URL(`/auth/login?callbackUrl=${encodeURIComponent(callbackUrl)}`, config.baseUrl),
    );
  }

  const issued = issueToken(session.user.id);
  const html = renderTokenPage({
    token: issued.token,
    expiresAt: issued.payload.expiresAt,
    scopes: issued.payload.scopes,
    actorId: issued.payload.actorId,
    issuer: issued.payload.issuer,
  });

  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store, max-age=0",
    },
  });
}

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const issued = issueToken(session.user.id);
  return NextResponse.json(
    {
      success: true,
      token: issued.token,
      expiresAt: issued.payload.expiresAt,
      scopes: issued.payload.scopes,
      actorId: issued.payload.actorId,
      issuer: issued.payload.issuer,
    },
    {
      headers: {
        "cache-control": "private, no-store, max-age=0",
      },
    },
  );
}

function issueToken(actorId: string): { token: string; payload: ScopedMcpTokenPayload } {
  const config = getInstanceConfig();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const now = Date.now();
  const payload: ScopedMcpTokenPayload = {
    type: "rivr_mcp_token",
    actorId,
    controllerId: actorId,
    actorType: "human",
    issuer: baseUrl,
    audience: baseUrl,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
    scopes: DEFAULT_SCOPES,
  };

  return {
    token: signPackedPayload(payload as unknown as Record<string, unknown>),
    payload,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderTokenPage(params: {
  token: string;
  expiresAt: string;
  scopes: string[];
  actorId: string;
  issuer: string;
}): string {
  const token = escapeHtml(params.token);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect RIVR to Prism</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 48px auto; padding: 0 20px; color: #17221f; background: #f7f3ea; }
      .card { border: 1px solid rgba(23,34,31,.14); border-radius: 18px; padding: 24px; background: rgba(255,255,255,.72); box-shadow: 0 20px 80px rgba(23,34,31,.12); }
      textarea { width: 100%; min-height: 160px; box-sizing: border-box; border-radius: 12px; border: 1px solid rgba(23,34,31,.18); padding: 12px; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
      button { border: 0; border-radius: 999px; padding: 10px 16px; background: #22463a; color: white; font-weight: 650; cursor: pointer; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
      .muted { color: rgba(23,34,31,.66); }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Connect RIVR to Prism</h1>
      <p class="muted">Copy this scoped MCP token into Prism Settings → RIVR → Token. It expires at <code>${escapeHtml(params.expiresAt)}</code>.</p>
      <textarea id="token" readonly>${token}</textarea>
      <p><button onclick="navigator.clipboard.writeText(document.getElementById('token').value).then(()=>this.textContent='Copied')">Copy token</button></p>
      <p class="muted">Actor: <code>${escapeHtml(params.actorId)}</code><br />Issuer: <code>${escapeHtml(params.issuer)}</code></p>
      <p class="muted">Scopes: <code>${escapeHtml(params.scopes.join(", "))}</code></p>
    </main>
  </body>
</html>`;
}
