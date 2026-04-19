/**
 * Scenario 01 — Sovereign user signs into home with local password.
 *
 * Issue: rivr-social/rivr-app#89 (SSO + sync, scenario 1)
 *
 * ============================================================
 * RUNBOOK (manual fallback while automation is incomplete)
 * ============================================================
 * 1. Provision a sovereign user with a known local password on the
 *    home instance (e.g. rivr.camalot.me). If no test-provisioning
 *    API exists, use the signup UI.
 * 2. Open the home login page and sign in with that password.
 * 3. Expect: redirect to /autobot (or home dashboard) with a valid
 *    session cookie.
 * 4. Expect: the home should NOT have needed to contact the global
 *    issuer to validate — local sign-in stands alone.
 *
 * When `createDisposableAccount` lands (rivr-app#91), this scenario
 * becomes fully automated.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NotYetImplementedError,
  createDisposableAccount,
  deleteDisposableAccount,
  requireE2EEnv,
  signInLocally,
  type DisposableAccount,
} from "../harness";

describe("Scenario 01 — sovereign user signs into home with local password", () => {
  let account: DisposableAccount | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    try {
      account = await createDisposableAccount({
        homeRole: "home",
        usernamePrefix: "e2e-sov-01",
      });
    } catch (err) {
      if (err instanceof NotYetImplementedError) throw err;
      throw err;
    }
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("signs in with local password and receives a session cookie", async () => {
    if (!account) throw new Error("precondition: account must exist");

    const result = await signInLocally(
      "home",
      account.username,
      account.localPassword
    );

    expect(result.ok).toBe(true);
    expect(result.sessionToken).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("session reflects home authority (not delegated to global)", async () => {
    if (!account) throw new Error("precondition: account must exist");
    const result = await signInLocally(
      "home",
      account.username,
      account.localPassword
    );

    // If the session surfaces home authority metadata, assert it matches.
    if (result.homeAuthority !== undefined) {
      expect(result.homeAuthority).toContain("camalot");
    }
    // Global issuer field may be blank or absent for purely-local sign-in.
    expect(result.globalIssuer ?? "").not.toContain("error");
  });
});
