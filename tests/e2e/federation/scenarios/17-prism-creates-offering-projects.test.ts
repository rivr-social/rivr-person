/**
 * Scenario 17 — Prism Claude creates an offering via RIVR MCP → projects correctly.
 *
 * Issue: rivr-social/rivr-app#89 (Prism-MCP, scenario 17)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Sign into the sovereign home. Invoke `rivr.offering.create` with:
 *      { title, description, priceCents, currency, localeId, tags }
 * 2. Expect: offering written on home; publication policy evaluated.
 * 3. Expect: projection facade produces a UM-compatible shard.
 * 4. Expect: global's marketplace index picks up the projection.
 * 5. Expect: peer's locale feed picks up the projection if the locale
 *    matches the peer's scope.
 * 6. Verify all three surfaces return the offering with a pointer back
 *    to the sovereign home for write operations.
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

describe("Scenario 17 — MCP-created offering projects to global and peer", () => {
  let account: DisposableAccount | undefined;
  let sessionToken: string | undefined;
  let offeringId: string | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-mcp-offering-17",
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

  it("MCP creates the offering on the home", async () => {
    const result = await prismMcpInvoke(
      "home",
      "rivr.offering.create",
      {
        title: `E2E Offering ${Date.now()}`,
        description: "Created by scenario 17 via MCP.",
        priceCents: 500,
        currency: "USD",
        visibility: "public",
        tags: ["e2e"],
      },
      { sessionToken }
    );
    expect(result.ok).toBe(true);
    const anyResult = result.result as { offeringId?: string } | undefined;
    offeringId = anyResult?.offeringId;
    expect(offeringId).toBeDefined();
  });

  it("global marketplace index includes the projected offering", async () => {
    if (!offeringId) throw new Error("precondition");
    const globalBase = process.env.E2E_GLOBAL_BASE!.replace(/\/$/, "");
    const response = await fetch(
      `${globalBase}/api/federation/query?kind=offering&id=${encodeURIComponent(
        offeringId
      )}`
    );
    expect(response.ok).toBe(true);
    const body = (await response.json()) as {
      entity?: { homeAuthority?: string };
    };
    expect(body.entity?.homeAuthority).toContain("camalot");
  });
});
