'use server';

import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { agents } from '@/db/schema';
import { getSession } from '@/lib/auth/get-session';
import { getFederationExecutionContext } from '@/lib/federation/execution-context';
import { ensureLocalActorAgent } from '@/lib/federation/actor-projection';
import { getSettlementWalletForAgent } from '@/lib/wallet';

/**
 * Resolve the acting principal for a READ on a money surface.
 *
 * Uses the unified session so a verified federated remote-viewer member (the
 * HMAC-signed `rivr_remote_viewer` cookie) is admitted — plain `auth()` was
 * blind to them, so every wallet/purchase surface treated a cross-instance
 * member as anonymous (2026-07-11 sweep). Forwarded/MCP writes carry an
 * already-resolved actor in the federation execution context; that takes
 * precedence. Person keys its direct federated writes on the raw verified
 * actor id (see {@link ensureLocalActorAgent} / `federatedWrite`), so no
 * external→local remap happens here.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const federationContext = getFederationExecutionContext();
  if (federationContext?.actorId) {
    return federationContext.actorId;
  }

  const session = await getSession();
  return session?.user?.id ?? null;
}

/**
 * {@link getCurrentUserId} plus first-contact projection for actor-keyed
 * WRITES (wallet FK, Stripe customer creation, ledger `subject_id`). A
 * federated remote-viewer's first economic action on this sovereign may
 * precede any local `agents` row, so keyed writes threw "Agent not found" /
 * FK violations. `ensureLocalActorAgent` materializes the private
 * verified-principal mirror keyed on the verified actor id — exactly what
 * `federatedWrite` does on the direct write path, so wallet writes and basic
 * interactions land on the SAME local row. It is a no-op for local NextAuth
 * users, forwarded/MCP execution contexts (already projected by the receiver),
 * and already-projected members. Read paths keep using
 * {@link getCurrentUserId} — projecting on read would mint agent rows for mere
 * viewers.
 */
export async function getCurrentUserIdForWrite(): Promise<string | null> {
  const federationContext = getFederationExecutionContext();
  if (federationContext?.actorId) {
    return federationContext.actorId;
  }

  const session = await getSession();
  if (!session?.user?.id) {
    return null;
  }

  if (session.user.authMethod === 'federated') {
    await ensureLocalActorAgent(session.user.id);
  }

  return session.user.id;
}

export async function getAgentRecord(agentId: string): Promise<{
  id: string;
  type: string;
  email: string | null;
  name: string;
  metadata: Record<string, unknown> | null;
} | null> {
  const [agent] = await db
    .select({
      id: agents.id,
      type: agents.type,
      email: agents.email,
      name: agents.name,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);

  if (!agent) return null;

  return {
    ...agent,
    metadata: (agent.metadata ?? {}) as Record<string, unknown>,
  };
}

export async function canManageWalletOwner(currentUserId: string, ownerId: string): Promise<boolean> {
  if (currentUserId === ownerId) return true;

  const owner = await getAgentRecord(ownerId);
  if (!owner) return false;

  const creatorId = typeof owner.metadata?.creatorId === 'string' ? owner.metadata.creatorId : null;
  const adminIds = Array.isArray(owner.metadata?.adminIds) ? owner.metadata.adminIds : [];

  return creatorId === currentUserId || adminIds.includes(currentUserId);
}

export async function resolveManagedWalletTarget(currentUserId: string, ownerId?: string): Promise<{
  ownerId: string;
  walletId: string;
  walletType: 'personal' | 'group';
  email: string | null;
  name: string;
}> {
  const resolvedOwnerId = ownerId ?? currentUserId;
  const allowed = await canManageWalletOwner(currentUserId, resolvedOwnerId);
  if (!allowed) {
    throw new Error('You are not allowed to manage payments for this treasury.');
  }

  const owner = await getAgentRecord(resolvedOwnerId);
  if (!owner) {
    throw new Error('Payment owner not found.');
  }

  const wallet = await getSettlementWalletForAgent(resolvedOwnerId);

  return {
    ownerId: resolvedOwnerId,
    walletId: wallet.id,
    walletType: wallet.type,
    email: owner.email,
    name: owner.name,
  };
}
