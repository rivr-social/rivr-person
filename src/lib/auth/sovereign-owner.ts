import { getSession, type UnifiedSession } from "@/lib/auth/get-session";
import { getInstanceConfig } from "@/lib/federation/instance-config";

export interface SovereignOwner {
  agentId: string;
  session: UnifiedSession;
}

export type SovereignOwnerResult =
  | { ok: true; owner: SovereignOwner }
  | { ok: false; status: 401 | 403 | 503; error: string };

export function isConfiguredSovereignOwner(
  actorId: string | null | undefined,
  primaryAgentId: string | null | undefined,
): boolean {
  return Boolean(actorId && primaryAgentId && actorId === primaryAgentId);
}

export function isLocalSignupAllowed(
  instanceType: string,
  allowLocalSignup: string | undefined,
): boolean {
  return instanceType !== "person" || allowLocalSignup === "true";
}

/**
 * Resolve the configured instance owner from a verified local or federated
 * session. Missing PRIMARY_AGENT_ID fails closed because owner-only host
 * controls must never infer ownership from authentication alone.
 */
export async function resolveSovereignOwner(): Promise<SovereignOwnerResult> {
  const session = await getSession();
  if (!session?.user?.id) {
    return { ok: false, status: 401, error: "Authentication required" };
  }

  const { primaryAgentId } = getInstanceConfig();
  if (!primaryAgentId) {
    return {
      ok: false,
      status: 503,
      error: "Sovereign owner is not configured",
    };
  }

  if (!isConfiguredSovereignOwner(session.user.id, primaryAgentId)) {
    return {
      ok: false,
      status: 403,
      error: "Forbidden: owner-only resource",
    };
  }

  return {
    ok: true,
    owner: { agentId: session.user.id, session },
  };
}

export async function requireSovereignOwner(): Promise<SovereignOwner> {
  const result = await resolveSovereignOwner();
  if (result.ok) return result.owner;

  const error = new Error(result.error) as Error & { status: number };
  error.status = result.status;
  throw error;
}
