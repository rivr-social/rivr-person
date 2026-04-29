# Person Instance Cutover

This is the concrete cutover path for moving a live person profile from a shared instance to a dedicated person instance.

## Principles

- Do not require the app user to run as PostgreSQL superuser.
- Pre-install required extensions (`postgis`, `vector`, `pg_trgm`) on the host database before Rivr migrations.
- Keep the same person agent UUID on the target instance.
- Register the target as `migrating_in`, freeze the source as `migrating_out`, import the manifest, then promote the target to `active` and archive the source.

## Required Environment

### Source export

```bash
DATABASE_URL=postgres://...
PERSON_AGENT_ID=<your-person-agent-uuid>
OUTPUT_PATH=tmp/camalot-person.manifest.json
pnpm federation:person:export
```

### Target import

```bash
DATABASE_URL=postgres://...
MANIFEST_PATH=tmp/camalot-person.manifest.json
pnpm federation:person:import
```

### Registry cutover

```bash
REGISTRY_URL=https://b.rivr.social/api/federation/registry
NODE_ADMIN_KEY=<global-registry-admin-key>

SOURCE_INSTANCE_ID=<b-instance-id>
SOURCE_INSTANCE_SLUG=test-b
SOURCE_BASE_URL=https://b.rivr.social
SOURCE_PRIMARY_AGENT_ID=<your-person-agent-uuid>

TARGET_INSTANCE_ID=<rivr-camalot-node-uuid>
TARGET_INSTANCE_SLUG=camalot
TARGET_BASE_URL=https://rivr.example.com
TARGET_PRIMARY_AGENT_ID=<your-person-agent-uuid>
TARGET_DISPLAY_NAME="<display-name>"
TARGET_PUBLIC_KEY=<target-node-public-key>

CUTOVER_PHASE=complete
pnpm federation:person:cutover
```

## Deployment Sequence

1. Bring up the target person domain with normal app credentials and a database where the required extensions are already installed.
2. Run Rivr migrations as the normal app user.
3. Import the person-instance manifest into the target database.
4. Set:
   - `INSTANCE_TYPE=person`
   - `INSTANCE_ID=<target-instance-id>`
   - `INSTANCE_SLUG=camalot`
   - `PRIMARY_AGENT_ID=<your-person-agent-uuid>`
   - `REGISTRY_URL=https://b.rivr.social/api/federation/registry`
   - `NEXT_PUBLIC_BASE_URL=https://rivr.example.com`
5. Restart the target app.
6. Run `pnpm federation:person:cutover` with `CUTOVER_PHASE=complete`.
7. Verify:
   - `GET /api/federation/registry?agentId=<your-agent-id>` now resolves to `https://rivr.example.com`
   - `GET /api/myprofile` on the target domain succeeds with your session
   - `GET /api/profile/<username>` on the target domain returns your public profile bundle

## Notes

- The export/import scripts preserve the same IDs for the person, personas, owned resources, wallets, subscriptions, ledger history, and relevant federation rows.
- The importer now upserts agent rows by ID. If the target person instance already has a bootstrap copy of the same person agent, re-import will merge the source profile fields and metadata instead of silently skipping them.
- Wallet transactions pointing at wallets not present in the manifest are imported with missing external wallet references nulled instead of failing FK checks.
- The current cutover script updates registry state only. It does not create DNS, databases, Docker services, or secrets for you.
