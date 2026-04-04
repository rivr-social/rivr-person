# Sovereign Deployment Guide

Deploy rivr-person with its full autobot sidecar stack on your own server.
This gives you a sovereign person instance with AI agent capabilities,
knowledge graph memory, voice transcription, and HTTPS out of the box.

## Service Topology

```
                         Internet
                            |
                     +------+------+
                     |   Traefik   |  :80 / :443
                     |  (reverse   |  automatic HTTPS
                     |   proxy)    |  via Let's Encrypt
                     +------+------+
                            |
              +-------------+-------------+
              |             |             |
    rivr.you.com    ai.you.com    chat.you.com
              |             |             |
     +--------+--+  +-------+------+  +--+----------+
     | rivr-person|  | openclaw-    |  | openclaw-   |
     | (Next.js)  |  | gateway      |  | web         |
     | :3000      |  | :18789       |  | :3001       |
     +-----+------+  +-------+------+  +------+------+
           |                  |                |
           |          +-------+------+         |
           |          | openclaw     |         |
           |          | config vol   |         |
           |          +--------------+         |
           |                                   |
     +-----+------+                    +-------+------+
     | PostgreSQL  |                    | voice-samples|
     | :5432       |                    | volume       |
     | rivr_person |                    +--------------+
     | cartoon_kg  |
     +-----+------+
           |
     +-----+------+
     | WhisperX   |
     | :9200      |
     | (speech-   |
     |  to-text)  |
     +------------+
```

### Network Isolation

```
rivr_proxy  (external)   -- Traefik <-> rivr-person, openclaw-gateway, openclaw-web
rivr_db     (internal)   -- PostgreSQL <-> rivr-person
rivr_app    (internal)   -- rivr-person <-> openclaw-gateway <-> openclaw-web <-> whisperx
```

Services on internal networks are not reachable from the internet.
Only Traefik-routed services are publicly accessible.


## Prerequisites

- A Linux server (Ubuntu 22.04+, Debian 12+, or similar)
  - Minimum 4 GB RAM, 2 vCPUs, 40 GB disk
  - Recommended: 8 GB RAM for comfortable operation with WhisperX
- Docker Engine 24+ and Docker Compose v2
- A domain name with DNS pointing to your server
- DNS A records for your domain:
  - `rivr.you.com` (or your chosen domain)
  - `ai.you.com` (OpenClaw gateway)
  - `chat.you.com` (OpenClaw web chat)
- An Anthropic API key (or OpenAI key) for the AI agent


## Quick Start

### 1. Clone the repository

```bash
git clone https://github.com/rivr-social/rivr-person.git
cd rivr-person
```

### 2. Prepare the OpenClaw web build context

Copy the token-server and web UI sources from the Autobot repository
into the sidecar build context:

```bash
# If you have the Autobot repo checked out alongside rivr-person:
cp ../Autobot/token-server/server.js sidecar/openclaw-web/server.js
cp ../Autobot/token-server/package.json sidecar/openclaw-web/package.json
cp -r ../Autobot/web/ sidecar/openclaw-web/web/
```

If you do not have the Autobot repo, you can skip the `openclaw-web`
service (comment it out in `docker-compose.sidecar.yml`). The main app
and agent gateway will still work; you just will not have the standalone
chat web UI.

### 3. Configure environment

```bash
cp .env.sidecar.example .env
```

Edit `.env` and fill in the required values. At minimum:

```bash
# Domain and TLS
DOMAIN=rivr.you.com
ACME_EMAIL=you@example.com

# Database passwords (generate with: openssl rand -hex 16)
POSTGRES_PASSWORD=<generated>
RIVR_DB_PASSWORD=<generated>
KG_DB_PASSWORD=<generated>

# App secrets (generate with: openssl rand -hex 32)
AUTH_SECRET=<generated>
NODE_ADMIN_KEY=<generated>
AIAGENT_MCP_TOKEN=<generated>
OPENCLAW_GATEWAY_TOKEN=<generated>

# Instance identity (generate UUIDs with: uuidgen)
INSTANCE_ID=<generated-uuid>
PRIMARY_AGENT_ID=<your-person-agent-uuid>

# Public URLs
NEXTAUTH_URL=https://rivr.you.com
NEXT_PUBLIC_BASE_URL=https://rivr.you.com
NEXT_PUBLIC_APP_URL=https://rivr.you.com

# LLM API key (at least one required)
ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Configure OpenClaw

Create the OpenClaw configuration volume and config file:

```bash
# Create a directory for OpenClaw config
mkdir -p openclaw-config

# Copy the example config
cp ../Autobot/config/openclaw.json.example openclaw-config/openclaw.json
```

Edit `openclaw-config/openclaw.json` and set:
- `gateway.auth.token` to match your `OPENCLAW_GATEWAY_TOKEN`
- `rivr.personUrl` to your `https://rivr.you.com`
- `rivr.mcpToken` to match your `AIAGENT_MCP_TOKEN`
- `rivr.primaryAgentId` to match your `PRIMARY_AGENT_ID`
- `messages.tts.providers.openai.apiKey` if using voice TTS

Then copy it into the Docker volume on first start, or mount it directly
by adding to the openclaw-gateway volumes in `docker-compose.sidecar.yml`:

```yaml
volumes:
  - ./openclaw-config:/home/node/.openclaw
```

### 5. Make init scripts executable

```bash
chmod +x sidecar/init-scripts/*.sh
```

### 6. Start the stack

```bash
docker compose -f docker-compose.sidecar.yml up -d
```

First start will:
- Pull/build all images (may take 5-10 minutes)
- Initialize PostgreSQL with both databases
- Obtain Let's Encrypt certificates
- Start all services

### 7. Verify

```bash
# Check all containers are running and healthy
docker compose -f docker-compose.sidecar.yml ps

# Check rivr-person health
curl -s https://rivr.you.com/api/health

# Check OpenClaw gateway health
curl -s https://ai.you.com/healthz

# Check WhisperX health
docker compose -f docker-compose.sidecar.yml exec whisperx \
  python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:9200/health').read())"
```


## Service Details

### rivr-person (Next.js app)

The main sovereign person application. Provides:
- Personal profile and public profile surfaces
- Autobot control plane UI (`/autobot`)
- MCP endpoint for AI agent access (`POST /api/mcp`)
- Federation API endpoints (`/api/federation/*`)
- Builder/bespoke site generation

### openclaw-gateway (AI agent runtime)

The OpenClaw conversational agent engine. Provides:
- Chat completions API
- Agent tool execution
- LiveKit avatar channel (when configured)
- Knowledge graph context injection via the livekit-avatar extension

### openclaw-web (token server + chat UI)

Express proxy that serves:
- Chat web interface
- LiveKit token generation
- Voice sample upload/management
- Digital twin job dispatch

### PostgreSQL

Runs two databases in one instance:
- `rivr_person` — the Next.js application database (Prisma-managed schema)
- `cartoon_kg` — the autobot knowledge graph (SPO triples, entities, transcripts)

### WhisperX

Self-hosted speech-to-text transcription:
- Runs on CPU by default
- Supports GPU acceleration (NVIDIA) for faster transcription
- Used by rivr-person for voice message and recording transcription


## GPU-Accelerated WhisperX

To enable GPU acceleration for WhisperX:

1. Install the NVIDIA Container Toolkit on your host:
   ```bash
   # Ubuntu/Debian
   curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
     sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
   distribution=$(. /etc/os-release; echo $ID$VERSION_ID)
   curl -s -L https://nvidia.github.io/libnvidia-container/$distribution/libnvidia-container.list | \
     sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
     sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
   sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   ```

2. Update `.env`:
   ```bash
   WHISPERX_DEVICE=cuda
   WHISPERX_COMPUTE_TYPE=float16
   ```

3. Uncomment the GPU deploy section in `docker-compose.sidecar.yml`
   under the whisperx service.

4. Rebuild and restart:
   ```bash
   docker compose -f docker-compose.sidecar.yml up -d --build whisperx
   ```


## Adding MinIO (Object Storage)

The sidecar stack does not include MinIO by default. If you need
S3-compatible object storage for file uploads, avatars, and exports,
add this to `docker-compose.sidecar.yml`:

```yaml
services:
  minio:
    image: minio/minio
    container_name: rivr_minio
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-minioadmin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - rivr_minio_data:/data
    networks:
      - app
      - proxy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
      interval: 30s
      timeout: 10s
      retries: 5
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.minio.rule=Host(`s3.${DOMAIN}`)"
      - "traefik.http.routers.minio.entrypoints=websecure"
      - "traefik.http.routers.minio.tls.certresolver=letsencrypt"
      - "traefik.http.services.minio.loadbalancer.server.port=9000"

volumes:
  rivr_minio_data:
    driver: local
```

Then add `s3.you.com` to your DNS A records.


## Upgrading

### Pull latest code and rebuild

```bash
cd rivr-person
git pull origin main

# Rebuild only the services that changed
docker compose -f docker-compose.sidecar.yml build rivr-person
docker compose -f docker-compose.sidecar.yml up -d rivr-person

# Or rebuild everything
docker compose -f docker-compose.sidecar.yml up -d --build
```

### Upgrade OpenClaw

If using the official image:

```bash
docker compose -f docker-compose.sidecar.yml pull openclaw-gateway
docker compose -f docker-compose.sidecar.yml up -d openclaw-gateway
```

If building locally, pull the latest Autobot/cartoon/openclaw source
and rebuild:

```bash
docker compose -f docker-compose.sidecar.yml build openclaw-gateway
docker compose -f docker-compose.sidecar.yml up -d openclaw-gateway
```

### Database migrations

rivr-person uses Prisma for database migrations. After upgrading:

```bash
docker compose -f docker-compose.sidecar.yml exec rivr-person \
  npx prisma migrate deploy
```

### Cleanup old images

```bash
docker image prune -f
docker builder prune -af
```


## Troubleshooting

### Certificates not issuing

- Verify DNS A records point to your server IP for all three subdomains
- Check that ports 80 and 443 are open in your firewall
- Check Traefik logs:
  ```bash
  docker compose -f docker-compose.sidecar.yml logs traefik
  ```
- Let's Encrypt has rate limits. For testing, set in `.env`:
  ```bash
  # Use staging CA to avoid rate limits during setup
  # Remove this line for production certificates
  ```
  And add to the Traefik command in `docker-compose.sidecar.yml`:
  ```
  - "--certificatesresolvers.letsencrypt.acme.caserver=https://acme-staging-v02.api.letsencrypt.org/directory"
  ```

### PostgreSQL init scripts not running

Init scripts only run on first start with an empty data volume. If you
need to re-run them:

```bash
# WARNING: This destroys all database data
docker compose -f docker-compose.sidecar.yml down
docker volume rm rivr_postgres_data
docker compose -f docker-compose.sidecar.yml up -d
```

### rivr-person cannot connect to database

- Verify PostgreSQL is healthy:
  ```bash
  docker compose -f docker-compose.sidecar.yml exec postgres pg_isready
  ```
- Verify the database and user exist:
  ```bash
  docker compose -f docker-compose.sidecar.yml exec postgres \
    psql -U postgres -c "\l"
  ```
- Check that `RIVR_DB_PASSWORD` in `.env` matches what the init script
  used on first start. If they differ, either reset the volume or
  update the password manually:
  ```bash
  docker compose -f docker-compose.sidecar.yml exec postgres \
    psql -U postgres -c "ALTER USER rivr WITH PASSWORD 'new-password';"
  ```

### OpenClaw gateway not starting

- Check logs:
  ```bash
  docker compose -f docker-compose.sidecar.yml logs openclaw-gateway
  ```
- Verify `openclaw.json` is properly mounted and valid JSON
- Verify the gateway token matches between `.env` and `openclaw.json`

### WhisperX out of memory

The `base` model needs about 1 GB RAM. Larger models need more:
- `small`: ~2 GB
- `medium`: ~5 GB
- `large-v3`: ~10 GB

Adjust `WHISPERX_MEMORY_LIMIT` in `.env` and consider GPU acceleration
for larger models.

### Viewing logs

```bash
# All services
docker compose -f docker-compose.sidecar.yml logs -f

# Specific service
docker compose -f docker-compose.sidecar.yml logs -f rivr-person

# Last 100 lines
docker compose -f docker-compose.sidecar.yml logs --tail=100 openclaw-gateway
```

### Full stack restart

```bash
docker compose -f docker-compose.sidecar.yml down
docker compose -f docker-compose.sidecar.yml up -d
```

### Factory reset (destroys all data)

```bash
docker compose -f docker-compose.sidecar.yml down -v
docker compose -f docker-compose.sidecar.yml up -d
```


## Resource Requirements

| Service           | Min RAM | Recommended RAM | CPU   |
|-------------------|---------|-----------------|-------|
| Traefik           | 64 MB   | 256 MB          | 0.1   |
| PostgreSQL        | 256 MB  | 1 GB            | 0.5   |
| rivr-person       | 256 MB  | 1 GB            | 0.5   |
| openclaw-gateway  | 256 MB  | 1 GB            | 0.5   |
| openclaw-web      | 64 MB   | 256 MB          | 0.1   |
| WhisperX (CPU)    | 1 GB    | 2 GB            | 1.0   |
| **Total**         | **~2 GB** | **~5.5 GB**   | **~2.7** |

A Hetzner CPX31 (4 vCPU, 8 GB RAM) or equivalent is a comfortable
target for running the full stack.
