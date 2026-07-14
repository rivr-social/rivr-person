# RIVR Person App — Agent & Contributor Guide

## What This Is

This is the **canonical sovereign person app** for the RIVR ecosystem. It runs
on an individual's own infrastructure as their personal instance, with
autobot/MCP control plane capabilities for AI agent integration.

Each deployment represents a single person — the app serves their profile,
content, personas, and autobot connections.

## How It Relates to Global

This repo shares a common codebase heritage with `rivr-social/rivr-app` (the
global app), but runs as an independent sovereign instance. Key differences:

- **Single-person focus.** Configured via `PRIMARY_AGENT_ID` and
  `INSTANCE_TYPE=person`.
- **Autobot-native.** Built-in MCP server, provenance logging, persona
  management, and external connector sync (Slack, Discord, Telegram, Google,
  etc.).
- **Control plane UI.** `/autobot` dashboard for status, personas, and activity.
- **Credential authority delegation.** Password verification delegates to
  `app.rivr.social/api/federation/sso/issue` with local bcrypt fallback.
- **Cryptographic identity.** Ed25519 keypair, BIP39 seed phrase recovery,
  sovereign key management.

## Tech Stack

Same foundation as global, plus person-specific capabilities:
- Next.js 15, TypeScript, PostgreSQL/PostGIS/pgvector, Drizzle, NextAuth v5,
  MinIO, Matrix, Stripe
- **LiveKit** — video/audio meetings
- **xterm** — terminal emulation for agent HQ
- **@noble/ed25519, @scure/bip39** — cryptographic identity
- **Dev port:** 3003

## Source Structure

```
src/
  app/
    (main)/               # Main layout
    api/
      federation/         # Federation endpoints
      autobot/            # Autobot connector management
      agent-hq/           # Agent HQ features
      mcp/                # MCP protocol endpoint
      personas/           # Persona management
      meetings/           # LiveKit meeting management
      instance/           # Instance self-management
      recovery/           # Account recovery
      builder/            # Builder/creator tools
      bespoke/            # Bespoke site generation
      ...
    settings/             # User settings
    marketplace/          # Marketplace (detail/purchase only)
    sovereign-merge-confirm/ # Sovereign merge flow
    session-record/       # Session recording
    ...
  lib/
    autobot/              # Autobot subsystem
      autobot-*.ts        # Connectors (Slack, Discord, Telegram, Google, etc.)
    agent-hq.ts           # Agent HQ
    persona-config.ts     # Persona configuration
    recovery-seed-*.ts    # Seed phrase recovery (MFA, local store, audit)
    meetings/             # Meeting/conference handling
    erc8004.ts            # ERC-8004 standard
    ...
  components/             # React components
  db/
    schema/               # Drizzle schema
    migrations/           # SQL migrations
```

## MCP Integration

The person app exposes an MCP server for AI agent access:

- **Discovery:** `GET /.well-known/mcp`
- **RPC endpoint:** `POST /api/mcp`
- **Auth:** `AIAGENT_MCP_TOKEN` env var, scoped MCP token (Bearer), or session
- **Device flow (RFC 8628):**
  - `POST /api/mcp/device/code` — request device code pair
  - `GET /api/mcp/device/poll/[deviceCode]` — poll for approval
  - `POST /api/mcp/device/approve` — approve/deny (session-authed)
  - `/mcp/authorize?user_code=XXXX-XXXX` — browser approval page
  - Pending codes also surface in the autobot dashboard Activity tab

Current tools: `get_context`, `list_personas`, `get_my_profile`, `audit.recent`,
`update_basic`, `create_post`, `create_live_invite`, `join_group`, `rsvp_event`,
`append_transcript`.

Every tool call is logged to `mcp_provenance_log` with full audit trail.

See `docs/AUTOBOT_MCP_SETUP.md` for integration details.

## Known Drift from Global

These are copied components that reference routes this app does not have.
**Fix the components — don't add global-only routes.**

All previously-tracked drift items below have been resolved; the table is kept
as a record of what was fixed and how.

| Component | Broken Link | Issue | Status |
| --- | --- | --- | --- |
| `src/components/CommandBar.tsx` | `/marketplace` (index) | [#27](https://github.com/rivr-social/rivr-person/issues/27) | Fixed — now points at `/?tab=marketplace` (home Mart tab). |
| `src/components/user-menu.tsx` | `/groups` (index) | [#27](https://github.com/rivr-social/rivr-person/issues/27) | Fixed — now points at `/?tab=groups` (home Groups tab). |
| `src/components/persona-creator.tsx` | `/personas` (index) | [#27](https://github.com/rivr-social/rivr-person/issues/27) | Not drift — `/personas` exists locally under `(main)/personas`. |
| `src/components/search-bar.tsx`, `search-header.tsx` | `/explore` | [#28](https://github.com/rivr-social/rivr-person/issues/28) | Fixed — "search/see all" now routes to `/?tab=posts&q=…` (home feed is the canonical browse surface); eliminates the 404 + retry loop. |
| `src/components/location-autocomplete-input.tsx` | `/api/locations/suggest` (global only) | [#29](https://github.com/rivr-social/rivr-person/issues/29) | Fixed — added a local `src/app/api/locations/suggest/route.ts` that serves suggestions from local place/locale graph nodes (no global call); degrades to an empty list. |

The home feed (`/`) reads a `tab` query param (`posts`/`events`/`groups`/
`people`/`gigs`/`marketplace`) so the above deep links land on the right tab.

### Other Known Issues

- [#30](https://github.com/rivr-social/rivr-person/issues/30): RESOLVED
  2026-06-01 — jobs detail page now resolves the real `auth()` session user and
  threads it (or `null` for anonymous) through `JobDetailClient` and its tabs;
  no more hardcoded `currentUserId = "user1"`.
- [#31](https://github.com/rivr-social/rivr-person/issues/31): RESOLVED
  2026-06-09 — unimplemented mutation types now return
  `accepted: false` with `MUTATION_NOT_IMPLEMENTED` (501) or
  `UNKNOWN_MUTATION_TYPE` (400) instead of claiming success.
- [#32](https://github.com/rivr-social/rivr-person/issues/32): Recovery SMS MFA
  is stubbed; some Autobot providers lack dispatch/test support
- [#33](https://github.com/rivr-social/rivr-person/issues/33): Generated
  bespoke-site contact form is placeholder only
- [#35](https://github.com/rivr-social/rivr-person/issues/35): Sovereign key
  cryptography is preview-only

### Federation Gaps

Resolved 2026-06-09 (coordinated parity sweep with global + group):

- **Materializer parity:** RESOLVED — the importer now handles the full
  upsert/delete event-type sets (`resource.created`, `post.created`,
  `event.created`, etc.) via `RESOURCE_UPSERT_EVENT_TYPES` /
  `RESOURCE_DELETE_EVENT_TYPES`.
- **Auto-projected agents:** RESOLVED — resources arriving before their
  owner's agent event project a minimal private placeholder agent
  (`metadata.federatedPlaceholder: true`); the next agent upsert from the same
  peer upgrades it in place. Locally owned agents are never overwritten.
- **Forwarding stubs:** RESOLVED — see #31 above.
- **Replay-window catch-up:** RESOLVED — the pull-sync cron passes
  `allowHistorical: true` so this instance can catch up after >7-day downtime
  (signature + nonce dedup still apply); push routes remain strict.

Still open:

- **Sovereign-merge:** The connect-to-sovereign flow requires 7 manual fixes
  before it works for new users without hand-intervention.

### Cross-instance `job.claimed` calendar projection (A8, materialize side)

When the owner claims a job on a REMOTE sovereign (a group instance), that group
emits a self-describing `job.claimed` federation event; THIS instance (the
claimant's HOME) materializes it onto the owner's calendar. The EMIT side ships
in rivr-group (`src/lib/federation/job-claim-event.ts` — the wire contract;
`JOB_CLAIMED_EVENT_TYPE = 'job.claimed'` + `JobClaimCalendarPayload`). Keep the
person copy in `src/lib/job-claim-calendar.ts` in lockstep with it.

- **Pure lane:** `src/lib/job-claim-calendar.ts` — payload parse/narrow
  (`parseJobClaimCalendarPayload`), owner match (`claimantMatchesLocalOwner`),
  the idempotency key (`syntheticClaimedJobEntityKey`), the projection metadata
  builder, and the read-side mapper (`claimedJobResourceToCalendarItem`). No IO,
  so it is imported by BOTH the server importer and the client calendar. Unit
  test: `src/lib/__tests__/job-claim-calendar.test.ts` (`pnpm test:unit`).
- **Materializer:** `materializeClaimedJobCalendar` in `src/lib/federation.ts`,
  called from `importFederationEvents` on a verified `job.claimed` event. Writes
  a private `resources` row tagged `metadata.resourceKind = 'claimed_job'` (no
  enum/schema migration — mirrors the group's `fund`/`workperiod` convention),
  owned by `PRIMARY_AGENT_ID`, carrying the canonical cross-origin job URL + the
  self-describing calendar fields. It projects ONLY when the claimant resolves
  to the local owner (raw id, or a `federation_entity_map` agent alias — no
  mapping is minted for a non-owner claim). This app hosts exactly one person,
  so a claim for anyone else is ignored.
- **Idempotency:** upsert keyed on `{owner, job}` via
  `syntheticClaimedJobEntityKey(primaryAgentId, jobId)` → a namespaced synthetic
  `federation_entity_map` external id → a stable local `resources.id`. Redelivery
  of the same claim updates the row in place (never duplicates).
- **Read path:** the profile **Calendar** tab. `fetchProfileData` already returns
  the owner's own resources (private included), so `profile-client.tsx` maps
  those rows through `claimedJobResourceToCalendarItem` and passes them to
  `ProfileCalendar` as `userClaimedJobs` — NOT a parallel store. `ProfileCalendar`
  renders each as a green shift-type entry whose link is the remote job's
  canonical URL, opened via a plain cross-origin `<a>` (`CalendarItemLink`), not
  `next/link`.
- **GAP — no unclaim/release event:** the wire contract has NO `job.released`
  (or `job.claimed` retraction) event, so when the owner releases a claim on the
  origin the projection is NOT removed and the entry lingers on the calendar
  until manually cleared. Adding a release event is a coordinated federation
  change (group EMIT + person/global MATERIALIZE); do not invent one unilaterally.

### Federated visitor access (browsing-SSO parity)

A cross-instance SSO actor who lands via `/api/federation/sso/land` is
auto-signed-in as a *visitor* with a `rivr_remote_viewer` cookie (minted
node-side, verified in the edge middleware). Non-owner visitors are constrained
by an owner-configurable policy; the instance OWNER (`PRIMARY_AGENT_ID`) is
never constrained.

- **Capability model + resolver:** `src/lib/federation/visitor-scope.ts` —
  `VISITOR_CAPABILITIES` (`read` baseline + `react`/`comment`/`rsvp`/`message`
  extras), `resolveVisitorScope()` (reads `federatedVisitorSettings`, degrades
  to `defaultVisitorScope()` pre-migration), `sanitizeCapabilities`,
  `visitorCan`, `requiredVisitorCapability`.
- **Owner policy API:** `GET/POST /api/admin/visitor-access` (owner-only).
  Body validation is in `src/lib/federation/visitor-access-policy.ts`
  (`parseVisitorAccessBody`, TTL bounds 1..1440) — kept out of the route module
  because Next.js 15 route files may only export request handlers.
- **Owner settings UI:** `/settings/visitor-access` — toggle auto-sign-in,
  per-capability checkboxes, session TTL, record-visits switch, and the most
  recent recorded landings.
- **Visit recording:** `src/lib/federation/visit-log.ts` appends to
  `federatedVisitLog` (referral path, home instance, granted scope) when the
  policy enables it. Schema: `federatedVisitorSettings` + `federatedVisitLog`
  (migration 0053).
- **Enforcement:** the lander mints a scoped/short-TTL cookie for non-owners and
  skips the landing entirely when visitors are disabled;
  `/api/federation/mutations` gates a cookie-visitor's action against
  `requiredVisitorCapability` (owner/peer requests bypass it).
- **Tests:** `visitor-access-policy.test.ts`, `visitor-scope.test.ts`, and
  `remote-viewer-edge-parity.test.ts` (node-mint → edge-verify parity). Run
  under Node ≥22 (`vitest`/rolldown needs `node:util.styleText`).

### Anonymous public-profile visibility

A fully anonymous viewer (no NextAuth session, no `rivr_remote_viewer` cookie)
can see the owner's PUBLIC content on their sovereign profile — but ONLY the
public/locale-visible subset. The viewer-aware filtering lives in
`src/app/actions/graph/profiles.ts`:

- `fetchProfileData(agentId, viewerIdOverride?)` resolves the viewer from
  `tryActorId()` unless an explicit `viewerIdOverride` is passed (MCP/autobot
  self-view callers have no `auth()` session, so they pass the owner id). The
  anonymous branch runs owned resources through `filterPubliclyCrawlableResources`
  rather than returning them raw.
- `fetchUserPosts(userId, limit, viewerId)` filters BEFORE slicing:
  `filterViewableResources(viewerId, …)` for an authenticated viewer,
  `filterPubliclyCrawlableResources(…)` for anonymous (`viewerId === null`), then
  applies `limit`. So private/locale posts never consume an anonymous viewer's
  page budget.
- Callers thread the real viewer: `api/profile/[username]` passes the (possibly
  null) session id; `api/myprofile`, `mcp-tools`, and `autobot-system-prompt`
  pass the owner id for self-view.
- Coverage: `src/app/actions/graph/__tests__/profiles.test.ts` asserts an
  anonymous viewer sees only public posts, the owner still sees their own
  private posts, and visibility filtering precedes the limit.

### Parachute vault import (Docs → Filesystem → "Import vault")

Owner-only ingress that turns a Parachute/Obsidian markdown vault into private,
faceted-tag doc Resources (the same rows the Tags view / `faceted-fs` render).

- **Route:** `POST /api/agent-hq/parachute-import` — gated by
  `assertAgentHqAccess()` (sovereign-only) **plus** a `PRIMARY_AGENT_ID` owner
  check. Discriminated body: `{ mode: "files", files: [{ path, content }] }`
  (browser `webkitdirectory` upload) or `{ mode: "daemon", url, token, vaultName? }`
  (server-side pull of a running daemon's `GET /notes`, `Bearer pvt_…`). SSRF
  guard + size/count caps mirror `builder/import-solid`. Returns
  `{ imported, updated, skipped }`.
- **Parser:** `src/lib/parachute-vault-md.ts` — dependency-free frontmatter +
  `#nested/tag` extractor (port of `repos/parachute/core/src/obsidian.ts`).
- **Mapping:** `src/lib/autobot-parachute-sync.ts` `importParachuteFile` merges
  folder-path facets WITH explicit note tags, stamps `metadata.parachute`
  (`sourceHash`, `frontmatter`, `links`) for provenance + idempotent re-import
  (unchanged notes return `"skipped"`).
- **UI:** `src/components/parachute-import-dialog.tsx`, opened from the "Import
  vault" button in `documents-tab.tsx` (personal docs only).
- **Tests:** `src/lib/__tests__/parachute-vault-md.test.ts`,
  `src/lib/__tests__/autobot-parachute-sync.test.ts` (run under Node ≥22).

### Builder: publish → serve on custom domains

The site builder can publish a workspace and serve it on the user's own domain
(e.g. `camalot.me`) straight from this instance — no GitHub/external host.

- **Storage-backed publish:** `POST /api/builder/publish` snapshots the current
  workspace files into a `site_versions` row **and** writes them to MinIO under
  `site-publications/<id>/…` (see `src/lib/builder/site-publish-storage.ts`),
  then upserts a `site_publications` row (migration `0057_site_publications.sql`;
  home-authority, never federated).
- **Host-dispatch serving:** `src/middleware.ts` rewrites any request whose
  `Host` is not one of this instance's own app hosts to
  `src/app/site-host/[[...path]]/route.ts`, which resolves the bound
  `custom_domain` (`resolveBoundPublicationByHost`) and streams the file from
  MinIO with a minimal per-site CSP + 404 fallback. Disabled fail-safe when no
  `NEXT_PUBLIC_BASE_URL`/`BASE_URL`/`NEXTAUTH_URL` is set.
- **Custom-domain panel:** `src/components/custom-domain-panel.tsx` in the
  builder Deploy tab — publish, show required A/CNAME records, Verify (node:dns
  vs the app host), Bind, and one-click **Set DNS for me** via a connected
  Cloudflare/Namecheap connector (`src/lib/builder/dns-write.ts`; creds decrypted
  server-side from the autobot connector lane, never client-supplied).
- **Service/pure split:** DB + storage in `src/lib/builder/site-publications.ts`;
  pure host-match + DNS-verify (unit-tested, no DB) in
  `src/lib/builder/site-host-resolve.ts`. Routes owner-gated via
  `src/lib/builder/site-owner.ts` (session + `PRIMARY_AGENT_ID`).
- **Distinct from `domain_configs`** (`/api/settings/domain`), which points a
  domain at the whole instance via Traefik. See `docs/CUSTOM_DOMAINS.md` for the
  required Traefik catch-all router + HTTP-01 cert snippet.
- **Tests:** `src/lib/builder/__tests__/{dns-write,site-host-resolve}.test.ts`.

## Development

```bash
pnpm install
pnpm dev          # Start dev server (port 3003)
pnpm build        # Production build
pnpm db:migrate   # Run database migrations
```

## Deployment

See `docs/QUICK_PERSON_INSTANCE.md`, `docs/PERSON_APP_DEPLOY_RUNBOOK.md`, and
`docs/PERSON_INSTANCE_CUTOVER.md` for sovereign deployment procedures.

Required env vars: `INSTANCE_TYPE=person`, `INSTANCE_ID`, `INSTANCE_SLUG`,
`PRIMARY_AGENT_ID`, `REGISTRY_URL`, `DATABASE_URL`, `AUTH_SECRET`, `BASE_URL`,
`AIAGENT_MCP_TOKEN` (for autobot).

## Contributing Rules

1. **This is a sovereign app.** Don't add global-only routes. Fix or remove
   references to routes that don't exist locally.
2. **MCP changes need provenance.** Every new MCP tool must log to
   `mcp_provenance_log`. Don't bypass the audit trail.
3. **Federation changes must be coordinated.** Changes to federation event
   format, materializer, or peer auth must land in global and other sovereign
   repos too.
4. **Autobot connectors are person-specific.** They belong here, not in global.
5. **No sensitive data in commits.** No IPs, passwords, secrets, or host paths.
6. **Update this file when you ship.** Fix a drift item, remove it from the
   table. Add a route, document it.
7. **Test before claiming done.** `pnpm build` must pass.
