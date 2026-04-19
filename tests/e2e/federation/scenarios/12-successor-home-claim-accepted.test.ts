/**
 * Scenario 12 — Successor home claim accepted → peers route to new home.
 *
 * Issue: rivr-social/rivr-app#89 (Authority enforcement, scenario 12)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Given a user previously homed at HOME_A, with a valid seed phrase.
 * 2. Provision HOME_B as the successor (new sovereign instance).
 * 3. On HOME_B, sign a `successor.home.claim` with the seed-derived key
 *    naming HOME_A as predecessor.
 * 4. Publish the claim to the federation event log.
 * 5. Peers + global must:
 *      - verify the claim against the stored seed public key
 *      - update the registry entry: homeAuthority → HOME_B
 *      - route subsequent writes to HOME_B
 * 6. Verify: `GET /api/federation/registry/:userId` on both global and
 *    peer returns HOME_B.
 * 7. Verify: a write to a home-owned resource routes to HOME_B.
 *
 * This scenario requires two sovereign instances. If E2E_HOME_BASE
 * points to a single home, the test is skipped with a clear message.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  publishSuccessorHomeClaim,
  requireE2EEnv,
  type DisposableAccount,
} from "../harness";

describe("Scenario 12 — successor home claim re-routes writes to the new home", () => {
  let account: DisposableAccount | undefined;
  const successorBase = process.env.E2E_SUCCESSOR_HOME_BASE;

  beforeAll(async () => {
    requireE2EEnv();
    if (!successorBase) {
      throw new Error(
        "Scenario 12 requires E2E_SUCCESSOR_HOME_BASE — a second sovereign instance"
      );
    }
    account = await createDisposableAccount({
      homeRole: "home",
      withSeedPhrase: true,
      usernamePrefix: "e2e-successor-12",
    });
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("publishes a successor claim signed by the seed-derived key", async () => {
    if (!account || !successorBase) throw new Error("precondition");
    const result = await publishSuccessorHomeClaim({
      subject: account,
      successorHomeBase: successorBase,
    });
    expect(result.ok).toBe(true);
    expect(result.claimId).toBeDefined();
  });

  it("global registry resolves the user to the new home", async () => {
    if (!account || !successorBase) throw new Error("precondition");
    const globalBase = process.env.E2E_GLOBAL_BASE!.replace(/\/$/, "");
    const response = await fetch(
      `${globalBase}/api/federation/registry/${encodeURIComponent(
        account.userId ?? account.username
      )}`
    );
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { homeAuthority?: string };
    expect(body.homeAuthority).toContain(
      successorBase.replace(/^https?:\/\//, "")
    );
  });

  it("peer registry resolves the user to the new home", async () => {
    if (!account || !successorBase) throw new Error("precondition");
    const peerBase = process.env.E2E_PEER_BASE!.replace(/\/$/, "");
    const response = await fetch(
      `${peerBase}/api/federation/registry/${encodeURIComponent(
        account.userId ?? account.username
      )}`
    );
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { homeAuthority?: string };
    expect(body.homeAuthority).toContain(
      successorBase.replace(/^https?:\/\//, "")
    );
  });
});
