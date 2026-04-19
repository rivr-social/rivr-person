/**
 * Scenario 03 — Hosted-only user resets password on global → only global updates.
 *
 * Issue: rivr-social/rivr-app#89 (SSO + sync, scenario 3)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Provision a hosted-only user whose home is the global instance.
 * 2. Trigger "forgot password" on global. Pick up the reset link from
 *    the mail-hog inbox.
 * 3. Complete the reset.
 * 4. Expect: global updates credentialVersion locally.
 * 5. Expect: NO push to any sovereign home (user has none).
 * 6. Verify: new password works on global login.
 * 7. Verify: peer instances see the new version via global SSO.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  requireE2EEnv,
  resetPasswordViaGlobal,
  signInLocally,
  type DisposableAccount,
} from "../harness";

describe("Scenario 03 — hosted-only user resets on global; no sovereign push", () => {
  let account: DisposableAccount | undefined;
  const newPassword = `GlobalReset-${Date.now()}-aA1!`;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "global",
      usernamePrefix: "e2e-hosted-03",
    });
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("global accepts the reset", async () => {
    if (!account) throw new Error("precondition");
    const result = await resetPasswordViaGlobal(account, newPassword);
    expect(result.ok).toBe(true);
    expect(result.newCredentialVersion).toBeGreaterThanOrEqual(1);
  });

  it("global does not mark a sovereign-sync attempt (there is none)", async () => {
    if (!account) throw new Error("precondition");
    const result = await resetPasswordViaGlobal(account, newPassword);
    // syncedToHome only meaningful when a home exists; for hosted-only
    // users this should be false/undefined.
    expect(result.syncedToHome ?? false).toBe(false);
  });

  it("new password works on global", async () => {
    if (!account) throw new Error("precondition");
    const signIn = await signInLocally(
      "global",
      account.username,
      newPassword
    );
    expect(signIn.ok).toBe(true);
  });
});
