/**
 * Approval check middleware for MCP tool execution.
 *
 * Wraps the MCP tool call path so that actions requiring approval are queued
 * instead of executed immediately. Returns a "pending approval" response when
 * the policy engine requires sign-off.
 *
 * Key export:
 * - `withApprovalCheck()` — wraps an MCP tool handler with policy evaluation
 */

import { db } from '@/db';
import { agents } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { evaluatePolicy, type AutobotControlMode } from './policy-engine';
import { requestApproval } from './approval-queue';
import { logAction } from './audit-log';
import type { McpToolCallContext, McpToolResult } from '@/lib/federation/mcp-tools';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CONTROL_MODES: readonly string[] = ['direct-only', 'approval-required', 'delegated'];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApprovalCheckResult {
  /** Whether the action was executed. */
  executed: boolean;
  /** The tool result if executed, or a pending-approval envelope if queued. */
  result: McpToolResult;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the control mode and metadata for a persona from the DB.
 * Returns null if the persona is not found or not autobot-enabled.
 */
async function resolvePersonaPolicy(personaId: string): Promise<{
  controlMode: AutobotControlMode;
  metadata: Record<string, unknown>;
} | null> {
  const [persona] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, personaId), isNull(agents.deletedAt)))
    .limit(1);

  if (!persona) return null;

  const metadata = (persona.metadata ?? {}) as Record<string, unknown>;
  const rawMode = metadata.autobotControlMode;
  // Default to 'delegated' so a fresh persona (no explicit mode set) can act
  // freely on read + medium-risk writes (posts, RSVPs, KG push, etc.) without
  // forcing the controller to manually approve every step. High-risk actions
  // (groups.join, thanks.send, deploys) still require approval. Operators who
  // want strict gating can set autobotControlMode='direct-only' on the persona.
  const controlMode: AutobotControlMode =
    typeof rawMode === 'string' && VALID_CONTROL_MODES.includes(rawMode)
      ? (rawMode as AutobotControlMode)
      : 'delegated';

  return { controlMode, metadata };
}

// ---------------------------------------------------------------------------
// Main wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an MCP tool execution with approval policy checks.
 *
 * When called with a persona context:
 * 1. Looks up the persona's control mode and metadata
 * 2. Evaluates the policy engine
 * 3. If approval is required, queues the action and returns a pending envelope
 * 4. If auto-allowed, executes the handler and logs the decision
 * 5. If blocked, returns a blocked response
 *
 * When called with a human context (non-persona), the handler executes directly.
 */
export async function withApprovalCheck(params: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  context: McpToolCallContext;
  handler: () => Promise<McpToolResult>;
}): Promise<ApprovalCheckResult> {
  const { toolName, toolArgs, context, handler } = params;

  // Only apply approval checks to persona actors
  if (context.actorType !== 'persona') {
    const result = await handler();
    return { executed: true, result };
  }

  const personaPolicy = await resolvePersonaPolicy(context.actorId);

  // If persona not found or policy can't be resolved, fail safe
  if (!personaPolicy) {
    return {
      executed: false,
      result: {
        success: false,
        error: 'Persona not found or deleted. Cannot evaluate approval policy.',
        pendingApproval: false,
      },
    };
  }

  const evaluation = evaluatePolicy({
    actionType: toolName,
    controlMode: personaPolicy.controlMode,
    personaMetadata: personaPolicy.metadata,
  });

  // Blocked actions
  if (!evaluation.allowed) {
    logAction({
      personaId: context.actorId,
      actionType: toolName,
      riskLevel: evaluation.riskLevel,
      decision: 'rejected',
      payload: sanitizePayload(toolArgs),
      actorId: context.controllerId ?? null,
    }).catch(() => {});

    return {
      executed: false,
      result: {
        success: false,
        error: evaluation.reason,
        blocked: true,
        riskLevel: evaluation.riskLevel,
      },
    };
  }

  // Actions requiring approval
  if (evaluation.requiresApproval) {
    const approval = await requestApproval({
      personaId: context.actorId,
      actionType: toolName,
      actionPayload: sanitizePayload(toolArgs),
      riskLevel: evaluation.riskLevel,
    });

    logAction({
      personaId: context.actorId,
      actionType: toolName,
      riskLevel: evaluation.riskLevel,
      decision: 'auto_allowed', // logged as pending — will be updated on resolution
      payload: sanitizePayload(toolArgs),
      actorId: context.controllerId ?? null,
      approvalId: approval.id,
    }).catch(() => {});

    return {
      executed: false,
      result: {
        success: true,
        pendingApproval: true,
        approvalId: approval.id,
        reason: evaluation.reason,
        riskLevel: evaluation.riskLevel,
        actionType: toolName,
        expiresAt: approval.expiresAt,
      },
    };
  }

  // Auto-allowed — execute immediately
  const result = await handler();

  logAction({
    personaId: context.actorId,
    actionType: toolName,
    riskLevel: evaluation.riskLevel,
    decision: 'auto_allowed',
    payload: sanitizePayload(toolArgs),
    actorId: context.controllerId ?? null,
  }).catch(() => {});

  return { executed: true, result };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Strip large or sensitive values from action payloads before storing. */
function sanitizePayload(args: Record<string, unknown>): Record<string, unknown> {
  const REDACTED_KEYS = new Set(['token', 'password', 'secret']);
  const MAX_STRING_LENGTH = 500;

  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (REDACTED_KEYS.has(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      sanitized[key] = value.slice(0, MAX_STRING_LENGTH) + '...';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
