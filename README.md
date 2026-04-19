# Rivr Person

**Sovereign, autobot-native Rivr instance for individuals.**

Rivr Person is a standalone deployment that gives you full ownership of your Rivr identity — your profile, your data, your domain. It ships with a built-in MCP server so AI agents (autobots) can read and write on your behalf, a control plane UI for managing personas and reviewing autobot activity, and federation support for staying connected to the wider Rivr network.

## What Makes It Autobot-Native

- **MCP server built-in** — `POST /api/mcp` with token auth. Discovery at `GET /.well-known/mcp`.
- **Provenance logging** — every MCP tool call is recorded with actor, auth mode, args, result, and timing.
- **Control plane UI** — `/autobot` page with Status, Personas, and Activity tabs.
- **Persona management** — create alternate identities that autobots can operate as.
- **`AIAGENT_MCP_TOKEN`** — first-class env var, not an afterthought.

## Goal

Someone should be able to:

1. clone this repo,
2. provision the PM Core host stack,
3. deploy the person app,
4. bind their existing Rivr agent,
5. import their data,
6. set `AIAGENT_MCP_TOKEN` and point an AI agent at the MCP endpoint,
7. update federation home-instance resolution,
8. land on their own `rivr.<domain>` profile with autobot access ready.

## Required PM Core Links

You need the host/foundation stack first.

- PM Core: `https://github.com/peermesh/pm-core`
- Docker Lab / host deployment base: `https://github.com/peermesh/docker-lab`

Recommended reading before deployment:

- PM Core repo: `https://github.com/peermesh/pm-core`
- Docker Lab repo: `https://github.com/peermesh/docker-lab`
- Current upstream PM Core main branch: `https://github.com/peermesh/pm-core/tree/main`

## What PM Core Provides

PM Core / Docker Lab is the base host layer:

- Traefik / ingress
- PostgreSQL
- Redis
- MinIO / S3-compatible object storage
- secrets management patterns
- container orchestration layout
- standard domain wiring

Rivr Person sits on top of that base.

## What Is In This Repo

This repo contains the person app itself, not the entire Rivr monorepo:

- Next.js person-instance app under `src/`
- database schema and migrations under `src/db/`
- federation routing and resolution code under `src/lib/federation/`
- person migration and cutover scripts under `src/scripts/`
- a standalone `Dockerfile`
- example compose and env files
- operator docs under `docs/`

You do not need the full Rivr monorepo to build or run this repo.

## High-Level Setup Flow

### 1. Bring up PM Core / Docker Lab

Clone and configure the host stack on your server:

```bash
git clone https://github.com/peermesh/docker-lab.git /opt/pm-core
cd /opt/pm-core
cp .env.example .env
```

At minimum, set:

- `DOMAIN`
- `ADMIN_EMAIL`
- `TRAEFIK_WEB_PORT=80`
- `TRAEFIK_WEBSECURE_PORT=443`

Then generate secrets and start the base stack:

```bash
./scripts/generate-secrets.sh
docker compose up -d
```

### 2. Prepare PostgreSQL extensions

Rivr requires these extensions:

- `postgis`
- `vector`
- `pg_trgm`

Preinstall them as a database admin before running Rivr migrations.

Do not make the Rivr app user a PostgreSQL superuser.

### 3. Deploy the Rivr person app

Clone and install only this repo:

```bash
git clone https://github.com/rivr-social/rivr-person.git
cd rivr-person
cp .env.example .env
pnpm install
pnpm build
```

For Docker:

```bash
docker build -t rivr-person:latest .
```

The runtime env must include:

```bash
INSTANCE_TYPE=person
INSTANCE_ID=<node-uuid>
INSTANCE_SLUG=<slug>
PRIMARY_AGENT_ID=<person-agent-uuid>
REGISTRY_URL=https://b.rivr.social/api/federation/registry
NEXTAUTH_URL=https://rivr.<your-domain>
NEXT_PUBLIC_BASE_URL=https://rivr.<your-domain>
DATABASE_URL=postgres://...
AUTH_SECRET=<real-secret>

# Federation-auth operating mode (see src/lib/instance-mode.ts).
# sovereign          — home-server deployments (e.g. rivr.camalot.me);
#                      enables seed-phrase / recovery-key UI.
# hosted-federated   — shared hosted deployments where global holds
#                      credentials; seed-phrase UI is suppressed.
# Defaults to `sovereign` when unset, matching the canonical Camalot deploy.
RIVR_INSTANCE_MODE=sovereign
```

The Camalot deploy (`rivr.camalot.me`, host `5.161.46.237`, container
`pmdl_rivr_person`) sets `RIVR_INSTANCE_MODE=sovereign` via its compose
env file under `/opt/pm-core`. A hosted rivr-person behind a global
shell should override this to `hosted-federated`.

### 4. Bind your existing Rivr agent

You need the UUID of your existing person agent from the current home instance.

That UUID becomes:

- `PRIMARY_AGENT_ID`
- the subject of export/import
- the target of federation home-instance cutover

### 5. Migrate your data

The intended migration path is:

1. export your person-owned data from the current home instance
2. import into the target person-instance DB
3. bootstrap the local node row
4. cut over global registry resolution to the new host

### 6. Verify

The deployed person instance should expose:

- `/api/health`
- `/api/myprofile`
- `/api/myprofile/manifest`
- `/api/profile/[username]`
- `/api/profile/[username]/manifest`
- `/profile`
- `/profile/[username]`

Run the bundled verifier:

```bash
BASE_URL=https://rivr.<your-domain> \
PROFILE_USERNAME=<your-username> \
pnpm federation:verify:e2e
```

### 7. Enable Autobot Access

Generate a token and add it to your env:

```bash
AIAGENT_MCP_TOKEN=$(openssl rand -hex 32)
```

Point your AI agent at the MCP endpoint:

```bash
# Discovery
curl https://rivr.<your-domain>/.well-known/mcp

# Authenticated tool call
curl -X POST https://rivr.<your-domain>/api/mcp \
  -H "Authorization: Bearer $AIAGENT_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Visit `/autobot` in the app to see MCP status, manage personas, and review autobot activity.

See `docs/AUTOBOT_MCP_SETUP.md` for the full MCP integration guide.

## Docs

- Quick start: `docs/QUICK_PERSON_INSTANCE.md`
- Full deploy runbook: `docs/PERSON_APP_DEPLOY_RUNBOOK.md`
- Cutover details: `docs/PERSON_INSTANCE_CUTOVER.md`
- Autobot/MCP setup: `docs/AUTOBOT_MCP_SETUP.md`

## Notes

- The PM Core links above are required because this app does not stand alone as “just a Next app”; it assumes the surrounding storage/network/DB foundation exists.
- The long-term product goal is a guided walkthrough where a user enters a domain and Rivr generates or executes the deployment plan automatically.
