#!/usr/bin/env bash
#
# dev-bootstrap.sh — take a fresh clone to a running local Rivr person instance.
#
# WHY: nothing in this repo took a clean checkout to a running app. What
# shipped was:
#   * docker-compose.example.yml — the app service alone, `build: context: .`,
#     pointed at a DATABASE_URL you were expected to already have. No database.
#   * docker-compose.sidecar.yml — the full production sidecar (Traefik,
#     OpenClaw, WhisperX). It does define a postgres, but on the
#     pgvector/pgvector:pg16 image, which has no PostGIS — and
#     0000_init_extensions.sql RAISEs EXCEPTION without PostGIS. So that stack
#     cannot migrate an empty database either.
#   * .env.example — production-shaped, with placeholder values that produce a
#     silently wrong instance rather than a loud failure (see step 3).
# docker-compose.local.yml supplies the services; this script supplies the
# configuration and the schema.
#
# WHAT IT DOES (idempotent — safe to re-run):
#   1. Checks Docker, Node and pnpm are available, and that the ports are free.
#   2. Generates any missing secrets/*.txt with random values.
#   3. Creates .env from .env.example if absent, then repairs the values that
#      must match this machine (backing the old file up to .env.bak).
#   4. Starts db + minio + mailpit (NOT the app — you run that on the host).
#   5. Waits for Postgres to report healthy.
#   6. Installs dependencies and builds the schema.
#
# USAGE: scripts/dev-bootstrap.sh [--seed]
#   --seed   also run pnpm db:seed after migrating
#
# Then: pnpm dev   → http://localhost:3003

set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

SEED=0
[ "${1:-}" = "--seed" ] && SEED=1

# Ports. These are offset from rivr-global's dev stack (3000/5432/9000/1025) so
# both instances can run at once — which is the point, since federation needs
# two sides. Override RIVR_DB_PORT if 5433 is also taken.
export RIVR_DB_PORT="${RIVR_DB_PORT:-5433}"
APP_PORT="${RIVR_APP_PORT:-3003}"          # matches `next dev --port 3003`
GLOBAL_URL="${RIVR_GLOBAL_URL:-http://localhost:3000}"
MINIO_PORT=9002
SMTP_PORT=1026

COMPOSE=(docker compose -f docker-compose.local.yml)
INFRA=(db minio createbuckets mailpit)

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mdev-bootstrap: %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. preflight ───────────────────────────────────────────────
say "Checking prerequisites"
command -v docker >/dev/null 2>&1 || die "docker not found. Install Docker Desktop, then re-run."
docker info >/dev/null 2>&1        || die "the Docker daemon isn't running. Start Docker Desktop, then re-run."
ok "docker $(docker --version | sed 's/Docker version //; s/,.*//')"
command -v node >/dev/null 2>&1 || die "node not found (Node 22+ required — see package.json engines)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node 22+ required (found $(node -v))."
ok "node $(node -v)"
command -v pnpm >/dev/null 2>&1 || die "pnpm not found. Try: corepack enable"
ok "pnpm $(pnpm --version)"

# A native Postgres binds 127.0.0.1:5433 while Docker binds *:5433, so BOTH can
# bind at once — and `localhost` then reaches the native one, producing an
# obscure `role "rivr" does not exist` from entirely the wrong database. Refuse
# rather than hand that failure to the next person.
if lsof -nP -iTCP:"$RIVR_DB_PORT" -sTCP:LISTEN 2>/dev/null | grep -qv '^COMMAND'; then
  if ! lsof -nP -iTCP:"$RIVR_DB_PORT" -sTCP:LISTEN 2>/dev/null | grep -q 'com.docke'; then
    warn "something other than Docker is listening on port $RIVR_DB_PORT:"
    lsof -nP -iTCP:"$RIVR_DB_PORT" -sTCP:LISTEN 2>/dev/null | sed -n '2,4p' | sed 's/^/      /'
    die "free that port, or re-run with RIVR_DB_PORT=<other>."
  fi
fi
ok "port $RIVR_DB_PORT available"

# ── 2. secrets ─────────────────────────────────────────────────
say "Checking secrets/ (gitignored — generated locally, never committed)"
mkdir -p secrets
# Node is already a hard prerequisite, so use it rather than a
# `tr </dev/urandom | head -c` pipeline: under `set -o pipefail` that pipeline
# fails whenever `head` exits first and `tr` takes the SIGPIPE, which happens
# often enough to break a clean run and never on a re-run (the files exist by
# then). Hex only — these values get inlined into .env and a URL.
randhex() { node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))'; }

gen() {
  local f="secrets/$1"
  if [ -s "$f" ]; then
    ok "$1 already present"
  else
    randhex > "$f"
    ok "$1 generated"
  fi
}
gen db_password.txt
gen minio_secret.txt
gen auth_secret.txt

# ── 3. .env ────────────────────────────────────────────────────
say "Checking .env"
if [ ! -f .env ]; then
  cp .env.example .env
  ok ".env created from .env.example"
fi

# .env.example is production-shaped. Several of its values are not merely
# unset but WRONG for a local instance, and each fails quietly rather than
# loudly, so repair them instead of trusting the operator to notice:
#
#   DATABASE_URL       placeholder password, and a `postgres` hostname that
#                      only resolves inside a compose network.
#   NEXT_PUBLIC_APP_URL  federation.ts:getBaseUrl() falls back to
#                      http://localhost:3000 when this is unset — but `pnpm
#                      dev` binds 3003. An unconfigured instance therefore
#                      publishes /api/federation/manifest advertising a base
#                      URL it is not listening on, and every peer that trusts
#                      the manifest calls the wrong port.
#   REGISTRY_URL       points at app.rivr.social — a local instance must not
#                      announce itself to production.
#   MINIO_*/SMTP_*     service names from a compose network, not host ports.
BACKED_UP=0
#
# Values are single-quoted when they contain anything a shell would act on.
# This matters: step 6 does `set -a; . ./.env` before migrating, and .env.example
# ships `INSTANCE_NAME=Rivr Person` unquoted — which Next.js's dotenv parser
# reads fine but a POSIX shell reads as the command `Person`.
env_quote() {
  case "$1" in
    *[!A-Za-z0-9_./:@+-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *)                     printf '%s' "$1" ;;
  esac
}
set_env() {
  local key="$1" val="$2" quoted have
  quoted="$(env_quote "$val")"
  have="$(sed -n "s|^${key}=||p" .env | head -1)"
  [ "$have" = "$quoted" ] && return 0
  if [ "$BACKED_UP" -eq 0 ]; then cp .env .env.bak; BACKED_UP=1; fi
  # Use a temp file rather than `sed -i`, which differs between BSD (macOS)
  # and GNU. Drop every existing occurrence, then append the correct one.
  grep -v "^${key}=" .env > .env.tmp || true
  printf '%s=%s\n' "$key" "$quoted" >> .env.tmp
  mv .env.tmp .env
  CHANGED="${CHANGED} ${key}"
}
CHANGED=""

DB_PASS="$(cat secrets/db_password.txt)"
MINIO_PASS="$(cat secrets/minio_secret.txt)"

set_env NODE_ENV development
set_env PORT "$APP_PORT"
set_env DATABASE_URL "postgresql://rivr:${DB_PASS}@localhost:${RIVR_DB_PORT}/rivr_person"

# Identity / URLs.
set_env NEXTAUTH_URL "http://localhost:${APP_PORT}"
set_env AUTH_TRUST_HOST "true"
set_env NEXT_PUBLIC_BASE_URL "http://localhost:${APP_PORT}"
set_env NEXT_PUBLIC_APP_URL "http://localhost:${APP_PORT}"
set_env NEXT_PUBLIC_DOMAIN "localhost"
set_env NEXT_PUBLIC_GLOBAL_URL "$GLOBAL_URL"
set_env REGISTRY_URL "${GLOBAL_URL}/api/federation/registry"
set_env NEXT_PUBLIC_REGISTRY_URL "${GLOBAL_URL}/api/federation/registry"

# THE CREDENTIAL AUTHORITY. auth.ts does not check passwords locally first: it
# POSTs the email and password to the global instance's /api/federation/sso/issue
# and only falls back to the local bcrypt hash if global is UNREACHABLE
# (lib/auth/global-credential-authority.ts). Which global it asks comes from
# GLOBAL_IDENTITY_AUTHORITY_URL — a variable .env.example never mentions.
#
# Unset, the resolver throws only when NODE_ENV=production; everywhere else it
# silently defaults to https://app.rivr.social. So a developer running this repo
# locally sends every login attempt, plaintext password included, to the
# production RIVR instance — and since production returns 401 for an account it
# has never heard of, and 401 is treated as an explicit rejection rather than a
# miss, the login then fails closed anyway.
#
# Pin it at the local global so credentials stay on this machine.
set_env GLOBAL_IDENTITY_AUTHORITY_URL "$GLOBAL_URL"

# Federation node identity. ensureLocalNode() reads NODE_SLUG / NODE_ROLE /
# NODE_DISPLAY_NAME, none of which .env.example mentions; NODE_SLUG falls back
# to INSTANCE_SLUG and NODE_ROLE now derives from INSTANCE_TYPE, so setting the
# INSTANCE_* triple is sufficient. Name them anyway — this is the identity a
# peer sees, and it should not be a silent default.
set_env INSTANCE_TYPE person
set_env INSTANCE_SLUG "${RIVR_INSTANCE_SLUG:-person-local}"
set_env INSTANCE_NAME "${RIVR_INSTANCE_NAME:-Local Person}"
set_env NODE_SLUG "${RIVR_INSTANCE_SLUG:-person-local}"
set_env NODE_DISPLAY_NAME "${RIVR_INSTANCE_NAME:-Local Person}"
set_env RIVR_INSTANCE_MODE sovereign

# A person instance hosts exactly one person, so auth.ts:signupAction refuses
# local signup outright unless ALLOW_LOCAL_SIGNUP is the string "true"
# (lib/auth/sovereign-owner.ts:isLocalSignupAllowed). In production the owner
# arrives by SSO from Global, or is seeded out of band. But .env.example does
# not mention this variable, so a fresh clone boots into an instance where the
# FIRST account cannot be created by any route the UI offers — the signup form
# returns "Local signup is disabled on this sovereign instance."
# Local development needs a way in, so open it here, explicitly.
#
# Turn this OFF before exposing an instance to anything but localhost: with it
# on, anyone who can reach the signup page can create an account on a host that
# is meant to have exactly one owner.
set_env ALLOW_LOCAL_SIGNUP true
# NODE_ROLE is deliberately NOT set. The node_role vocabulary is
# group/locale/basin/global — there is no `person` role, and a person instance
# federates as `group` (federation.ts:instanceTypeToNodeRole). getNodeRole()
# silently discards any unrecognised value and derives the right one from
# INSTANCE_TYPE, so setting NODE_ROLE here could only be wrong or redundant.

# One-time random values. Only minted if still the .env.example placeholder,
# so re-running never rotates a secret out from under a running instance.
mint_if_placeholder() {
  local key="$1" val="$2" have
  have="$(sed -n "s|^${key}=||p" .env | head -1)"
  case "$have" in
    ""|replace-*) set_env "$key" "$val" ;;
  esac
}
mint_if_placeholder AUTH_SECRET "$(cat secrets/auth_secret.txt)"
mint_if_placeholder NODE_ADMIN_KEY "$(randhex)"
mint_if_placeholder AIAGENT_MCP_TOKEN "$(randhex)"
mint_if_placeholder INSTANCE_ID "$(node -p 'crypto.randomUUID()')"

# PRIMARY_AGENT_ID names the local agent that owns this instance, and it cannot
# be minted here: that agent does not exist until you sign up. The config layer
# already treats it as `string | null` and every consumer null-guards, so EMPTY
# is a supported state — but .env.example ships the literal string
# `replace-with-person-agent-uuid`, which is truthy, reaches a uuid comparison,
# and makes GET /api/federation/manifest fail with
#   invalid input syntax for type uuid: "replace-with-person-agent-uuid"
# The manifest is the first thing a peer fetches, so an instance configured
# straight from .env.example cannot federate at all. Blank the placeholder;
# README explains how to fill it in after the first account exists.
HAVE_PRIMARY="$(sed -n 's|^PRIMARY_AGENT_ID=||p' .env | head -1)"
case "$HAVE_PRIMARY" in
  replace-*) set_env PRIMARY_AGENT_ID "" ;;
esac

# Object storage + mail, on the host ports docker-compose.local.yml publishes.
set_env MINIO_ENDPOINT localhost
set_env MINIO_PORT "$MINIO_PORT"
set_env MINIO_USE_SSL false
set_env MINIO_ACCESS_KEY minioadmin
set_env MINIO_SECRET_KEY "$MINIO_PASS"
set_env MINIO_ROOT_USER minioadmin
set_env MINIO_ROOT_PASSWORD "$MINIO_PASS"
set_env NEXT_PUBLIC_MINIO_URL "http://localhost:${MINIO_PORT}"
set_env ASSET_PUBLIC_BASE_URL "http://localhost:${MINIO_PORT}"
set_env SMTP_HOST localhost
set_env SMTP_PORT "$SMTP_PORT"
set_env SMTP_SECURE false
set_env SMTP_FROM "noreply@rivr.local"

# External lanes this repo integrates with that have no local equivalent: the
# GPU voice clone (Vast.ai), the OpenClaw chat proxy, the knowledge-graph API,
# LiveKit, Matrix bridges, the live-avatar worker. They must degrade, not boot
# the app — blanking the production endpoints keeps a local instance from
# calling someone else's servers.
set_env OPENCLAW_URL ""
set_env AUTOBOT_KG_URL ""
set_env AUTOBOT_KG_TOKEN ""

if [ -n "$CHANGED" ]; then
  ok "repaired:$CHANGED"
  [ "$BACKED_UP" -eq 1 ] && warn "previous .env saved as .env.bak"
else
  ok ".env already correct"
fi
warn "Stripe and Mapbox keys are left empty — those features stay off locally"

# ── 4. infrastructure ──────────────────────────────────────────
say "Starting infrastructure (db, minio, mailpit)"
"${COMPOSE[@]}" up -d --build "${INFRA[@]}"
ok "containers up"

# ── 5. wait for postgres ───────────────────────────────────────
say "Waiting for Postgres to become healthy"
for i in $(seq 1 60); do
  STATE="$(docker inspect -f '{{.State.Health.Status}}' rivr-person-dev-db 2>/dev/null || echo starting)"
  [ "$STATE" = "healthy" ] && { ok "postgres healthy after ${i}s"; break; }
  [ "$i" -eq 60 ] && die "postgres did not become healthy in 60s. Check: docker logs rivr-person-dev-db"
  sleep 1
done

# ── 6. dependencies + schema ───────────────────────────────────
say "Installing dependencies"
pnpm install --frozen-lockfile
ok "dependencies installed"

# `next dev` loads .env by itself, but src/db/migrate.ts is a bare tsx script
# reading process.env directly — its own docstring shows DATABASE_URL being
# passed by the caller. Export .env first, or it exits with "DATABASE_URL
# environment variable is not set".
say "Building the schema"
set -a; . ./.env; set +a
scripts/dev-migrate-fresh.sh
ok "schema up to date"

if [ "$SEED" -eq 1 ]; then
  say "Seeding development data"
  pnpm db:seed
  ok "seeded"
fi

# ── done ───────────────────────────────────────────────────────
cat <<DONE

$(printf '\033[1m')Ready.$(printf '\033[0m')

  pnpm dev              the app          http://localhost:${APP_PORT}
                        mail catcher     http://localhost:8026
                        object storage   http://localhost:9003

  Stop infrastructure:  docker compose -f docker-compose.local.yml down
  Database (host):      localhost:${RIVR_DB_PORT}  (db rivr_person, user rivr)
  Reset the database:   docker compose -f docker-compose.local.yml down -v

  To federate with a local rivr-global (default http://localhost:3000):
  start both, then paste http://localhost:${APP_PORT} into Global's
  /settings → sovereign merge. See README "Federating with a local Global".

DONE
