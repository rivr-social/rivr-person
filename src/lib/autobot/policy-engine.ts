/**
 * Policy engine for autobot persona actions.
 *
 * Evaluates whether a persona action can proceed immediately, requires
 * approval, or is blocked entirely based on:
 * 1. The action's risk level (low / medium / high)
 * 2. The persona's control mode (direct-only / approval-required / delegated)
 * 3. Per-action overrides stored in persona metadata
 *
 * Key exports:
 * - `evaluatePolicy()` — main evaluation function
 * - `getActionRiskLevel()` — maps action type to risk level
 * - Action type constants and risk level types
 */

// ---------------------------------------------------------------------------
// Risk levels
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high';

export type AutobotControlMode = 'direct-only' | 'approval-required' | 'delegated';

// ---------------------------------------------------------------------------
// Action type → risk level mapping
// ---------------------------------------------------------------------------

/**
 * Canonical mapping of MCP tool / action names to risk levels.
 *
 * low    — read-only or informational (no side effects)
 * medium — creates content or social interaction (reversible)
 * high   — financial, destructive, or membership-changing (hard to undo)
 */
const ACTION_RISK_MAP: Record<string, RiskLevel> = {
  // Low — read-only
  'rivr.instance.get_context': 'low',
  'rivr.personas.list': 'low',
  'rivr.profile.get_my_profile': 'low',
  'rivr.kg.list_docs': 'low',
  'rivr.kg.query': 'low',
  'rivr.kg.chat': 'low',
  'rivr.audit.recent': 'low',

  // Medium — create content, react, RSVP
  'rivr.profile.update_basic': 'medium',
  'rivr.posts.create': 'medium',
  'rivr.posts.create_live_invite': 'medium',
  'rivr.events.rsvp': 'medium',
  'rivr.events.append_transcript': 'medium',
  'rivr.kg.push_doc': 'medium',

  // High — financial, join/leave, destructive
  'rivr.groups.join': 'high',
  'rivr.thanks.send': 'high',
};

/** Default risk level for unrecognized action types. */
const DEFAULT_RISK_LEVEL: RiskLevel = 'medium';

/**
 * Returns the risk level for a given action type.
 * Falls back to `medium` for unknown actions to err on the side of caution.
 */
export function getActionRiskLevel(actionType: string): RiskLevel {
  return ACTION_RISK_MAP[actionType] ?? DEFAULT_RISK_LEVEL;
}

// ---------------------------------------------------------------------------
// Per-action override support
// ---------------------------------------------------------------------------

/**
 * Shape of per-action overrides stored in persona metadata.
 *
 * Example metadata:
 * ```json
 * {
 *   "actionOverrides": {
 *     "rivr.posts.create": { "requiresApproval": false },
 *     "rivr.thanks.send": { "blocked": true }
 *   }
 * }
 * ```
 */
interface ActionOverride {
  requiresApproval?: boolean;
  blocked?: boolean;
}

function getActionOverride(
  metadata: Record<string, unknown> | null | undefined,
  actionType: string,
): ActionOverride | null {
  if (!metadata) return null;
  const overrides = metadata.actionOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return null;
  const override = (overrides as Record<string, unknown>)[actionType];
  if (!override || typeof override !== 'object' || Array.isArray(override)) return null;
  return override as ActionOverride;
}

// ---------------------------------------------------------------------------
// Policy evaluation result
// ---------------------------------------------------------------------------

export interface PolicyEvaluation {
  /** Whether the action can proceed (immediately or after approval). */
  allowed: boolean;
  /** Whether the action must go through the approval queue before execution. */
  requiresApproval: boolean;
  /** Human-readable explanation of the decision. */
  reason: string;
  /** The resolved risk level for audit/logging purposes. */
  riskLevel: RiskLevel;
}

// ---------------------------------------------------------------------------
// Core evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a persona action can proceed given the persona's
 * control mode, the action's risk level, and any per-action overrides.
 */
export function evaluatePolicy(params: {
  actionType: string;
  controlMode: AutobotControlMode;
  personaMetadata?: Record<string, unknown> | null;
}): PolicyEvaluation {
  const { actionType, controlMode, personaMetadata } = params;
  const riskLevel = getActionRiskLevel(actionType);

  // Check per-action overrides first
  const override = getActionOverride(personaMetadata, actionType);

  if (override?.blocked === true) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: `Action "${actionType}" is explicitly blocked by persona configuration.`,
      riskLevel,
    };
  }

  if (override?.requiresApproval === true) {
    return {
      allowed: true,
      requiresApproval: true,
      reason: `Action "${actionType}" requires approval per persona override.`,
      riskLevel,
    };
  }

  if (override?.requiresApproval === false) {
    return {
      allowed: true,
      requiresApproval: false,
      reason: `Action "${actionType}" is auto-allowed per persona override.`,
      riskLevel,
    };
  }

  // Apply control mode rules
  switch (controlMode) {
    case 'direct-only':
      // All actions require approval — the persona can only act when explicitly commanded
      return {
        allowed: true,
        requiresApproval: true,
        reason: `Control mode "direct-only" requires approval for all actions.`,
        riskLevel,
      };

    case 'approval-required':
      // Medium and high risk require approval; low risk is auto-allowed
      if (riskLevel === 'low') {
        return {
          allowed: true,
          requiresApproval: false,
          reason: `Low-risk action "${actionType}" is auto-allowed in "approval-required" mode.`,
          riskLevel,
        };
      }
      return {
        allowed: true,
        requiresApproval: true,
        reason: `${riskLevel}-risk action "${actionType}" requires approval in "approval-required" mode.`,
        riskLevel,
      };

    case 'delegated':
      // Only high risk requires approval; low and medium are auto-allowed
      if (riskLevel === 'high') {
        return {
          allowed: true,
          requiresApproval: true,
          reason: `High-risk action "${actionType}" requires approval even in "delegated" mode.`,
          riskLevel,
        };
      }
      return {
        allowed: true,
        requiresApproval: false,
        reason: `${riskLevel}-risk action "${actionType}" is auto-allowed in "delegated" mode.`,
        riskLevel,
      };

    default:
      // Unknown control mode — fail safe: require approval
      return {
        allowed: true,
        requiresApproval: true,
        reason: `Unknown control mode "${controlMode}" — defaulting to require approval.`,
        riskLevel,
      };
  }
}
