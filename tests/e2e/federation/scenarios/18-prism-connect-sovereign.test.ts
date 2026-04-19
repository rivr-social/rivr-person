/**
 * Scenario 18 — Prism connect works for sovereign user (rivr.camalot.me).
 *
 * Issue: rivr-social/rivr-app#89 (Prism-MCP, scenario 18)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. As a sovereign user, open Prism Claude's integrations page.
 * 2. Choose "Connect RIVR" → enter sovereign home URL.
 * 3. Prism discovers `/.well-known/mcp` at the home.
 * 4. OAuth / session handshake completes.
 * 5. Expect: Prism shows the full tool catalogue for the user
 *    (posts, events, offerings, profile, thanks, audit).
 * 6. Expect: a subsequent tool call succeeds against the home.
 *
 * Automated parts:
 *   - Verifying /.well-known/mcp is discoverable.
 *   - Verifying the tool catalogue contains expected tools.
 *   - Invoking a read-only tool (e.g. `rivr.myprofile.get`) succeeds.
 * Manual parts:
 *   - Confirming the OAuth consent screen renders correctly inside Prism.
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

describe("Scenario 18 — Prism connect works for sovereign user", () => {
  let account: DisposableAccount | undefined;
  let sessionToken: string | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-prism-sov-18",
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

  it("home exposes /.well-known/mcp", async () => {
    const base = process.env.E2E_HOME_BASE!.replace(/\/$/, "");
    const response = await fetch(`${base}/.well-known/mcp`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { tools?: Array<{ name: string }> };
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools?.length).toBeGreaterThan(0);
  });

  it("catalogue lists the expected core tools", async () => {
    const base = process.env.E2E_HOME_BASE!.replace(/\/$/, "");
    const response = await fetch(`${base}/.well-known/mcp`);
    const body = (await response.json()) as { tools?: Array<{ name: string }> };
    const names = body.tools?.map((t) => t.name) ?? [];
    for (const expected of [
      "rivr.post.create",
      "rivr.event.create",
      "rivr.myprofile.get",
    ]) {
      expect(names, `catalogue missing ${expected}`).toContain(expected);
    }
  });

  it("read-only tool call succeeds as the connected user", async () => {
    const result = await prismMcpInvoke(
      "home",
      "rivr.myprofile.get",
      {},
      { sessionToken }
    );
    expect(result.ok).toBe(true);
    expect(result.result).toBeDefined();
  });
});
