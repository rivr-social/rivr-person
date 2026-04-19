/**
 * Scenario 19 — Prism connect works for hosted-only user (a.rivr.social).
 *
 * Issue: rivr-social/rivr-app#89 (Prism-MCP, scenario 19)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. As a hosted-only user (homed on global), open Prism Claude.
 * 2. Choose "Connect RIVR" → enter global URL (e.g. a.rivr.social).
 * 3. Prism discovers `/.well-known/mcp` on global.
 * 4. OAuth / session handshake completes against global.
 * 5. Expect: Prism tool catalogue is available.
 * 6. Expect: subsequent tool calls target global as the home.
 *
 * This mirrors Scenario 18 but targets the global instance instead of
 * a sovereign home, ensuring hosted users aren't penalized.
 * ============================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDisposableAccount,
  deleteDisposableAccount,
  prismMcpInvoke,
  requireE2EEnv,
  signInLocally,
  type DisposableAccount,
} from "../harness";

describe("Scenario 19 — Prism connect works for hosted-only user on global", () => {
  let account: DisposableAccount | undefined;
  let sessionToken: string | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "global",
      usernamePrefix: "e2e-prism-hosted-19",
    });
    const signIn = await signInLocally(
      "global",
      account.username,
      account.localPassword
    );
    sessionToken = signIn.sessionToken;
  });

  afterAll(async () => {
    if (account) await deleteDisposableAccount(account);
  });

  it("global exposes /.well-known/mcp", async () => {
    const base = process.env.E2E_GLOBAL_BASE!.replace(/\/$/, "");
    const response = await fetch(`${base}/.well-known/mcp`);
    expect(response.ok).toBe(true);
  });

  it("hosted-only tool call succeeds against global", async () => {
    const result = await prismMcpInvoke(
      "global",
      "rivr.myprofile.get",
      {},
      { sessionToken }
    );
    expect(result.ok).toBe(true);
    // Hosted-only users have homeAuthority === global base
    if (result.homeAuthority) {
      expect(result.homeAuthority).toContain(
        (process.env.E2E_GLOBAL_BASE ?? "").replace(/^https?:\/\//, "")
      );
    }
  });
});
