/**
 * Instance-mode server-side helper.
 *
 * Purpose:
 * Expose the current deployment's operating mode (sovereign vs
 * hosted-federated) so that server and client code can gate seed-phrase
 * and recovery-key UI consistently.
 *
 * Key exports:
 * - `InstanceMode`                       — type union for the two modes.
 * - `INSTANCE_MODE_SOVEREIGN`            — named constant, not a magic string.
 * - `INSTANCE_MODE_HOSTED_FEDERATED`     — named constant, not a magic string.
 * - `INSTANCE_MODE_ENV_VAR`              — env var name read by the helper.
 * - `DEFAULT_INSTANCE_MODE`              — default (sovereign) for rivr-person.
 * - `INSTANCE_MODES`                     — readonly tuple of valid values.
 * - `isValidInstanceMode()`              — type guard for external inputs.
 * - `getInstanceMode()`                  — resolve the current mode (cached).
 * - `resetInstanceModeCache()`           — clear cache (test-only).
 * - `InvalidInstanceModeError`           — thrown when env value is invalid.
 *
 * Dependencies:
 * - None (pure module — no framework/DB deps so it can be imported by
 *   route handlers, server actions, and signup flows alike).
 *
 * Related:
 * - `/api/instance/mode`                         — HTTP surface for clients.
 * - `src/db/schema.ts#instanceModeEnum`          — persisted per-agent mode.
 * - GitHub issues rivr-social/rivr-person#11, #18.
 * - HANDOFF 2026-04-19 Clarifications #3 and #5.
 */

/**
 * The only legal instance-mode values. Ordering mirrors the DB enum
 * (`hosted-federated`, `sovereign`) so any drift is visible at review time.
 */
export const INSTANCE_MODE_HOSTED_FEDERATED = 'hosted-federated' as const;
export const INSTANCE_MODE_SOVEREIGN = 'sovereign' as const;

/** Readonly tuple of all valid instance modes. */
export const INSTANCE_MODES = [
  INSTANCE_MODE_HOSTED_FEDERATED,
  INSTANCE_MODE_SOVEREIGN,
] as const;

/**
 * Narrow union type of the allowed operating modes.
 *
 * - `sovereign`: home-server deployments (e.g. `rivr.camalot.me`).
 *   Seed-phrase UI and recovery-key material are available.
 * - `hosted-federated`: shared hosted deployments where global holds
 *   credentials. Seed UI is suppressed.
 */
export type InstanceMode = (typeof INSTANCE_MODES)[number];

/**
 * Environment variable read by {@link getInstanceMode}. A dedicated
 * constant prevents silent typos when callers want to set it in tests or
 * compose files.
 */
export const INSTANCE_MODE_ENV_VAR = 'RIVR_INSTANCE_MODE' as const;

/**
 * Default mode when the env var is missing or blank.
 *
 * rivr-person's canonical deploy is `rivr.camalot.me`, which is a
 * sovereign home instance, so `sovereign` is the safer default. A hosted
 * deployment of this same codebase must set
 * `RIVR_INSTANCE_MODE=hosted-federated` explicitly.
 */
export const DEFAULT_INSTANCE_MODE: InstanceMode = INSTANCE_MODE_SOVEREIGN;

/**
 * Thrown when {@link getInstanceMode} encounters an unrecognizable value
 * in the configured env var. The error carries the offending value and
 * the list of accepted modes so operators can diagnose misconfiguration
 * without re-reading source.
 */
export class InvalidInstanceModeError extends Error {
  /** The raw value that failed validation. */
  public readonly received: string;
  /** The accepted set of modes (for operator-friendly messages). */
  public readonly allowed: readonly InstanceMode[];

  constructor(received: string) {
    super(
      `Invalid ${INSTANCE_MODE_ENV_VAR}=${JSON.stringify(received)}. ` +
        `Expected one of: ${INSTANCE_MODES.map((m) => `"${m}"`).join(', ')}.`,
    );
    this.name = 'InvalidInstanceModeError';
    this.received = received;
    this.allowed = INSTANCE_MODES;
  }
}

/**
 * Type guard for arbitrary string values. Useful when decoding data
 * supplied by clients, env vars, or databases.
 *
 * @param value Candidate string.
 * @returns `true` when `value` is a recognised {@link InstanceMode}.
 */
export function isValidInstanceMode(value: unknown): value is InstanceMode {
  return typeof value === 'string' && (INSTANCE_MODES as readonly string[]).includes(value);
}

// Cache per-process so route handlers don't pay the validation cost on
// every request. Next.js may keep the module resident across many
// requests in production.
let cachedMode: InstanceMode | null = null;

/**
 * Resolve the active instance operating mode for this deployment.
 *
 * Precedence:
 * 1. `process.env.RIVR_INSTANCE_MODE` — required to be one of
 *    {@link INSTANCE_MODES} when present.
 * 2. {@link DEFAULT_INSTANCE_MODE} (sovereign) when the var is missing
 *    or blank.
 *
 * Throws {@link InvalidInstanceModeError} (not a generic Error) so
 * callers can distinguish configuration failures from transient issues.
 *
 * @returns The resolved {@link InstanceMode}.
 * @throws {InvalidInstanceModeError} When the env var is set to an
 *   unsupported value.
 * @example
 * ```ts
 * import { getInstanceMode, INSTANCE_MODE_SOVEREIGN } from '@/lib/instance-mode';
 *
 * if (getInstanceMode() === INSTANCE_MODE_SOVEREIGN) {
 *   // render seed-phrase UI
 * }
 * ```
 */
export function getInstanceMode(): InstanceMode {
  if (cachedMode !== null) {
    return cachedMode;
  }

  const raw = process.env[INSTANCE_MODE_ENV_VAR];
  const trimmed = typeof raw === 'string' ? raw.trim() : '';

  if (trimmed.length === 0) {
    cachedMode = DEFAULT_INSTANCE_MODE;
    return cachedMode;
  }

  if (!isValidInstanceMode(trimmed)) {
    throw new InvalidInstanceModeError(trimmed);
  }

  cachedMode = trimmed;
  return cachedMode;
}

/**
 * Reset the cached mode. Exposed for test suites that flip
 * `process.env.RIVR_INSTANCE_MODE` between cases.
 */
export function resetInstanceModeCache(): void {
  cachedMode = null;
}
