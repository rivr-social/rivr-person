/**
 * @module middleware
 *
 * Next.js edge middleware for authentication gating and security headers.
 *
 * Responsibilities:
 * 1. **Route protection** -- unauthenticated requests to non-public routes are
 *    redirected to `/auth/login` (pages) or receive a 401 JSON response (API).
 * 2. **Content Security Policy** -- a per-request nonce is generated and injected
 *    into a strict CSP header to mitigate XSS attacks.
 * 3. **Security hardening** -- HSTS, X-Content-Type-Options, X-Frame-Options,
 *    and Referrer-Policy headers are applied to every response.
 * 4. **POST filtering** -- non-Server-Action, non-form POST requests to page
 *    routes are short-circuited with 204 to prevent CSRF-style abuse.
 *
 * The `config.matcher` excludes static assets and metadata files so the
 * middleware only runs on navigational and API requests.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { isPublicRoute } from "@/lib/route-access";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { REMOTE_VIEWER_COOKIE_NAME } from "@/lib/federation-remote-session-types";
import {
  decodeRemoteViewerSessionEdge,
  resolveFederationSecretEdge,
} from "@/lib/federation-remote-session-edge";

/**
 * Route prefixes that only the instance OWNER may reach. A federated visitor
 * (non-owner) holding a valid `rivr_remote_viewer` cookie is authenticated for
 * browsing but must be bounced off these sovereign control-plane surfaces:
 * settings, autobot/agent-HQ control plane, persona/instance/recovery
 * management, builder/bespoke authoring, and their backing APIs. The OWNER and
 * any local NextAuth session pass through unaffected.
 */
const OWNER_ONLY_PREFIXES = [
  "/settings",
  "/autobot",
  "/agent-hq",
  "/recovery",
  "/builder",
  "/bespoke",
  "/session-record",
  "/sovereign-merge-confirm",
  "/api/admin",
  "/api/autobot",
  "/api/agent-hq",
  "/api/personas",
  "/api/instance",
  "/api/recovery",
  "/api/builder",
  "/api/bespoke",
];

/** Whether a path targets an owner-only control-plane surface. */
function isOwnerOnlyPath(pathname: string): boolean {
  return OWNER_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Builds a Content-Security-Policy header string with a per-request nonce.
 *
 * `'unsafe-eval'` and `'wasm-unsafe-eval'` are always included in `script-src`
 * because CesiumJS requires eval for dynamic module loading and WebAssembly
 * compilation for geospatial computations.
 *
 * @param nonce - A Base64-encoded UUID unique to this request.
 * @returns The complete CSP header value.
 */
function buildCspHeader(nonce: string): string {
  const isDev = process.env.NODE_ENV === "development";
  const matrixUrl = process.env.NEXT_PUBLIC_MATRIX_HOMESERVER_URL;
  const matrixWss = matrixUrl?.replace(/^https:\/\//, "wss://");
  const publicDomain = process.env.NEXT_PUBLIC_DOMAIN?.trim();
  const minioPublicUrl = process.env.ASSET_PUBLIC_BASE_URL?.trim() || process.env.NEXT_PUBLIC_MINIO_URL?.trim();
  // Federated content (avatars, group images) references the global hub's
  // asset store. Derive the hub's S3 origin from REGISTRY_URL (or the
  // GLOBAL_BASE_URL / NEXT_PUBLIC_GLOBAL_URL fallbacks credential-sync also
  // honors): https://app.<domain> -> https://s3.<domain>. Instances configured
  // purely through the DB (no hub env vars at all — live case: camalot) fall
  // back to the RIVR hub's store, else every federated avatar/photo is
  // CSP-blocked and profiles render broken.
  const hubUrl =
    process.env.REGISTRY_URL?.trim() ||
    process.env.GLOBAL_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_GLOBAL_URL?.trim();
  let federatedAssetSource = "https://s3.rivr.social";
  if (hubUrl) {
    try {
      const hubHost = new URL(hubUrl).hostname;
      federatedAssetSource = `https://s3.${hubHost.replace(/^app\./, "")}`;
    } catch {
      // keep the default hub store
    }
  }

  const imageSources = [
    "'self'",
    "data:",
    "blob:",
    "http://localhost:9000",
    ...(minioPublicUrl ? [minioPublicUrl] : []),
    ...(publicDomain ? [`https://s3.${publicDomain}`] : []),
    federatedAssetSource,
    "http://*.virtualearth.net",
    "http://dev.virtualearth.net",
    "https://*.virtualearth.net",
    "https://dev.virtualearth.net",
    "https://tile.openstreetmap.org",
    "https://*.tile.openstreetmap.org",
    "https://tiles.hydrosheds.org",
    "https://api.mapbox.com",
    "https://*.mapbox.com",
    "https://*.arcgisonline.com",
    "https://*.arcgis.com",
    "https://api.cesium.com",
    "https://assets.cesium.com",
    "https://*.cesium.com",
    "https://*.stripe.com",
    // Platform embed CDNs (Twitter/X, YouTube, Vimeo, Spotify, SoundCloud).
    "https://pbs.twimg.com",
    "https://abs.twimg.com",
    "https://syndication.twitter.com",
    "https://i.ytimg.com",
    "https://*.ytimg.com",
    "https://i.vimeocdn.com",
    "https://*.vimeocdn.com",
    "https://i.scdn.co",
    "https://mosaic.scdn.co",
    "https://*.scdn.co",
    "https://i1.sndcdn.com",
    "https://*.sndcdn.com",
    // Facebook post-plugin iframe image CDNs.
    "https://*.fbcdn.net",
    "https://scontent.xx.fbcdn.net",
    "https://static.xx.fbcdn.net",
  ];

  // Resolve the app's own origin so HMR WebSockets and fetch work behind Traefik
  const appUrl = process.env.NEXTAUTH_URL?.trim();
  const appWss = appUrl?.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");

  // Canonical global/federation instance — the locale switcher, registry
  // lookups, and /api/locales calls all hit the global app cross-origin.
  // Resolved from NEXT_PUBLIC_GLOBAL_IDENTITY_AUTHORITY_URL at runtime so
  // self-hosted deployments can point at a different global.
  const globalBaseUrl =
    process.env.NEXT_PUBLIC_GLOBAL_IDENTITY_AUTHORITY_URL?.trim() ||
    process.env.GLOBAL_IDENTITY_AUTHORITY_URL?.trim() ||
    "https://a.rivr.social";

  const connectSources = [
    "'self'",
    "ws://localhost:*",
    "wss://localhost:*",
    "http://localhost:*",
    "https://localhost:*",
    "http://127.0.0.1:*",
    "https://127.0.0.1:*",
    ...(appUrl ? [appUrl] : []),
    ...(appWss ? [appWss] : []),
    globalBaseUrl,
    "https://*.rivr.social",
    // Allow GLB/GLTF fetches by the self-hosted three.js avatar viewer from
    // this instance's MinIO bucket (e.g. https://s3.camalot.me) — same-origin
    // patterns above only cover *.rivr.social, so sovereign instances need
    // this explicit entry.
    ...(publicDomain ? [`https://s3.${publicDomain}`] : []),
    "https://api.stripe.com",
    "https://api.mapbox.com",
    "https://*.mapbox.com",
    "https://*.arcgisonline.com",
    "https://*.arcgis.com",
    "https://api.cesium.com",
    "https://assets.cesium.com",
    "https://*.cesium.com",
    "http://*.virtualearth.net",
    "http://dev.virtualearth.net",
    "https://*.virtualearth.net",
    "https://dev.virtualearth.net",
    "https://ibasemaps-api.arcgis.com",
    "https://tile.openstreetmap.org",
    "https://*.tile.openstreetmap.org",
    "https://tiles.hydrosheds.org",
    "https://photon.komoot.io",
    "https://nominatim.openstreetmap.org",
    ...(matrixUrl ? [matrixUrl] : []),
    ...(matrixWss ? [matrixWss] : []),
    // Twitter/X widgets.js fetches tweet card data from these origins;
    // without them the rich oembed-style card can't render.
    "https://cdn.syndication.twimg.com",
    "https://syndication.twitter.com",
    "https://platform.twitter.com",
  ];

  // In dev mode, use 'unsafe-inline' for scripts to avoid CSP noise from
  // next-themes, HMR, and other dev-time inline scripts that lack nonces.
  // In production, enforce nonce-based CSP for proper XSS protection.
  // The sha256 hashes whitelist the two static inline scripts: next-themes'
  // FOUC-prevention script and the crystalline-bg pre-paint boot script
  // (recompute if either script's exact text changes).
  const platformEmbedScripts =
    "https://platform.twitter.com https://cdn.syndication.twimg.com";

  const scriptSrc = isDev
    ? `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://js.stripe.com ${platformEmbedScripts}`
    : `script-src 'self' 'nonce-${nonce}' 'sha256-n46vPwSWuMC0W703pBofImv82Z26xo4LXymv0E9caPk=' 'sha256-4lN0Nms+eLyEuxG3yC9cHcVuEbIxGjeYo4BkqFxl1oE=' 'unsafe-eval' 'wasm-unsafe-eval' https://js.stripe.com ${platformEmbedScripts}`;

  const frameSrc = [
    "frame-src 'self'",
    "https://js.stripe.com",
    "https://hooks.stripe.com",
    "https://www.youtube.com",
    "https://www.youtube-nocookie.com",
    "https://player.vimeo.com",
    "https://open.spotify.com",
    "https://w.soundcloud.com",
    "https://platform.twitter.com",
    "https://syndication.twitter.com",
    "https://www.facebook.com",
    "https://web.facebook.com",
  ].join(" ");

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "worker-src 'self' blob:",
    `img-src ${Array.from(new Set(imageSources)).join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    frameSrc,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Applies security-related HTTP headers to a response.
 *
 * Sets CSP, HSTS (2-year max-age with preload), nosniff, DENY framing,
 * and strict referrer policy. The nonce is also exposed via `x-nonce`
 * so that server components can read it and inject it into inline scripts.
 *
 * @param response - The NextResponse to augment.
 * @param cspHeader - Pre-built CSP header string.
 * @param nonce - The per-request nonce.
 * @returns The same response object with headers set (mutated in place).
 */
function applySecurityHeaders(response: NextResponse, cspHeader: string, nonce: string): NextResponse {
  response.headers.set("Content-Security-Policy", cspHeader);
  response.headers.set("x-nonce", nonce);
  response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return response;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Next.js edge middleware entry point.
 *
 * Execution flow:
 * 1. Generate a per-request CSP nonce.
 * 2. Filter suspicious non-Server-Action POST requests to page routes.
 * 3. Allow public routes through with security headers.
 * 4. For protected routes, verify the JWT; redirect or 401 if absent.
 * 5. Forward the nonce via the `x-nonce` request header so downstream
 *    server components can access it.
 *
 * @param request - The incoming Next.js request.
 * @returns A NextResponse with security headers applied.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const nonce = btoa(crypto.randomUUID());
  const cspHeader = buildCspHeader(nonce);
  const method = request.method.toUpperCase();
  // Filter non-API POST requests that are neither Server Actions nor form
  // submissions. This prevents bare POST requests from being processed as
  // page navigations, which could be used for CSRF-style attacks.
  const isPagePost = method === "POST" && !pathname.startsWith("/api/");
  if (isPagePost) {
    const nextAction = request.headers.get("next-action");
    const contentType = request.headers.get("content-type") ?? "";
    const isFormPost =
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data");
    const allowPath = pathname.startsWith("/auth/");
    if (!nextAction && !isFormPost && !allowPath) {
      const response = new NextResponse(null, { status: 204 });
      return applySecurityHeaders(response, cspHeader, nonce);
    }
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const forcePublicPrefixes = [
    "/api/mcp",
    "/api/profile/",
    "/.well-known/mcp",
  ];

  if (forcePublicPrefixes.some((prefix) => pathname.startsWith(prefix))) {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    return applySecurityHeaders(response, cspHeader, nonce);
  }

  if (isPublicRoute(pathname)) {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    return applySecurityHeaders(response, cspHeader, nonce);
  }

  // Behind a TLS-terminating reverse proxy (Traefik), the internal request
  // arrives over HTTP even though the browser connected via HTTPS. Detect the
  // original protocol so getToken looks for the correct cookie name
  // (__Secure-authjs.session-token vs authjs.session-token).
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const isSecure =
    forwardedProto === "https" || request.nextUrl.protocol === "https:";

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET,
    secureCookie: isSecure,
  });

  // A local NextAuth session is always the sovereign owner — pass through with
  // full access to every surface, including the owner-only control plane.
  if (token) {
    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    return applySecurityHeaders(response, cspHeader, nonce);
  }

  // No NextAuth session: accept a verified cross-instance `rivr_remote_viewer`
  // cookie as an authenticated browsing session. The cookie is HMAC-verified,
  // instance-bound, and expiry-checked in the edge runtime (node:crypto is
  // unavailable here). This is what lets an auto-signed-in federated visitor
  // browse without being bounced to /auth/login.
  const secret = resolveFederationSecretEdge();
  const remoteViewerCookie = request.cookies.get(
    REMOTE_VIEWER_COOKIE_NAME,
  )?.value;
  const { instanceId, primaryAgentId } = getInstanceConfig();
  const remoteViewer = secret
    ? await decodeRemoteViewerSessionEdge(
        remoteViewerCookie,
        secret,
        instanceId,
      )
    : null;

  if (remoteViewer) {
    const isOwner =
      primaryAgentId !== null && remoteViewer.actorId === primaryAgentId;

    // Non-owner visitors get a read/browse session but are barred from the
    // sovereign control plane. Owners (rare on this path, but possible) are
    // unconstrained.
    if (!isOwner && isOwnerOnlyPath(pathname)) {
      if (pathname.startsWith("/api/")) {
        const response = NextResponse.json(
          { error: "Forbidden: owner-only resource" },
          { status: 403 },
        );
        return applySecurityHeaders(response, cspHeader, nonce);
      }
      const homeUrl = new URL("/", request.url);
      const response = NextResponse.redirect(homeUrl);
      return applySecurityHeaders(response, cspHeader, nonce);
    }

    // Forward the verified visitor identity to downstream server components and
    // route handlers via request headers (they cannot re-run the edge decoder).
    requestHeaders.set("x-remote-viewer-id", remoteViewer.actorId);
    requestHeaders.set("x-remote-viewer-home", remoteViewer.homeBaseUrl);
    requestHeaders.set("x-remote-viewer-owner", isOwner ? "1" : "0");

    const response = NextResponse.next({
      request: { headers: requestHeaders },
    });
    return applySecurityHeaders(response, cspHeader, nonce);
  }

  // Neither a NextAuth session nor a valid remote-viewer cookie.
  if (pathname.startsWith("/api/")) {
    const response = NextResponse.json(
      { error: "Authentication required" },
      { status: 401 }
    );
    return applySecurityHeaders(response, cspHeader, nonce);
  }

  const loginUrl = new URL("/auth/login", request.url);
  loginUrl.searchParams.set("callbackUrl", pathname);
  const response = NextResponse.redirect(loginUrl);
  return applySecurityHeaders(response, cspHeader, nonce);
}

/**
 * Middleware route matcher configuration.
 *
 * The regex excludes Next.js internal routes (_next/static, _next/image),
 * metadata files (favicon, sitemap, robots), and static asset file
 * extensions to ensure the middleware only processes navigational
 * and API requests.
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except static files and metadata:
     * - _next/static (static files)
     * - _next/image (image optimization)
     * - Cesium public runtime assets under /Cesium
     * - Public GeoJSON datasets under /geojson
     * - favicon.ico, sitemap.xml, robots.txt
     * - Static assets (images, fonts, json data)
     */
    "/((?!_next/static|_next/image|Cesium/|geojson/|favicon\\.ico|sitemap\\.xml|robots\\.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|xml|json|geojson)$).*)",
  ],
};
