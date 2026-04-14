import { auth } from "@/auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";
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
import * as kg from "@/lib/kg/autobot-kg-client";

const MCP_PROTOCOL_VERSION = "2024-11-05";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type McpAuthContext = McpToolCallContext;

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
  if (!configuredToken || !providedToken || providedToken !== configuredToken) {
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
    const tool = getMcpToolDefinition(toolName);
    if (!tool) {
      return errorResponse(id, -32601, `Unknown tool: ${toolName}`);
    }

    if (!tool.enabledFor.includes(authContext.authMode)) {
      return errorResponse(id, -32003, `Tool ${toolName} is not enabled for this auth mode.`);
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

      const durationMs = Date.now() - startTime;
      logMcpProvenance({
        toolName,
        context: authContext,
        args: toolArgs,
        resultStatus: approvalResult.executed ? "success" : "success",
        durationMs,
      }).catch(() => {});

      return successResponse(id, toToolContent(approvalResult.result));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tool execution failed.";
      const durationMs = Date.now() - startTime;
      logMcpProvenance({
        toolName,
        context: authContext,
        args: toolArgs,
        resultStatus: "error",
        errorMessage: message,
        durationMs,
      }).catch(() => {});

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
