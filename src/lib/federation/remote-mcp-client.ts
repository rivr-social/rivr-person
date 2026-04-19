// src/lib/federation/remote-mcp-client.ts

/**
 * Remote MCP Client.
 *
 * Allows agents to call MCP tool endpoints on ANY Rivr instance
 * (person, group, locale, region, global) while carrying persona
 * context and proper authentication.
 *
 * Uses the same JSON-RPC 2.0 protocol as the local MCP server
 * (see mcp-server.ts) and follows the same cross-instance HTTP
 * patterns as write-router.ts and update-facade.ts.
 *
 * Usage:
 *
 *   import { callRemoteMcpTool, listRemoteMcpTools, RemoteMcpClient } from "@/lib/federation/remote-mcp-client";
 *
 *   // One-shot call
 *   const result = await callRemoteMcpTool({
 *     targetInstanceUrl: "https://spirit-of-the-front-range.rivr.social",
 *     toolName: "get_locale_events",
 *     toolArgs: { limit: 10 },
 *     actorId: "some-user-uuid",
 *     personaId: "optional-persona-uuid",
 *   });
 *
 *   // Reusable client with token caching
 *   const client = new RemoteMcpClient({ actorId: "some-user-uuid" });
 *   const tools = await client.listTools("https://spirit-of-the-front-range.rivr.social");
 *   const result = await client.callTool("https://spirit-of-the-front-range.rivr.social", "get_locale_events", { limit: 10 });
 */

import { getInstanceConfig } from "./instance-config";

// ─── Constants ──────────────────────────────────────────────────────────────

/** HTTP timeout for remote MCP requests (ms) */
const REMOTE_MCP_TIMEOUT_MS = 30_000;

/** MCP endpoint path on remote instances */
const MCP_ENDPOINT_PATH = "/api/mcp";

/** Agent assertion endpoint path on local instance */
const AGENT_ASSERTION_PATH = "/api/federation/agent-assertion";

/** JSON-RPC protocol version */
const JSONRPC_VERSION = "2.0";

/** Buffer before token expiry to trigger refresh (ms) — 60 seconds */
const TOKEN_REFRESH_BUFFER_MS = 60_000;

/** Default token TTL assumption when expiry is not returned (ms) — 5 minutes */
const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Parameters for a single remote MCP tool call.
 */
export interface RemoteMcpCallParams {
  /** Base URL of the target Rivr instance (e.g. "https://spirit-of-the-front-range.rivr.social") */
  targetInstanceUrl: string;
  /** MCP tool name to invoke */
  toolName: string;
  /** Arguments to pass to the tool */
  toolArgs: Record<string, unknown>;
  /** Actor ID performing the call */
  actorId: string;
  /** Optional persona ID for persona-scoped calls */
  personaId?: string;
  /** Pre-obtained assertion token; if omitted, one will be fetched automatically */
  assertionToken?: string;
}

/**
 * Parameters for listing tools on a remote instance.
 */
export interface RemoteMcpListParams {
  /** Base URL of the target Rivr instance */
  targetInstanceUrl: string;
  /** Pre-obtained assertion token; if omitted, one will be fetched automatically */
  assertionToken?: string;
  /** Actor ID performing the discovery */
  actorId: string;
  /** Optional persona ID */
  personaId?: string;
}

/**
 * JSON-RPC 2.0 error shape returned by MCP servers.
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * Result of a remote MCP tool call.
 */
export interface RemoteMcpCallResult<T = unknown> {
  success: boolean;
  /** Tool result data (when success is true) */
  data?: T;
  /** Error message (when success is false) */
  error?: string;
  /** Structured JSON-RPC error (when the remote returned one) */
  jsonRpcError?: JsonRpcError;
  /** Error classification */
  errorCode?: RemoteMcpErrorCode;
  /** Target instance that was called */
  targetInstanceUrl: string;
}

/**
 * A tool definition as returned by the MCP tools/list method.
 */
export interface RemoteMcpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Result of listing tools on a remote instance.
 */
export interface RemoteMcpListResult {
  success: boolean;
  tools?: RemoteMcpToolDefinition[];
  error?: string;
  errorCode?: RemoteMcpErrorCode;
  targetInstanceUrl: string;
}

/**
 * Assertion token response from /api/federation/agent-assertion.
 */
interface AssertionTokenResponse {
  token: string;
  expiresAt?: string;
  expiresIn?: number;
}

/**
 * Cached assertion token with expiry tracking.
 */
interface CachedToken {
  token: string;
  expiresAt: number;
}

type RemoteMcpErrorCode =
  | "ASSERTION_FETCH_FAILED"
  | "REMOTE_UNREACHABLE"
  | "REMOTE_HTTP_ERROR"
  | "REMOTE_JSONRPC_ERROR"
  | "REMOTE_PARSE_ERROR"
  | "TOOL_EXECUTION_ERROR";

/**
 * Options for constructing a RemoteMcpClient.
 */
export interface RemoteMcpClientOptions {
  /** Actor ID for all calls made through this client */
  actorId: string;
  /** Optional default persona ID */
  personaId?: string;
  /** Optional pre-set assertion token (will be cached and auto-refreshed) */
  assertionToken?: string;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Build standard headers for a remote MCP request.
 */
function buildMcpHeaders(
  assertionToken: string,
  actorId: string,
  personaId?: string,
): Record<string, string> {
  const config = getInstanceConfig();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${assertionToken}`,
    "X-Actor-Id": actorId,
    "X-Home-Base-Url": config.baseUrl,
    "X-Instance-Id": config.instanceId,
    "X-Instance-Slug": config.instanceSlug,
  };
  if (personaId) {
    headers["X-Persona-Id"] = personaId;
  }
  return headers;
}

/**
 * Build a JSON-RPC 2.0 request body.
 */
function buildJsonRpcBody(
  method: string,
  params: Record<string, unknown>,
): string {
  return JSON.stringify({
    jsonrpc: JSONRPC_VERSION,
    id: crypto.randomUUID(),
    method,
    params,
  });
}

/**
 * Fetch an assertion token from the local federation agent-assertion endpoint.
 */
async function fetchAssertionToken(
  actorId: string,
  personaId?: string,
): Promise<CachedToken> {
  const config = getInstanceConfig();
  const url = `${config.baseUrl}${AGENT_ASSERTION_PATH}`;

  const body: Record<string, string> = { actorId };
  if (personaId) {
    body.personaId = personaId;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Authenticate with the local instance using NODE_ADMIN_KEY if available
  const adminKey = process.env.NODE_ADMIN_KEY?.trim();
  if (adminKey) {
    headers["X-Node-Admin-Key"] = adminKey;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REMOTE_MCP_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to reach assertion endpoint";
    throw new RemoteMcpError(
      `Failed to fetch assertion token: ${message}`,
      "ASSERTION_FETCH_FAILED",
    );
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new RemoteMcpError(
      `Assertion endpoint returned HTTP ${response.status}: ${errorBody}`,
      "ASSERTION_FETCH_FAILED",
    );
  }

  const data = (await response.json()) as AssertionTokenResponse;
  if (!data.token) {
    throw new RemoteMcpError(
      "Assertion endpoint returned no token",
      "ASSERTION_FETCH_FAILED",
    );
  }

  let expiresAt: number;
  if (data.expiresAt) {
    expiresAt = new Date(data.expiresAt).getTime();
  } else if (data.expiresIn) {
    expiresAt = Date.now() + data.expiresIn * 1000;
  } else {
    expiresAt = Date.now() + DEFAULT_TOKEN_TTL_MS;
  }

  return { token: data.token, expiresAt };
}

// ─── Error Class ────────────────────────────────────────────────────────────

export class RemoteMcpError extends Error {
  readonly errorCode: RemoteMcpErrorCode;

  constructor(message: string, errorCode: RemoteMcpErrorCode) {
    super(message);
    this.name = "RemoteMcpError";
    this.errorCode = errorCode;
  }
}

// ─── Core Request Function ──────────────────────────────────────────────────

/**
 * Send a JSON-RPC 2.0 request to a remote MCP endpoint.
 * Returns the parsed JSON-RPC response.
 */
async function sendMcpRequest(
  targetInstanceUrl: string,
  method: string,
  params: Record<string, unknown>,
  assertionToken: string,
  actorId: string,
  personaId?: string,
): Promise<{ result?: unknown; error?: JsonRpcError }> {
  const url = `${targetInstanceUrl.replace(/\/+$/, "")}${MCP_ENDPOINT_PATH}`;
  const headers = buildMcpHeaders(assertionToken, actorId, personaId);
  const body = buildJsonRpcBody(method, params);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REMOTE_MCP_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Remote instance unreachable";
    throw new RemoteMcpError(
      `Failed to reach ${targetInstanceUrl}: ${message}`,
      "REMOTE_UNREACHABLE",
    );
  }

  let responseBody: Record<string, unknown>;
  try {
    responseBody = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new RemoteMcpError(
      `Failed to parse response from ${targetInstanceUrl} (HTTP ${response.status})`,
      "REMOTE_PARSE_ERROR",
    );
  }

  // JSON-RPC error responses may come with HTTP 400 but are still valid protocol responses
  if (responseBody.error && typeof responseBody.error === "object") {
    return { error: responseBody.error as JsonRpcError };
  }

  if (!response.ok) {
    throw new RemoteMcpError(
      `Remote MCP endpoint returned HTTP ${response.status}`,
      "REMOTE_HTTP_ERROR",
    );
  }

  return { result: responseBody.result };
}

// ─── Convenience Functions ──────────────────────────────────────────────────

/**
 * Call a single MCP tool on a remote Rivr instance.
 *
 * If no assertionToken is provided, one will be fetched from the local
 * /api/federation/agent-assertion endpoint automatically.
 */
export async function callRemoteMcpTool<T = unknown>(
  params: RemoteMcpCallParams,
): Promise<RemoteMcpCallResult<T>> {
  const {
    targetInstanceUrl,
    toolName,
    toolArgs,
    actorId,
    personaId,
  } = params;

  let assertionToken = params.assertionToken;

  // Auto-fetch assertion token if not provided
  if (!assertionToken) {
    try {
      const cached = await fetchAssertionToken(actorId, personaId);
      assertionToken = cached.token;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to obtain assertion token",
        errorCode: "ASSERTION_FETCH_FAILED",
        targetInstanceUrl,
      };
    }
  }

  try {
    const { result, error } = await sendMcpRequest(
      targetInstanceUrl,
      "tools/call",
      { name: toolName, arguments: toolArgs },
      assertionToken,
      actorId,
      personaId,
    );

    if (error) {
      return {
        success: false,
        error: error.message,
        jsonRpcError: error,
        errorCode: "REMOTE_JSONRPC_ERROR",
        targetInstanceUrl,
      };
    }

    // MCP tools/call result wraps content in { content: [...], structuredContent, isError }
    const mcpResult = result as Record<string, unknown> | undefined;
    if (mcpResult?.isError) {
      const structuredContent = mcpResult.structuredContent as Record<string, unknown> | undefined;
      return {
        success: false,
        error: (structuredContent?.error as string) || "Remote tool execution returned an error",
        data: structuredContent as T,
        errorCode: "TOOL_EXECUTION_ERROR",
        targetInstanceUrl,
      };
    }

    return {
      success: true,
      data: (mcpResult?.structuredContent ?? mcpResult) as T,
      targetInstanceUrl,
    };
  } catch (error) {
    if (error instanceof RemoteMcpError) {
      return {
        success: false,
        error: error.message,
        errorCode: error.errorCode,
        targetInstanceUrl,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error calling remote MCP tool",
      errorCode: "REMOTE_UNREACHABLE",
      targetInstanceUrl,
    };
  }
}

/**
 * List available MCP tools on a remote Rivr instance.
 *
 * If no assertionToken is provided, one will be fetched automatically.
 */
export async function listRemoteMcpTools(
  params: RemoteMcpListParams,
): Promise<RemoteMcpListResult> {
  const { targetInstanceUrl, actorId, personaId } = params;

  let assertionToken = params.assertionToken;

  if (!assertionToken) {
    try {
      const cached = await fetchAssertionToken(actorId, personaId);
      assertionToken = cached.token;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to obtain assertion token",
        errorCode: "ASSERTION_FETCH_FAILED",
        targetInstanceUrl,
      };
    }
  }

  try {
    const { result, error } = await sendMcpRequest(
      targetInstanceUrl,
      "tools/list",
      {},
      assertionToken,
      actorId,
      personaId,
    );

    if (error) {
      return {
        success: false,
        error: error.message,
        errorCode: "REMOTE_JSONRPC_ERROR",
        targetInstanceUrl,
      };
    }

    const listResult = result as { tools?: RemoteMcpToolDefinition[] } | undefined;
    return {
      success: true,
      tools: listResult?.tools ?? [],
      targetInstanceUrl,
    };
  } catch (error) {
    if (error instanceof RemoteMcpError) {
      return {
        success: false,
        error: error.message,
        errorCode: error.errorCode,
        targetInstanceUrl,
      };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error listing remote MCP tools",
      errorCode: "REMOTE_UNREACHABLE",
      targetInstanceUrl,
    };
  }
}

// ─── Stateful Client Class ──────────────────────────────────────────────────

/**
 * Reusable MCP client that caches assertion tokens per target instance
 * and auto-refreshes them when near expiry.
 *
 * Usage:
 *
 *   const client = new RemoteMcpClient({ actorId: session.user.id });
 *   const tools = await client.listTools("https://boulder-commons.rivr.social");
 *   const result = await client.callTool(
 *     "https://boulder-commons.rivr.social",
 *     "get_events",
 *     { limit: 5 },
 *   );
 */
export class RemoteMcpClient {
  private readonly actorId: string;
  private readonly personaId?: string;
  private readonly tokenCache: Map<string, CachedToken> = new Map();

  constructor(options: RemoteMcpClientOptions) {
    this.actorId = options.actorId;
    this.personaId = options.personaId;

    // Seed the cache with a pre-provided token (applies to all targets)
    if (options.assertionToken) {
      this.tokenCache.set("__default__", {
        token: options.assertionToken,
        expiresAt: Date.now() + DEFAULT_TOKEN_TTL_MS,
      });
    }
  }

  /**
   * Get a valid assertion token for a target instance.
   * Returns a cached token if still valid, otherwise fetches a new one.
   */
  private async getToken(targetInstanceUrl: string): Promise<string> {
    const cacheKey = targetInstanceUrl.replace(/\/+$/, "");

    // Check instance-specific cache first, then default
    const cached = this.tokenCache.get(cacheKey) ?? this.tokenCache.get("__default__");
    if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
      return cached.token;
    }

    // Fetch a fresh token
    const fresh = await fetchAssertionToken(this.actorId, this.personaId);
    this.tokenCache.set(cacheKey, fresh);
    return fresh.token;
  }

  /**
   * Call an MCP tool on a remote instance.
   */
  async callTool<T = unknown>(
    targetInstanceUrl: string,
    toolName: string,
    toolArgs: Record<string, unknown> = {},
  ): Promise<RemoteMcpCallResult<T>> {
    let token: string;
    try {
      token = await this.getToken(targetInstanceUrl);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to obtain assertion token",
        errorCode: "ASSERTION_FETCH_FAILED",
        targetInstanceUrl,
      };
    }

    const result = await callRemoteMcpTool<T>({
      targetInstanceUrl,
      toolName,
      toolArgs,
      actorId: this.actorId,
      personaId: this.personaId,
      assertionToken: token,
    });

    // If we got an auth error, invalidate the cached token and retry once
    if (!result.success && result.jsonRpcError?.code === -32001) {
      this.tokenCache.delete(targetInstanceUrl.replace(/\/+$/, ""));
      this.tokenCache.delete("__default__");

      try {
        token = await this.getToken(targetInstanceUrl);
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to refresh assertion token",
          errorCode: "ASSERTION_FETCH_FAILED",
          targetInstanceUrl,
        };
      }

      return callRemoteMcpTool<T>({
        targetInstanceUrl,
        toolName,
        toolArgs,
        actorId: this.actorId,
        personaId: this.personaId,
        assertionToken: token,
      });
    }

    return result;
  }

  /**
   * List available MCP tools on a remote instance.
   */
  async listTools(targetInstanceUrl: string): Promise<RemoteMcpListResult> {
    let token: string;
    try {
      token = await this.getToken(targetInstanceUrl);
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to obtain assertion token",
        errorCode: "ASSERTION_FETCH_FAILED",
        targetInstanceUrl,
      };
    }

    return listRemoteMcpTools({
      targetInstanceUrl,
      actorId: this.actorId,
      personaId: this.personaId,
      assertionToken: token,
    });
  }

  /**
   * Invalidate all cached assertion tokens.
   * Useful when the actor's permissions have changed.
   */
  clearTokenCache(): void {
    this.tokenCache.clear();
  }

  /**
   * Invalidate the cached token for a specific target instance.
   */
  clearTokenFor(targetInstanceUrl: string): void {
    this.tokenCache.delete(targetInstanceUrl.replace(/\/+$/, ""));
  }
}
