/**
 * Autobot isolation / sandbox configuration.
 *
 * Defines the runtime boundaries for autobot agents based on whether the
 * instance is sovereign or shared. This is the enforcement layer that
 * prevents agents on shared infrastructure from accessing host-level
 * operations.
 *
 * Security model:
 * - Shared server (e.g., app.rivr.social): strict sandbox. No SSH, no
 *   Docker, no filesystem writes outside the container, no host exec.
 *   Agents are containerized per-agent with capped resources.
 * - Sovereign server (e.g., rivr.camalot.me): relaxed sandbox. The owner
 *   explicitly opted into self-hosting and can push, build, and self-edit
 *   autobot or rivr-person on their OWN server.
 *
 * Key exports:
 * - `getAutobotSandbox()` — returns the sandbox config for the current instance
 * - `assertOperationAllowed()` — throws if an operation is denied
 * - `isOperationAllowed()` — boolean check without throwing
 * - `AutobotSandbox` — the sandbox shape
 */

import { getDeployCapability } from '@/lib/deploy/capability';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Operations that are always denied on shared instances. */
const SHARED_DENIED_OPERATIONS = [
  'ssh',
  'docker',
  'docker_build',
  'docker_exec',
  'docker_restart',
  'fs_write_host',
  'fs_read_host',
  'host_exec',
  'systemctl',
  'process_spawn',
  'network_bind',
  'self_deploy',
  'autobot_deploy',
  'traefik_config',
  'cert_management',
] as const;

/** Operations denied on sovereign instances (still unsafe even for owners). */
const SOVEREIGN_DENIED_OPERATIONS = [
  'network_bind',
] as const;

/** Default resource limits for shared instances. */
const SHARED_MAX_MEMORY_MB = 512;
const SHARED_MAX_CPU_PERCENT = 25;

/** Default resource limits for sovereign instances. */
const SOVEREIGN_MAX_MEMORY_MB = 2048;
const SOVEREIGN_MAX_CPU_PERCENT = 80;

/** Allowed network targets for shared-instance agents. */
const SHARED_ALLOWED_NETWORK = [
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://api.together.ai',
  'https://api.groq.com',
  'https://api.github.com',
  'https://app.rivr.social',
  'https://dev.rivr.social',
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeniedOperation = typeof SHARED_DENIED_OPERATIONS[number] | typeof SOVEREIGN_DENIED_OPERATIONS[number];

export interface AutobotSandbox {
  /** Network URLs this agent is allowed to reach. Empty array = unrestricted. */
  allowedNetworkAccess: string[];
  /** Operations explicitly denied for this sandbox tier. */
  deniedOperations: readonly string[];
  /** Maximum memory in MB for the agent process/container. */
  maxMemoryMb: number;
  /** Maximum CPU percentage for the agent process/container. */
  maxCpuPercent: number;
  /** Whether this agent is scoped to a container (no host breakout). */
  scopedToContainer: boolean;
  /** Whether this agent can trigger self-deploy operations. */
  canSelfDeploy: boolean;
  /** Whether this agent can modify autobot runtime. */
  canModifyAutobot: boolean;
  /** Whether this agent can write to the host filesystem. */
  canWriteHostFs: boolean;
  /** Human-readable sandbox tier label. */
  tier: 'strict' | 'relaxed';
}

// ---------------------------------------------------------------------------
// Build sandbox config
// ---------------------------------------------------------------------------

function buildSandbox(): AutobotSandbox {
  const cap = getDeployCapability();

  if (cap.isSovereign) {
    return {
      allowedNetworkAccess: [], // unrestricted on sovereign
      deniedOperations: SOVEREIGN_DENIED_OPERATIONS,
      maxMemoryMb: SOVEREIGN_MAX_MEMORY_MB,
      maxCpuPercent: SOVEREIGN_MAX_CPU_PERCENT,
      scopedToContainer: false,
      canSelfDeploy: true,
      canModifyAutobot: true,
      canWriteHostFs: true,
      tier: 'relaxed',
    };
  }

  return {
    allowedNetworkAccess: [...SHARED_ALLOWED_NETWORK],
    deniedOperations: SHARED_DENIED_OPERATIONS,
    maxMemoryMb: SHARED_MAX_MEMORY_MB,
    maxCpuPercent: SHARED_MAX_CPU_PERCENT,
    scopedToContainer: true,
    canSelfDeploy: false,
    canModifyAutobot: false,
    canWriteHostFs: false,
    tier: 'strict',
  };
}

// ---------------------------------------------------------------------------
// Cached singleton
// ---------------------------------------------------------------------------

let _cached: AutobotSandbox | null = null;

/**
 * Returns the autobot sandbox configuration for this instance.
 * Cached for the process lifetime.
 */
export function getAutobotSandbox(): AutobotSandbox {
  if (!_cached) {
    _cached = buildSandbox();
  }
  return _cached;
}

/** Reset cached sandbox (for testing). */
export function resetAutobotSandbox(): void {
  _cached = null;
}

// ---------------------------------------------------------------------------
// Operation checks
// ---------------------------------------------------------------------------

export class OperationDeniedError extends Error {
  public readonly operation: string;
  public readonly tier: string;

  constructor(operation: string, tier: string) {
    super(
      `Operation "${operation}" is denied on ${tier}-sandbox instances. ` +
      `Autobot agents on shared infrastructure cannot perform host-level operations.`
    );
    this.name = 'OperationDeniedError';
    this.operation = operation;
    this.tier = tier;
  }
}

/**
 * Check whether a specific operation is allowed in the current sandbox.
 */
export function isOperationAllowed(operation: string): boolean {
  const sandbox = getAutobotSandbox();
  return !sandbox.deniedOperations.includes(operation);
}

/**
 * Assert that an operation is allowed. Throws `OperationDeniedError` if not.
 */
export function assertOperationAllowed(operation: string): void {
  const sandbox = getAutobotSandbox();
  if (sandbox.deniedOperations.includes(operation)) {
    throw new OperationDeniedError(operation, sandbox.tier);
  }
}

/**
 * Check whether a network URL is allowed for the current sandbox.
 * On sovereign instances (empty allowedNetworkAccess), all URLs are allowed.
 * On shared instances, only whitelisted URLs are permitted.
 */
export function isNetworkAccessAllowed(url: string): boolean {
  const sandbox = getAutobotSandbox();

  // Empty list means unrestricted (sovereign)
  if (sandbox.allowedNetworkAccess.length === 0) {
    return true;
  }

  // Check if the URL starts with any allowed prefix
  return sandbox.allowedNetworkAccess.some((allowed) => url.startsWith(allowed));
}

/**
 * Returns a summary of the current sandbox state for diagnostic/UI purposes.
 */
export function getSandboxSummary(): {
  tier: string;
  canSelfDeploy: boolean;
  canModifyAutobot: boolean;
  canWriteHostFs: boolean;
  scopedToContainer: boolean;
  deniedOperationCount: number;
  networkRestricted: boolean;
  maxMemoryMb: number;
  maxCpuPercent: number;
} {
  const sandbox = getAutobotSandbox();
  return {
    tier: sandbox.tier,
    canSelfDeploy: sandbox.canSelfDeploy,
    canModifyAutobot: sandbox.canModifyAutobot,
    canWriteHostFs: sandbox.canWriteHostFs,
    scopedToContainer: sandbox.scopedToContainer,
    deniedOperationCount: sandbox.deniedOperations.length,
    networkRestricted: sandbox.allowedNetworkAccess.length > 0,
    maxMemoryMb: sandbox.maxMemoryMb,
    maxCpuPercent: sandbox.maxCpuPercent,
  };
}
