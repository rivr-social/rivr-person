# Rivr Person

Standalone Rivr person-instance app and deployment guide.

This repo is the small sovereign-profile distribution for people who want to run their own Rivr home instance, point their existing Rivr agent at it, and cut over cleanly from a shared host such as `b.rivr.social`.

## Goal

Someone should be able to:

1. clone this repo,
2. provision the PM Core host stack,
3. deploy the person app,
4. bind their existing Rivr agent,
5. import their data,
6. update federation home-instance resolution,
7. land on their own `rivr.<domain>` profile.

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

## Docs

- Quick start: `docs/QUICK_PERSON_INSTANCE.md`
- Full deploy runbook: `docs/PERSON_APP_DEPLOY_RUNBOOK.md`
- Cutover details: `docs/PERSON_INSTANCE_CUTOVER.md`

## Notes

- The PM Core links above are required because this app does not stand alone as “just a Next app”; it assumes the surrounding storage/network/DB foundation exists.
- The long-term product goal is a guided walkthrough where a user enters a domain and Rivr generates or executes the deployment plan automatically.
