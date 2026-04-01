# Strategic Build vs. Scope Report

**Date:** 2026-03-31
**Scope:** Rivr ecosystem -- rivr-monorepo, rivr-person, Autobot/OpenClaw, PM Core
**Audience:** Product decision-making
**Stance:** Brutally honest

---

## 1. Current State Inventory

### 1.1 Deployed and Verified Live

**Camalot host (5.161.46.237):**

| Service | Status | Evidence |
|---|---|---|
| rivr-person at `rivr.camalot.me` | Live, serving pages | Root page, static assets, public profile rendering work |
| MCP discovery at `/.well-known/mcp` | Live | Returns tool list, token auth works |
| MCP transport at `/api/mcp` | Live | Read tools and write tools verified; first MCP write exists (resource `107e2067...`) |
| OpenClaw agent | Live | Wired to `RIVR_PERSON_URL` and `AIAGENT_MCP_TOKEN` |
| Chatterbox TTS | Live (Vast.ai GPU, SSH tunnel port 18001) | Voice clone of Cameron works via token-server proxy |
| LiveKit server | Running in pm-core stack | Used for OpenClaw digital-human voice room |
| Traefik + TLS | Live | Handles `*.camalot.me` routing |
| PostgreSQL (rivr_person DB) | Live | Schema through migration 0031; migration 0032 pending |
| MinIO | Live | Object storage for assets |
| Redis | Live | Pub/sub and caching |
| PM Core dashboard | Live at `pm.camalot.me` (or `core.camalot.me` when DNS cache clears) | Admin login verified |

**Rivr Social host (178.156.185.116):**

| Service | Status |
|---|---|
| rivr (prod) at `app.rivr.social` | Live |
| rivr-test-a at `a.rivr.social` | Live |
| rivr-test-b at `b.rivr.social` | Live |
| rivr-staging at `dev.rivr.social` | Live |
| PM Core dashboard at `core.rivr.social` | Live |
| PostgreSQL (rivr, rivr_test_a, rivr_test_b, rivr_dev DBs) | Live |
| Federation registry at `b.rivr.social/api/federation/registry` | Live |
| Person-instance node registration for Cameron | Verified in DB: node `44444444...`, slug `cameron`, base URL `rivr.camalot.me`, status `active` |

### 1.2 Built in Source, Not Yet Deployed

These are complete in code and sitting in the rivr-person source tree, awaiting rsync + migration + rebuild on Camalot:

1. **MCP Provenance Logging** -- migration `0032_mcp_provenance_log.sql`, `mcpProvenanceLog` table, `logMcpProvenance()` fire-and-forget logger, `getProvenanceLog()` query, `rivr.audit.recent` MCP tool, API routes for control plane.

2. **Autobot Control Plane UI** (`/autobot` page) -- three-tab interface: Status (instance identity, MCP health), Personas (full persona management), Activity (filterable provenance log). Added as 4th nav item in bottom-nav.

3. **Autobot-native docs/config** -- rewritten README, `.env.example` with `AIAGENT_MCP_TOKEN` as first-class, `docker-compose.example.yml`, expanded `AUTOBOT_MCP_SETUP.md`.

4. **Home-instance projection UI** (in rivr-monorepo, `testb_decomp` branch) -- `FederationIdentityStatus` with home/current instance routing, Canonical Home Instance panel in Federation settings, projected-profile banner on profile page in global app.

### 1.3 Partially Built / Infrastructure Exists but Feature Incomplete

| Feature | What Exists | What Is Missing |
|---|---|---|
| **WhisperX transcription** | `appendEventTranscriptAction()`, `EventTranscriptPanel`, `transcription.ts` with `WHISPER_TRANSCRIBE_URL`, MCP tool `rivr.events.append_transcript` | WhisperX Docker service not deployed; per-attendee transcript docs not implemented; speaker diarization label mapping not wired |
| **NLP command bar** | `nlp-parser-v2.ts` (full parser), `nlp-input.tsx`, `entity-scaffold-preview.tsx`, `create-entities.ts`, `engine.ts` (34+ verbs), `contract-engine.ts` | Parser not wired into `CommandBar.tsx`; scaffold preview not triggered from command bar; the chain is disconnected |
| **Matrix messaging** | `matrix-js-sdk` in dependencies, `groupMatrixRooms` table, Matrix env/CSP in middleware, Matrix actions/helpers in monorepo | Not verified end-to-end on sovereign instances; identity provisioning unclear; DM and group messaging consistency unverified |
| **Bespoke site builder** | `BespokeModuleManifest` type system, MyProfile and PublicProfile module manifests, public API endpoints for profile data, site-generator producing 8 person + 6 group HTML pages | AI chat interface not built; iterative generation not built; MinIO static deployment pipeline not built |
| **Cesium/map** | `cesium` and `resium` in dependencies, CSP middleware configured for Cesium assets | No spatial asset model in DB; no group-owned 3D object management; AR sidecar exists separately in Autobot/AR but not integrated |
| **Federation write routing** | Node registration exists, peer trust model exists, federation events/entity map/audit log tables exist | Global UI does not consistently route writes to home instance; projection semantics incomplete |
| **Stripe/wallets** | `wallets`, `walletTransactions`, `capitalEntries` tables, Stripe deps in package.json, subscription tiers defined | Unclear deployment verification status on sovereign instances |
| **LiveKit meetings** | Token server in Autobot issues LiveKit JWT, `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`/`LIVEKIT_WS_URL` configured, LiveKit server running on Camalot | Hardcoded to `digital-human` room; no dynamic room creation; no meeting UI components; no recording pipeline; no `@livekit/components-react` in dependencies |

### 1.4 Schema Inventory (22 Tables)

The rivr-person database has 22 tables: `agents`, `resources`, `ledger`, `nodes`, `nodePeers`, `nodeMemberships`, `federationEvents`, `federationEntityMap`, `federationAuditLog`, `auditLog`, `emailVerificationTokens`, `emailLog`, `subscriptions`, `wallets`, `walletTransactions`, `capitalEntries`, `groupMatrixRooms`, `contractRules`, `accounts`, `sessions`, `verificationTokens`, `mcpProvenanceLog` (pending migration).

This is a substantial, well-designed schema. PostGIS geometry, pgvector 384-dim embeddings, full-text search, JSONB metadata -- all present. The schema is not the bottleneck.

---

## 2. What Should Be Built -- High Priority

### 2.1 Deploy Pending Changes (Provenance + Control Plane + Home-Instance UI)

**What exists:** Complete code for provenance logging, `/autobot` control plane, home-instance projection UI.
**What is missing:** rsync, run migration 0032, rebuild, verify.
**Effort:** Small (1-2 hours of deploy work).
**Dependencies:** None.
**Tracking:** GitHub issue #79 (MCP Provenance Logging + Autobot Control Plane).
**Rationale:** This is finished code sitting on the shelf. Deploying it validates the autobot-native architecture and makes the control plane visible. There is zero reason not to ship this immediately.

### 2.2 WhisperX Transcription Service

**What exists:** The entire transcript storage pipeline, recording UI, MCP tool, env var placeholder.
**What is missing:** WhisperX Docker service definition, deployment to PM Core stack, `WHISPER_TRANSCRIBE_URL` configured, per-attendee transcript doc refactor, speaker diarization mapping.
**Effort:** Medium (1-2 days for Docker service + integration; 1 day for per-attendee refactor).
**Dependencies:** None -- CPU inference works on CPX31 (slower but functional). GPU optional.
**Tracking:** GitHub issue #71 (WhisperX Live Event Transcription Pipeline), local spec `002-whisperx-live-transcription.md`.
**Rationale:** This is the highest-leverage feature remaining. The pipeline is 80% built. WhisperX is a known-good Docker image. CPU inference on CPX31 will be slow (~3-5x realtime for large-v3) but usable for async transcription. This unlocks meeting transcripts, which are a core value proposition for group coordination.

### 2.3 Command Bar NLP Integration

**What exists:** Complete NLP parser v2, entity scaffold preview, create-entities action, engine with 34+ verbs, contract engine.
**What is missing:** ~50 lines of wiring in `CommandBar.tsx` to add NLP parser as fallback after pay regex, plus sheet/dialog to render scaffold preview.
**Effort:** Small-Medium (half a day for wiring, 1-2 days for polish and testing).
**Dependencies:** None.
**Tracking:** GitHub issue #72 (Command Bar NLP Parser V2 Integration), local spec `003-command-bar-nlp-integration.md`.
**Rationale:** The semantic constructor chain is the most architecturally distinctive feature in Rivr. The NLP parser, entity scaffold, ledger, graph, and contract engine are all built and disconnected from each other. Wiring the command bar is the keystone that activates the entire chain. This is a small amount of code for a massive capability unlock.

### 2.4 Federation Write Routing (Home-Instance Canonical Routing)

**What exists:** Node registration, peer trust model, home-instance resolution code, projected-profile banner (in monorepo, undeployed).
**What is missing:** All write surfaces in the global app need to route through the home-instance facade. The UI needs to consistently present "your profile lives on your sovereign instance."
**Effort:** Medium (2-3 days to audit all write surfaces, implement routing, deploy, verify).
**Dependencies:** Deploy of home-instance UI changes from monorepo.
**Tracking:** GitHub issue #73 (Home-Instance Write Routing + Projection Sync).
**Rationale:** This is foundational to the sovereign instance model. Without it, the global app pretends writes are local, undermining the entire federation architecture. The DB already has the correct data (Cameron's node registration is verified). The gap is purely in the UI/routing layer.

---

## 3. What Should Be Built -- Medium Priority

### 3.1 TextBee SMS Gateway

**What exists:** Issue spec, clear architecture (group metadata config, server action, webhook handler).
**What is missing:** Everything -- this is spec only, no code.
**Effort:** Medium (2-3 days).
**Dependencies:** An actual Android phone with TextBee installed.
**Tracking:** GitHub issue #70, local spec `001-textbee-sms-gateway.md`.
**Rationale:** Valuable for reaching community members who do not use the app. The commodity hardware angle (old Android phone as infrastructure) fits the Rivr philosophy. Not blocking anything else. Build after the high-priority items.

### 3.2 Humanizer Integration for Autobot

**What exists:** Research report confirms it is a zero-dependency SKILL.md file, one-command install into OpenClaw.
**What is missing:** Running the install command on Camalot.
**Effort:** Tiny (5 minutes).
**Dependencies:** OpenClaw running on Camalot (already true).
**Tracking:** No GitHub issue. Should not need one -- just do it.
**Rationale:** Free quality improvement for all autobot-generated content. There is no reason not to install this immediately alongside the high-priority deploys.

### 3.3 Matrix Messaging End-to-End Verification

**What exists:** `matrix-js-sdk` dependency, `groupMatrixRooms` table, Matrix actions in monorepo.
**What is missing:** Nobody has verified that Matrix identity provisioning, DM creation, and group-linked messaging work consistently on sovereign instances.
**Effort:** Medium (1-2 days for audit, likely bugfixes).
**Dependencies:** Matrix homeserver must be running (verify on both hosts).
**Tracking:** No dedicated issue. Create one.
**Rationale:** Matrix is listed as a core communication channel, but there is no evidence it has been verified on the sovereign person instance. If it does not work, several downstream features (livestream chat, meeting chat) lose their assumed foundation.

### 3.4 Autobot Chat Frontend Integration

**What exists:** OpenClaw agent running, token server proxying `/api/chat`, voice pipeline working.
**What is missing:** In-app chat surface in the Rivr UI. Currently requires going to `ai.camalot.me` (the OpenClaw web UI).
**Effort:** Medium (2-3 days).
**Dependencies:** OpenClaw running (already true).
**Tracking:** GitHub issue #74 (Autobot Chat -- OpenClaw Frontend Integration).
**Rationale:** Users should not need to leave the Rivr app to talk to their autobot. An embedded chat panel using the existing token server proxy would unify the experience. Not blocking but improves usability significantly.

### 3.5 Bespoke AI Website Builder (Simplified Version)

**What exists:** Module manifests, public API endpoints, static site generator producing 14 HTML pages.
**What is missing:** AI chat interface, iterative generation, MinIO deployment pipeline.
**Effort:** Large (1-2 weeks for full implementation).
**Dependencies:** AI SDK integration, PM Core Traefik routing for root domain.
**Tracking:** GitHub issue #2 (rivr-person repo), local spec `004-bespoke-ai-website-builder.md`.
**Rationale:** The static site generator already works and produces 14 pages from real data. The AI chat layer is the ambitious part. Consider shipping the static generator as v1 (deterministic, no AI) and adding the conversational builder later. The 14-page static site from profile data is already useful as a public personal/group website.

---

## 4. What Should Be Built -- Low Priority / Future

### 4.1 WebRTC Meetings via LiveKit

**What exists:** LiveKit server running on Camalot, token server issuing JWTs (hardcoded to one room).
**What is missing:** Dynamic room creation, meeting UI components (`@livekit/components-react` not in dependencies), recording pipeline to MinIO, integration with Rivr event model.
**Effort:** Large (1-2 weeks for basic meetings, 3-4 weeks for training mode, livestreaming, and recording).
**Dependencies:** LiveKit Egress Docker service (4 CPU, 4 GB RAM -- significant resource demand on CPX31).
**Tracking:** GitHub issue #77 (WebRTC Meetings, Livestreaming, Video Posts & Reels).
**Rationale:** The research report is thorough and the architecture plan is sound. However, this is a major feature surface requiring significant frontend work, infrastructure resources, and ongoing maintenance. The CPX31 can handle ~25 video participants or ~200 audio-only -- adequate for small communities but tight. Build this when there are actual groups regularly meeting, not before. The existing WhisperX + Matrix combo covers the immediate needs for transcription and messaging.

### 4.2 Video Avatar Generation

**What exists:** Comprehensive research report covering all SaaS and open-source options.
**What is missing:** Everything -- this is pure research, no code.
**Effort:** Very Large (weeks to months depending on approach).
**Dependencies:** GPU infrastructure (Vast.ai or dedicated), model selection, training data pipeline.
**Tracking:** GitHub issue #76 (Video Avatar Generation -- Transcript to Talking Head Video).
**Rationale:** Cool technology, but premature. The report correctly identifies MuseTalk + Vast.ai RTX 4090 at $0.29/hr as the viable self-hosted path, and Hedra at $0.05/min as the viable API path. Neither is needed until there are users creating content at scale. File this for later.

### 4.3 Cesium/AR Spatial Assets and Group 3D Objects

**What exists:** Cesium and resium dependencies, CSP middleware, Autobot AR sidecar reference app.
**What is missing:** Spatial asset DB model, group-owned 3D object management, Cesium map placement, AR-to-map alignment.
**Effort:** Large (2-3 weeks).
**Dependencies:** Cesium ion account or self-hosted terrain/imagery tiles, 3D asset pipeline.
**Tracking:** Covered in cross-app plan section 7, no dedicated GitHub issue.
**Rationale:** The 3D/AR spatial layer is architecturally interesting but has no demonstrated user demand. Building group spatial assets requires solving asset hosting, coordinate systems, permission models, and rendering pipelines -- all significant work. Defer until there is a concrete use case with real users.

### 4.4 Federation UX Unification (Seamless Cross-Instance Navigation)

**What exists:** GitHub issue #75.
**What is missing:** UI work to make cross-instance navigation feel seamless.
**Effort:** Medium-Large.
**Dependencies:** Home-instance write routing (2.4) must be done first.
**Tracking:** GitHub issue #75.
**Rationale:** Important for the long-term vision but meaningless until the write routing works. Sequence it after 2.4.

### 4.5 Local LLM Deployment (Ollama, Vast.ai, Self-Hosted Models)

**What exists:** GitHub issue #78.
**What is missing:** Everything.
**Effort:** Medium.
**Dependencies:** GPU infrastructure decisions.
**Tracking:** GitHub issue #78.
**Rationale:** OpenClaw already uses an LLM. The question is whether to self-host the model vs. use API providers. This is an infrastructure optimization, not a feature. Defer until API costs become a concern.

---

## 5. What Is OUT OF SCOPE

### 5.1 Building a Full Video Conferencing Platform

**Why out of scope:** The WebRTC report describes meetings, training mode, breakout rooms, livestreaming, video posts, reels, video processing pipelines with FFmpeg transcoding, HLS adaptive streaming, and RTMP simulcast to YouTube/Twitch/Facebook. This is building Zoom + YouTube + TikTok from scratch. A small team cannot maintain this.

**Alternative:** Use LiveKit's existing meeting room as a lightweight embedded component for group calls when demand appears. Do not build training mode, breakout rooms, video reels, or RTMP streaming. For livestreaming, embed a third-party player. For video posts, let users upload to existing platforms and link them.

### 5.2 Building a Video Avatar Pipeline

**Why out of scope:** Even the cheapest self-hosted option (MuseTalk on Vast.ai) requires maintaining a GPU pipeline, model updates, video processing, and quality assurance. The SaaS options ($0.05-$6/minute) are expensive at scale. There are no users requesting this.

**Alternative:** If avatar generation becomes relevant, use Hedra's API ($0.05/min) for occasional use. Do not build or maintain a self-hosted pipeline.

### 5.3 Multi-Platform RTMP Simulcasting

**Why out of scope:** Streaming to YouTube, Twitch, and Facebook simultaneously requires LiveKit Egress (4 CPU, 4 GB RAM), reliable long-duration connections to US-based RTMP endpoints from a European server, and ongoing stream key management. The report itself notes RTMP "does not perform well over long distances."

**Alternative:** If a group wants to livestream, they can use OBS directly to their platform of choice. Rivr does not need to be the streaming middleman.

### 5.4 Solid Pod Integration

**Why out of scope:** The bespoke website builder spec mentions importing from Solid Pod URIs. The Solid ecosystem has low adoption and unstable specs. Implementing a Solid client adds complexity with minimal user benefit.

**Alternative:** Import data from the Rivr profile API, which already exists and is well-defined. If a user wants Solid Pod data on their website, they can manually add it.

### 5.5 rivr-locale-commons and rivr-bioregional Instance Types

**Why out of scope:** The cross-app plan lists these as sovereign deployment targets, but there is no code, no schema, no UI, and no concrete use case. "Locale commons" and "bioregional" are conceptual layers that require significant ontology design, data sourcing, and community adoption before they become useful software.

**Alternative:** Build group instances well. Groups can be locale-scoped or bioregion-scoped through metadata and tagging without requiring separate deployment targets. If locale/bioregional patterns emerge organically from group usage, extract them later.

### 5.6 Comprehensive Video Processing Pipeline (FFmpeg Transcoding, HLS, Thumbnails)

**Why out of scope:** The WebRTC report describes a full video processing stack: upload to MinIO, FFmpeg transcoding to multiple resolutions, HLS segment generation, animated preview generation, thumbnail extraction. This is a media platform backend that requires dedicated compute, monitoring, and maintenance.

**Alternative:** Accept user-uploaded videos as-is. Serve them directly from MinIO. If quality/bandwidth becomes a problem, add a single-resolution transcode. Do not build adaptive bitrate streaming for a platform with fewer than 1,000 users.

### 5.7 Building Custom Breakout Room, Poll, Q&A, and Emoji Reaction Systems

**Why out of scope:** These are features of a mature conferencing product. Each one requires its own UI, state management, and data persistence. Building custom polls, Q&A panels, and emoji reactions from LiveKit data channels is engineering effort that competes with Zoom/Teams for no competitive advantage.

**Alternative:** Use LiveKit's basic meeting room. For polls, use Rivr's existing proposal/voting system. For Q&A, use Matrix chat. For reactions, use Rivr's existing reaction system.

---

## 6. Missing Issues -- What Is Not Yet Tracked

### 6.1 Matrix Verification on Sovereign Instances

**Gap:** No issue tracks verifying Matrix messaging works end-to-end on `rivr.camalot.me`.
**Risk:** Multiple features assume Matrix works (meeting chat, livestream chat, DMs).
**Recommendation:** Create a GitHub issue. Verify before building anything that depends on it.

### 6.2 Database Migration Automation

**Gap:** Migrations are run manually via `docker exec -i pmdl_postgres psql ...`. There is no automated migration runner in the deploy pipeline.
**Risk:** Migrations get forgotten, leading to schema drift between hosts.
**Recommendation:** Add migration execution to the deploy script or Docker entrypoint. Fix directly -- no issue needed.

### 6.3 Health Check / Monitoring

**Gap:** No uptime monitoring, no alerting, no health check endpoints beyond what Traefik does.
**Risk:** Services can go down without anyone knowing.
**Recommendation:** Create a GitHub issue. Add a `/api/health` endpoint that checks DB, Redis, and MinIO connectivity. Set up a free uptime monitor (UptimeRobot, Healthchecks.io).

### 6.4 Backup Strategy

**Gap:** No documented backup strategy for PostgreSQL databases on either host.
**Risk:** Data loss from hardware failure, accidental deletion, or bad migration.
**Recommendation:** Create a GitHub issue. Implement `pg_dump` cron job to MinIO or off-host storage. This is urgent.

### 6.5 MCP Token Rotation

**Gap:** `AIAGENT_MCP_TOKEN` is a static secret with no rotation mechanism.
**Risk:** Token compromise means permanent unauthorized access until manually rotated.
**Recommendation:** Defer -- acceptable for current scale. Note for future security hardening.

### 6.6 Test Coverage for Server Actions

**Gap:** Vitest and Playwright are in devDependencies, but there is no evidence of meaningful test suites for the server actions that the MCP tools depend on.
**Risk:** MCP tool calls may break silently when server actions change.
**Recommendation:** Create a GitHub issue. Write integration tests for the critical MCP tool handlers.

### 6.7 Cameron's Profile Data Sparseness

**Gap:** The source agent row on `b.rivr.social` for Cameron (`aa29fa2d...`) only has username, termsAcceptedAt, notification settings. No bio, skills, social links, or rich profile data.
**Risk:** Every surface that renders Cameron's profile (public profile, bespoke site, federation projections) shows sparse/empty content.
**Recommendation:** Update the profile directly on Camalot via the UI or MCP and treat Camalot as canonical. This is tracked as local issue 004 but has no GitHub issue.

### 6.8 AR View Camera Permission Fix

**Gap:** GitHub issue #80 (AR View -- Mobile Camera Permission Fix) is open.
**Risk:** AR sidecar does not work on mobile.
**Recommendation:** Already tracked. Low priority given AR is out of scope for now.

---

## 7. Architecture Risks

### 7.1 Single Points of Failure

- **Each Hetzner CPX31 is a single server.** No redundancy, no failover, no load balancing. If `5.161.46.237` goes down, all of Camalot goes down. If `178.156.185.116` goes down, all of Rivr Social goes down.
- **PostgreSQL is a single instance on each host.** No replication, no read replicas.
- **Vast.ai GPU instance is interruptible.** Voice clone can disappear at any time. The SSH tunnel must be re-established manually.
- **Mitigation:** Acceptable at current scale. Document recovery procedures. Implement backups (see 6.4).

### 7.2 Resource Contention on CPX31

- **Camalot (4 vCPU, 7.6 GB RAM) runs:** Traefik, OpenClaw gateway, OpenClaw web, rivr-person, camalot-site, AR sidecar, PostgreSQL (2 DBs), Redis, MinIO, LiveKit. That is 10+ containers on 4 vCPUs.
- **Adding WhisperX** (CPU inference) will consume significant CPU during transcription. Running large-v3 on CPU will take 3-5x realtime, monopolizing 1-2 cores during processing.
- **Adding LiveKit Egress** (for recording) needs 4 CPU and 4 GB RAM per the LiveKit docs. This is impossible on the current hardware without displacing other services.
- **Mitigation:** Use WhisperX `medium` model instead of `large-v3` for faster CPU inference. Do not deploy LiveKit Egress on CPX31 -- use LiveKit Cloud Egress if recording is needed. Consider upgrading Camalot to CPX41 (8 vCPU, 16 GB RAM) when transcription or meetings become regular.

### 7.3 Vast.ai Dependency for Voice

- Chatterbox TTS runs on Vast.ai with dynamic IP and interruptible instances.
- If the Vast.ai instance is reclaimed, voice clone stops working until a new instance is provisioned and the SSH tunnel is re-established.
- **Mitigation:** Document the Vast.ai provisioning process. Consider whether CPU-based TTS (slower, lower quality) could serve as a fallback on the Hetzner box.

### 7.4 Schema Complexity vs. Team Size

- 22 tables with PostGIS, pgvector, full-text search, JSONB, federation events, and a 50+ verb ledger system is a lot of schema for a small team.
- The contract engine (WHEN/THEN rule chains with 5-level depth) is powerful but adds operational complexity that nobody is actively using or testing.
- **Risk:** Schema features that are not exercised by real users rot. Bugs accumulate in untested paths.
- **Mitigation:** Focus on the subset of the schema that has active users. Do not add more tables until the existing ones are fully exercised.

### 7.5 Federation Consistency

- The federation model has 6 tables (`nodes`, `nodePeers`, `nodeMemberships`, `federationEvents`, `federationEntityMap`, `federationAuditLog`) but write routing is not implemented.
- Until writes route to the home instance, the federation tables represent aspirational architecture more than working infrastructure.
- **Risk:** Data can get out of sync between global and sovereign instances if writes happen on the wrong instance.
- **Mitigation:** Implement write routing (section 2.4) before adding more federation features.

### 7.6 No CI/CD Pipeline

- Deploys are manual rsync + SSH commands.
- No type-checking gate, no test gate, no build verification before deploy.
- **Risk:** Broken code ships to production.
- **Mitigation:** At minimum, add `tsc --noEmit && next build` as a pre-deploy check. A GitHub Actions pipeline would be better but is not urgent at current deploy frequency.

---

## 8. Recommended Execution Order

### Week 1

1. **Deploy provenance logging + control plane + home-instance UI.** Complete code, zero risk, immediate value. (Section 2.1)
2. **Install Humanizer in OpenClaw.** One command, zero risk. (Section 3.2)
3. **Populate Cameron's profile on Camalot.** Fill in bio, skills, social links via MCP or UI so every profile surface has real data. (Section 6.7)

### Week 2

4. **Deploy WhisperX Docker service.** Get `WHISPER_TRANSCRIBE_URL` working with the existing transcript pipeline. Start with `medium` model for CPU performance. Verify: create event, press record, transcript appears. (Section 2.2)
5. **Wire NLP parser v2 into command bar.** Small code change, massive capability unlock. Test with "create a meetup in Pioneer Square for Friday." (Section 2.3)

### Week 3

6. **Implement federation write routing.** Audit all write surfaces in global app, route to home instance, deploy, verify. (Section 2.4)
7. **Verify Matrix messaging end-to-end.** Confirm identity provisioning, DM, and group messaging work on sovereign instances. (Section 3.3)

### Week 4

8. **Implement database backups.** `pg_dump` cron to MinIO or offsite. Both hosts. (Section 6.4)
9. **Add health check endpoints and uptime monitoring.** (Section 6.3)
10. **Ship static bespoke website (v1, no AI).** Use existing site-generator output at root domain. Deterministic, no LLM required. (Section 3.5, simplified)

### Month 2+

11. **TextBee SMS gateway.** (Section 3.1)
12. **Autobot chat frontend integration.** (Section 3.4)
13. **AI-powered bespoke website builder (v2).** Add conversational AI on top of static v1. (Section 3.5)
14. **LiveKit dynamic meetings.** Only if groups are actively requesting it. (Section 4.1)

### Defer Indefinitely

- Video avatar generation
- Multi-platform livestreaming
- Video posts/reels pipeline
- Cesium/AR spatial assets
- Locale-commons and bioregional instance types
- Solid Pod integration
- Breakout rooms, polls, Q&A systems

---

## 9. Hardware / Infrastructure Assessment

### Current Utilization

**Camalot (CPX31 -- 4 vCPU, 7.6 GB RAM, ~EUR 16.49/mo):**
- Running 10+ containers. RAM is likely near capacity. CPU is adequate for current traffic (essentially one user).
- Adding WhisperX CPU inference will spike CPU during transcription.
- LiveKit Egress is infeasible on this hardware.

**Rivr Social (CPX31 -- 4 vCPU, 7.6 GB RAM, ~EUR 16.49/mo):**
- Running 4 Rivr instances (prod, test-a, test-b, staging) + PostgreSQL + Redis + MinIO.
- Less strained than Camalot because the Rivr app instances are relatively lightweight when idle.

### Upgrade Triggers

| Trigger | Action | Estimated Cost |
|---|---|---|
| WhisperX transcription becomes regular use (multiple transcriptions/day) | Upgrade Camalot to CPX41 (8 vCPU, 16 GB RAM) | ~EUR 30/mo |
| LiveKit meetings needed with recording | Upgrade Camalot to CPX41 + separate LiveKit Egress consideration | ~EUR 30/mo + potential cloud egress costs |
| More than 5 sovereign instances running simultaneously | Upgrade Rivr Social to CPX41 | ~EUR 30/mo |
| Voice clone needs to be always-available (not interruptible) | Move from Vast.ai to reserved GPU or Hetzner GPU server | EUR 100-300/mo for dedicated GPU |
| Production traffic exceeds single-server capacity | Add a second server behind load balancer | ~EUR 33/mo for two CPX31s |

### Cost Projections

| Timeframe | Infrastructure | Monthly Cost |
|---|---|---|
| Now | 2x CPX31 + Vast.ai (spot) | ~EUR 33 + ~$20-50 Vast.ai |
| 3 months (WhisperX regular use) | 1x CPX41 + 1x CPX31 + Vast.ai | ~EUR 47 + Vast.ai |
| 6 months (meetings + more instances) | 2x CPX41 + Vast.ai | ~EUR 60 + Vast.ai |
| 12 months (dedicated GPU for voice) | 2x CPX41 + dedicated GPU | ~EUR 160-360 |

### Optimization Before Upgrading

Before spending money on larger servers:
- Profile container memory usage and identify any leaks or oversized allocations.
- Consider running WhisperX transcription as a batch job (not always-on service) to reduce idle resource consumption.
- Use LiveKit Cloud Egress ($0.015-0.02/min) instead of self-hosted Egress to avoid the 4 CPU + 4 GB RAM requirement.
- Ensure Next.js standalone output is optimized (no dev dependencies in production image).

---

## Summary

Rivr has a sophisticated, well-architected codebase with more built infrastructure than most projects at this stage. The schema, federation model, MCP integration, ledger/engine system, and NLP parser are genuinely impressive foundations.

The primary problem is not that things need to be built -- it is that things already built need to be connected, deployed, and verified. The NLP parser exists but is not wired in. The transcript pipeline exists but WhisperX is not deployed. The federation tables exist but write routing is not implemented. The home-instance UI exists but is not deployed.

The highest-leverage work right now is deployment and wiring, not new feature development. Ship what exists. Connect the disconnected pieces. Verify the assumed foundations (Matrix, federation). Build new things only after the existing things are working end-to-end.

The ambition is correct. The architecture supports it. The execution order matters more than the feature list.
