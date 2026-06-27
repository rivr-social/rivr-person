/**
 * Tests for the `rivr.connectors.sync` MCP tool.
 *
 * The tool exposes person's autobot connector SYNC lanes (Notion, Google
 * Drive/Calendar, Slack, Discord, etc.) to the already-wired autobot chat
 * tool-use loop, scoped to the calling actor and routed through the same
 * provenance-logging execution path (`executeMcpToolCall`) as the JSON-RPC
 * `tools/call` handler.
 *
 * Coverage:
 *   1. The tool is registered with the expected name, schema, and enabled
 *      modes; its provider enum matches the syncable-provider catalog.
 *   2. The handler dispatches to `runConnectorSync` with the execution
 *      context's `actorId` (NOT an ambient session) and the requested provider.
 *   3. A successful call is logged to mcp_provenance_log with resultStatus
 *      "success".
 *   4. A failed lane (ConnectorSyncError) is returned as a structured
 *      `{ success: false }` and recorded in provenance as resultStatus "error".
 *   5. Unknown/empty input (missing provider) is rejected.
 *
 * Database, the sync runner, and the approval middleware are stubbed so this is
 * a pure-logic test that runs without a live Postgres. Installed before the
 * modules under test are imported so top-level bindings capture the stubs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Shape of the single argument passed to the stubbed `logMcpProvenance`. */
type ProvenanceLogParams = {
  toolName: string;
  resultStatus: "success" | "error";
  context: { actorId: string };
};

// ---------------------------------------------------------------------------
// Stubs — installed before importing the modules under test.
// ---------------------------------------------------------------------------

// `vi.mock` factories are hoisted above the file body, so anything they
// reference must be created in a `vi.hoisted` block (also hoisted) rather than
// as ordinary top-level bindings.
const {
  runConnectorSyncMock,
  FakeConnectorSyncError,
  FAKE_SYNCABLE_PROVIDERS,
  logMcpProvenanceMock,
} = vi.hoisted(() => {
    class HoistedConnectorSyncError extends Error {
      constructor(
        message: string,
        readonly code: string,
      ) {
        super(message);
        this.name = "ConnectorSyncError";
      }
    }

    return {
      runConnectorSyncMock: vi.fn<(actorId: string, provider: string) => unknown>(),
      logMcpProvenanceMock: vi.fn<(params: ProvenanceLogParams) => Promise<void>>(
        async () => {},
      ),
      FakeConnectorSyncError: HoistedConnectorSyncError,
      FAKE_SYNCABLE_PROVIDERS: [
        "google_docs",
        "google_calendar",
        "notion",
        "telegram",
        "messenger",
        "facebook",
        "instagram",
        "obsidian_vault",
        "parachute_vault",
        "proton_docs",
        "wolfram",
        "generic_oauth2",
        "slack",
        "discord",
        "dropbox",
        "zoom",
      ],
    };
  });

vi.mock("@/lib/autobot-connector-sync", () => ({
  runConnectorSync: (actorId: string, provider: string) =>
    runConnectorSyncMock(actorId, provider),
  ConnectorSyncError: FakeConnectorSyncError,
  CONNECTOR_SYNC_FAILURE: {
    UNKNOWN_PROVIDER: "UNKNOWN_PROVIDER",
    NOT_CONFIGURED: "NOT_CONFIGURED",
    SYNC_UNSUPPORTED: "SYNC_UNSUPPORTED",
    SYNC_FAILED: "SYNC_FAILED",
  },
  SYNCABLE_CONNECTOR_PROVIDERS: FAKE_SYNCABLE_PROVIDERS,
}));

// `mcp-server.ts` imports `@/auth` (next-auth) at module load. We never exercise
// the auth path here (we call `executeMcpToolCall` with an already-authorized
// context), so stub it to avoid next-auth's ESM `next/server` resolution under
// vitest.
vi.mock("@/auth", () => ({
  auth: async () => null,
}));

// Provenance logging: assert it is written with the right status.
vi.mock("@/lib/federation/mcp-provenance", () => ({
  logMcpProvenance: (params: ProvenanceLogParams) => logMcpProvenanceMock(params),
}));

// Execution context: just run the callback (no async-local store needed here).
vi.mock("@/lib/federation/execution-context", () => ({
  runWithMcpExecutionContext: (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
}));

// Approval middleware: human actors execute directly — mirror that behavior so
// we exercise the real provenance path without a DB-backed policy lookup.
vi.mock("@/lib/autobot/with-approval-check", () => ({
  withApprovalCheck: async (params: {
    handler: () => Promise<unknown>;
  }) => ({
    executed: true,
    result: await params.handler(),
  }),
}));

import {
  MCP_TOOL_DEFINITIONS,
  getMcpToolDefinition,
  listMcpToolsForMode,
  type McpToolCallContext,
} from "@/lib/federation/mcp-tools";
import { executeMcpToolCall } from "@/lib/federation/mcp-server";

const TOOL_NAME = "rivr.connectors.sync";
const TEST_ACTOR_ID = "agent-under-test";

function humanContext(): McpToolCallContext {
  return {
    actorId: TEST_ACTOR_ID,
    controllerId: TEST_ACTOR_ID,
    actorType: "human",
    authMode: "session",
  };
}

beforeEach(() => {
  runConnectorSyncMock.mockReset();
  logMcpProvenanceMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("rivr.connectors.sync registration", () => {
  it("is registered with the expected name, schema, and enabled modes", () => {
    const tool = getMcpToolDefinition(TOOL_NAME);
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe(TOOL_NAME);
    expect(tool?.enabledFor).toEqual(["session", "token"]);

    const schema = tool?.inputSchema as {
      type: string;
      required: string[];
      additionalProperties: boolean;
      properties: { provider: { enum: string[] } };
    };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["provider"]);
    // The provider enum is the syncable-provider catalog.
    expect(schema.properties.provider.enum).toEqual(FAKE_SYNCABLE_PROVIDERS);
  });

  it("is exposed in both session and token tool listings", () => {
    expect(
      listMcpToolsForMode("session").some((t) => t.name === TOOL_NAME),
    ).toBe(true);
    expect(
      listMcpToolsForMode("token").some((t) => t.name === TOOL_NAME),
    ).toBe(true);
    // It is a single registry entry, not duplicated.
    expect(
      MCP_TOOL_DEFINITIONS.filter((t) => t.name === TOOL_NAME),
    ).toHaveLength(1);
  });
});

describe("rivr.connectors.sync execution", () => {
  it("dispatches to runConnectorSync with the context actorId and provider", async () => {
    runConnectorSyncMock.mockResolvedValue({
      result: { provider: "notion", imported: 2, updated: 1, skipped: 0, message: "ok" },
      kgIngest: { provider: "notion", ingested: 3, skipped: 0, errors: 0, details: [] },
      connections: [{ provider: "notion" }],
    });

    const { result, executed } = await executeMcpToolCall(
      TOOL_NAME,
      { provider: "notion" },
      humanContext(),
    );

    // Scoped to the execution context's actor — never an ambient session.
    expect(runConnectorSyncMock).toHaveBeenCalledTimes(1);
    expect(runConnectorSyncMock).toHaveBeenCalledWith(TEST_ACTOR_ID, "notion");

    expect(executed).toBe(true);
    const payload = result as { success: boolean; result: { provider: string } };
    expect(payload.success).toBe(true);
    expect(payload.result.provider).toBe("notion");
  });

  it("logs provenance with resultStatus success on a successful sync", async () => {
    runConnectorSyncMock.mockResolvedValue({
      result: { provider: "slack", imported: 0, updated: 0, skipped: 0, message: "ok" },
      kgIngest: null,
      connections: [],
    });

    await executeMcpToolCall(TOOL_NAME, { provider: "slack" }, humanContext());

    expect(logMcpProvenanceMock).toHaveBeenCalledTimes(1);
    const logged = logMcpProvenanceMock.mock.calls[0][0];
    expect(logged.toolName).toBe(TOOL_NAME);
    expect(logged.resultStatus).toBe("success");
    expect(logged.context.actorId).toBe(TEST_ACTOR_ID);
  });

  it("returns a structured failure and logs resultStatus error when the lane fails", async () => {
    runConnectorSyncMock.mockRejectedValue(
      new FakeConnectorSyncError(
        'Connector "notion" is not configured for this actor.',
        "NOT_CONFIGURED",
      ),
    );

    const { result, executed } = await executeMcpToolCall(
      TOOL_NAME,
      { provider: "notion" },
      humanContext(),
    );

    // The handler converts ConnectorSyncError into a structured failure rather
    // than throwing, so the call still "executes".
    expect(executed).toBe(true);
    const payload = result as { success: boolean; code: string; error: string };
    expect(payload.success).toBe(false);
    expect(payload.code).toBe("NOT_CONFIGURED");

    // Provenance records the action's actual outcome as an error.
    expect(logMcpProvenanceMock).toHaveBeenCalledTimes(1);
    expect(logMcpProvenanceMock.mock.calls[0][0].resultStatus).toBe("error");
  });

  it("rejects a call with a missing provider and logs an error", async () => {
    await expect(
      executeMcpToolCall(TOOL_NAME, {}, humanContext()),
    ).rejects.toThrow(/provider is required/);

    // The lane is never reached when input validation fails.
    expect(runConnectorSyncMock).not.toHaveBeenCalled();
    // The thrown handler error is still recorded in provenance.
    expect(logMcpProvenanceMock).toHaveBeenCalledTimes(1);
    expect(logMcpProvenanceMock.mock.calls[0][0].resultStatus).toBe("error");
  });
});
