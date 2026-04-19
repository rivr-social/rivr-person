# Federation Auth E2E Runbook

This is the top-level runbook for the federation auth + recovery +
Prism-MCP end-to-end test matrix. It corresponds to
rivr-social/rivr-app#89.

## Why this matters

RIVR's core promise is that a person's authority is portable across
three deployment modes:

1. **Sovereign self-hosted** — the user runs their own home instance
   (e.g. `rivr.camalot.me`).
2. **Sovereign Rivr-hosted** — the user has a sovereign instance but
   Rivr operates it.
3. **Hosted-only** — the user lives entirely on the global instance
   (e.g. `a.rivr.social`).

All three modes must survive the full lifecycle of:
- signing in
- resetting a forgotten password
- losing email access and recovering via seed phrase
- revoking a compromised home and claiming a successor
- surviving global outages without losing the ability to do local work
- letting Prism Claude (MCP) act on the user's behalf against the
  correct authority

This matrix is the integration test that proves those promises hold
together, across three actual instances, as a system.

## The 19-scenario matrix

Scenarios are grouped into four sections, mirroring the issue body.

### Section A — SSO + sync (scenarios 1-5)

| # | Title | Status | Drivers |
|---|-------|--------|---------|
| 1 | Sovereign signs into home with local password | scaffolded | NextAuth on home |
| 2 | Sovereign resets password on home → global credentialVersion updates | scaffolded (awaits impl) | rivr-app#15 |
| 3 | Hosted-only resets on global → only global updates | scaffolded (awaits impl) | rivr-app#15 |
| 4 | Sovereign signs into peer via global SSO with new password | scaffolded (awaits impl) | rivr-app#15 + #16 |
| 5 | Peer session carries home authority + globalIssuer | scaffolded (awaits impl) | rivr-app#18 |

### Section B — Recovery (scenarios 6-10)

| # | Title | Status | Drivers |
|---|-------|--------|---------|
| 6 | Forgot local password → global email reset → home accepts temp-write | scaffolded (awaits impl) | rivr-app#16 (WIP) |
| 7 | Forgot local password + no email → seed phrase → home accepts recovery assertion | scaffolded (awaits impl) | rivr-app#17 (WIP) |
| 8 | Hosted-only forgot password → global email reset works | scaffolded (awaits impl) | rivr-app#15 |
| 9 | Reveal seed in settings with MFA → audit log entry present | scaffolded (awaits impl) | `recovery-seed-ui` branch |
| 10 | Rotate seed → old seed rejected on next recovery | scaffolded (awaits impl) | `recovery-seed-ui` branch |

### Section C — Authority enforcement (scenarios 11-14)

| # | Title | Status | Drivers |
|---|-------|--------|---------|
| 11 | Home revoked via signed `authority.revoke` → peers reject sessions within 60s | scaffolded (awaits impl) | rivr-app#18 |
| 12 | Successor home claim accepted → peers route to new home | scaffolded (awaits impl) | rivr-app#18 |
| 13 | Global down during local login → local login still works | scaffolded (partial) | home NextAuth |
| 14 | Global down during recovery → recovery blocked (seed still works) | scaffolded (partial) | rivr-app#17 |

### Section D — Prism-MCP (scenarios 15-19)

| # | Title | Status | Drivers |
|---|-------|--------|---------|
| 15 | Prism creates post via MCP → lands on correct authority | live (MCP route exists) | home `/api/mcp` |
| 16 | Prism creates event via MCP → federates to peer | scaffolded (partial) | federation event export |
| 17 | Prism creates offering via MCP → projects correctly | scaffolded (partial) | projection facade |
| 18 | Prism connect works for sovereign user (rivr.camalot.me) | live | home MCP surface |
| 19 | Prism connect works for hosted-only user (a.rivr.social) | scaffolded | global MCP surface |

## Status legend

- **live** — scenario runs end-to-end against current deployments
- **scaffolded (partial)** — test calls live endpoints but some assertions
  require additional implementation
- **scaffolded (awaits impl)** — helper currently throws
  `NotYetImplementedError` and the scenario is skipped by the runner

## How to run

### Against staging (recommended)

```bash
export E2E_GLOBAL_BASE=https://a.rivr.social
export E2E_HOME_BASE=https://rivr.camalot.me
export E2E_PEER_BASE=https://front-range.rivr.social

bash tests/e2e/federation/run.sh
```

The script will:
1. validate env
2. run each scenario file sequentially
3. classify each outcome as PASS / FAIL / SKIP-awaiting-impl
4. print a coverage report

### Against local dev (single instance)

Point the three env vars at the same local process (e.g. `http://localhost:3003`):

```bash
export E2E_GLOBAL_BASE=http://localhost:3003
export E2E_HOME_BASE=http://localhost:3003
export E2E_PEER_BASE=http://localhost:3003

bash tests/e2e/federation/run.sh
```

Scenarios that explicitly require distinct instances (4, 5, 11, 12, 16,
17) will fail — the single-instance run exists to let scenarios 1, 9,
10, 13, 15, 18 exercise real code paths during development.

### Running a single scenario

Individual scenario files are regular vitest tests:

```bash
pnpm exec vitest run tests/e2e/federation/scenarios/01-sovereign-signs-in-home-local.test.ts
```

## What counts as "passing the matrix"

Per issue #89's acceptance criteria:

> Each scenario has an automated test OR a documented manual runbook.
> All passing before MVP is declared complete.

The manual runbook requirement is already satisfied: every scenario
file starts with a `RUNBOOK` block documenting the exact manual steps.
The automated coverage tracks forward as each backing ticket lands:

- rivr-app#15 merging → scenarios 2, 3, 8 flip from skipped to live
- rivr-app#16 merging → scenarios 4, 6 flip
- rivr-app#17 merging → scenarios 7, 14 flip
- rivr-app#18 merging → scenarios 5, 11, 12 flip
- `recovery-seed-ui` branch merging → scenarios 9, 10 flip
- `rivr-app#91` (test account provisioning) merging → all scenarios
  that need disposable accounts become fully automated

## Relationship to the broader system

- The matrix does NOT replace per-repo unit tests
  (`src/__tests__/federation-crypto.test.ts`,
  `federation-entity-map.test.ts`, etc.). It complements them by proving
  the pieces integrate across three actual instances.
- The three-instance topology deliberately mirrors the current deployed
  reality: global + sovereign home + peer.
- Scenarios 11–14 are the hardest to automate because they require
  either signed events (#18) or simulated outages. Until those land,
  the RUNBOOK blocks remain the canonical way to verify the behaviour
  at release time.

## Open questions

- Should `createDisposableAccount` provision a peer-local projection of
  the sovereign user up front, or lazily on first sign-in? (Affects
  scenarios 4, 5.)
- Should `authority.revoke` propagate via pull (peers poll) or push
  (home announces)? Scenario 11's 60s window assumes push. Needs
  product decision on rivr-app#18.
- For scenario 12 (successor home), what is the authoritative naming
  for the federation event — `successor.home.claim` or
  `home.succession`? Scaffolding uses the former.
