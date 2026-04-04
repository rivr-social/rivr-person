#!/bin/bash
# ==============================================================
# rivr-person Sidecar — Knowledge Graph Initialization
# ==============================================================
# Creates the cartoon_kg database with the SPO triple store,
# transcript tables, doc registry, and graph traversal functions
# for the autobot's semantic memory system.
#
# This is a self-contained copy of the KG schema from
# Autobot/cartoon/pm-core/profiles/postgresql/init-scripts/02-init-cartoon-kg.sh
# adapted for the sidecar deployment pattern.
#
# Environment variables (set via docker-compose.sidecar.yml):
#   KG_DB_USER     — KG database user (default: cartoon)
#   KG_DB_PASSWORD — KG database password (REQUIRED)
#   KG_DB_NAME     — KG database name (default: cartoon_kg)
# ==============================================================

set -euo pipefail

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

DB_NAME="${KG_DB_NAME:-cartoon_kg}"
DB_USER="${KG_DB_USER:-cartoon}"
DB_PASSWORD="${KG_DB_PASSWORD:-}"

if [[ -z "$DB_PASSWORD" ]]; then
    log "ERROR: KG_DB_PASSWORD is not set. Cannot create KG database."
    exit 1
fi

# ----------------------------------------------------------
# Create database and user
# ----------------------------------------------------------
log "Creating $DB_NAME database and user..."

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

# ----------------------------------------------------------
# Create schema inside the KG database
# ----------------------------------------------------------
log "Creating KG schema..."

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$DB_NAME" <<-EOSQL
    -- Grant schema permissions
    GRANT ALL ON SCHEMA public TO $DB_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO $DB_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO $DB_USER;

    -- Enable pgvector for embedding support
    CREATE EXTENSION IF NOT EXISTS vector;

    -- ==========================================================
    -- Sessions: conversation session metadata
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT PRIMARY KEY,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at        TIMESTAMPTZ,
        participant     TEXT,
        channel         TEXT,
        metadata        JSONB DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_participant ON sessions(participant);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

    -- ==========================================================
    -- Transcripts: every utterance recorded
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS transcripts (
        id              SERIAL PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id),
        line_number     INT NOT NULL,
        speaker         TEXT NOT NULL,
        content         TEXT NOT NULL,
        file_path       TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_transcripts_session ON transcripts(session_id);
    CREATE INDEX IF NOT EXISTS idx_transcripts_speaker ON transcripts(speaker);
    CREATE INDEX IF NOT EXISTS idx_transcripts_created ON transcripts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_transcripts_content_fts
        ON transcripts USING gin(to_tsvector('english', content));

    -- ==========================================================
    -- Entities: canonical entity registry
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS entities (
        id              SERIAL PRIMARY KEY,
        name            TEXT NOT NULL,
        canonical_name  TEXT NOT NULL,
        entity_type     TEXT NOT NULL,
        first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        metadata        JSONB DEFAULT '{}'::jsonb,
        embedding       vector(384),
        UNIQUE(canonical_name, entity_type)
    );

    CREATE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_name);
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(entity_type);

    -- ==========================================================
    -- Docs: document registry for KG ingestion
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS docs (
        id              SERIAL PRIMARY KEY,
        title           TEXT NOT NULL,
        doc_type        TEXT NOT NULL DEFAULT 'document',
        content_hash    TEXT,
        source_uri      TEXT,
        scope_type      TEXT NOT NULL DEFAULT 'person',
        scope_id        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending',
        triple_count    INT DEFAULT 0,
        ingested_at     TIMESTAMPTZ,
        metadata        JSONB DEFAULT '{}'::jsonb,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_docs_scope ON docs(scope_type, scope_id);
    CREATE INDEX IF NOT EXISTS idx_docs_hash ON docs(content_hash);
    CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);
    CREATE INDEX IF NOT EXISTS idx_docs_source_uri ON docs(source_uri);

    -- ==========================================================
    -- Triples: subject-predicate-object with provenance
    -- ==========================================================
    CREATE TABLE IF NOT EXISTS triples (
        id              SERIAL PRIMARY KEY,
        subject_id      INT NOT NULL REFERENCES entities(id),
        predicate       TEXT NOT NULL,
        object_id       INT NOT NULL REFERENCES entities(id),
        transcript_id   INT REFERENCES transcripts(id),
        transcript_ref  TEXT,
        session_id      TEXT REFERENCES sessions(id),
        source_doc_id   INT REFERENCES docs(id),
        scope_type      TEXT,
        scope_id        TEXT,
        confidence      FLOAT DEFAULT 1.0,
        extraction_method TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active       BOOLEAN DEFAULT TRUE
    );

    CREATE INDEX IF NOT EXISTS idx_triples_subject ON triples(subject_id) WHERE is_active;
    CREATE INDEX IF NOT EXISTS idx_triples_object ON triples(object_id) WHERE is_active;
    CREATE INDEX IF NOT EXISTS idx_triples_predicate ON triples(predicate) WHERE is_active;
    CREATE INDEX IF NOT EXISTS idx_triples_session ON triples(session_id);
    CREATE INDEX IF NOT EXISTS idx_triples_transcript ON triples(transcript_id);
    CREATE INDEX IF NOT EXISTS idx_triples_doc ON triples(source_doc_id) WHERE is_active;
    CREATE INDEX IF NOT EXISTS idx_triples_scope ON triples(scope_type, scope_id) WHERE is_active;
    CREATE INDEX IF NOT EXISTS idx_triples_spo ON triples(subject_id, predicate, object_id) WHERE is_active;
    CREATE INDEX IF NOT EXISTS idx_triples_ops ON triples(object_id, predicate, subject_id) WHERE is_active;

    -- ==========================================================
    -- Views
    -- ==========================================================

    CREATE OR REPLACE VIEW triples_readable AS
    SELECT
        t.id,
        s.name AS subject,
        s.entity_type AS subject_type,
        t.predicate,
        o.name AS object,
        o.entity_type AS object_type,
        t.confidence,
        t.transcript_ref,
        t.source_doc_id,
        d.title AS source_doc_title,
        t.scope_type,
        t.scope_id,
        t.extraction_method,
        t.created_at
    FROM triples t
    JOIN entities s ON t.subject_id = s.id
    JOIN entities o ON t.object_id = o.id
    LEFT JOIN docs d ON t.source_doc_id = d.id
    WHERE t.is_active = TRUE;

    -- ==========================================================
    -- Graph traversal functions
    -- ==========================================================

    CREATE OR REPLACE FUNCTION traverse_graph(
        start_entity TEXT,
        max_hops INT DEFAULT 3
    )
    RETURNS TABLE(
        hop INT,
        subject TEXT,
        predicate TEXT,
        object TEXT,
        confidence FLOAT,
        transcript_ref TEXT
    )
    LANGUAGE sql STABLE AS \$\$
        WITH RECURSIVE graph_walk AS (
            SELECT
                1 AS hop,
                s.name AS subject,
                t.predicate,
                o.name AS object,
                o.id AS next_id,
                t.confidence,
                t.transcript_ref
            FROM triples t
            JOIN entities s ON t.subject_id = s.id
            JOIN entities o ON t.object_id = o.id
            WHERE s.canonical_name = lower(start_entity)
              AND t.is_active = TRUE

            UNION ALL

            SELECT
                gw.hop + 1,
                s.name,
                t.predicate,
                o.name,
                o.id,
                t.confidence,
                t.transcript_ref
            FROM graph_walk gw
            JOIN triples t ON t.subject_id = gw.next_id AND t.is_active = TRUE
            JOIN entities s ON t.subject_id = s.id
            JOIN entities o ON t.object_id = o.id
            WHERE gw.hop < max_hops
        )
        SELECT hop, subject, predicate, object, confidence, transcript_ref
        FROM graph_walk
        ORDER BY hop, subject, predicate;
    \$\$;

    CREATE OR REPLACE FUNCTION entity_context(
        entity_name TEXT,
        max_facts INT DEFAULT 50
    )
    RETURNS TABLE(
        direction TEXT,
        subject TEXT,
        predicate TEXT,
        object TEXT,
        confidence FLOAT,
        transcript_ref TEXT
    )
    LANGUAGE sql STABLE AS \$\$
        (
            SELECT 'outgoing'::TEXT, s.name, t.predicate, o.name, t.confidence, t.transcript_ref
            FROM triples t
            JOIN entities s ON t.subject_id = s.id
            JOIN entities o ON t.object_id = o.id
            WHERE s.canonical_name = lower(entity_name) AND t.is_active = TRUE
            ORDER BY t.confidence DESC, t.created_at DESC
            LIMIT max_facts / 2
        )
        UNION ALL
        (
            SELECT 'incoming'::TEXT, s.name, t.predicate, o.name, t.confidence, t.transcript_ref
            FROM triples t
            JOIN entities s ON t.subject_id = s.id
            JOIN entities o ON t.object_id = o.id
            WHERE o.canonical_name = lower(entity_name) AND t.is_active = TRUE
            ORDER BY t.confidence DESC, t.created_at DESC
            LIMIT max_facts / 2
        );
    \$\$;

    CREATE OR REPLACE FUNCTION doc_triples(
        doc_id_param INT,
        max_facts INT DEFAULT 200
    )
    RETURNS TABLE(
        id INT,
        subject TEXT,
        subject_type TEXT,
        predicate TEXT,
        object TEXT,
        object_type TEXT,
        confidence FLOAT,
        extraction_method TEXT,
        created_at TIMESTAMPTZ
    )
    LANGUAGE sql STABLE AS \$\$
        SELECT
            t.id,
            s.name AS subject,
            s.entity_type AS subject_type,
            t.predicate,
            o.name AS object,
            o.entity_type AS object_type,
            t.confidence,
            t.extraction_method,
            t.created_at
        FROM triples t
        JOIN entities s ON t.subject_id = s.id
        JOIN entities o ON t.object_id = o.id
        WHERE t.source_doc_id = doc_id_param
          AND t.is_active = TRUE
        ORDER BY t.confidence DESC, t.created_at DESC
        LIMIT max_facts;
    \$\$;

    CREATE OR REPLACE FUNCTION scoped_graph(
        scope_type_param TEXT,
        scope_id_param TEXT,
        max_facts INT DEFAULT 200
    )
    RETURNS TABLE(
        id INT,
        subject TEXT,
        subject_type TEXT,
        predicate TEXT,
        object TEXT,
        object_type TEXT,
        confidence FLOAT,
        source_doc_title TEXT,
        extraction_method TEXT,
        created_at TIMESTAMPTZ
    )
    LANGUAGE sql STABLE AS \$\$
        SELECT
            t.id,
            s.name AS subject,
            s.entity_type AS subject_type,
            t.predicate,
            o.name AS object,
            o.entity_type AS object_type,
            t.confidence,
            d.title AS source_doc_title,
            t.extraction_method,
            t.created_at
        FROM triples t
        JOIN entities s ON t.subject_id = s.id
        JOIN entities o ON t.object_id = o.id
        LEFT JOIN docs d ON t.source_doc_id = d.id
        WHERE t.scope_type = scope_type_param
          AND t.scope_id = scope_id_param
          AND t.is_active = TRUE
        ORDER BY t.confidence DESC, t.created_at DESC
        LIMIT max_facts;
    \$\$;

EOSQL

log "========================================"
log "Knowledge Graph Schema Initialization Complete"
log "  Database: $DB_NAME"
log "  User: $DB_USER"
log "  Tables: sessions, transcripts, entities, docs, triples"
log "  Functions: traverse_graph(), entity_context(), doc_triples(), scoped_graph()"
log "========================================"

exit 0
