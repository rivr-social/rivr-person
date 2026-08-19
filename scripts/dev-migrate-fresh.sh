#!/usr/bin/env bash
#
# dev-migrate-fresh.sh — build a Rivr person schema from zero on a LOCAL database.
#
# WHY THIS EXISTS: `pnpm db:migrate` cannot build an empty database. Verified
# 2026-08-19 against a fresh rivr_person:
#
#   [migrate] Migration failed: unsafe use of new value "voucher"
#             of enum type resource_type
#
# drizzle-orm's pg migrator wraps EVERY pending migration in ONE transaction
# (pg-core/dialect.js: session.transaction around the whole loop).
# 0001_rea_expansion does `ALTER TYPE resource_type ADD VALUE 'voucher'`, and a
# later migration in the same run USES that value — which Postgres forbids until
# the ALTER TYPE has committed. Twelve migrations in this repo add enum values,
# so this is structural, not a one-off. On the live databases each migration was
# applied when it was written, in its own transaction, so the conflict never
# surfaced there. From zero it fails on the second file.
#
# This script applies each .sql file through psql, which autocommits — letting
# ALTER TYPE commit before later statements use the value — and then stamps
# drizzle's journal table so a subsequent `pnpm db:migrate` correctly sees the
# schema as current.
#
# It honours the `-- drizzle-journal: manual` header (see
# scripts/check-migration-journal.mjs). Files carrying it are supervised
# backfills that are deliberately outside the journal — currently
# 0055_reconcile_federation_owner_id_split — and must not be auto-applied.
# NOTE this differs from rivr-global's version of this script, which applies
# every file in the directory; global has no manual-marked migrations.
#
# SCOPE: local development only. It deliberately does NOT edit any migration
# file, because those files' hashes are recorded in the live databases' journal
# tables. Fixing this properly means changing migration history and has to be
# planned against production.
#
# USAGE: scripts/dev-migrate-fresh.sh [--force]
#   Builds the schema on an EMPTY database and stops if one is already there.
#   The individual .sql files are NOT idempotent — 0000_panoramic_iron_man
#   opens with a bare `CREATE TYPE agent_type`, so a second run dies on
#   `type "agent_type" already exists`. Once the schema exists, incremental
#   changes go through `pnpm db:migrate` as normal; to rebuild from zero,
#   `docker compose -f docker-compose.local.yml down -v` first.
#
#   --force applies every file anyway. Only useful when you know the failures
#   are harmless.
#
#   NOTE: rivr-global's copy of this script carries a docstring claiming it is
#   safe to re-run. It is not, for the same reason.

set -euo pipefail
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

MIG_DIR="src/db/migrations"
CONTAINER="${RIVR_DB_CONTAINER:-rivr-person-dev-db}"
DB_NAME="${RIVR_DB_NAME:-rivr_person}"
DB_USER="${RIVR_DB_USER:-rivr}"
MANUAL_MARKER="drizzle-journal: manual"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '    \033[33m·\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mdev-migrate-fresh: %s\033[0m\n' "$*" >&2; exit 1; }

docker inspect "$CONTAINER" >/dev/null 2>&1 \
  || die "container '$CONTAINER' not found. Run scripts/dev-bootstrap.sh first."

PSQL=(docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q)

# Refuse a second run rather than failing halfway through it. PostGIS creates
# three of its own relations in `public` on extension install, so those don't
# count as "the schema is already here".
EXISTING="$("${PSQL[@]}" -t -A -c "
  select count(*) from information_schema.tables
   where table_schema='public'
     and table_name not in ('spatial_ref_sys','geometry_columns','geography_columns')
")"
if [ "${EXISTING:-0}" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
  ok "$DB_NAME already has $EXISTING tables — nothing to build"
  printf '      Incremental changes:  pnpm db:migrate\n'
  printf '      Rebuild from zero:    docker compose -f docker-compose.local.yml down -v\n'
  exit 0
fi

say "Applying migrations to $DB_NAME"
COUNT=0
SKIPPED=0
for f in $(ls "$MIG_DIR"/*.sql | sort); do
  TAG="$(basename "$f" .sql)"
  if grep -q "$MANUAL_MARKER" "$f"; then
    skip "$(printf '%-52s' "$TAG") hand-run (drizzle-journal: manual)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  if "${PSQL[@]}" < "$f" >/dev/null 2>/tmp/rivr-person-mig-err; then
    COUNT=$((COUNT + 1))
    printf '    %-52s ok\n' "$TAG"
  else
    printf '\n\033[31m    FAILED: %s\033[0m\n' "$TAG" >&2
    sed 's/^/      /' /tmp/rivr-person-mig-err >&2
    die "stopped at $TAG ($COUNT applied before it)"
  fi
done
ok "$COUNT files applied, $SKIPPED hand-run file(s) skipped"

# Stamp drizzle's journal so `pnpm db:migrate` treats the schema as current.
# hash = sha256 of the raw file; created_at = the journal's `when`. This
# matches drizzle-orm/migrator.js readMigrationFiles(). Manual-marked files are
# absent from the journal by design, so they are not stamped either.
say "Stamping drizzle journal"
node -e '
const fs = require("fs"), crypto = require("crypto");
const dir = "src/db/migrations";
const journal = JSON.parse(fs.readFileSync(dir + "/meta/_journal.json", "utf8"));
const rows = journal.entries.map((e) => {
  const sql = fs.readFileSync(`${dir}/${e.tag}.sql`, "utf8");
  const hash = crypto.createHash("sha256").update(sql).digest("hex");
  return `('"'"'${hash}'"'"',${e.when})`;
});
console.log(`CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
DELETE FROM drizzle.__drizzle_migrations;
INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ${rows.join(",")};`);
' | "${PSQL[@]}"
ok "journal stamped ($(node -p 'JSON.parse(require("fs").readFileSync("src/db/migrations/meta/_journal.json","utf8")).entries.length') entries)"

say "Verifying"
"${PSQL[@]}" -t -c "select count(*)||' tables' from information_schema.tables where table_schema='public';"
"${PSQL[@]}" -t -c "select count(*)||' journal rows' from drizzle.__drizzle_migrations;"
ok "schema built. 'pnpm db:migrate' should now report nothing to do."
