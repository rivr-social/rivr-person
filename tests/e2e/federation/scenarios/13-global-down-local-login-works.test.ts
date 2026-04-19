/**
 * Scenario 13 — Global down during local login → local login still works.
 *
 * Issue: rivr-social/rivr-app#89 (Authority enforcement, scenario 13)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Provision a sovereign user with a known local password.
 * 2. Simulate global outage: point E2E_GLOBAL_BASE at an unroutable
 *    address (the harness helper `simulateGlobalOutage` does this).
 * 3. Attempt to sign into the sovereign home with the local password.
 * 4. Expect: home completes sign-in WITHOUT contacting global.
 * 5. Expect: credentialVersion check falls back to the home-local value.
 * 6. Clean up: restore E2E_GLOBAL_BASE.
 *
 * This ensures sovereign instances are not hard-dependent on global
 * availability — a core tenet of the sovereign-app design.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  requireE2EEnv,
  signInLocally,
  simulateGlobalOutage,
  type DisposableAccount,
} from "../harness";

describe("Scenario 13 — home local login is resilient to global outage", () => {
  let account: DisposableAccount | undefined;
  let restore: (() => void) | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-global-down-13",
    });
    restore = simulateGlobalOutage();
  });

  afterAll(async () => {
    if (restore) restore();
    if (account) await deleteDisposableAccount(account);
  });

  it("home accepts local sign-in while global is unreachable", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally(
      "home",
      account.username,
      account.localPassword
    );
    expect(result.ok).toBe(true);
    expect(result.sessionToken).toBeDefined();
  });

  it("session does not surface a globalIssuer value", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally(
      "home",
      account.username,
      account.localPassword
    );
    // If the field exists at all, it should be absent or empty when
    // global was unreachable at sign-in time.
    expect(result.globalIssuer ?? "").toBe("");
  });
});
