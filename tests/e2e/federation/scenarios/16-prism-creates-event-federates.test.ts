/**
 * Scenario 16 — Prism Claude creates an event via RIVR MCP → federates to peer instance.
 *
 * Issue: rivr-social/rivr-app#89 (Prism-MCP, scenario 16)
 *
 * ============================================================
 * RUNBOOK
 * ============================================================
 * 1. Sign into the sovereign home. Invoke `rivr.event.create` via MCP:
 *      { title, startsAt, endsAt, locationId, visibility: "public" }
 * 2. Expect: event written locally on the home.
 * 3. Expect: federation export picks up the event and projects it to
 *    peers matching the locale/tags.
 * 4. Wait ≤ 60s.
 * 5. Query the peer's event feed. Expect the event to appear with a
 *    pointer back to the sovereign home's authoritative URL.
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

const FEDERATION_WINDOW_MS = 90_000;

describe("Scenario 16 — MCP-created event federates to peer", () => {
  let account: DisposableAccount | undefined;
  let sessionToken: string | undefined;
  let eventId: string | undefined;

  beforeAll(async () => {
    requireE2EEnv();
    account = await createDisposableAccount({
      homeRole: "home",
      usernamePrefix: "e2e-mcp-event-16",
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

  it("MCP creates the event on the home", async () => {
    const result = await prismMcpInvoke(
      "home",
      "rivr.event.create",
      {
        title: `E2E Event ${Date.now()}`,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        endsAt: new Date(Date.now() + 90_000_000).toISOString(),
        visibility: "public",
      },
      { sessionToken }
    );
    expect(result.ok).toBe(true);
    const anyResult = result.result as { eventId?: string } | undefined;
    eventId = anyResult?.eventId;
    expect(eventId).toBeDefined();
  });

  it("peer sees the federated event within the window", async () => {
    if (!eventId) throw new Error("precondition: eventId required");
    const peerBase = process.env.E2E_PEER_BASE!.replace(/\/$/, "");

    const deadline = Date.now() + FEDERATION_WINDOW_MS;
    while (Date.now() < deadline) {
      const response = await fetch(
        `${peerBase}/api/federation/query?kind=event&id=${encodeURIComponent(
          eventId
        )}`
      );
      if (response.ok) {
        const body = (await response.json()) as {
          entity?: { id?: string; homeAuthority?: string };
        };
        if (body.entity?.id === eventId) {
          expect(body.entity.homeAuthority).toContain("camalot");
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(
      `peer did not see event ${eventId} within ${FEDERATION_WINDOW_MS}ms`
    );
  });
});
