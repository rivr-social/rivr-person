import { auth } from "@/auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { verifyPackedPayload } from "@/lib/federation-remote-session";
import { isPersonaOf } from "@/lib/persona";
import { runWithMcpExecutionContext, type PersonaContext } from "@/lib/federation/execution-context";
import {
  getMcpToolDefinition,
  listMcpToolsForMode,
  type McpToolCallContext,
} from "@/lib/federation/mcp-tools";
import { logMcpProvenance } from "@/lib/federation/mcp-provenance";
import { withApprovalCheck } from "@/lib/autobot/with-approval-check";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import * as kg from "@/lib/kg/autobot-kg-client";

const MCP_PROTOCOL_VERSION = "2024-11-05";

/**
 * Constant-time string comparison (AUTH-SEC-006b). Length mismatch short-
 * circuits (token lengths are not themselves secret), but equal-length inputs
 * are compared with `timingSafeEqual` so a byte-by-byte timing side-channel
 * cannot recover the high-value static AIAGENT_MCP_TOKEN.
 */
function secureEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type McpAuthContext = McpToolCallContext;

type ScopedMcpTokenPayload = {
  type: "rivr_mcp_token";
  actorId: string;
  controllerId: string;
  actorType: "human" | "persona";
  issuer: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
  scopes: string[];
};

function errorResponse(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data,
    },
  };
}

function successResponse(id: JsonRpcId, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function getQueryToken(request: Request): string | null {
  const token = new URL(request.url).searchParams.get("token")?.trim();
  return token ? token : null;
}

function validateScopedMcpToken(token: string): ScopedMcpTokenPayload | null {
  const payload = verifyPackedPayload<ScopedMcpTokenPayload>(token);
  if (!payload || payload.type !== "rivr_mcp_token") return null;

  const now = Date.now();
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return null;
  if (issuedAt > now + 60_000 || expiresAt <= now) return null;

  const config = getInstanceConfig();
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  if (payload.issuer !== baseUrl || payload.audience !== baseUrl) return null;
  if (!payload.scopes.includes("mcp:tools")) return null;

  return payload;
}

/**
 * Fetch full persona context from the DB for a given persona agent ID.
 * Returns null if the agent is not found or is deleted.
 */
async function fetchPersonaContext(personaId: string): Promise<PersonaContext | null> {
  const [row] = await db
    .select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(and(eq(agents.id, personaId), isNull(agents.deletedAt)))
    .limit(1);

  if (!row) return null;

  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const bio = typeof meta.bio === "string" ? meta.bio : row.description ?? undefined;

  // Gather KG doc references for this persona scope
  let kgRefs: string[] = [];
  try {
    const docs = await kg.listDocs("persona", personaId);
    kgRefs = docs.map((d) => String(d.id));
  } catch {
    // KG unavailable — proceed without refs
  }

  return {
    personaId: row.id,
    name: row.name,
    bio,
    kgRefs: kgRefs.length > 0 ? kgRefs : undefined,
    metadata: Object.keys(meta).length > 0 ? meta : undefined,
  };
}

async function authorizeMcpRequest(
  request: Request,
  requestedActorId?: string | null,
): Promise<McpAuthContext | null> {
  const session = await auth();
  const sessionUserId = session?.user?.id ?? null;

  if (sessionUserId) {
    if (!requestedActorId || requestedActorId === sessionUserId) {
      return {
        actorId: sessionUserId,
        controllerId: sessionUserId,
        actorType: "human",
        authMode: "session",
      };
    }

    const ownedPersona = await isPersonaOf(requestedActorId, sessionUserId);
    if (ownedPersona) {
      return {
        actorId: requestedActorId,
        controllerId: sessionUserId,
        actorType: "persona",
        authMode: "session",
      };
    }

    return null;
  }

  const configuredToken = process.env.AIAGENT_MCP_TOKEN?.trim() || "";
  const providedToken = getBearerToken(request) ?? getQueryToken(request);

  if (providedToken) {
    const scopedToken = validateScopedMcpToken(providedToken);
    if (scopedToken) {
      if (!requestedActorId || requestedActorId === scopedToken.actorId) {
        return {
          actorId: scopedToken.actorId,
          controllerId: scopedToken.controllerId,
          actorType: scopedToken.actorType,
          authMode: "token",
        };
      }

      const ownedPersona = await isPersonaOf(requestedActorId, scopedToken.controllerId);
      if (ownedPersona) {
        return {
          actorId: requestedActorId,
          controllerId: scopedToken.controllerId,
          actorType: "persona",
          authMode: "token",
        };
      }

      return null;
    }
  }

  // Constant-time compare: the scoped-token path is HMAC-verified; the
  // high-value static AIAGENT_MCP_TOKEN must not be probed via a byte-wise
  // timing side-channel (AUTH-SEC-006b).
  if (!configuredToken || !providedToken || !secureEqualStrings(providedToken, configuredToken)) {
    return null;
  }

  const config = getInstanceConfig();
  const primaryAgentId = config.primaryAgentId;
  if (!primaryAgentId) {
    return null;
  }

  if (!requestedActorId || requestedActorId === primaryAgentId) {
    return {
      actorId: primaryAgentId,
      controllerId: primaryAgentId,
      actorType: "autobot",
      authMode: "token",
    };
  }

  const ownedPersona = await isPersonaOf(requestedActorId, primaryAgentId);
  if (!ownedPersona) {
    return null;
  }

  return {
    actorId: requestedActorId,
    controllerId: primaryAgentId,
    actorType: "autobot",
    authMode: "token",
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toToolContent(result: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
    structuredContent: result,
    isError,
  };
}

export type McpToolCallFailureCode = "unknown_tool" | "not_enabled" | "execution_failed";

export class McpToolCallError extends Error {
  constructor(
    message: string,
    readonly code: McpToolCallFailureCode,
  ) {
    super(message);
    this.name = "McpToolCallError";
  }
}

/**
 * Execute a single MCP tool call for an already-authorized actor context.
 *
 * This is the single execution path shared by the JSON-RPC `tools/call`
 * handler and the in-process autobot chat tool-use loop. It enforces the
 * tool's auth-mode gating, fills in persona context when the actor is a
 * persona, routes through the approval policy engine, runs the handler
 * inside the MCP execution context, and writes the provenance log entry.
 *
 * Throws {@link McpToolCallError} with `unknown_tool` / `not_enabled` for
 * gating failures; handler errors are logged to provenance and rethrown as
 * `execution_failed`.
 */
export async function executeMcpToolCall(
  toolName: string,
  toolArgs: Record<string, unknown>,
  authContext: McpToolCallContext,
): Promise<{ result: unknown; executed: boolean }> {
  const tool = getMcpToolDefinition(toolName);
  if (!tool) {
    throw new McpToolCallError(`Unknown tool: ${toolName}`, "unknown_tool");
  }
  if (!tool.enabledFor.includes(authContext.authMode)) {
    throw new McpToolCallError(
      `Tool ${toolName} is not enabled for this auth mode.`,
      "not_enabled",
    );
  }

  if (authContext.actorType === "persona" && !authContext.personaContext) {
    authContext.personaContext =
      (await fetchPersonaContext(authContext.actorId).catch(() => null)) ?? undefined;
  }

  const startTime = Date.now();
  try {
    const approvalResult = await withApprovalCheck({
      toolName,
      toolArgs,
      context: authContext,
      handler: () =>
        runWithMcpExecutionContext(
          {
            actorId: authContext.actorId,
            controllerId: authContext.controllerId,
            actorType: authContext.actorType,
            personaContext: authContext.personaContext,
          },
          async () => tool.handler(toolArgs, authContext),
        ),
    });

    // Tool handlers signal failure two ways: by throwing (caught below) OR by
    // returning an ActionResult-shaped `{ success: false, ... }` without
    // throwing (e.g. FORBIDDEN/INVALID_INPUT from a server action). The
    // provenance log must reflect the action's actual outcome — otherwise a
    // blocked post is recorded as "success" and the audit trail lies about what
    // the assistant accomplished.
    const callResult = approvalResult.result as unknown;
    const actionFailed =
      approvalResult.executed === true &&
      typeof callResult === "object" &&
      callResult !== null &&
      "success" in callResult &&
      (callResult as { success?: unknown }).success === false;
    const actionFailureMessage = actionFailed
      ? (((callResult as { message?: unknown }).message as string | undefined) ??
        ((callResult as { error?: { code?: unknown } }).error?.code as
          | string
          | undefined))
      : undefined;

    logMcpProvenance({
      toolName,
      context: authContext,
      args: toolArgs,
      resultStatus: actionFailed ? "error" : "success",
      errorMessage: actionFailureMessage,
      durationMs: Date.now() - startTime,
    }).catch(() => {});

    return { result: approvalResult.result, executed: approvalResult.executed };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Tool execution failed.";
    logMcpProvenance({
      toolName,
      context: authContext,
      args: toolArgs,
      resultStatus: "error",
      errorMessage: message,
      durationMs: Date.now() - startTime,
    }).catch(() => {});

    throw new McpToolCallError(message, "execution_failed");
  }
}

export async function handleMcpRequest(request: Request, body: JsonRpcRequest) {
  const id = body.id ?? null;
  const method = typeof body.method === "string" ? body.method : "";
  const params = asObject(body.params);
  const requestedActorId =
    typeof params.actorId === "string" && params.actorId.trim().length > 0
      ? params.actorId.trim()
      : null;

  if (body.jsonrpc !== "2.0") {
    return errorResponse(id, -32600, "Invalid Request", "jsonrpc must be '2.0'.");
  }

  const authContext = await authorizeMcpRequest(request, requestedActorId);
  if (!authContext) {
    return errorResponse(id, -32001, "Unauthorized", "Valid session or AIAGENT_MCP_TOKEN required.");
  }

  // Resolve persona context when the actor is a persona, or when a remote
  // agent asserts a persona via the X-Persona-Id header.
  let personaContext: PersonaContext | null = null;
  const headerPersonaId = request.headers.get("x-persona-id")?.trim() || null;

  if (authContext.actorType === "persona") {
    // Auth already resolved to a persona — fetch its full context
    personaContext = await fetchPersonaContext(authContext.actorId).catch(() => null);
  } else if (headerPersonaId) {
    // Remote agent assertion via header — validate ownership before accepting
    const controllerId = authContext.controllerId ?? authContext.actorId;
    const owned = await isPersonaOf(headerPersonaId, controllerId).catch(() => false);
    if (owned) {
      personaContext = await fetchPersonaContext(headerPersonaId).catch(() => null);
      // Upgrade the auth context to reflect persona acting mode
      authContext.actorType = "persona";
      authContext.actorId = headerPersonaId;
    }
  }

  if (personaContext) {
    authContext.personaContext = personaContext;
  }

  if (method === "initialize") {
    const config = getInstanceConfig();
    return successResponse(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: {
        name: `rivr-${config.instanceType}-mcp`,
        version: "0.1.0",
      },
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
    });
  }

  if (method === "tools/list") {
    return successResponse(id, {
      tools: listMcpToolsForMode(authContext.authMode),
    });
  }

  if (method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    const toolArgs = asObject(params.arguments);

    try {
      const { result } = await executeMcpToolCall(toolName, toolArgs, authContext);
      return successResponse(id, toToolContent(result));
    } catch (error) {
      if (error instanceof McpToolCallError && error.code === "unknown_tool") {
        return errorResponse(id, -32601, error.message);
      }
      if (error instanceof McpToolCallError && error.code === "not_enabled") {
        return errorResponse(id, -32003, error.message);
      }
      const message = error instanceof Error ? error.message : "Tool execution failed.";
      return successResponse(id, toToolContent({ success: false, error: message }, true));
    }
  }

  return errorResponse(id, -32601, `Method not found: ${method}`);
}

export function getMcpServerMetadata() {
  const config = getInstanceConfig();
  return {
    name: `rivr-${config.instanceType}-mcp`,
    version: "0.1.0",
    protocolVersion: MCP_PROTOCOL_VERSION,
    endpoint: "/api/mcp",
    auth: {
      session: true,
      bearerToken: Boolean(process.env.AIAGENT_MCP_TOKEN?.trim()),
      bearerTokenEnv: "AIAGENT_MCP_TOKEN",
      scopedBearerToken: true,
      scopedBearerTokenEndpoint: "/api/mcp/token",
      queryToken: Boolean(process.env.AIAGENT_MCP_TOKEN?.trim()),
    },
    instance: {
      instanceId: config.instanceId,
      instanceType: config.instanceType,
      instanceSlug: config.instanceSlug,
      primaryAgentId: config.primaryAgentId,
      baseUrl: config.baseUrl,
    },
    tools: listMcpToolsForMode("session"),
  };
}
