#!/bin/bash
# ==============================================================
# rivr-person Sidecar — Database Initialization
# ==============================================================
# Creates the rivr_person application database and user.
# Runs on first PostgreSQL container start with an empty data volume.
#
# Environment variables (set via docker-compose.sidecar.yml):
#   RIVR_DB_USER     — app database user (default: rivr)
#   RIVR_DB_PASSWORD — app database password (REQUIRED)
#   RIVR_DB_NAME     — app database name (default: rivr_person)
# ==============================================================

set -euo pipefail

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

DB_USER="${RIVR_DB_USER:-rivr}"
DB_NAME="${RIVR_DB_NAME:-rivr_person}"
DB_PASSWORD="${RIVR_DB_PASSWORD:-}"

if [[ -z "$DB_PASSWORD" ]]; then
    log "ERROR: RIVR_DB_PASSWORD is not set. Cannot create app database."
    exit 1
fi

log "Creating rivr-person application database..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE $DB_NAME'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '$DB_NAME')
    \gexec

    ALTER DATABASE $DB_NAME SET timezone TO 'UTC';

    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$DB_USER') THEN
            CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
        ELSE
            ALTER USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
        END IF;
    END
    \$\$;

    GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
EOSQL

# Grant schema-level permissions
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB_NAME" <<-EOSQL
    GRANT ALL ON SCHEMA public TO $DB_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $DB_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $DB_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO $DB_USER;
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

log "========================================"
log "rivr-person Database Initialization Complete"
log "  Database: $DB_NAME"
log "  User: $DB_USER"
log "========================================"

exit 0
