const PUBLIC_PAGE_PATHS = new Set([
  "/",
  "/auth/login",
  "/explore",
  "/map",
  "/search",
  "/calendar",
  "/manifest.webmanifest",
  "/llms.html",
  "/llms.txt",
]);

const PUBLIC_PAGE_PREFIXES = [
  // /docs subtree is auth-optional so agents and anonymous visitors can read it.
  "/docs",
  "/auth/signup",
  "/auth/reset-password",
  "/auth/forgot-password",
  "/events",
  "/marketplace",
  "/groups",
  "/locales",
  "/basins",
  "/rings",
  "/families",
  "/people",
  "/badges",
  "/posts",
  "/profile/",
  "/projects",
  "/jobs",
  "/products",
  // Device-authorization approval page: it handles its own auth
  // redirect internally so it can preserve the `user_code` query arg
  // across the login round-trip. Middleware's generic redirect
  // would drop it.
  "/mcp/authorize",
];

const PUBLIC_API_PREFIXES = [
  "/api/auth",
  // Chatterbox worker source: the Vast GPU box curls this anonymously at
  // boot (plain source code, no secrets — auth token arrives via env).
  "/api/autobot/gpu/worker-source",
  "/api/billing/trial-reminders",
  "/api/cron/federation-deliver",
  "/api/cron/federation-sync",
  // Own bearer/x-node-admin-key auth (route.ts) — must be reachable so that
  // check runs; its siblings above are already allowlisted (2026-07-22).
  "/api/cron/thanks-demurrage",
  // Dual auth (admin session OR shared-secret bearer, for sessionless
  // external drains) — same allowlist reason as the cron above (2026-07-22).
  "/api/admin/federation/drain-credential-sync-queue",
  "/api/health",
  "/api/federation",
  "/api/mcp",
  "/api/murmurations",
  "/api/profile",
  "/api/universal-manifest",
  "/api/stripe/webhook",
  "/api/stripe/checkout",
  "/api/stripe/marketplace-checkout",
  "/api/stripe/payment-intent",
  "/api/map-style-tiles",
  "/api/map-style",
  "/api/map-tilesets",
  "/api/map-diagnostics",
  "/api/locations/suggest",
  "/api/wallet/banks/webhook",
  "/.well-known/mcp",
  "/.well-known/matrix",
  "/.well-known/openid-configuration",
  "/.well-known/universal-manifest.json",
];

export function isPublicPageRoute(pathname: string): boolean {
  if (PUBLIC_PAGE_PATHS.has(pathname)) {
    return true;
  }

  return PUBLIC_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isPublicRoute(pathname: string): boolean {
  if (isPublicPageRoute(pathname)) {
    return true;
  }

  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export {
  PUBLIC_API_PREFIXES,
  PUBLIC_PAGE_PATHS,
  PUBLIC_PAGE_PREFIXES,
};
