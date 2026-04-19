/**
 * Scenario 15 — Prism Claude creates a post via RIVR MCP → post lands on correct authority.
 *
 * Issue: rivr-social/rivr-app#89 (Prism-MCP, scenario 15)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Sign in as a sovereign user on the home instance. Obtain session
 *    token (the MCP route accepts the same auth).
 * 2. Invoke `rivr.post.create` via MCP with:
 *      { title, body, visibility, tags }
 * 3. Expect: 200 JSON-RPC response with `result.postId`.
 * 4. Expect: the post is written to the sovereign home's DB, not the
 *    peer or global.
 * 5. Expect: the response carries `homeAuthority = <home base>`.
 * 6. Fetch the post through the federated query API on global and peer.
 *    Both must resolve it to the sovereign home.
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

describe("Scenario 15 — rivr.post.create via MCP lands on the correct authority", () => {
  let account: DisposableAccount | undefined;
  let sessionToken: string | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-mcp-post-15",
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

  it("MCP accepts a post create and returns homeAuthority", async () => {
    const result = await prismMcpInvoke(
      "home",
      "rivr.post.create",
      {
        title: `E2E Post ${Date.now()}`,
        body: "Created by scenario 15 via MCP.",
        visibility: "public",
        tags: ["e2e", "federation-auth"],
      },
      { sessionToken }
    );
    expect(result.ok).toBe(true);
    expect(result.homeAuthority).toBeDefined();
    expect(result.homeAuthority).toContain(
      (process.env.E2E_HOME_BASE ?? "").replace(/^https?:\/\//, "")
    );
  });
});
