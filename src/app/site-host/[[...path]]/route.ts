/**
 * @fileoverview Host-dispatch serving for published builder sites.
 *
 * The edge middleware rewrites any request whose Host header is NOT the
 * instance's own app host to `/site-host/<original-path>` (carrying the original
 * host in `x-site-host`). This Node-runtime handler resolves that foreign host
 * to a bound {@link resolveBoundPublicationByHost publication} and streams the
 * requested file from MinIO, defaulting a directory request to `index.html` and
 * rendering a minimal 404 page when the host is unbound or the file is missing.
 *
 * This route MUST NOT be reachable on the app's own host with app privileges:
 * middleware only rewrites here for foreign hosts, and a direct app-host request
 * to `/site-host/...` (no `x-site-host`) is treated as an unknown host -> 404.
 */
import { NextResponse } from "next/server";

import { resolveBoundPublicationByHost, normalizeHost } from "@/lib/builder/site-publications";
import { getPublishedObject } from "@/lib/builder/site-publish-storage";

export const dynamic = "force-dynamic";

const STATUS_OK = 200;
const STATUS_NOT_FOUND = 404;

/**
 * Minimal, permissive-but-sane CSP for served static sites (not the app CSP).
 * Published sites are author-controlled static pages that routinely pull styles
 * and fonts from CDNs (Google Fonts, etc.), so `style-src`/`font-src`/`img-src`
 * allow `https:`. `script-src` stays locked to `'self' 'unsafe-inline'` (no
 * third-party https scripts) so a published site cannot pull in arbitrary
 * remote JS — the XSS boundary is kept tight while fonts/CSS work.
 */
const SITE_CSP =
  "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https:; " +
  "font-src 'self' data: https:; script-src 'self' 'unsafe-inline'; frame-ancestors 'self'; base-uri 'self'";

/** Renders the 404 fallback page for an unbound host or a missing file. */
function notFound(message: string): NextResponse {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Not found</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#0b0b0f;color:#f5f5f7;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{text-align:center;padding:2rem}h1{font-size:3rem;margin:0 0 .5rem}p{opacity:.7}</style>
</head><body><main><h1>404</h1><p>${message}</p></main></body></html>`;
  return new NextResponse(html, {
    status: STATUS_NOT_FOUND,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SITE_CSP,
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
): Promise<NextResponse> {
  // The foreign host set by middleware; fall back to the Host header.
  const host = normalizeHost(
    request.headers.get("x-site-host") || request.headers.get("host") || "",
  );
  if (!host) return notFound("No site is published for this address.");

  const target = await resolveBoundPublicationByHost(host);
  if (!target) return notFound("No site is published for this address.");

  const { path } = await context.params;
  const requestPath = Array.isArray(path) ? path.join("/") : "";

  let object;
  try {
    object = await getPublishedObject(target.bucket, target.prefix, requestPath);
  } catch {
    return notFound("This page could not be loaded.");
  }
  if (!object) return notFound("This page could not be found.");

  return new NextResponse(new Uint8Array(object.body), {
    status: STATUS_OK,
    headers: {
      "Content-Type": object.contentType,
      "Content-Security-Policy": SITE_CSP,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=60, must-revalidate",
    },
  });
}
