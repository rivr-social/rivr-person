/**
 * Scenario 06 — Sovereign user forgot local password → global email reset →
 * home accepts temp-write → local login works.
 *
 * Issue: rivr-social/rivr-app#89 (Recovery, scenario 6)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Provision a sovereign user whose home is rivr.camalot.me.
 * 2. Assume they forgot the local password.
 * 3. Visit global's /forgot-password page. Submit email.
 * 4. Pick up the reset email from the mail-hog inbox.
 * 5. Click the reset link (hosted on global).
 * 6. Set a new password.
 * 7. Expect: global mints a short-lived temp-write credential.
 * 8. Expect: global POSTs the credential-update to the sovereign home's
 *    `/api/auth/temp-write/accept` endpoint. See rivr-app#16 (WIP).
 * 9. Expect: home verifies the temp-write signature + TTL, installs the
 *    new password locally, bumps credentialVersion.
 * 10. Verify: local sign-in with the new password succeeds on the home.
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

describe("Scenario 06 — forgotten-password reset via global propagates to sovereign home", () => {
  let account: DisposableAccount | undefined;
  const newPassword = `RecoveryEmail-${Date.now()}-aA1!`;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-recover-06",
    });
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("global accepts the reset and emits a temp-write to home", async () => {
    if (!account) throw new Error("precondition");
    const result = await resetPasswordViaGlobal(account, newPassword);
    expect(result.ok).toBe(true);
    expect(result.syncedToHome).toBe(true);
  });

  it("local sign-in on home works with the new password", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally("home", account.username, newPassword);
    expect(result.ok).toBe(true);
  });

  it("old password is rejected on home", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally(
      "home",
      account.username,
      account.localPassword
    );
    expect(result.ok).toBe(false);
  });
});
