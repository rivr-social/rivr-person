-- Create the extensions Rivr requires before any application code runs.
-- The migrations also do this, but pre-creating them here means a failure
-- surfaces at container start with a clear Postgres error, rather than
-- midway through the first migration run.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
