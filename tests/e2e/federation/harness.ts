/**
 * Federation Auth E2E Harness
 * ---------------------------
 * Shared helpers for the federation auth + recovery + Prism-MCP E2E matrix
 * defined in rivr-social/rivr-app issue #89.
 *
 * Design intent:
 *   - Helpers are thin wrappers around real HTTP endpoints on the three
 *     target instances: global, sovereign home, and peer.
 *   - When a helper's backing endpoint does not yet exist, the helper
 *     throws `NotYetImplementedError` tagged with the issue/ticket that
 *     will deliver the missing surface. The runner (`run.sh`) treats this
 *     as a "skipped" coverage gap rather than a hard failure.
 *   - The three instances are addressed by environment variable:
 *       E2E_GLOBAL_BASE  — e.g. https://a.rivr.social
 *       E2E_HOME_BASE    — e.g. https://rivr.camalot.me
 *       E2E_PEER_BASE    — e.g. https://front-range.rivr.social
 *   - All helpers return structured objects rather than raw Response
 *     objects, so scenario tests can assert on typed fields.
 *
 * This file intentionally has NO side effects at import time. It does not
 * contact the network until a helper is called.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Targetable instance roles in the matrix.
 */
export type InstanceRole = "global" | "home" | "peer";

/**
 * Supported recovery modes for a sovereign user.
 */
export type RecoveryMode = "email-via-global" | "seed-phrase";

/**
 * Thrown when a helper's backing endpoint is not yet implemented.
 *
 * The runner in `run.sh` pattern-matches on the error name and prints
 * a coverage report instead of failing the suite, so that scaffolding
 * can land before the implementation does.
 */
export class NotYetImplementedError extends Error {
  public readonly ticket: string;
  public readonly helper: string;

  constructor(helper: string, ticket: string, detail?: string) {
    super(
      `[NotYetImplemented] ${helper} — awaiting ${ticket}${
        detail ? ` — ${detail}` : ""
      }`
    );
    this.name = "NotYetImplementedError";
    this.ticket = ticket;
    this.helper = helper;
  }
}

/**
 * Resolves a base URL for the given instance role from the environment.
 *
 * @throws Error if the corresponding env var is unset.
 */
export function baseFor(role: InstanceRole): string {
  const envKey =
    role === "global"
      ? "E2E_GLOBAL_BASE"
      : role === "home"
        ? "E2E_HOME_BASE"
        : "E2E_PEER_BASE";
  const value = process.env[envKey];
  if (!value) {
    throw new Error(
      `[harness] ${envKey} is not set — cannot target ${role} instance.`
    );
  }
  return value.replace(/\/$/, "");
}

/**
 * Disposable test account created for a single scenario run.
 *
 * Callers should clean these up with `deleteDisposableAccount` in
 * `afterEach`/`afterAll` where possible.
 */
export interface DisposableAccount {
  username: string;
  email: string;
  homeRole: InstanceRole;
  localPassword: string;
  seedPhrase?: string;
  userId?: string;
}

/**
 * Options for `createDisposableAccount`.
 */
export interface CreateDisposableAccountOptions {
  homeRole: InstanceRole;
  withSeedPhrase?: boolean;
  usernamePrefix?: string;
}

/**
 * Creates a disposable test account on the given home instance.
 *
 * Real implementation would:
 *   1. POST /api/test/accounts (gated to NODE_ENV=test on target)
 *   2. Receive back credentials + seed phrase
 *   3. Register the account in the global registry for SSO
 *
 * Currently throws NotYetImplementedError because the `POST /api/test/accounts`
 * surface does not exist yet. See rivr-app#91.
 */
export async function createDisposableAccount(
  options: CreateDisposableAccountOptions
): Promise<DisposableAccount> {
  throw new NotYetImplementedError(
    "createDisposableAccount",
    "rivr-app#91",
    `requires test-scoped account provisioning endpoint on ${options.homeRole}`
  );
}

/**
 * Tears down a disposable account. Safe to call even if creation failed.
 * Real implementation would DELETE /api/test/accounts/:id.
 */
export async function deleteDisposableAccount(
  account: DisposableAccount
): Promise<void> {
  // No-op until the provisioning endpoint exists.
  // Intentionally does NOT throw — teardown should never mask test failures.
  void account;
}

/**
 * Result of a local sign-in attempt.
 */
export interface SignInResult {
  ok: boolean;
  sessionToken?: string;
  credentialVersion?: number;
  homeAuthority?: string;
  globalIssuer?: string;
  error?: string;
}

/**
 * Performs a sign-in with username + password against the given instance.
 *
 * Maps to `POST /api/auth/callback/credentials` (NextAuth credentials
 * provider) on the target. The home instance variant also returns the
 * currently-trusted `credentialVersion` so the test can compare it to
 * what the global issuer holds.
 */
export async function signInLocally(
  role: InstanceRole,
  username: string,
  password: string
): Promise<SignInResult> {
  const base = baseFor(role);
  const url = `${base}/api/auth/callback/credentials`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
      redirect: "manual",
    });
  } catch (err) {
    return {
      ok: false,
      error: `network error contacting ${role} (${url}): ${
        (err as Error).message
      }`,
    };
  }

  // NextAuth returns 302 on success; 401 on failure.
  if (response.status === 302 || response.status === 200) {
    const cookie = response.headers.get("set-cookie") ?? "";
    const sessionToken = /next-auth\.session-token=([^;]+)/.exec(cookie)?.[1];
    // credentialVersion / homeAuthority / globalIssuer are surfaced by the
    // federation-auth-reset-sync and federation-auth-foundations branches.
    // If the deployed build does not yet expose them in the session cookie,
    // callers should degrade to comparing behaviour.
    return {
      ok: true,
      sessionToken,
    };
  }

  return {
    ok: false,
    error: `sign-in failed with status ${response.status}`,
  };
}

/**
 * Result of a password-reset-via-global flow.
 */
export interface PasswordResetResult {
  ok: boolean;
  newCredentialVersion?: number;
  syncedToHome?: boolean;
  error?: string;
}

/**
 * Triggers a password reset on the global instance for a sovereign user.
 *
 * In the target end-state (see rivr-app#15, #16):
 *   1. POST /api/auth/password-reset/request   { email }
 *   2. GET  mail-hog / test inbox for reset token
 *   3. POST /api/auth/password-reset/confirm   { token, newPassword }
 *   4. global bumps credentialVersion
 *   5. global emits credentialVersion to the home instance's temp-write API
 *
 * The temp-write acceptance path (#16) is still WIP, so this helper
 * currently throws `NotYetImplementedError`.
 */
export async function resetPasswordViaGlobal(
  _account: DisposableAccount,
  _newPassword: string
): Promise<PasswordResetResult> {
  throw new NotYetImplementedError(
    "resetPasswordViaGlobal",
    "rivr-app#15 + rivr-app#16",
    "credential sync to sovereign home is WIP"
  );
}

/**
 * Result of a local-only (home-only) password reset.
 */
export interface LocalPasswordResetResult {
  ok: boolean;
  syncedToGlobal?: boolean;
  newCredentialVersion?: number;
  error?: string;
}

/**
 * Triggers a local password reset on the sovereign home instance.
 * The home is expected to push the new credentialVersion to global.
 *
 * Mapped to `POST /api/auth/password-reset/local` on the home instance.
 * NOT YET IMPLEMENTED — see rivr-app#15.
 */
export async function resetPasswordOnHome(
  _account: DisposableAccount,
  _newPassword: string
): Promise<LocalPasswordResetResult> {
  throw new NotYetImplementedError(
    "resetPasswordOnHome",
    "rivr-app#15",
    "home→global credential sync path is WIP"
  );
}

/**
 * Result of a seed-phrase reveal.
 */
export interface SeedRevealResult {
  ok: boolean;
  seedPhrase?: string;
  auditLogId?: string;
  error?: string;
}

/**
 * Reveals the seed phrase for a signed-in user. Requires MFA confirmation.
 *
 * Backing endpoint: `POST /api/settings/seed/reveal` on the home instance.
 * MFA model is not yet finalized — see rivr-person recovery-seed-ui branch.
 */
export async function revealSeed(
  _account: DisposableAccount,
  _mfaCode: string
): Promise<SeedRevealResult> {
  throw new NotYetImplementedError(
    "revealSeed",
    "rivr-person#recovery-seed-ui",
    "seed reveal UI is on a feature branch; endpoint not yet merged"
  );
}

/**
 * Rotates the seed phrase for a signed-in user. Previous seed must be
 * rejected by subsequent recovery attempts.
 *
 * Backing endpoint: `POST /api/settings/seed/rotate`. Not yet implemented.
 */
export async function rotateSeed(
  _account: DisposableAccount,
  _mfaCode: string
): Promise<{ ok: boolean; newSeedPhrase?: string; error?: string }> {
  throw new NotYetImplementedError(
    "rotateSeed",
    "rivr-person#recovery-seed-ui",
    "seed rotation endpoint pending"
  );
}

/**
 * Attempts a seed-phrase recovery: produces a signed recovery assertion
 * from the seed, posts it to the home instance, and on acceptance
 * installs a new local password.
 *
 * Backing endpoint: `POST /api/auth/recovery/seed` (home instance).
 * See rivr-app#17 — acceptance path is WIP.
 */
export async function recoverWithSeed(
  _account: DisposableAccount,
  _seedPhrase: string,
  _newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  throw new NotYetImplementedError(
    "recoverWithSeed",
    "rivr-app#17",
    "seed-signed recovery assertion acceptance is WIP"
  );
}

/**
 * Result of an authority revocation.
 */
export interface RevokeAuthorityResult {
  ok: boolean;
  revocationId?: string;
  propagatedAtMs?: number;
  error?: string;
}

/**
 * Signs and publishes an `authority.revoke` federation event.
 *
 * Real implementation would:
 *   1. Mint a signed revocation payload with the home's federation key.
 *   2. POST it to /api/federation/events on the home (and/or global).
 *   3. Peers pull/receive it and must invalidate sessions within ~60s.
 *
 * Uses the existing federation crypto helpers already present in
 * src/lib/federation-crypto; the signing piece is available today, but
 * the `authority.revoke` event type is not yet wired, so this helper
 * still throws NotYetImplementedError.
 */
export async function revokeAuthority(_options: {
  subject: DisposableAccount;
  revokingRole: InstanceRole;
  successorHomeBase?: string;
}): Promise<RevokeAuthorityResult> {
  throw new NotYetImplementedError(
    "revokeAuthority",
    "rivr-app#18",
    "authority.revoke federation event type is not yet defined"
  );
}

/**
 * Publishes a successor home claim that peers should route to after the
 * previous home has been revoked.
 */
export async function publishSuccessorHomeClaim(_options: {
  subject: DisposableAccount;
  successorHomeBase: string;
}): Promise<{ ok: boolean; claimId?: string; error?: string }> {
  throw new NotYetImplementedError(
    "publishSuccessorHomeClaim",
    "rivr-app#18",
    "successor-home claim type is not yet defined"
  );
}

/**
 * Result of a Prism-MCP tool invocation.
 */
export interface PrismMcpInvokeResult {
  ok: boolean;
  toolCallId?: string;
  result?: unknown;
  homeAuthority?: string;
  projectedTo?: string[];
  error?: string;
}

/**
 * Invokes a RIVR MCP tool via the Prism Claude integration.
 *
 * In the target end-state this routes through
 *   POST ${base}/api/mcp
 * with a JSON-RPC envelope naming the tool + args. The live MCP surface
 * exists on home (rivr.camalot.me) already — see src/app/api/mcp/route.ts —
 * so this helper performs a real network call and returns a normalized
 * response when the endpoint is reachable.
 */
export async function prismMcpInvoke(
  role: InstanceRole,
  tool: string,
  args: Record<string, unknown>,
  opts: { sessionToken?: string } = {}
): Promise<PrismMcpInvokeResult> {
  const base = baseFor(role);
  const url = `${base}/api/mcp`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.sessionToken
          ? { cookie: `next-auth.session-token=${opts.sessionToken}` }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `e2e-${Date.now()}`,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `network error contacting ${role} MCP (${url}): ${
        (err as Error).message
      }`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: `MCP call failed with status ${response.status}`,
    };
  }

  let parsed: any;
  try {
    parsed = await response.json();
  } catch (err) {
    return {
      ok: false,
      error: `MCP response was not JSON: ${(err as Error).message}`,
    };
  }

  if (parsed.error) {
    return { ok: false, error: JSON.stringify(parsed.error) };
  }

  return {
    ok: true,
    toolCallId: parsed.id,
    result: parsed.result,
    homeAuthority: parsed.result?.homeAuthority,
    projectedTo: parsed.result?.projectedTo,
  };
}

/**
 * Simulates a global-instance outage by pointing subsequent helpers at a
 * non-routable base, so tests can exercise "global down" code paths
 * without actually tearing down infrastructure.
 *
 * Returns a disposer that restores the original env var.
 *
 * NOTE: only safe for local/dev test runs — do not use against prod.
 */
export function simulateGlobalOutage(): () => void {
  const previous = process.env.E2E_GLOBAL_BASE;
  process.env.E2E_GLOBAL_BASE = "http://127.0.0.1:1"; // unroutable
  return () => {
    if (previous === undefined) delete process.env.E2E_GLOBAL_BASE;
    else process.env.E2E_GLOBAL_BASE = previous;
  };
}

/**
 * Fetches audit log entries for a given user on the target instance,
 * filtered by event name. Used by scenarios that assert an action
 * produced a specific audit trail.
 *
 * Maps to `GET /api/audit?userId=...&event=...`. Already live on home.
 */
export async function fetchAuditEntries(
  role: InstanceRole,
  userId: string,
  event: string,
  sessionToken?: string
): Promise<{ ok: boolean; entries?: Array<Record<string, unknown>>; error?: string }> {
  const base = baseFor(role);
  const url = `${base}/api/audit?userId=${encodeURIComponent(
    userId
  )}&event=${encodeURIComponent(event)}`;

  try {
    const response = await fetch(url, {
      headers: sessionToken
        ? { cookie: `next-auth.session-token=${sessionToken}` }
        : {},
    });

    if (response.status === 404) {
      throw new NotYetImplementedError(
        "fetchAuditEntries",
        "rivr-app#19",
        `audit query API not yet exposed on ${role}`
      );
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `audit query failed with status ${response.status}`,
      };
    }

    const parsed = (await response.json()) as {
      entries: Array<Record<string, unknown>>;
    };
    return { ok: true, entries: parsed.entries ?? [] };
  } catch (err) {
    if (err instanceof NotYetImplementedError) throw err;
    return {
      ok: false,
      error: `network error: ${(err as Error).message}`,
    };
  }
}

/**
 * Convenience: asserts that the three required env vars are set and
 * returns them. Used in `beforeAll` hooks to fail fast with a clear
 * message when the suite is misconfigured.
 */
export function requireE2EEnv(): {
  global: string;
  home: string;
  peer: string;
} {
  const global = process.env.E2E_GLOBAL_BASE;
  const home = process.env.E2E_HOME_BASE;
  const peer = process.env.E2E_PEER_BASE;
  if (!global || !home || !peer) {
    throw new Error(
      "E2E federation suite requires E2E_GLOBAL_BASE, E2E_HOME_BASE, E2E_PEER_BASE"
    );
  }
  return {
    global: global.replace(/\/$/, ""),
    home: home.replace(/\/$/, ""),
    peer: peer.replace(/\/$/, ""),
  };
}
