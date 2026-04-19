/**
 * Scenario 10 — Sovereign user rotates seed → old seed rejected on next recovery attempt.
 *
 * Issue: rivr-social/rivr-app#89 (Recovery, scenario 10)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Sign in as a sovereign user with a known seed phrase.
 * 2. Navigate to /settings/security → "Rotate Seed Phrase".
 * 3. Complete MFA.
 * 4. Record the NEW seed phrase displayed.
 * 5. Expect: home replaces the stored public key derived from the seed,
 *    and writes an audit row with event=`seed.rotated`.
 * 6. Attempt recovery using the OLD seed. Expect failure.
 * 7. Attempt recovery using the NEW seed. Expect success.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  recoverWithSeed,
  requireE2EEnv,
  rotateSeed,
  type DisposableAccount,
} from "../harness";

describe("Scenario 10 — seed rotation invalidates the previous seed", () => {
  let account: DisposableAccount | undefined;
  const nextPassword = `AfterRotate-${Date.now()}-aA1!`;
  let oldSeed: string | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      withSeedPhrase: true,
      usernamePrefix: "e2e-seed-10",
    });
    oldSeed = account?.seedPhrase;
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("rotation succeeds and returns a new seed phrase", async () => {
    if (!account) throw new Error("precondition");
    const result = await rotateSeed(account, "123456");
    expect(result.ok).toBe(true);
    expect(result.newSeedPhrase).toBeDefined();
    expect(result.newSeedPhrase).not.toEqual(oldSeed);
    // Replace the seed on the in-memory account so later steps use it.
    if (account && result.newSeedPhrase) {
      account.seedPhrase = result.newSeedPhrase;
    }
  });

  it("recovery with OLD seed is rejected", async () => {
    if (!account || !oldSeed) throw new Error("precondition");
    const result = await recoverWithSeed(account, oldSeed, nextPassword);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("recovery with NEW seed succeeds", async () => {
    if (!account?.seedPhrase) throw new Error("precondition");
    const result = await recoverWithSeed(
      account,
      account.seedPhrase,
      nextPassword
    );
    expect(result.ok).toBe(true);
  });
});
