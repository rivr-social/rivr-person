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

- `rivr.instance.get_context`
- `rivr.personas.list`
- `rivr.profile.get_my_profile`
- `rivr.profile.update_basic`
- `rivr.posts.create`
- `rivr.posts.create_live_invite`
- `rivr.groups.join`
- `rivr.events.rsvp`
- `rivr.events.append_transcript`

## Actor behavior

- token-authenticated calls act as `PRIMARY_AGENT_ID` by default
- pass `actorId` to act as an owned persona instead of the person root agent

## Verification

1. `curl https://rivr.camalot.me/.well-known/mcp`
2. call `initialize`
3. call `tools/list`
4. call `tools/call` with `rivr.instance.get_context`
5. call `tools/call` with `rivr.profile.get_my_profile`
