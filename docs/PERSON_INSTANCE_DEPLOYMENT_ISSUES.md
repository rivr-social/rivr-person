# Person Instance Deployment Issues

Known deployment constraints for `rivr-person`.

## PostgreSQL Extensions

Rivr requires:

- `postgis`
- `vector`
- `pg_trgm`

These must be preinstalled by a database admin before app migrations run.

The app user should remain a normal DB user. Do not use PostgreSQL superuser for normal runtime.

## Person Identity Binding

If the wrong page loads at `/`, check:

- `INSTANCE_TYPE=person`
- `PRIMARY_AGENT_ID=<your-person-agent-uuid>`

If either value is missing or wrong, the app will not render the person-instance home/profile behavior correctly.

## Public Profile Resolution

If `/api/profile/<username>` does not resolve:

- confirm the target agent exists in the target database
- confirm the target agent has `metadata.username`
- confirm the imported profile data matches the live agent UUID

## Federation Cutover

If writes still route to the source instance:

- confirm `REGISTRY_URL` points at the global registry
- rerun `pnpm federation:person:cutover`
- verify `GET /api/federation/registry?agentId=<your-agent-uuid>` resolves to the new host

## Build/Runtime Split

The app can compile with build-time placeholder env values for `AUTH_SECRET` and `DATABASE_URL`, but runtime deployment still requires real values.

## PM Core Foundation

This app assumes the surrounding PM Core / Docker Lab foundation exists:

- Traefik
- PostgreSQL
- Redis
- MinIO or equivalent object storage

Repo links:

- `https://github.com/peermesh/pm-core`
- `https://github.com/peermesh/docker-lab`
