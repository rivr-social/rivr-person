# Next Session Handoff

Date: 2026-03-31

## Cross-App Execution Context

- Cross-repo/system execution plan:
  - `/Users/cameronely-murdock/Desktop/RIVR/rivr-monorepo-workspace/rivr-monorepo/docs/federation-arch/25-cross-app-intercoursive-engagement-plan.md`
- Use that document together with this handoff.
- This handoff is person-instance specific.
- The cross-app plan is the source of truth for:
  - Matrix
  - autobot voice + cloned voice chat
  - WhisperX transcription
  - command bar NLP
  - TextBee SMS gateway
  - map / Cesium / AR / group 3D assets

## Latest Session Addendum

### 1. Canonical identity / home-instance finding

- This was checked directly against the live databases.
- Cameron does **not** currently have two different person-agent rows.
- Global (`rivr_test_b`) and Camalot (`rivr_person`) both use the same canonical agent id:
  - `aa29fa2d-4c2a-4eaf-a069-b2203a2ce667`
- Global also already has the correct person-instance node registration:
  - node id: `44444444-4444-4444-4444-444444444444`
  - slug: `cameron`
  - base URL: `https://rivr.camalot.me`
  - instance type: `person`
  - migration status: `active`

Meaning:

- the current user-facing problem is **not** DB-level duplicate identity rows
- the real gap is that global/shared UI still does not consistently express:
  - "your canonical profile lives on your sovereign home instance"
  - "this surface may be a projection"
  - "writes should route to the home instance"

### 2. Source changes added in monorepo this session

These are source-side only and still need normal build/deploy verification:

- `src/lib/federation-identities.ts`
  - now includes home-instance/current-instance routing status in `FederationIdentityStatus`
- `src/app/settings/settings-form.tsx`
  - new **Canonical Home Instance** panel in Federation settings
  - shows:
    - current instance
    - resolved home instance
    - whether this surface is local or projected
    - where writes should execute
    - links to open the canonical home instance
- `src/app/(main)/profile/page.tsx`
  - new projected-profile banner
  - intended behavior:
    - when global is rendering a projection, tell the user their canonical profile lives on the sovereign home instance

Important:

- no destructive merge routine was added this session
- that was intentional, because the live data says there is nothing to merge yet at the agent-row level

### 3. PM Core dashboard state

Rivr Social:

- URL: `https://core.rivr.social`
- login:
  - username: `admin`
  - password: `Th@nkfu114you@ll`

Camalot:

- intended dashboard URL: `https://core.camalot.me`
- fallback fresh hostname: `https://pm.camalot.me`
- login:
  - username: `admin`
  - password: `Th@nkfu114you@ll`

Notes:

- `pm.camalot.me` was created because `core.camalot.me` was still stuck behind stale local/router NXDOMAIN caching during the session
- server-side routing is configured for both hosts on Camalot:
  - `Host(\`core.camalot.me\`) || Host(\`pm.camalot.me\`)`

## Immediate Next Session Priorities

1. Deploy the already-landed `rivr-person` handoff items from this file
2. Deploy/verify the new global home-instance/projection UI changes from monorepo
3. Confirm that global now clearly presents Cameron's sovereign person instance as canonical
4. Audit remaining write surfaces to ensure they all use home-instance routing rather than pretending writes are local
5. Then continue with the cross-app plan:
   - WhisperX
   - command-bar NLP
   - TextBee
   - voice + AR / Cesium / group 3D assets

## Current Live State

- `rivr-person` is live at `https://rivr.camalot.me`
- Root page, static assets, and public profile rendering are working
- MCP is live:
  - `GET /.well-known/mcp` works
  - `POST /api/mcp` works with `AIAGENT_MCP_TOKEN`
  - read tools work
  - write tools work
- OpenClaw is wired to:
  - `RIVR_PERSON_URL=https://rivr.camalot.me`
  - `AIAGENT_MCP_TOKEN=<live secret on host>`
- First verified MCP write exists:
  - resource id `107e2067-3088-4244-901b-d3f4e8479620`

## Important Contracts

- Discovery endpoint: `https://rivr.camalot.me/.well-known/mcp`
- Transport endpoint: `https://rivr.camalot.me/api/mcp`
- Auth: `Authorization: Bearer <AIAGENT_MCP_TOKEN>`
- Default actor: omit `actorId` to act as primary person agent
- Persona actor: pass explicit `actorId`
- Primary person agent id:
  - `aa29fa2d-4c2a-4eaf-a069-b2203a2ce667`
- Registry URL:
  - `https://b.rivr.social/api/federation/registry`

## Host / Deploy Notes

- Camalot host: `root@5.161.46.237`
- Active PM Core override file:
  - `/opt/pm-core/docker-compose.camalot.yml`
- Standalone app source on host:
  - `/opt/rivr-person`

## What Landed This Session (2026-03-31)

### 1. MCP Provenance Logging (COMPLETE — needs deploy + migration)

Every MCP `tools/call` invocation is now logged to `mcp_provenance_log` with actor, auth mode, tool name, sanitized args, result status, error message, and duration.

**Files created/modified:**
- `src/db/migrations/0032_mcp_provenance_log.sql` — new table + indexes
- `src/db/schema.ts` — added `mcpProvenanceLog` table definition + types
- `src/lib/federation/mcp-provenance.ts` — `logMcpProvenance()` (fire-and-forget) + `getProvenanceLog()` query
- `src/lib/federation/mcp-server.ts` — every `tools/call` now logs provenance (success + error paths)
- `src/lib/federation/mcp-tools/index.ts` — new `rivr.audit.recent` MCP tool for querying provenance
- `src/app/api/autobot/provenance/route.ts` — API route for control plane UI
- `src/app/api/autobot/status/route.ts` — API route for instance + autobot config

### 2. Autobot Control Plane UI (COMPLETE — needs deploy)

New `/autobot` page with three tabs:
- **Status** — instance identity, primary agent info, MCP endpoint health, token config
- **Personas** — full PersonaManager (create/edit/delete/switch) moved here
- **Activity** — filterable provenance log table (actor type, tool, status, timing)

**Files created/modified:**
- `src/app/(main)/autobot/page.tsx` — full control plane page
- `src/components/bottom-nav.tsx` — added Autobot (Bot icon) as 4th nav item

### 3. Autobot-Native Docs/Config (COMPLETE)

- `README.md` — rewritten to lead with sovereign autobot-native framing
- `.env.example` — `AIAGENT_MCP_TOKEN` promoted to first-class with full docs
- `docker-compose.example.yml` — autobot token in environment section
- `docs/AUTOBOT_MCP_SETUP.md` — expanded with provenance logging, control plane, audit tool docs

## Deploy Checklist (must do before features work on Camalot)

1. **rsync** the updated source to `/opt/rivr-person` on Camalot
2. **Run migration** `0032_mcp_provenance_log.sql` against the rivr_person DB:
   ```bash
   ssh root@5.161.46.237
   docker exec -i pmdl_postgres psql -U rivr -d rivr_person < /opt/rivr-person/src/db/migrations/0032_mcp_provenance_log.sql
   ```
3. **Rebuild + restart**:
   ```bash
   ssh root@5.161.46.237 "cd /opt/rivr-person && docker build -t rivr-person:latest . && docker builder prune -af"
   ssh root@5.161.46.237 "cd /opt/pm-core && docker compose -f docker-compose.camalot.yml up -d rivr-person"
   ```
4. **Verify**:
   - `curl https://rivr.camalot.me/.well-known/mcp` — should include `rivr.audit.recent` in tools
   - Visit `https://rivr.camalot.me/autobot` — should show control plane
   - Call any MCP tool, then check Activity tab — should show provenance entry

## Open Issues (docs/issues/)

### Issue 001: TextBee SMS Gateway (Priority: Medium)
- Groups register an old Android phone running [TextBee](https://github.com/vernu/textbee) as SMS gateway
- Per-group config: `textbeeUrl` + `textbeeApiKey` in group metadata
- Outbound: event invites, announcements via SMS
- Inbound: SMS replies parsed for RSVP
- Full spec: `docs/issues/001-textbee-sms-gateway.md`

### Issue 002: WhisperX Live Transcription (Priority: HIGH)
- Deploy [WhisperX](https://github.com/m-bain/whisperx) as Docker service in PM Core
- The transcript storage pipeline ALREADY EXISTS and works:
  - `appendEventTranscriptAction()` appends to event-linked docs
  - `EventTranscriptPanel` provides recording UI
  - `src/lib/transcription.ts` has `WHISPER_TRANSCRIBE_URL` support ready
  - MCP tool `rivr.events.append_transcript` exists
- What's needed: WhisperX Docker service + `WHISPER_TRANSCRIBE_URL` pointed at it
- Key feature: speaker diarization from WhisperX → `speakerLabel` in transcript segments
- Important design correction: use attendee-specific event transcript documents, not one shared transcript doc
- Flow: live invite → meeting event + transcript workspace → members RSVP → each attendee records into their own event transcript doc → event shows aggregate transcript view
- Full spec: `docs/issues/002-whisperx-live-transcription.md`

### Issue 003: Command Bar NLP Integration (Priority: Medium-High)
- Command bar currently only does `pay X Y` via regex
- NLP parser v2 (`nlp-parser-v2.ts`) exists with full entity/relationship extraction but is NOT wired in
- Entity scaffold preview (`entity-scaffold-preview.tsx`) and NLP input (`nlp-input.tsx`) exist but are separate
- Wire NLP parser v2 as fallback in command bar → show scaffold preview → create entities
- This activates: parse → preview → create → graph → contract engine chain
- Full spec: `docs/issues/003-command-bar-nlp-integration.md`

## Architecture Context: Semantic Constructor Chain

The rivr-person codebase has a layered semantic architecture:

```
Command Bar ($) ─── currently: regex "pay X Y" only
     │               should be: NLP parser v2 (issue 003)
     ▼
NLP Parser V2 (nlp-parser-v2.ts)
     │  tokenize → extract entities → map to REA model
     │  verb categories, determiner analysis, chrono-node temporal
     ▼
Entity Scaffold Preview (entity-scaffold-preview.tsx)
     │  user confirms/edits parsed entities before persistence
     ▼
createEntitiesFromScaffold() → DB + ledger + embeddings
     │
     ├──▶ Agent Graph (profile Graph tab, D3 force-directed)
     └──▶ Contract Engine (WHEN/THEN rule chains fire on ledger entries)
```

Key files:
- `src/components/CommandBar.tsx` — `$` input, keyboard shortcuts
- `src/lib/nlp-parser-v2.ts` — full NLP parser (disconnected from command bar)
- `src/components/nlp-input.tsx` — parse → DB enhance → confirm → create
- `src/components/entity-scaffold-preview.tsx` — confirmation UI
- `src/app/actions/create-entities.ts` — transactional entity creation
- `src/lib/engine.ts` — 34+ verb types, sentence grammar, reputation
- `src/lib/contract-engine.ts` — WHEN/THEN rule chains

### Issue 004: Cameron Profile Data (Priority: Low, carried from previous session)
- The source row on `b.rivr.social` for agent `aa29fa2d-4c2a-4eaf-a069-b2203a2ce667` is sparse
- Only contains: username, termsAcceptedAt, notification settings, murmurationsPublishing
- The source-side migration upsert bug was fixed (imports no longer skip existing agent rows)
- But fixing the import can't restore attributes that don't exist in the source
- **Decision needed:** either find richer profile data from another authoritative source and migrate it, or update the profile directly on Camalot via MCP/UI and treat Camalot as canonical going forward

## Execution Plan

### Phase 1: Deploy current changes (immediate)
1. rsync + migrate + rebuild on Camalot
2. Verify provenance logging + control plane UI

### Phase 2: WhisperX (issue 002, highest priority)
1. Create WhisperX Docker service definition for PM Core
2. Deploy on Camalot host (GPU optional — CPU works)
3. Set `WHISPER_TRANSCRIBE_URL=http://whisperx:8000/transcribe`
4. Verify: create live invite → RSVP → press Record → transcript appears in group doc
5. Add speaker diarization label mapping from WhisperX response

### Phase 3: Command Bar NLP (issue 003)
1. Add NLP parser v2 fallback in CommandBar.tsx after pay regex
2. Show EntityScaffoldPreview in a sheet when entities are parsed
3. Wire confirm → createEntitiesFromScaffold → graph update
4. Test with: "create a meetup in Pioneer Square for Friday"

### Phase 4: TextBee SMS (issue 001)
1. Add TextBee gateway config to group settings UI
2. Create `sendGroupSms()` server action
3. Add SMS webhook handler for inbound messages
4. Wire event invites to SMS delivery channel

## Quick Verification Commands

```bash
curl -sS https://rivr.camalot.me/.well-known/mcp | jq .
curl -sS https://rivr.camalot.me/api/profile/cameron | jq .
```

On Camalot host:

```bash
docker inspect -f '{{.State.StartedAt}}' pmdl_rivr_person
docker inspect pmdl_rivr_person --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'PRIMARY_AGENT_ID|AIAGENT_MCP_TOKEN|REGISTRY_URL|NEXT_PUBLIC_BASE_URL'
```
