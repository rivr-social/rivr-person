# Publish → serve builder sites on custom domains

The site builder can publish a user's workspace and serve it on the user's own
domain (e.g. `camalot.me`) directly from this instance — no external host or
GitHub round-trip required.

## How it works

1. **Publish** (`POST /api/builder/publish`) snapshots the current workspace
   files into a `site_versions` row **and** writes them to MinIO under
   `site-publications/<publicationId>/…`, then records a `site_publications` row
   for the owner.
2. **Bind a domain** (`POST /api/builder/domain`) — the owner enters a domain,
   verifies it points at this instance (`node:dns`), and binds it. Binding sets
   `site_publications.custom_domain` + `domain_status = 'bound'`.
3. **Host-dispatch** — the edge middleware (`src/middleware.ts`) detects that an
   incoming request's `Host` is **not** one of this instance's own app hosts and
   rewrites it to the `/site-host/[[...path]]` route. That route
   (`resolveBoundPublicationByHost`) looks up the bound publication and streams
   the requested file from MinIO (default document `index.html`, minimal
   per-site CSP, 404 fallback page). App routing/auth is never touched for the
   app's own host.

`site_publications` is home-authority and **never federated**. No secrets are
stored in it — the DNS-write credential lives only on the agent's autobot
connector lane (encrypted at rest).

### Distinct from `domain_configs`

`domain_configs` (+ `/api/settings/domain`) points a domain at the **whole
sovereign instance** via a Traefik router and TXT ownership verification. The
publish→serve feature here instead points a domain at a **builder-published
static site** served from storage by the app. They are independent tables and
can coexist.

## Required infrastructure: Traefik catch-all router (operator step)

For host-dispatch to work, Traefik must route requests for **unknown hosts**
(the bound custom domains) to the app container, and obtain TLS certs for them
via Let's Encrypt HTTP-01. Add a lower-priority catch-all router alongside the
app's own host router. **Do not** edit live compose files without approval — add
these labels to the app service where the existing app router labels live:

```yaml
labels:
  # ... existing app router (keep as-is; higher priority than the catch-all) ...

  # Catch-all router: any Host not matched by a more specific router is served
  # by the app, which host-dispatches bound custom domains to published sites.
  - "traefik.http.routers.rivr-sites.rule=HostRegexp(`{host:.+}`)"
  - "traefik.http.routers.rivr-sites.priority=1"
  - "traefik.http.routers.rivr-sites.entrypoints=websecure"
  - "traefik.http.routers.rivr-sites.tls=true"
  - "traefik.http.routers.rivr-sites.tls.certresolver=le"
  - "traefik.http.services.rivr-sites.loadbalancer.server.port=3000"
```

Notes:

- The app's own host router **must** have a higher `priority` (a specific
  `Host(...)` rule already outranks the `HostRegexp` catch-all by specificity,
  but set an explicit priority to be safe) so normal app traffic is unaffected.
- Traefik v3 syntax is `HostRegexp(` + "`" + `{host:.+}` + "`" + `)`; on v2 use
  `` HostRegexp(`{host:.+}`) `` as shown.
- The `certresolver` name (`le` here) must match the ACME resolver configured on
  the Traefik entrypoint. HTTP-01 requires the custom domain's DNS to already
  resolve to this host (which is exactly what the builder's Verify step checks).
- The app must know its **own** hostname so it does not treat its own traffic as
  a custom domain: set `NEXT_PUBLIC_BASE_URL` / `BASE_URL` / `NEXTAUTH_URL` to
  the app host (e.g. `https://app.camalot.me`). If none are set, host-dispatch
  is disabled (fail-safe) and all traffic routes to the app normally.

## DNS for the domain owner

The builder's domain panel shows the exact record to add:

- **A record** → point the domain at the **same IP** that the app host
  (`NEXT_PUBLIC_BASE_URL`) resolves to.
- **CNAME** (subdomains) → CNAME to the app host.

Owners who have connected a **Cloudflare** or **Namecheap** DNS connector can
click **Set DNS for me** — the server writes the record using the connector's
decrypted credential (never sent to the browser). Squarespace has no public
DNS-write API, so it returns manual instructions.

## Limitations

- Host-dispatch serves the file types the edge middleware runs on: HTML, CSS,
  JS, JSON-ish/text. Binary assets (PNG/JPG/WOFF/…) referenced by **relative**
  path from a custom domain are excluded by the middleware matcher and will not
  be served — inline them, or reference them by absolute URL (the instance's
  MinIO public URL). The builder's default output (`index.html` + `style.css` +
  `script.js`) works as-is.
- One published site per owner agent; publishing replaces the served snapshot
  (older `site_versions` snapshots remain for rollback).
