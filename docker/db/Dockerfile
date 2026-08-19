# ── Local development database ─────────────────────────────────
# Postgres with the three extensions the Rivr person migrations require:
#
#   postgis   — geometry columns (agents.location, place/venue surfaces)
#   vector    — pgvector, embedding columns
#   pg_trgm   — trigram indexes for location search (0017)
#
# src/db/migrations/0000_init_extensions.sql CREATEs postgis and vector and
# RAISEs EXCEPTION if either is absent, so the binaries must exist in the
# image — requesting them from a migration is not enough.
#
# NOTE: docker-compose.sidecar.yml uses pgvector/pgvector:pg16, which has NO
# PostGIS. That stack cannot migrate an empty database; this image can.
#
# Build context for the `db` service in docker-compose.local.yml.

FROM postgis/postgis:16-3.4

# pgvector is not bundled with the postgis image. The upstream postgres image
# (which postgis builds on) already configures the PGDG apt repo, so the
# versioned package is available directly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-16-pgvector \
 && rm -rf /var/lib/apt/lists/*

# Runs once, on first boot of an empty data volume. Safe to re-run: every
# statement is IF NOT EXISTS. Delete the volume to re-trigger.
COPY init/10-extensions.sql /docker-entrypoint-initdb.d/10-extensions.sql
