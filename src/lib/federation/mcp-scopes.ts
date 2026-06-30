/**
 * @module lib/federation/mcp-scopes
 *
 * Single source of truth for the MCP device-flow scope allow-list and the
 * clamp that enforces it (AUTH-SEC-005).
 *
 * The device-authorization grant lets a headless caller request scopes, but the
 * caller must never be able to obtain — or have the human approver consent to —
 * authority broader than the server is willing to grant. Both the `/device/code`
 * storage site (so the approval screen renders the EFFECTIVE scopes) and the
 * poll-time token mint intersect the request with {@link MCP_DEFAULT_SCOPES}.
 */

/**
 * The server's grantable scope allow-list for device-flow MCP tokens. Any
 * requested scope outside this set is dropped at both storage and mint time.
 */
export const MCP_DEFAULT_SCOPES: readonly string[] = [
  "mcp:tools",
  "profile:read",
  "profile:write",
  "post:create",
  "event:create",
  "offering:create",
  "group:write",
  "federation:write",
];

/**
 * Intersect caller-requested scopes with the server allow-list
 * ({@link MCP_DEFAULT_SCOPES}), preserving request order and de-duplicating.
 *
 * Purely subtractive: any scope outside the allow-list is silently dropped, and
 * the result is never broader than what was requested. This does NOT substitute
 * a default set for an empty request — each call site decides its own
 * empty-set fallback (`/device/code` defaults to `mcp:tools`; the poll mint
 * defaults to the full allow-list) so clamping can never widen authority.
 */
export function clampMcpScopes(
  requested: readonly string[] | null | undefined,
): string[] {
  const allowed = new Set(MCP_DEFAULT_SCOPES);
  const seen = new Set<string>();
  const clamped: string[] = [];
  for (const scope of requested ?? []) {
    if (typeof scope === "string" && allowed.has(scope) && !seen.has(scope)) {
      seen.add(scope);
      clamped.push(scope);
    }
  }
  return clamped;
}
