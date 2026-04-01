# Autobot MCP Setup

Use this when wiring a colocated OpenClaw autobot to a sovereign `rivr-person`
instance.

## Required env on `rivr-person`

```env
AIAGENT_MCP_TOKEN=replace-with-long-random-token
PRIMARY_AGENT_ID=replace-with-real-person-agent-id
```

## MCP endpoint

- discovery: `GET /.well-known/mcp`
- RPC endpoint: `POST /api/mcp`

## OpenClaw config

Minimum config:

```json
{
  "commands": {
    "mcp": true
  },
  "mcp": {
    "servers": {
      "rivr": {
        "url": "https://rivr.camalot.me/api/mcp?token=REPLACE_WITH_AIAGENT_MCP_TOKEN"
      }
    }
  }
}
```

If your active OpenClaw MCP runtime supports remote request headers, prefer:

```json
{
  "commands": {
    "mcp": true
  },
  "mcp": {
    "servers": {
      "rivr": {
        "url": "https://rivr.camalot.me/api/mcp",
        "headers": {
          "Authorization": "Bearer REPLACE_WITH_AIAGENT_MCP_TOKEN"
        }
      }
    }
  }
}
```

## Current Rivr tools

### Read tools
- `rivr.instance.get_context` — instance identity + actor context
- `rivr.personas.list` — personas owned by the controller
- `rivr.profile.get_my_profile` — full myprofile bundle
- `rivr.audit.recent` — recent MCP provenance log entries (filter by tool, actor type, status)

### Write tools
- `rivr.profile.update_basic` — update name, bio, skills, location
- `rivr.posts.create` — create a post
- `rivr.posts.create_live_invite` — create a live event invite
- `rivr.groups.join` — join or leave a group/ring
- `rivr.events.rsvp` — set RSVP status
- `rivr.events.append_transcript` — append transcript segment to a meeting doc

## Actor behavior

- token-authenticated calls act as `PRIMARY_AGENT_ID` by default
- pass `actorId` to act as an owned persona instead of the person root agent

## Provenance logging

Every `tools/call` invocation is automatically logged to the `mcp_provenance_log` table with:

- tool name, actor ID, actor type, auth mode, controller ID
- sanitized args summary (sensitive values redacted, long strings truncated)
- result status (success/error), error message if applicable
- execution duration in milliseconds

Query via:
- **MCP tool**: `rivr.audit.recent` (from any autobot or session)
- **API**: `GET /api/autobot/provenance?actorType=autobot&limit=50` (session-authenticated)
- **UI**: `/autobot` → Activity tab

## Control plane UI

The `/autobot` page provides a web-based control plane for managing your instance's autobot capabilities:

- **Status tab** — instance identity, primary agent info, MCP endpoint health, token status
- **Personas tab** — create/edit/delete/switch personas that autobots can operate as
- **Activity tab** — filterable provenance log with tool name, actor type, auth mode, status, timing

## Verification

1. `curl https://rivr.camalot.me/.well-known/mcp`
2. call `initialize`
3. call `tools/list`
4. call `tools/call` with `rivr.instance.get_context`
5. call `tools/call` with `rivr.profile.get_my_profile`
6. call `tools/call` with `rivr.audit.recent` — should show the previous calls
