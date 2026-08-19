# Rivr Person

**Sovereign, autobot-native Rivr instance for individuals.**

Rivr Person is the deployment surface for the canonical person app in the Rivr monorepo. It gives you full ownership of your Rivr identity — your profile, your data, your domain. It ships with a built-in MCP server so AI agents (autobots) can read and write on your behalf, a control plane UI for managing personas and reviewing autobot activity, and federation support for staying connected to the wider Rivr network.

## What Makes It Autobot-Native

- **MCP server built-in** — `POST /api/mcp` with token auth. Discovery at `GET /.well-known/mcp`.
- **Provenance logging** — every MCP tool call is recorded with actor, auth mode, args, result, and timing.
- **Control plane UI** — `/autobot` page with Status, Personas, and Activity tabs.
- **Persona management** — create alternate identities that autobots can operate as.
- **`AIAGENT_MCP_TOKEN`** — first-class env var, not an afterthought.

## Goal

Someone should be able to:

1. clone the canonical monorepo,
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

This repo is the deployment mirror and operator surface for the canonical monorepo app:

- person-instance app code under `src/`
- database schema and migrations under `src/db/`
- federation routing and resolution code under `src/lib/federation/`
- person migration and cutover scripts under `src/scripts/`
- a standalone `Dockerfile`
- example compose and env files
- operator docs under `docs/`

The canonical source of truth is `rivr-social/rivr-monorepo` under `apps/person`.

## Local Development

Takes a fresh clone to a running instance on your own machine. Everything runs
in Docker except the Next.js app, which runs on the host so you get fast
refresh and a debugger.

```bash
git clone https://github.com/rivr-social/rivr-person.git
cd rivr-person
scripts/dev-bootstrap.sh
pnpm dev                     # → http://localhost:3003
```

`scripts/dev-bootstrap.sh` is idempotent — re-run it any time. It checks your
toolchain and ports, generates `secrets/*.txt`, repairs `.env` for this
machine, starts Postgres/MinIO/Mailpit, installs dependencies, and builds the
schema. Pass `--seed` to also load development data.

Requirements: Docker, Node 22+, pnpm (`corepack enable`).

| Service        | URL                     |
| -------------- | ----------------------- |
| App            | http://localhost:3003   |
| Postgres       | localhost:5433 (`rivr_person`, user `rivr`) |
| Mail catcher   | http://localhost:8026   |
| Object storage | http://localhost:9003   |

Ports are offset from `rivr-global`'s dev stack (3000/5432/9000/1025) so both
can run side by side — see "Federating with a local Global" below.

```bash
docker compose -f docker-compose.local.yml down      # stop
docker compose -f docker-compose.local.yml down -v   # stop and destroy the database
```

### Creating the first account

A person instance hosts exactly one person, so two things are true out of the
box that will otherwise stop you:

1. **Local signup is disabled** unless `ALLOW_LOCAL_SIGNUP=true`. The bootstrap
   sets it for you. Turn it off before exposing the instance to anything but
   localhost.
2. **Passwords are not checked locally.** `src/auth.ts` sends the email and
   password to the global instance's `/api/federation/sso/issue` and only falls
   back to the local hash when global is *unreachable*; an explicit 401 from
   global fails the login closed. So an account created by local signup on this
   instance **cannot log in** while global is reachable and does not know that
   email.

The practical consequence: **register on your global instance, then sign in
here with those credentials.** Your session actor id is your *global* agent id.

Then make that identity the instance owner — `/sovereign-merge-confirm`,
`/settings`, `/builder` and the rest of the control plane are gated on the
session actor matching `PRIMARY_AGENT_ID`:

```bash
# the id from GET /api/auth/session after signing in
echo 'PRIMARY_AGENT_ID=<your-global-agent-id>' >> .env
# restart pnpm dev — the instance config is cached at module load
```

`.env.example` ships `PRIMARY_AGENT_ID=replace-with-person-agent-uuid`. That
placeholder is not inert: it reaches a `uuid` comparison and makes
`GET /api/federation/manifest` return 500. The bootstrap blanks it, which is a
supported state (the config type is `string | null`), but the owner-only
surfaces stay closed until you set it to a real id.

### Federating with a local Global

Run both instances and link them, which is the only way to exercise the
federation code without deploying:

1. Start `rivr-global` on port 3000 and this instance on 3003.
2. Sign in to global, open `/settings`, and enter `http://localhost:3003` under
   the sovereign link.
3. Approve on this side. Global verifies the token it issued *and* this
   instance's Ed25519 signature, then writes `nodes`, a `node_peers` row with
   `trustState: "trusted"`, and a `federation_entity_map` row.

The bootstrap points `REGISTRY_URL`, `NEXT_PUBLIC_GLOBAL_URL` and
`GLOBAL_IDENTITY_AUTHORITY_URL` at `http://localhost:3000`. Override with
`RIVR_GLOBAL_URL` if your global runs elsewhere.

> **`GLOBAL_IDENTITY_AUTHORITY_URL` matters.** It is absent from
> `.env.example`, and unset it defaults to `https://app.rivr.social` on
> anything that is not `NODE_ENV=production` — meaning a local instance sends
> real login attempts, passwords included, to the production RIVR. Keep it
> pinned locally.

Note that the merge is **one-directional**. Global ends up with a trusted peer
row and a shared secret; this instance records nothing and is never given the
secret. Wiring the return path is a separate manual step
(`pnpm federation:connect`, which needs `FEDERATION_*` variables that are also
not in `.env.example`).

### Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` | A `node_modules` installed elsewhere (different pnpm store path). Re-run with `CI=true`. |
| `role "rivr" does not exist` | A native Postgres is answering on the port instead of Docker's. Stop it, or re-run with `RIVR_DB_PORT=5434`. |
| `unsafe use of new value "..." of enum type` | `pnpm db:migrate` cannot build an empty database — drizzle wraps every migration in one transaction, and an `ALTER TYPE ... ADD VALUE` cannot be used before it commits. Use `scripts/dev-migrate-fresh.sh` (the bootstrap does). |
| `type "agent_type" already exists` | `dev-migrate-fresh.sh` was run against a database that already has the schema. Use `pnpm db:migrate` for incremental changes, or `down -v` first. |
| `PostGIS extension failed to install` | You are on a Postgres image without PostGIS. `docker-compose.local.yml` builds `docker/db`, which has it; `docker-compose.sidecar.yml` uses `pgvector/pgvector:pg16`, which does not. |
| Signup returns "Local signup is disabled on this sovereign instance." | `ALLOW_LOCAL_SIGNUP` is not `true`. See "Creating the first account". |
| `GET /api/federation/manifest` returns 500 | `PRIMARY_AGENT_ID` still holds the `.env.example` placeholder. |
| `GET /api/federation/manifest` returns 404 | `PRIMARY_AGENT_ID` is empty — expected until you set it. |
| Login fails with a correct password | Global is the credential authority. Check `GLOBAL_IDENTITY_AUTHORITY_URL`, that global is running, and that the account exists *there*. First request can also exceed the 10s timeout while global compiles the route in dev — retry. |
| `/settings` or `/sovereign-merge-confirm` redirects to `/` | The session actor does not match `PRIMARY_AGENT_ID`. These are owner-only. |

Features with no local equivalent — the GPU voice clone (Vast.ai), LiveKit,
Matrix bridges, Chatterbox TTS, the live-avatar worker — degrade rather than
block boot. The bootstrap blanks their production endpoints so a local instance
does not call someone else's servers.

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

Clone the canonical monorepo and build the person app from there:

```bash
git clone https://github.com/rivr-social/rivr-monorepo.git
cd rivr-monorepo/apps/person
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
# sovereign          — home-server deployments; enables seed-phrase / recovery-key UI.
# hosted-federated   — shared hosted deployments where global holds credentials;
#                      seed-phrase UI is suppressed.
# Defaults to `sovereign` when unset.
RIVR_INSTANCE_MODE=sovereign
```

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
