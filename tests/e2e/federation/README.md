# Federation Auth E2E Test Matrix

This directory contains the cross-instance end-to-end test matrix for
federation auth, recovery, and Prism-MCP flows.

- Issue: rivr-social/rivr-app#89
- Acceptance: every scenario has either an automated test OR a documented
  manual runbook (embedded at the top of each scenario file).

## The three instances

The suite assumes a 3-instance topology. Each instance is addressed by a
base URL pulled from the environment:

| Role | Env var | Example |
|------|---------|---------|
| Global | `E2E_GLOBAL_BASE` | `https://a.rivr.social` |
| Sovereign home | `E2E_HOME_BASE` | `https://rivr.camalot.me` |
| Peer | `E2E_PEER_BASE` | `https://front-range.rivr.social` |

Some scenarios additionally require:

| Role | Env var | Example |
|------|---------|---------|
| Successor sovereign home (Scenario 12) | `E2E_SUCCESSOR_HOME_BASE` | `https://rivr-b.camalot.me` |

## What is fully automated vs still manual

At the time of scaffolding (issue #89 landing), most scenarios are
**partially automated**:

- Helpers that have a live endpoint are real HTTP calls:
  - `signInLocally` — NextAuth `POST /api/auth/callback/credentials`
  - `prismMcpInvoke` — `POST /api/mcp`
  - `fetchAuditEntries` — `GET /api/audit`
  - `simulateGlobalOutage` — env-var-based
- Helpers awaiting implementation throw `NotYetImplementedError` with a
  reference to the ticket that will land them. The runner skips these
  scenarios and prints a coverage report at the end:
  - `createDisposableAccount` — awaits `rivr-app#91` (test-scoped
    account provisioning)
  - `deleteDisposableAccount` — no-op until the above lands
  - `resetPasswordViaGlobal` — awaits `rivr-app#15 + rivr-app#16`
  - `resetPasswordOnHome` — awaits `rivr-app#15`
  - `revealSeed` / `rotateSeed` / `recoverWithSeed` — awaits the
    `recovery-seed-ui` branch merging and `rivr-app#17` accept path
  - `revokeAuthority` / `publishSuccessorHomeClaim` — awaits
    `rivr-app#18` (authority.revoke + successor claim event types)

## Running the matrix

```bash
export E2E_GLOBAL_BASE=https://a.rivr.social
export E2E_HOME_BASE=https://rivr.camalot.me
export E2E_PEER_BASE=https://front-range.rivr.social

bash tests/e2e/federation/run.sh
```

The script:
1. Validates that all required env vars are set.
2. Runs the scenario suite with vitest in a dedicated project.
3. Tracks scenarios that skipped via `NotYetImplementedError`.
4. Prints a coverage summary:
   - total scenarios
   - automated passing
   - automated failing
   - skipped (awaiting implementation)

## Running against local dev

For local development you can point the three env vars at the same
dev instance (e.g. `http://localhost:3003`). Scenarios that explicitly
need distinct instances (4, 5, 11, 12, 16, 17) will fail, but the
single-instance scenarios (1, 9, 10, 13, 15, 18) will exercise real
code paths.

## Why the scaffolding landed before the impl

Issue #89 lists 19 scenarios tied to multiple WIP tickets (#15, #16,
#17, #18). Landing the matrix first means:

- Each downstream PR can enable its scenarios by replacing
  `NotYetImplementedError` with a real call, producing a visible
  forward movement on the coverage report.
- Product/design can read the runbook blocks to audit the intended
  behavior before implementation lands.
- No scenario gets forgotten or drifts out of sync with the handoff doc.
