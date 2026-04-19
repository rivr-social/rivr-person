/**
 * Scenario 09 — Sovereign user reveals seed in settings with MFA → audit log entry present.
 *
 * Issue: rivr-social/rivr-app#89 (Recovery, scenario 9)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Sign into the sovereign home as the target user.
 * 2. Navigate to /settings/security → "Reveal Seed Phrase".
 * 3. The UI requires MFA: TOTP code, WebAuthn, or re-entered password +
 *    email confirmation (whichever the home is configured for).
 * 4. Complete MFA.
 * 5. Expect: seed phrase is displayed once, never stored client-side.
 * 6. Expect: an audit log row is written with event=`seed.revealed`,
 *    userId, timestamp, and source IP.
 * 7. Verify: `GET /api/audit?event=seed.revealed&userId=...` returns
 *    exactly one new entry.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  fetchAuditEntries,
  requireE2EEnv,
  revealSeed,
  signInLocally,
  type DisposableAccount,
} from "../harness";

describe("Scenario 09 — seed reveal requires MFA and leaves an audit trail", () => {
  let account: DisposableAccount | undefined;
  let sessionToken: string | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      withSeedPhrase: true,
      usernamePrefix: "e2e-seed-09",
    });
    const signIn = await signInLocally(
      "home",
      account.username,
      account.localPassword
    );
    sessionToken = signIn.sessionToken;
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("reveals the seed when MFA succeeds", async () => {
    if (!account) throw new Error("precondition");
    const result = await revealSeed(account, "123456");
    expect(result.ok).toBe(true);
    expect(result.seedPhrase).toBeDefined();
    expect(result.seedPhrase?.split(" ").length).toBeGreaterThanOrEqual(12);
  });

  it("writes an audit entry with event=seed.revealed", async () => {
    if (!account?.userId) throw new Error("precondition: userId required");
    const audit = await fetchAuditEntries(
      "home",
      account.userId,
      "seed.revealed",
      sessionToken
    );
    expect(audit.ok).toBe(true);
    expect(audit.entries?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("rejects reveal when MFA is invalid", async () => {
    if (!account) throw new Error("precondition");
    const result = await revealSeed(account, "000000");
    expect(result.ok).toBe(false);
  });
});
