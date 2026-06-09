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
- **Auth:** `AIAGENT_MCP_TOKEN` env var or Authorization header

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
