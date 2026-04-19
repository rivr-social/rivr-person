/**
 * Scenario 08 — Hosted-only user forgot password → global email reset → login works.
 *
 * Issue: rivr-social/rivr-app#89 (Recovery, scenario 8)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Provision a hosted-only user on global.
 * 2. Visit global's /forgot-password. Submit email.
 * 3. Click the reset link from mail-hog.
 * 4. Set a new password.
 * 5. Expect: global credentialVersion bumps.
 * 6. Expect: no sovereign-home push (user has none).
 * 7. Verify: login on global works with the new password.
 * 8. Verify: peers accept the new password via SSO.
 *
 * This is the simplest case; it MUST continue to work even while
 * sovereign flows are being extended.
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

describe("Scenario 08 — hosted-only forgotten-password email reset works", () => {
  let account: DisposableAccount | undefined;
  const newPassword = `HostedRecover-${Date.now()}-aA1!`;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "global",
      usernamePrefix: "e2e-hosted-08",
    });
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("reset on global succeeds", async () => {
    if (!account) throw new Error("precondition");
    const result = await resetPasswordViaGlobal(account, newPassword);
    expect(result.ok).toBe(true);
  });

  it("login on global works with new password", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally(
      "global",
      account.username,
      newPassword
    );
    expect(result.ok).toBe(true);
  });

  it("peer SSO works with new password", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally("peer", account.username, newPassword);
    expect(result.ok).toBe(true);
  });
});
