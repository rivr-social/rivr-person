import { NextResponse } from "next/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, ledger } from "@/db/schema";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveHomeInstance } from "@/lib/federation/resolution";
import { authorizeFederationRequest } from "@/lib/federation-auth";
import { runWithFederationExecutionContext } from "@/lib/federation/execution-context";
import { emitDomainEvent, EVENT_TYPES } from "@/lib/federation/domain-events";
import { REMOTE_VIEWER_COOKIE_NAME, validateRemoteViewerToken } from "@/lib/federation-remote-session";
import type {
  FederatedInteractionRequest,
  FederatedInteractionAction,
  FederatedInteractionResult,
  FederatedActorContext,
} from "@/lib/federation/cross-instance-types";
import type { RoutingProvenance } from "@/lib/federation/write-router";
import { toggleFollowAgent } from "@/app/actions/interactions/social";
import * as kg from "@/lib/kg/autobot-kg-client";

// ─── Supported Mutation Types ──────────────────────────────────────────────

/** Legacy mutation types from the stub implementation */
const KNOWN_MUTATION_TYPES = [
  "createGroupResource",
  "updateGroupResource",
  "deleteGroupResource",
  "createPostResource",
  "createEventResource",
  "toggleFollowAgent",
  "toggleJoinGroup",
  "createOffering",
  "updateAgent",
  "createComment",
  "toggleReaction",
  "applyMembershipProjection",
] as const;

/** Federated interaction actions dispatched via the new interaction protocol */
const INTERACTION_HANDLERS: Record<
  FederatedInteractionAction,
  (actorId: string, targetAgentId: string, payload?: Record<string, unknown>) => Promise<FederatedInteractionResult>
> = {
  connect: handleConnectAction,
  follow: handleConnectAction, // follow and connect use the same underlying action
  react: createStubHandler("react"),
  rsvp: createStubHandler("rsvp"),
  thanks: createStubHandler("thanks"),
  message_thread_start: createStubHandler("message_thread_start"),
  membership_request: createStubHandler("membership_request"),
  kg_push_doc: handleKgPushDoc,
  kg_query: handleKgQuery,
};

type MutationRequestBody = {
  type?: string;
  actorId?: string;
  targetAgentId?: string;
  payload?: unknown;
  // Federated interaction fields (new protocol)
  action?: FederatedInteractionAction;
  actor?: FederatedActorContext;
  targetInstanceNodeId?: string;
  idempotencyKey?: string;
  /**
   * Routing provenance — present when this mutation was forwarded from
   * a foreign instance. Indicates the originating instance and provides
   * tracing/dedup metadata.
   */
  routedFrom?: RoutingProvenance;
};

/**
 * POST /api/federation/mutations
 *
 * Receives forwarded mutations from remote instances.
 *
 * Supports two protocols:
 * 1. Legacy mutation protocol: { type, actorId, targetAgentId, payload }
 * 2. Federated interaction protocol: { action, actor, targetAgentId, ... }
 *
 * The interaction protocol is used for cross-instance actions like
 * connect, follow, react, etc. where a remote authenticated actor
 * performs an action on a locally-homed entity.
 */
export async function POST(request: Request) {
  const config = getInstanceConfig();

  try {
    const cookieToken = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${REMOTE_VIEWER_COOKIE_NAME}=`))
      ?.slice(`${REMOTE_VIEWER_COOKIE_NAME}=`.length);
    const remoteViewerToken = request.headers.get("X-Remote-Viewer-Token") || cookieToken || null;
    const remoteViewerSession = remoteViewerToken
      ? validateRemoteViewerToken(remoteViewerToken, config.instanceId)
      : null;

    // ── Authenticate the request ─────────────────────────────────────
    const authorization = remoteViewerSession
      ? {
          authorized: true,
          actorId: remoteViewerSession.actorId,
        }
      : await authorizeFederationRequest(request);
    if (!authorization.authorized) {
      return NextResponse.json(
        {
          success: false,
          error: authorization.reason ?? "Authentication required",
        },
        { status: 401 },
      );
    }

    const remoteInstanceId = request.headers.get("X-Instance-Id");
    const remoteInstanceSlug = request.headers.get("X-Instance-Slug");

    if (!remoteInstanceId || !remoteInstanceSlug) {
      return NextResponse.json(
        {
          success: false,
          error: "Missing required headers: X-Instance-Id, X-Instance-Slug",
        },
        { status: 400 },
      );
    }

    const body = (await request.json()) as MutationRequestBody;

    // ── Validate routing provenance if present ──────────────────────
    const routedFrom = body.routedFrom ?? null;
    if (routedFrom) {
      const provenanceError = validateRoutingProvenance(routedFrom, remoteInstanceId);
      if (provenanceError) {
        return NextResponse.json(
          { success: false, error: provenanceError },
          { status: 400 },
        );
      }
      console.log(
        `[federation/mutations] Routed write from ${routedFrom.originInstanceSlug} (${routedFrom.originInstanceId}):`,
        {
          type: body.type ?? body.action,
          targetAgentId: body.targetAgentId,
          idempotencyKey: routedFrom.idempotencyKey,
          correlationId: routedFrom.correlationId,
        },
      );
    }

    // ── Route to the correct protocol ────────────────────────────────
    if (body.action && body.actor) {
      return handleFederatedInteraction(
        body,
        config,
        remoteInstanceSlug,
        remoteInstanceId,
        request.headers.get("X-Remote-Viewer-Token"),
        routedFrom,
      );
    }

    return handleLegacyMutation(body, config, remoteInstanceSlug, remoteInstanceId, routedFrom);
  } catch (error) {
    console.error("[federation/mutations] Error processing mutation:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to process mutation",
      },
      { status: 500 },
    );
  }
}

// ─── Federated Interaction Protocol ──────────────────────────────────────

async function handleFederatedInteraction(
  body: MutationRequestBody,
  config: ReturnType<typeof getInstanceConfig>,
  remoteSlug: string,
  remoteId: string,
  remoteViewerToken?: string | null,
  routedFrom?: RoutingProvenance | null,
): Promise<NextResponse> {
  const { action, actor, targetAgentId, payload, idempotencyKey } = body;

  if (!action || !actor || !targetAgentId) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: action, actor, targetAgentId" },
      { status: 400 },
    );
  }

  if (!actor.actorId || !actor.homeBaseUrl || !actor.assertion) {
    return NextResponse.json(
      { success: false, error: "Actor context must include actorId, homeBaseUrl, and assertion" },
      { status: 400 },
    );
  }
  if (remoteViewerToken) {
    const remoteViewerSession = validateRemoteViewerToken(
      remoteViewerToken,
      config.instanceId,
    );
    if (!remoteViewerSession) {
      return NextResponse.json(
        { success: false, error: "Invalid remote viewer session" },
        { status: 401 },
      );
    }

    if (
      remoteViewerSession.actorId !== actor.actorId ||
      remoteViewerSession.homeBaseUrl !== actor.homeBaseUrl
    ) {
      return NextResponse.json(
        { success: false, error: "Remote viewer token does not match actor context" },
        { status: 401 },
      );
    }
  }

  // Verify the target agent is local to this instance
  const homeInstance = await resolveHomeInstance(targetAgentId);
  if (!homeInstance.isLocal) {
    return NextResponse.json(
      {
        success: false,
        error: `Agent ${targetAgentId} is not local to this instance. Home: ${homeInstance.slug} (${homeInstance.nodeId})`,
      },
      { status: 421 },
    );
  }

  // Dispatch to the interaction handler
  const handler = INTERACTION_HANDLERS[action];
  if (!handler) {
    return NextResponse.json(
      { success: false, error: `Unsupported interaction action: ${action}` },
      { status: 400 },
    );
  }

  console.log(
    `[federation/mutations] Federated interaction from ${remoteSlug} (${remoteId}):`,
    {
      action,
      actorId: actor.actorId,
      targetAgentId,
      idempotencyKey,
      routedFrom: routedFrom ? routedFrom.originInstanceSlug : null,
    },
  );

  // Execute the interaction under the remote actor's federation execution context
  const result = await runWithFederationExecutionContext(
    actor.actorId,
    () => handler(actor.actorId, targetAgentId, (payload ?? {}) as Record<string, unknown>),
  );

  return NextResponse.json({
    ...result,
    instanceId: config.instanceId,
    action,
    ...(routedFrom ? { routedFrom: { originInstanceSlug: routedFrom.originInstanceSlug, originInstanceId: routedFrom.originInstanceId } } : {}),
  });
}

// ─── Interaction Handlers ────────────────────────────────────────────────

/**
 * Handle the "connect" / "follow" action.
 *
 * Creates or toggles a connection between the remote actor and the
 * local target agent. This is the first end-to-end federated interaction.
 */
async function handleConnectAction(
  actorId: string,
  targetAgentId: string,
): Promise<FederatedInteractionResult> {
  try {
    const result = await toggleFollowAgent(targetAgentId);

    // Emit a federation event so the actor's home instance can sync
    const isConnect = result.message?.includes("now following") || result.message?.includes("connected") || false;
    await emitDomainEvent({
      eventType: isConnect ? EVENT_TYPES.FOLLOW_CREATED : EVENT_TYPES.FOLLOW_REMOVED,
      entityId: targetAgentId,
      entityType: "agent",
      actorId,
      payload: {
        action: "connect",
        targetAgentId,
        actorId,
        result,
      },
    });

    return {
      success: result.success,
      action: "connect",
      data: {
        message: result.message,
        isNowConnected: isConnect,
      },
      federationEventEmitted: true,
    };
  } catch (error) {
    return {
      success: false,
      action: "connect",
      error: error instanceof Error ? error.message : "Connect action failed",
      errorCode: "CONNECT_FAILED",
    };
  }
}

/**
 * Handle the "kg_push_doc" action.
 *
 * A remote instance pushes a document into this instance's KG for extraction.
 * The payload should contain { title, content, doc_type, scope_type, scope_id }.
 */
async function handleKgPushDoc(
  actorId: string,
  targetAgentId: string,
  payload?: Record<string, unknown>,
): Promise<FederatedInteractionResult> {
  try {
    const title = typeof payload?.title === "string" ? payload.title : "Federated Doc";
    const content = typeof payload?.content === "string" ? payload.content : "";
    const docType = typeof payload?.doc_type === "string" ? payload.doc_type : "document";
    const scopeType = typeof payload?.scope_type === "string" ? payload.scope_type : "person";
    const scopeId = typeof payload?.scope_id === "string" ? payload.scope_id : targetAgentId;

    if (!content) {
      return {
        success: false,
        action: "kg_push_doc",
        error: "No content provided for KG ingestion",
        errorCode: "MISSING_CONTENT",
      };
    }

    const doc = await kg.createDoc({
      title,
      doc_type: docType,
      scope_type: scopeType,
      scope_id: scopeId,
      source_uri: `rivr://federation/${actorId}/doc`,
    });

    const result = await kg.ingestDoc(doc.id, content, undefined, title);

    await emitDomainEvent({
      eventType: "kg.doc_pushed",
      entityId: String(doc.id),
      entityType: "kg_doc",
      actorId,
      payload: {
        action: "kg_push_doc",
        docId: doc.id,
        title,
        scopeType,
        scopeId,
        triplesExtracted: result.regexTriplesExtracted + result.llmChunksQueued,
      },
    });

    return {
      success: true,
      action: "kg_push_doc",
      data: {
        docId: doc.id,
        title,
        ingestResult: result,
      },
      federationEventEmitted: true,
    };
  } catch (error) {
    return {
      success: false,
      action: "kg_push_doc",
      error: error instanceof Error ? error.message : "KG push doc failed",
      errorCode: "KG_PUSH_FAILED",
    };
  }
}

/**
 * Handle the "kg_query" action.
 *
 * A remote instance queries this instance's scoped KG subgraph.
 * The payload should contain { scope_type, scope_id, entity?, predicate?, max_results? }.
 */
async function handleKgQuery(
  actorId: string,
  targetAgentId: string,
  payload?: Record<string, unknown>,
): Promise<FederatedInteractionResult> {
  try {
    const scopeType = typeof payload?.scope_type === "string" ? payload.scope_type : "person";
    const scopeId = typeof payload?.scope_id === "string" ? payload.scope_id : targetAgentId;
    const entity = typeof payload?.entity === "string" ? payload.entity : undefined;
    const predicate = typeof payload?.predicate === "string" ? payload.predicate : undefined;
    const maxResults = typeof payload?.max_results === "number" ? payload.max_results : undefined;

    const result = await kg.queryScope(scopeType, scopeId, {
      entity,
      predicate,
      max_results: maxResults,
    });

    return {
      success: true,
      action: "kg_query",
      data: {
        triples: result.triples,
        count: result.count,
        scope: { type: scopeType, id: scopeId },
      },
    };
  } catch (error) {
    return {
      success: false,
      action: "kg_query",
      error: error instanceof Error ? error.message : "KG query failed",
      errorCode: "KG_QUERY_FAILED",
    };
  }
}

/**
 * Create a stub handler for actions that are not yet fully implemented.
 * Returns a structured response indicating the action was received but
 * dispatch is pending.
 */
function createStubHandler(
  action: FederatedInteractionAction,
): (actorId: string, targetAgentId: string, payload?: Record<string, unknown>) => Promise<FederatedInteractionResult> {
  return async (actorId, targetAgentId) => {
    console.log(
      `[federation/mutations] Stub handler for '${action}':`,
      { actorId, targetAgentId },
    );
    return {
      success: false,
      action,
      error: `Action '${action}' is not yet implemented on this instance. Coming in Phase 2.`,
      errorCode: "ACTION_NOT_IMPLEMENTED",
    };
  };
}

// ─── Legacy Mutation Protocol ────────────────────────────────────────────

async function handleLegacyMutation(
  body: MutationRequestBody,
  config: ReturnType<typeof getInstanceConfig>,
  remoteSlug: string,
  remoteId: string,
  routedFrom?: RoutingProvenance | null,
): Promise<NextResponse> {
  const { type, actorId, targetAgentId, payload } = body;

  if (!type || !actorId || !targetAgentId) {
    return NextResponse.json(
      { success: false, error: "Missing required fields: type, actorId, targetAgentId" },
      { status: 400 },
    );
  }

  // Verify the target agent is local
  const homeInstance = await resolveHomeInstance(targetAgentId);
  if (!homeInstance.isLocal) {
    return NextResponse.json(
      {
        success: false,
        error: `Agent ${targetAgentId} is not local to this instance. Home: ${homeInstance.slug} (${homeInstance.nodeId})`,
      },
      { status: 421 },
    );
  }

  console.log(
    `[federation/mutations] Legacy mutation from ${remoteSlug} (${remoteId}):`,
    {
      type,
      actorId,
      targetAgentId,
      payloadKeys: payload && typeof payload === "object" ? Object.keys(payload as object) : [],
      routedFrom: routedFrom ? routedFrom.originInstanceSlug : null,
    },
  );

  const isKnownType = (KNOWN_MUTATION_TYPES as readonly string[]).includes(type);

  if (type === "toggleFollowAgent") {
    const result = await runWithFederationExecutionContext(actorId, () => toggleFollowAgent(targetAgentId));
    return NextResponse.json({
      success: result.success,
      data: result,
      knownType: true,
      instanceId: config.instanceId,
      ...(routedFrom
        ? {
            routedFrom: {
              originInstanceSlug: routedFrom.originInstanceSlug,
              originInstanceId: routedFrom.originInstanceId,
            },
          }
        : {}),
    });
  }

  if (type === "applyMembershipProjection") {
    const result = await applyMembershipProjection(actorId, payload);
    return NextResponse.json({
      ...result,
      instanceId: config.instanceId,
      knownType: true,
      ...(routedFrom
        ? {
            routedFrom: {
              originInstanceSlug: routedFrom.originInstanceSlug,
              originInstanceId: routedFrom.originInstanceId,
            },
          }
        : {}),
    });
  }

  return NextResponse.json({
    success: true,
    phase: "forwarding-stub",
    instanceId: config.instanceId,
    accepted: true,
    knownType: isKnownType,
    message: isKnownType
      ? `Mutation type '${type}' recognized. Dispatch pending full implementation.`
      : `Mutation type '${type}' not in known dispatch map. Logged for review.`,
    ...(routedFrom ? { routedFrom: { originInstanceSlug: routedFrom.originInstanceSlug, originInstanceId: routedFrom.originInstanceId } } : {}),
  });
}

// ─── Routing Provenance Validation ──────────────────────────────────────

/**
 * Validate routing provenance attached to a forwarded write.
 *
 * Checks that:
 * - Required fields are present (originInstanceId, originInstanceSlug, originBaseUrl, originTimestamp)
 * - The origin instance ID matches the X-Instance-Id header from the request
 * - The origin timestamp is not too far in the past (5 minute window)
 *
 * Returns null if valid, or an error message string if invalid.
 */
function validateRoutingProvenance(
  provenance: RoutingProvenance,
  requestInstanceId: string,
): string | null {
  if (!provenance.originInstanceId || !provenance.originInstanceSlug || !provenance.originBaseUrl || !provenance.originTimestamp) {
    return "routedFrom is missing required fields: originInstanceId, originInstanceSlug, originBaseUrl, originTimestamp";
  }

  // The origin instance ID in the provenance must match the instance that sent the request
  if (provenance.originInstanceId !== requestInstanceId) {
    return `routedFrom.originInstanceId (${provenance.originInstanceId}) does not match request X-Instance-Id (${requestInstanceId})`;
  }

  // Check timestamp freshness (5 minute window to allow for clock skew and network latency)
  const ROUTING_FRESHNESS_WINDOW_MS = 5 * 60 * 1000;
  const originTime = new Date(provenance.originTimestamp).getTime();
  if (!Number.isFinite(originTime)) {
    return "routedFrom.originTimestamp is not a valid ISO 8601 timestamp";
  }
  const age = Date.now() - originTime;
  if (age > ROUTING_FRESHNESS_WINDOW_MS) {
    return `routedFrom.originTimestamp is too old (${Math.round(age / 1000)}s). Maximum age is ${ROUTING_FRESHNESS_WINDOW_MS / 1000}s.`;
  }
  if (age < -ROUTING_FRESHNESS_WINDOW_MS) {
    return "routedFrom.originTimestamp is in the future beyond acceptable clock skew";
  }

  return null;
}

async function applyMembershipProjection(
  actorId: string,
  payload: unknown,
): Promise<{
  success: boolean;
  data?: {
    joined: boolean;
    groupId: string;
  };
  error?: string;
}> {
  const projection =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;

  const group =
    projection?.group && typeof projection.group === "object"
      ? (projection.group as Record<string, unknown>)
      : null;

  const groupId = typeof group?.id === "string" ? group.id : null;
  const groupName = typeof group?.name === "string" ? group.name.trim() : "";
  const groupType = typeof group?.type === "string" ? group.type : "organization";
  const joined = projection?.joined === true;
  const remoteRole =
    typeof projection?.role === "string" && projection.role.length > 0
      ? projection.role
      : "member";

  if (!groupId || !groupName) {
    return { success: false, error: "Membership projection requires group.id and group.name" };
  }

  const metadata =
    group?.metadata && typeof group.metadata === "object"
      ? (group.metadata as Record<string, unknown>)
      : {};
  const sourceOwner =
    group?.sourceOwner && typeof group.sourceOwner === "object"
      ? (group.sourceOwner as Record<string, unknown>)
      : null;
  const homeBaseUrl =
    typeof group?.homeBaseUrl === "string"
      ? group.homeBaseUrl
      : typeof sourceOwner?.homeBaseUrl === "string"
        ? sourceOwner.homeBaseUrl
        : null;

  await db
    .insert(agents)
    .values({
      id: groupId,
      name: groupName,
      type: groupType as typeof agents.$inferInsert.type,
      description: typeof group?.description === "string" ? group.description : null,
      visibility: "public",
      metadata: {
        ...metadata,
        ...(homeBaseUrl ? { federatedHomeBaseUrl: homeBaseUrl } : {}),
        federatedProjection: true,
        sourceType: "federated_group_projection",
      },
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: agents.id,
      set: {
        name: groupName,
        type: groupType as typeof agents.$inferInsert.type,
        description: typeof group?.description === "string" ? group.description : null,
        metadata: {
          ...metadata,
          ...(homeBaseUrl ? { federatedHomeBaseUrl: homeBaseUrl } : {}),
          federatedProjection: true,
          sourceType: "federated_group_projection",
        },
        updatedAt: new Date(),
      },
    });

  const existingMembership = await db.query.ledger.findFirst({
    where: and(
      eq(ledger.subjectId, actorId),
      eq(ledger.verb, "join"),
      sql`${ledger.metadata}->>'interactionType' = 'membership'`,
      sql`${ledger.metadata}->>'targetId' = ${groupId}`,
      isNull(ledger.expiresAt),
    ),
    columns: {
      id: true,
      isActive: true,
    },
    orderBy: (fields, { desc }) => [desc(fields.timestamp)],
  });

  if (joined) {
    if (existingMembership) {
      await db
        .update(ledger)
        .set({
          isActive: true,
          expiresAt: null,
          role: remoteRole,
          metadata: {
            interactionType: "membership",
            targetId: groupId,
            targetType: "group",
            sourceType: "federated_membership_projection",
            sourceGroupId: groupId,
          },
        })
        .where(eq(ledger.id, existingMembership.id));
    } else {
      await db.insert(ledger).values({
        verb: "join",
        subjectId: actorId,
        objectId: groupId,
        objectType: "agent",
        role: remoteRole,
        isActive: true,
        visibility: "public",
        metadata: {
          interactionType: "membership",
          targetId: groupId,
          targetType: "group",
          sourceType: "federated_membership_projection",
          sourceGroupId: groupId,
        },
      });
    }
  } else if (existingMembership) {
    await db
      .update(ledger)
      .set({
        isActive: false,
        expiresAt: new Date(),
        metadata: {
          interactionType: "membership",
          targetId: groupId,
          targetType: "group",
          sourceType: "federated_membership_projection",
          sourceGroupId: groupId,
        },
      })
      .where(eq(ledger.id, existingMembership.id));
  }

  return {
    success: true,
    data: {
      joined,
      groupId,
    },
  };
}
