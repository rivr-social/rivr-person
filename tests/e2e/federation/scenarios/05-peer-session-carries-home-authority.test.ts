/**
 * Scenario 05 — Target remote session carries home authority + globalIssuer.
 *
 * Issue: rivr-social/rivr-app#89 (SSO + sync, scenario 5)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Sign into a peer instance via global SSO (Scenario 04).
 * 2. Inspect the session JWT / session record on the peer.
 * 3. Expect: the session carries two distinct fields:
 *      - `homeAuthority`  — sovereign home URL (e.g. rivr.camalot.me)
 *      - `globalIssuer`   — URL of the global that minted the SSO ticket
 * 4. Expect: writes to home-owned resources route to `homeAuthority`.
 * 5. Expect: peer does not claim to own the user itself.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  requireE2EEnv,
  signInLocally,
  type DisposableAccount,
} from "../harness";

describe("Scenario 05 — remote peer session exposes home authority + global issuer", () => {
  let account: DisposableAccount | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-sov-05",
    });
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("peer session exposes homeAuthority pointing at the sovereign home", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally(
      "peer",
      account.username,
      account.localPassword
    );
    expect(result.ok).toBe(true);
    expect(result.homeAuthority).toBeDefined();
    expect(result.homeAuthority).not.toEqual(process.env.E2E_PEER_BASE);
  });

  it("peer session exposes globalIssuer distinct from homeAuthority", async () => {
    if (!account) throw new Error("precondition");
    const result = await signInLocally(
      "peer",
      account.username,
      account.localPassword
    );
    expect(result.globalIssuer).toBeDefined();
    expect(result.globalIssuer).not.toEqual(result.homeAuthority);
  });
});
