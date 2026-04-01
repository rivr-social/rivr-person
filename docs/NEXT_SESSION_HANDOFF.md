# Next Session Handoff

Date: 2026-04-01

## Cross-App Execution Context

- Cross-repo/system execution plan:
  - `/Users/cameronely-murdock/Desktop/RIVR/rivr-monorepo-workspace/rivr-monorepo/docs/federation-arch/25-cross-app-intercoursive-engagement-plan.md`
- Strategic build-vs-scope report:
  - `docs/reports/strategic-build-vs-scope-report.md`
- Use both documents together with this handoff.

## What's Live Right Now

### rivr.camalot.me (person instance)
- MCP provenance logging (every tool call logged)
- `/autobot` control plane (Status/Personas/Activity/Chat tabs)
- `rivr.audit.recent` + `rivr.thanks.send` MCP tools
- Site builder v2 (multi-page generator + deploy to camalot.me)
- NLP command bar (parser v2 + entity scaffold preview)
- Autobot chat is now an OpenClaw frontend proxy, not a separate local bot
- `/autobot/chat?settings=voice` has a real voice-sample setup flow:
  - record in browser
  - preview playback
  - upload/replace/remove sample
  - sample metadata saved in Rivr user settings
- Federation-aware nav (Home/Map→global/Create/Profile)
- Builder/Autobot/Chat accessible from profile page cards
- Humanizer skill installed in OpenClaw
- Autobot-native docs/config

### b.rivr.social (global test-b)
- text=uuid bug fixed (0 errors)
- Home-instance canonical UI (settings panel + projection banner)
- AR mobile fix (`camera=(self), microphone=(self)`)
- `NEXT_IGNORE_TYPE_ERRORS=true` in Dockerfile
- Federation registry correctly resolves Cameron → rivr.camalot.me

### Hosts
| | Camalot | Rivr Social |
|---|---|---|
| IP | `5.161.46.237` | `178.156.185.116` |
| Person | `rivr.camalot.me` | — |
| Global | — | `b.rivr.social` |
| OpenClaw | `ai.camalot.me` (gateway:18789) | — |
| PM Core | `core.camalot.me` / `pm.camalot.me` | `core.rivr.social` |
| Static site | `camalot.me` (`/opt/camalot/`) | — |
| AR | `ar.camalot.me` | — |
| Login | `admin` / `Th@nkfu114you@ll` | same |

## Built in Source — Not Yet Deployed

| Feature | Repo | Key Files |
|---|---|---|
| Home-instance write routing + projection sync | monorepo | `write-proxy.ts`, `projection-sync.ts`, modified `profile.ts`, `posts.ts`, `social.ts` |
| TextBee SMS gateway (full) | monorepo | `textbee-client.ts`, `sms.ts`, webhook handler, settings UI, phone opt-in |
| WhisperX Docker service def | person | `docs/whisperx/` (Dockerfile, app.py, compose, README) |
| AI site builder v3 (real LLM) | person | `builder-system-prompt.ts`, `site-files.ts`, `api/builder/chat/route.ts`, rewritten page |
| Inline content editing + overrides | person | `site-overrides.ts`, updated generator + deploy routes |
| Scoped create flow | person | Updated `create/page.tsx` with publish-to picker |
| Federated profile links + global URL | person | `profile-link.ts`, `global-url.ts`, `federation-session-banner.tsx` |
| Autobot system prompt builder | person | `autobot-system-prompt.ts` |

## GitHub Issues (all tracked)

**rivr-social/rivr-app:** #70-#80
- #70 TextBee SMS | #71 WhisperX | #72 NLP Command Bar | #73 Write Routing
- #74 Autobot Chat (OpenClaw) | #75 Federation UX | #76 Video Avatar | #77 WebRTC/Video/Reels
- #78 Local LLM | #79 Provenance (done) | #80 AR Fix (done)

**rivr-social/rivr-person:** #2 Bespoke AI Website Builder

## Research Reports

| Report | File |
|---|---|
| Video Avatar Generation | `docs/reports/video-avatar-generation-report.md` |
| WebRTC Meetings, Livestreaming, Video & Reels | `docs/reports/webrtc-meetings-video-report.md` |
| Humanizer Skill | `docs/reports/humanizer-report.md` |
| Bespoke UI Possibilities | `docs/BESPOKE_UI_POSSIBILITIES.md` |
| Strategic Build vs Scope | `docs/reports/strategic-build-vs-scope-report.md` |

## Critical: Autobot Chat Must Use OpenClaw

This is now the correct architecture in source and live deploys:
- `/autobot/chat` is a frontend/proxy to the existing OpenClaw instance
- stable thread/session keys are forwarded to OpenClaw
- selected model is forwarded
- Rivr context/system prompt is forwarded
- user voice/provider preferences are stored in Rivr settings

The remaining gap is runtime binding, not architecture:
- saved provider settings need to fully drive `/api/gpu/*` and `/api/tts`
- saved uploaded voice samples need to be pushed onto the active Chatterbox runtime automatically
- rich preview/confirm cards still need to replace plain text tool responses

- Gateway: `pmdl_openclaw` at `http://openclaw-gateway:18789` (Docker internal)
- Web UI: `pmdl_openclaw_web` at `ai.camalot.me`
- Chat API: `POST /api/chat` with `{ username, message, history }` → `{ reply }`
- Voice: LiveKit + Chatterbox TTS on Vast.ai
- MCP: all Rivr tools via `AIAGENT_MCP_TOKEN`
- KG memory: `cartoon_kg` PostgreSQL
- Skills: Humanizer at `/home/node/.openclaw/skills/humanizer/`
- Deploy: `Autobot/deploy-camalot.sh openclaw`

OpenClaw already does multi-hop reasoning and conversation threading. Don't rebuild this — keep extending the proxy/runtime binding path.

## Canonical Identity (Settled)

- Agent: `aa29fa2d-4c2a-4eaf-a069-b2203a2ce667`
- Node: `44444444-4444-4444-4444-444444444444`
- Home: `rivr.camalot.me`, slug: `cameron`, status: `active`
- No duplicate rows. UI/UX routing is the remaining gap, not data.

## Priority Order (from strategic report)

### Week 1
1. Deploy write routing to b.rivr.social
2. Deploy WhisperX Docker service on Camalot
3. Set `OPENAI_API_KEY` on rivr-person for AI builder
4. Finish runtime binding for autobot voice/provider settings

### Week 2
5. Verify federation write proxy end-to-end
6. Test NLP command bar on live
7. Verify Matrix messaging
8. **Set up database backups (URGENT — none exist)**

### Weeks 3-4
9. TextBee SMS integration test
10. Bespoke builder: ship static v1, AI generation later
11. LiveKit meeting rooms (Phase 1)
12. Video posts (upload + transcode)

### Out of Scope
- Full video conferencing (use LiveKit Cloud)
- Video avatar pipeline (research only)
- RTMP simulcasting (use OBS)
- Solid Pod (no demand)
- Locale/bioregional instances (premature)

## OpenClaw Architecture Reference

```
Autobot/
├── extension/index.ts          — main plugin (KG, persona, tools)
├── extension/src/kg-client.ts  — PostgreSQL KG
├── extension/src/pmcore-operator-tool.ts — server operator
├── token-server/server.js      — proxy (/api/chat, /api/token, /api/tts)
├── web/index.html              — chat UI
├── persona/soul.md             — agent identity
├── skills/humanizer/           — AI writing humanizer
├── config/                     — runtime config
├── deploy-camalot.sh           — deploy script (now syncs skills/)
└── cartoon/openclaw/           — upstream fork
```

## Quick Verification

```bash
curl -sS https://rivr.camalot.me/api/health | jq .
curl -sS https://rivr.camalot.me/.well-known/mcp | jq '.tools[] | .name'
curl -sS https://b.rivr.social/api/health | jq .
curl -sS 'https://b.rivr.social/api/federation/registry/aa29fa2d-4c2a-4eaf-a069-b2203a2ce667' | jq .
ssh root@5.161.46.237 "docker exec pmdl_openclaw curl -sS http://127.0.0.1:18789/healthz"
```

## Starting Message for Next Session

Use `rivr-person/docs/NEXT_SESSION_HANDOFF.md` as source of truth. Autobot chat is already an OpenClaw frontend proxy on `rivr.camalot.me`, and `/autobot/chat?settings=voice` now has real in-browser sample creation/upload with saved sample metadata in Rivr settings. The current workstream is no longer “rewrite autobot chat”; it is “finish runtime binding” so saved provider settings and saved uploaded voice samples actually drive `/api/gpu/*` and `/api/tts` end to end. Then continue with write routing and WhisperX deployment. Read `docs/reports/strategic-build-vs-scope-report.md` before starting new scope.
