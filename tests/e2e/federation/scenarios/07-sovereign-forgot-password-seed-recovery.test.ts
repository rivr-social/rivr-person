/**
 * Scenario 07 — Sovereign user forgot local password AND cannot receive email →
 * uses seed phrase → home accepts recovery assertion → login works.
 *
 * Issue: rivr-social/rivr-app#89 (Recovery, scenario 7)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Provision a sovereign user with a seed phrase captured at signup.
 * 2. Assume both local password AND email are inaccessible.
 * 3. Visit home's /recovery page. Choose "seed phrase".
 * 4. Enter the seed phrase. Client derives a signing key and produces
 *    a signed recovery assertion:
 *      { userId, newPasswordHash, nonce, timestamp, sig }
 * 5. Submit the assertion. See rivr-app#17 (WIP).
 * 6. Expect: home validates the signature against the seed-derived
 *    public key stored for this user.
 * 7. Expect: home installs the new password and bumps credentialVersion.
 * 8. Expect: home pushes the bump to global (reuse #15 sync path).
 * 9. Verify: local sign-in with the new password succeeds.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  recoverWithSeed,
  requireE2EEnv,
  signInLocally,
  type DisposableAccount,
} from "../harness";

describe("Scenario 07 — seed-phrase recovery installs new password on home", () => {
  let account: DisposableAccount | undefined;
  const newPassword = `SeedRecover-${Date.now()}-aA1!`;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      withSeedPhrase: true,
      usernamePrefix: "e2e-recover-07",
    });
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("home accepts the seed-signed recovery assertion", async () => {
    if (!account?.seedPhrase) throw new Error("precondition: seed required");
    const result = await recoverWithSeed(
      account,
      account.seedPhrase,
      newPassword
    );
    expect(result.ok).toBe(true);
  });

  it("local sign-in works after seed recovery", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally("home", account.username, newPassword);
    expect(result.ok).toBe(true);
  });

  it("the new credentialVersion propagates to global", async () => {
    if (!account) throw new Error("precondition");
    // Peer sign-in via global SSO should use the new password.
    const result = await signInLocally("peer", account.username, newPassword);
    expect(result.ok).toBe(true);
  });
});
