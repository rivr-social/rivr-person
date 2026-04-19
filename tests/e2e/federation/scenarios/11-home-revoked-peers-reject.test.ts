/**
 * Scenario 11 — Home revoked via signed authority.revoke → peers reject sessions within 60s.
 *
 * Issue: rivr-social/rivr-app#89 (Authority enforcement, scenario 11)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Provision a sovereign user. Sign into a peer via global SSO.
 * 2. Record the peer session cookie.
 * 3. On the sovereign home, issue a signed `authority.revoke` event:
 *      - subject = userId
 *      - reason = "test_revocation"
 *      - nonce, timestamp, signature by home's federation key
 * 4. Publish to `/api/federation/events` on the home.
 * 5. Global pulls / peer pulls the event.
 * 6. Expect: within ~60s the peer invalidates the previously-valid
 *    session and returns 401 on any authenticated request.
 *
 * Tolerance: assertion uses a 90s wait window to allow for poll/push
 * jitter.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  requireE2EEnv,
  revokeAuthority,
  signInLocally,
  type DisposableAccount,
} from "../harness";

const MAX_PROPAGATION_MS = 90_000;

describe("Scenario 11 — authority.revoke invalidates peer sessions within 60s", () => {
  let account: DisposableAccount | undefined;
  let peerSessionToken: string | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-revoke-11",
    });
    const peerSignIn = await signInLocally(
      "peer",
      account.username,
      account.localPassword
    );
    peerSessionToken = peerSignIn.sessionToken;
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("home successfully signs and publishes authority.revoke", async () => {
    if (!account) throw new Error("precondition");
    const result = await revokeAuthority({
      subject: account,
      revokingRole: "home",
    });
    expect(result.ok).toBe(true);
    expect(result.revocationId).toBeDefined();
  });

  it("peer rejects the previously-valid session within the propagation window", async () => {
    if (!account || !peerSessionToken) throw new Error("precondition");
    const peerBase = process.env.E2E_PEER_BASE!.replace(/\/$/, "");

    const deadline = Date.now() + MAX_PROPAGATION_MS;
    let lastStatus = 0;
    while (Date.now() < deadline) {
      const response = await fetch(`${peerBase}/api/myprofile`, {
        headers: { cookie: `next-auth.session-token=${peerSessionToken}` },
      });
      lastStatus = response.status;
      if (response.status === 401 || response.status === 403) {
        return;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(
      `peer did not invalidate session within ${MAX_PROPAGATION_MS}ms (last status ${lastStatus})`
    );
  });
});
