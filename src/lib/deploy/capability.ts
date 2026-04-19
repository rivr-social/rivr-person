/**
 * Deploy capability model for Rivr instance isolation.
 *
 * Determines what deployment operations an instance is allowed to perform
 * based on its type and sovereignty status. This is a critical security
 * boundary:
 *
 * - Sovereign person instances (e.g., rivr.camalot.me): full self-deploy,
 *   autobot management, host access, Docker builds, and direct deploys.
 * - Shared/global instances (e.g., app.rivr.social): no host access, no
 *   Docker builds, no direct deploys. Site builder uses GitHub integration.
 *
 * Key exports:
 * - `getDeployCapability()` — returns the resolved capability for this instance
 * - `assertCapability()` — throws if a specific capability is not available
 * - `InstanceDeployCapability` — the capability shape
 */

import { getInstanceConfig, type InstanceType } from '@/lib/federation/instance-config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Environment variable that explicitly marks an instance as sovereign. */
const ENV_IS_SOVEREIGN = 'IS_SOVEREIGN';

/** Deploy method types for the site builder. */
export type DeployMethod = 'github' | 'direct' | 'none';

// ---------------------------------------------------------------------------
// Capability shape
// ---------------------------------------------------------------------------

export interface InstanceDeployCapability {
  /** Can this instance deploy/restart itself (git pull, rebuild, etc.)? */
  canSelfDeploy: boolean;
  /** Can this instance deploy/restart its autobot sidecar? */
  canDeployAutobot: boolean;
  /** Can this instance SSH/exec on the host machine? */
  canAccessHost: boolean;
  /** Can this instance trigger Docker builds/rebuilds? */
  canBuildDocker: boolean;
  /** How does the site builder deploy generated sites? */
  deployMethod: DeployMethod;
  /** Is this a sovereign (self-hosted or Rivr-hosted sovereign) instance? */
  isSovereign: boolean;
  /** Human-readable label for the isolation tier. */
  isolationTier: 'sovereign' | 'shared';
  /** The resolved instance type from federation config. */
  instanceType: InstanceType;
}

// ---------------------------------------------------------------------------
// Resolution logic
// ---------------------------------------------------------------------------

/**
 * Determine whether this instance is sovereign.
 *
 * Resolution order:
 * 1. Explicit `IS_SOVEREIGN` env var (truthy = sovereign)
 * 2. `INSTANCE_TYPE` = 'person' implies sovereign (person instances are
 *    sovereign by default — the whole point of rivr-person)
 * 3. Everything else defaults to shared/global
 */
function resolveSovereignty(instanceType: InstanceType): boolean {
  const explicit = process.env[ENV_IS_SOVEREIGN];
  if (explicit !== undefined) {
    return explicit === 'true' || explicit === '1' || explicit === 'yes';
  }

  // Person instances are sovereign by default
  if (instanceType === 'person') {
    return true;
  }

  return false;
}

/**
 * Build the deploy capability for the current instance.
 */
function buildCapability(): InstanceDeployCapability {
  const config = getInstanceConfig();
  const isSovereign = resolveSovereignty(config.instanceType);

  if (isSovereign) {
    return {
      canSelfDeploy: true,
      canDeployAutobot: true,
      canAccessHost: true,
      canBuildDocker: true,
      deployMethod: 'direct',
      isSovereign: true,
      isolationTier: 'sovereign',
      instanceType: config.instanceType,
    };
  }

  return {
    canSelfDeploy: false,
    canDeployAutobot: false,
    canAccessHost: false,
    canBuildDocker: false,
    deployMethod: 'github',
    isSovereign: false,
    isolationTier: 'shared',
    instanceType: config.instanceType,
  };
}

// ---------------------------------------------------------------------------
// Cached singleton
// ---------------------------------------------------------------------------

let _cached: InstanceDeployCapability | null = null;

/**
 * Returns the deploy capability for this instance. Result is cached for
 * the lifetime of the process since env vars do not change at runtime.
 */
export function getDeployCapability(): InstanceDeployCapability {
  if (!_cached) {
    _cached = buildCapability();
  }
  return _cached;
}

/** Reset cached capability (for testing). */
export function resetDeployCapability(): void {
  _cached = null;
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

export class CapabilityDeniedError extends Error {
  public readonly capability: string;
  public readonly isolationTier: string;

  constructor(capability: string, isolationTier: string) {
    super(
      `Capability "${capability}" is not available on ${isolationTier} instances. ` +
      `This operation requires a sovereign instance with direct host access.`
    );
    this.name = 'CapabilityDeniedError';
    this.capability = capability;
    this.isolationTier = isolationTier;
  }
}

type CapabilityKey = keyof Pick<
  InstanceDeployCapability,
  'canSelfDeploy' | 'canDeployAutobot' | 'canAccessHost' | 'canBuildDocker'
>;

/**
 * Assert that a specific boolean capability is available.
 * Throws `CapabilityDeniedError` if not.
 */
export function assertCapability(key: CapabilityKey): void {
  const cap = getDeployCapability();
  if (!cap[key]) {
    throw new CapabilityDeniedError(key, cap.isolationTier);
  }
}

/**
 * Assert that the instance is sovereign.
 * Throws `CapabilityDeniedError` if running on a shared instance.
 */
export function assertSovereign(): void {
  const cap = getDeployCapability();
  if (!cap.isSovereign) {
    throw new CapabilityDeniedError('isSovereign', cap.isolationTier);
  }
}

/**
 * Check a capability without throwing. Returns true if the capability
 * is available, false otherwise.
 */
export function hasCapability(key: CapabilityKey): boolean {
  return getDeployCapability()[key];
}
