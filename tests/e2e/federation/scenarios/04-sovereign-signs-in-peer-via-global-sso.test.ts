/**
 * Scenario 04 — Sovereign user signs into peer via global SSO with new password.
 *
 * Issue: rivr-social/rivr-app#89 (SSO + sync, scenario 4)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Pre-req: Scenario 02 has already rotated the password.
 * 2. On the peer instance (e.g. front-range.rivr.social), click
 *    "Sign in with RIVR" → redirected to global SSO.
 * 3. Authenticate with the NEW password.
 * 4. Expect: global verifies against its current credentialVersion,
 *    issues an SSO ticket, and redirects back to peer.
 * 5. Expect: peer session has home-authority = sovereign home,
 *    not the peer itself.
 *
 * This scenario is the primary integration test that ties the whole
 * reset→sync→SSO chain together.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  requireE2EEnv,
  resetPasswordOnHome,
  signInLocally,
  type DisposableAccount,
} from "../harness";

describe("Scenario 04 — peer SSO via global uses the post-reset password", () => {
  let account: DisposableAccount | undefined;
  const newPassword = `PeerSSO-${Date.now()}-aA1!`;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-sov-04",
    });
    // Rotate to the new password first.
    await resetPasswordOnHome(account, newPassword);
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("peer rejects the old password", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally(
      "peer",
      account.username,
      account.localPassword
    );
    expect(result.ok).toBe(false);
  });

  it("peer accepts the new password (via global SSO)", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally("peer", account.username, newPassword);
    expect(result.ok).toBe(true);
    expect(result.sessionToken).toBeDefined();
  });
});
