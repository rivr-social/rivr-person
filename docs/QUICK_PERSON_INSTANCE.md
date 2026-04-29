# Spin Up Your Own Rivr Person Instance

A sovereign personal profile on your own server.

## What You Need

- a server running Docker
- a domain name pointing to that server
- your person agent UUID from an existing Rivr instance
- a PM Core / Docker Lab host foundation

## Steps

### 1. Bring up PM Core

```bash
git clone https://github.com/peermesh/docker-lab.git /opt/pm-core
cd /opt/pm-core
cp .env.example .env
./scripts/generate-secrets.sh
docker compose up -d
```

Set at least:

- `DOMAIN`
- `ADMIN_EMAIL`
- `TRAEFIK_WEB_PORT=80`
- `TRAEFIK_WEBSECURE_PORT=443`

### 2. Prepare PostgreSQL

Rivr requires:

- `postgis`
- `vector`
- `pg_trgm`

Create them as a database admin before running app migrations. Do not grant PostgreSQL superuser to the app user.

### 3. Clone the canonical monorepo

```bash
git clone https://github.com/rivr-social/rivr-monorepo.git /opt/rivr-monorepo
cd /opt/rivr-monorepo/apps/person
cp .env.example .env
```

### 4. Configure `.env`

Set the required values:

```bash
DATABASE_URL=postgresql://rivr:...@postgres:5432/rivr_person
AUTH_SECRET=<long-random-secret>
NEXTAUTH_URL=https://rivr.<your-domain>
NEXT_PUBLIC_BASE_URL=https://rivr.<your-domain>
INSTANCE_TYPE=person
INSTANCE_ID=<new-node-uuid>
INSTANCE_SLUG=<your-slug>
PRIMARY_AGENT_ID=<your-existing-person-agent-uuid>
REGISTRY_URL=https://b.rivr.social/api/federation/registry
NODE_ADMIN_KEY=<strong-admin-key>
```

### 5. Install and build

```bash
pnpm install
pnpm build
```

### 6. Run migrations

```bash
pnpm db:migrate
```

### 7. Start the app

For a direct process run:

```bash
pnpm start
```

For Docker:

```bash
docker build -t rivr-person:latest .
docker run --env-file .env -p 3000:3000 rivr-person:latest
```

### 8. Migrate your existing profile

Export from the current home instance:

```bash
DATABASE_URL=<source-db-url> \
PERSON_AGENT_ID=<your-agent-uuid> \
OUTPUT_PATH=tmp/person.manifest.json \
pnpm federation:person:export
```

Import into the new person instance:

```bash
DATABASE_URL=<target-db-url> \
MANIFEST_PATH=tmp/person.manifest.json \
pnpm federation:person:import
```

Cut over federation resolution:

```bash
REGISTRY_URL=https://b.rivr.social/api/federation/registry \
NODE_ADMIN_KEY=<global-registry-admin-key> \
SOURCE_INSTANCE_ID=<source-instance-id> \
SOURCE_INSTANCE_SLUG=<source-slug> \
SOURCE_BASE_URL=https://b.rivr.social \
SOURCE_PRIMARY_AGENT_ID=<your-agent-uuid> \
TARGET_INSTANCE_ID=<target-node-id> \
TARGET_INSTANCE_SLUG=<your-slug> \
TARGET_BASE_URL=https://rivr.<your-domain> \
TARGET_PRIMARY_AGENT_ID=<your-agent-uuid> \
TARGET_DISPLAY_NAME="<your-display-name>" \
TARGET_PUBLIC_KEY=<target-node-public-key> \
CUTOVER_PHASE=complete \
pnpm federation:person:cutover
```

### 9. Verify

```bash
curl https://rivr.<your-domain>/api/health
BASE_URL=https://rivr.<your-domain> \
PROFILE_USERNAME=<your-username> \
pnpm federation:verify:e2e
```

The instance is correctly installed when:

- `/api/health` returns healthy
- `/api/profile/<username>` works publicly
- `/api/myprofile` is gated without auth and works with your session
- federation registry resolution points your agent to your new host
