/**
 * Scenario 02 — Sovereign user resets password on home → global
 * credentialVersion updates.
 *
 * Issue: rivr-social/rivr-app#89 (SSO + sync, scenario 2)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Sign into the sovereign home instance.
 * 2. Visit /settings/security → change password.
 * 3. Expect: home writes new credential locally.
 * 4. Expect: home's credential-sync job pushes a new credentialVersion
 *    to the global issuer within a short window (< 30s).
 * 5. Verify: hit /api/federation/registry/:userId on global and confirm
 *    the credentialVersion has incremented.
 * 6. Attempt sign-in on a peer instance via global SSO — must require
 *    the new password.
 *
 * Backing work: rivr-app#15 "sync password reset to global" (merged),
 * plus the admin drain route #15b. The sync job is wired but not yet
 * covered by automated e2e.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NotYetImplementedError,
  createDisposableAccount,
  deleteDisposableAccount,
  requireE2EEnv,
  resetPasswordOnHome,
  signInLocally,
  type DisposableAccount,
} from "../harness";

describe("Scenario 02 — local reset on home propagates credentialVersion to global", () => {
  let account: DisposableAccount | undefined;
  const newPassword = `NewPass-${Date.now()}-aA1!`;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-sov-02",
    });
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("home accepts the local reset and bumps credentialVersion", async () => {
    if (!account) throw new Error("precondition");
    const result = await resetPasswordOnHome(account, newPassword);
    expect(result.ok).toBe(true);
    expect(result.newCredentialVersion).toBeGreaterThanOrEqual(1);
  });

  it("home pushes new credentialVersion to global", async () => {
    if (!account) throw new Error("precondition");
    const result = await resetPasswordOnHome(account, newPassword);
    expect(result.syncedToGlobal).toBe(true);
  });

  it("old password is rejected on the home instance", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally(
      "home",
      account.username,
      account.localPassword
    );
    expect(result.ok).toBe(false);
  });

  it("new password works on the home instance", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally("home", account.username, newPassword);
    expect(result.ok).toBe(true);
  });
});
