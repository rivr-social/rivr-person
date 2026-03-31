# Person App Deploy Runbook

This is the operator runbook for deploying a standalone `rivr-person` instance such as `rivr.camalot.me`.

Use this document if you are the agent responsible for bringing up the sovereign person instance, migrating the profile off `b.rivr.social`, and verifying the bespoke profile contract works on the target host.

## Canonical Source

- Repo: `rivr-person`
- App to deploy: the repo root app
- Build command: `pnpm build`
- Runtime command: `pnpm start`
- Docker build: `docker build -t rivr-person:latest .`

This repo is the source of truth. You do not need the full Rivr monorepo to deploy the person app.

## What This App Must Provide

The deployed person instance must expose all of the following:

- Person-instance root behavior controlled by env:
  - `INSTANCE_TYPE=person`
  - `PRIMARY_AGENT_ID=<person-agent-uuid>`
- Federation endpoints:
  - `/api/federation/registry`
  - `/api/federation/mutations`
  - `/api/federation/status`
- Bespoke profile contract endpoints:
  - `/api/myprofile`
  - `/api/myprofile/manifest`
  - `/api/profile/[username]`
  - `/api/profile/[username]/manifest`
- Profile UI surfaces:
  - `/profile`
  - `/profile/[username]`

## Preconditions

Before deployment:

1. DNS for your target host must already resolve to the server.
2. The target database must exist.
3. Required PostgreSQL extensions must be preinstalled by a DB admin:
   - `postgis`
   - `vector`
   - `pg_trgm`
4. The app user must remain a normal DB user. Do not grant PostgreSQL superuser to the app.
5. You must know the existing Rivr person agent UUID currently live on the source instance.
6. You must know or create a unique node UUID for the new person instance.

## Required Runtime Environment

Minimum required env:

```bash
NODE_ENV=production
NEXTAUTH_URL=https://rivr.example.com
NEXT_PUBLIC_BASE_URL=https://rivr.example.com
AUTH_SECRET=<real-secret>
DATABASE_URL=postgres://...

INSTANCE_TYPE=person
INSTANCE_ID=<target-node-uuid>
INSTANCE_SLUG=<slug>
PRIMARY_AGENT_ID=<existing-person-agent-uuid>
REGISTRY_URL=https://b.rivr.social/api/federation/registry

MINIO_ENDPOINT=<real-value>
MINIO_PORT=<real-value>
MINIO_ACCESS_KEY=<real-value>
MINIO_SECRET_KEY=<real-value>
MINIO_BUCKET_UPLOADS=<real-value>
MINIO_BUCKET_AVATARS=<real-value>
MINIO_BUCKET_EXPORTS=<real-value>
```

Commonly needed in production:

```bash
NODE_ADMIN_KEY=<local-admin-key>
REDIS_URL=<real-value>
STRIPE_SECRET_KEY=<real-value>
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=<real-value>
SMTP_HOST=<real-value>
SMTP_PORT=<real-value>
SMTP_USER=<real-value>
SMTP_PASS=<real-value>
SMTP_FROM=<real-value>
MAPBOX_TOKEN=<real-value>
NEXT_PUBLIC_MAPBOX_TOKEN=<real-value>
```

## Build And Deploy

### 1. Install and build

```bash
pnpm install
pnpm build
```

### 2. Deploy the app

Direct run:

```bash
pnpm start
```

Docker:

```bash
docker build -t rivr-person:latest .
docker run --env-file .env -p 3000:3000 rivr-person:latest
```

Compose example:

- `docker-compose.example.yml`

### 3. Run migrations

Run as the normal app user:

```bash
pnpm db:migrate
```

Do not try to create missing extensions from the app user.

## Migration And Cutover

### 1. Export from the source

```bash
DATABASE_URL=<source-db-url> \
PERSON_AGENT_ID=<existing-person-agent-uuid> \
OUTPUT_PATH=tmp/person.manifest.json \
pnpm federation:person:export
```

### 2. Import into the target

```bash
DATABASE_URL=<target-db-url> \
MANIFEST_PATH=tmp/person.manifest.json \
pnpm federation:person:import
```

### 3. Register and cut over the home instance

```bash
REGISTRY_URL=https://b.rivr.social/api/federation/registry \
NODE_ADMIN_KEY=<global-registry-admin-key> \
SOURCE_INSTANCE_ID=<source-instance-id> \
SOURCE_INSTANCE_SLUG=<source-slug> \
SOURCE_BASE_URL=https://b.rivr.social \
SOURCE_PRIMARY_AGENT_ID=<existing-person-agent-uuid> \
TARGET_INSTANCE_ID=<target-node-uuid> \
TARGET_INSTANCE_SLUG=<target-slug> \
TARGET_BASE_URL=https://rivr.example.com \
TARGET_PRIMARY_AGENT_ID=<existing-person-agent-uuid> \
TARGET_DISPLAY_NAME="<display-name>" \
TARGET_PUBLIC_KEY=<target-node-public-key> \
CUTOVER_PHASE=complete \
pnpm federation:person:cutover
```

### 4. Restart the target app

Ensure the running process has the final person-instance env values.

## Verification

Run the live verifier:

```bash
BASE_URL=https://rivr.example.com \
PROFILE_USERNAME=<your-username> \
SESSION_COOKIE='<next-auth-session-cookie-if-you-want-authenticated-checks>' \
pnpm federation:verify:e2e
```

The following must succeed:

1. `GET https://rivr.example.com/api/federation/registry?agentId=<person-agent-uuid>` resolves to `https://rivr.example.com`
2. `GET https://rivr.example.com/api/myprofile` returns `401` without auth and succeeds with your session
3. `GET https://rivr.example.com/api/myprofile/manifest` returns `401` without auth and succeeds with your session
4. `GET https://rivr.example.com/api/profile/<username>` succeeds publicly
5. `GET https://rivr.example.com/api/profile/<username>/manifest` succeeds publicly
6. `/profile` loads as the owner-facing editable profile
7. `/profile/<username>` loads as the public bespoke-profile surface

## Failure Modes

If the app boots but shows the home feed instead of the person profile:

- `PRIMARY_AGENT_ID` is missing or wrong
- `INSTANCE_TYPE` is not `person`

If migrations fail:

- extensions are missing
- or they were not preinstalled by a DB admin

If profile routes load but data is wrong:

- import may not have run
- cutover may not have completed
- `PRIMARY_AGENT_ID` may not match the migrated person agent

If federation resolution still points to the source host:

- `pnpm federation:person:cutover` did not complete
- target node ID/base URL values were wrong
- global registry was not updated with the correct admin key

## Related Docs

- `docs/PERSON_INSTANCE_CUTOVER.md`
- `docs/PERSON_INSTANCE_DEPLOYMENT_ISSUES.md`
