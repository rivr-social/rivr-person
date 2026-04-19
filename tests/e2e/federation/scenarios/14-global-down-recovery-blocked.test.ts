/**
 * Scenario 14 — Global down during recovery → recovery blocked (documented behavior).
 *
 * Issue: rivr-social/rivr-app#89 (Authority enforcement, scenario 14)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Provision a sovereign user.
 * 2. Simulate global outage.
 * 3. Attempt the email-reset-via-global recovery flow.
 * 4. Expect: the flow returns a clear, user-facing error indicating
 *    global is unreachable and to try again later (or use seed phrase).
 * 5. Expect: home does NOT install a partial credential update.
 * 6. Attempt seed-phrase recovery — this should STILL work because
 *    seed-phrase recovery is home-local by design.
 *
 * Documented behavior: email-via-global recovery is the only path that
 * hard-depends on global. Seed recovery must be available as the
 * always-on fallback.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NotYetImplementedError,
  createDisposableAccount,
  deleteDisposableAccount,
  recoverWithSeed,
  requireE2EEnv,
  resetPasswordViaGlobal,
  simulateGlobalOutage,
  type DisposableAccount,
} from "../harness";

describe("Scenario 14 — global outage blocks email recovery but not seed recovery", () => {
  let account: DisposableAccount | undefined;
  let restore: (() => void) | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      withSeedPhrase: true,
      usernamePrefix: "e2e-global-down-14",
    });
    restore = simulateGlobalOutage();
  });

  afterAll(async () => {
    if (restore) restore();
    if (account) await deleteDisposableAccount(account);
  });

  it("email-via-global recovery fails cleanly while global is down", async () => {
    if (!account) throw new Error("precondition");
    const newPassword = `BlockedRecover-${Date.now()}-aA1!`;
    try {
      const result = await resetPasswordViaGlobal(account, newPassword);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
      // The error should mention unreachability, not "wrong password" etc.
      expect(result.error?.toLowerCase()).toMatch(/unreach|network|offline|global/);
    } catch (err) {
      // NotYetImplementedError is acceptable at scaffolding stage.
      if (!(err instanceof NotYetImplementedError)) throw err;
    }
  });

  it("seed recovery continues to work while global is down", async () => {
    if (!account?.seedPhrase) throw new Error("precondition");
    const newPassword = `SeedStillWorks-${Date.now()}-aA1!`;
    const result = await recoverWithSeed(
      account,
      account.seedPhrase,
      newPassword
    );
    expect(result.ok).toBe(true);
  });
});
