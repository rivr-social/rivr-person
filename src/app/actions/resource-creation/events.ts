"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  ledger,
  resources,
  type NewLedgerEntry,
  type VisibilityLevel,
} from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { hasEntitlement } from "@/lib/billing";

import {
  resolveAuthenticatedUserId,
  hasGroupWriteAccess,
  createResourceWithLedger,
} from "./helpers";
import { updateFacade, emitDomainEvent, EVENT_TYPES } from "@/lib/federation/index";
import type { ActionResult, EventTicketInput, NormalizedEventTicket } from "./types";
import { normalizeEventTickets } from "./types";
import type { EventHost, EventPayout, EventSession, EventWorkItem } from "@/types";

const MAX_EVENT_DESCRIPTION_LENGTH = 50000;

/**
 * Coerce an optional `groupId` input into a real id or `null`.
 *
 * UI forms commonly submit empty strings instead of `null` when no
 * group is selected. An empty `groupId` reaching `metadata.groupId`
 * (or domain-event payloads) breaks downstream consumers like the
 * federation scope filter, which checks `metadata.groupId` for
 * routing decisions and would treat `""` as "scoped to a group with
 * an empty id" rather than "unscoped".
 */
function normalizeGroupId(value: string | null | undefined): string | null {
  if (typeof value !== "string") return value ?? null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function syncEventTicketOfferings(params: {
  eventId: string;
  ownerId: string;
  eventName: string;
  eventDescription: string;
  visibility: VisibilityLevel;
  tags: string[];
  scopedLocaleIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  ticketTypes: NormalizedEventTicket[];
}): Promise<void> {
  const syncTargetAgentId = params.ownerId;
  const facadeResult = await updateFacade.execute(
    {
      type: "syncEventTicketOfferings",
      actorId: params.ownerId,
      targetAgentId: syncTargetAgentId,
      payload: params,
    },
    async () => {
  const existingOfferings = await db
    .select({
      id: resources.id,
      metadata: resources.metadata,
    })
    .from(resources)
    .where(
      and(
        sql`${resources.deletedAt} IS NULL`,
        eq(resources.type, "listing"),
        sql`metadata->>'eventId' = ${params.eventId}`,
        sql`lower(coalesce(metadata->>'productKind', '')) = 'ticket'`
      )
    );

  const existingByTierId = new Map<string, { id: string; metadata: Record<string, unknown> }>();
  for (const offering of existingOfferings) {
    const metadata = (offering.metadata ?? {}) as Record<string, unknown>;
    const tierId = typeof metadata.ticketTierId === "string" && metadata.ticketTierId.length > 0
      ? metadata.ticketTierId
      : "general-admission";
    existingByTierId.set(tierId, { id: offering.id, metadata });
  }

  const keepTierIds = new Set(params.ticketTypes.map((ticket) => ticket.id));
  for (const ticket of params.ticketTypes) {
    const existing = existingByTierId.get(ticket.id);
    const formattedPrice = ticket.priceCents > 0
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(ticket.priceCents / 100)
      : "Free";
    const metadata = {
      entityType: "offering",
      resourceKind: "offering",
      listingType: "product",
      offeringType: "ticket",
      productKind: "ticket",
      eventId: params.eventId,
      eventName: params.eventName,
      ticketTierId: ticket.id,
      ticketQuantity: ticket.quantity,
      ticketPrice: ticket.priceCents / 100,
      ticketPriceCents: ticket.priceCents,
      totalPriceCents: ticket.priceCents,
      price: formattedPrice,
      items: [{ resourceId: params.eventId, term: ticket.term, priceCents: ticket.priceCents }],
      targetAgentTypes: ["person"],
      scopedLocaleIds: params.scopedLocaleIds ?? [],
      scopedGroupIds: params.scopedGroupIds ?? [],
      scopedUserIds: params.scopedUserIds ?? [],
      status: "active",
    } satisfies Record<string, unknown>;

    if (existing) {
      await db
        .update(resources)
        .set({
          ownerId: params.ownerId,
          name: `${params.eventName} — ${ticket.name}`,
          description: `${ticket.name} for ${params.eventName}. ${ticket.description || params.eventDescription}`.trim(),
          content: params.eventDescription || null,
          visibility: params.visibility,
          tags: params.tags,
          metadata: {
            ...existing.metadata,
            ...metadata,
          },
        })
        .where(eq(resources.id, existing.id));
      continue;
    }

    await createResourceWithLedger({
      ownerId: params.ownerId,
      name: `${params.eventName} — ${ticket.name}`,
      type: "listing",
      description: `${ticket.name} for ${params.eventName}. ${ticket.description || params.eventDescription}`.trim(),
      content: params.eventDescription,
      visibility: params.visibility,
      tags: params.tags,
      metadata,
    });
  }

  for (const offering of existingOfferings) {
    const metadata = (offering.metadata ?? {}) as Record<string, unknown>;
    const tierId = typeof metadata.ticketTierId === "string" && metadata.ticketTierId.length > 0
      ? metadata.ticketTierId
      : "general-admission";
    if (keepTierIds.has(tierId)) continue;
    await db
      .update(resources)
      .set({
        visibility: "private",
        metadata: {
          ...metadata,
          status: "archived",
          archivedAt: new Date().toISOString(),
        },
      })
      .where(eq(resources.id, offering.id));
  }
    },
  );

  if (!facadeResult.success) {
    throw new Error(facadeResult.error ?? "syncEventTicketOfferings facade failed");
  }
}

export async function createEventResource(input: {
  title: string;
  description: string;
  date: string;
  time: string;
  location: string;
  eventType: "in-person" | "online";
  price?: number | null;
  imageUrl?: string;
  ownerId?: string | null;
  groupId?: string | null;
  projectId?: string | null;
  venueId?: string | null;
  venueStartTime?: string | null;
  venueEndTime?: string | null;
  localeId?: string | null;
  scopedLocaleIds?: string[];
  scopedGroupIds?: string[];
  scopedUserIds?: string[];
  isGlobal?: boolean;
  eftValues?: Record<string, number>;
  capitalValues?: Record<string, number>;
  auditValues?: Record<string, number>;
  ticketTypes?: EventTicketInput[];
  hosts?: EventHost[];
  sessions?: EventSession[];
  payouts?: EventPayout[];
  financialSummary?: {
    revenueCents?: number;
    expensesCents?: number;
    payoutsCents?: number;
    profitCents?: number;
    remainingCents?: number;
    currency?: string;
  };
  workItems?: EventWorkItem[];
}): Promise<ActionResult> {
  if (!input.title?.trim() || !input.description?.trim() || !input.date || !input.time || !input.location?.trim()) {
    return {
      success: false,
      message: "Please fill in all required event fields",
      error: {
        code: "INVALID_INPUT",
      },
    };
  }

  if (input.description.length > MAX_EVENT_DESCRIPTION_LENGTH) {
    return {
      success: false,
      message: `Description exceeds maximum length of ${MAX_EVENT_DESCRIPTION_LENGTH} characters.`,
      error: { code: "INVALID_INPUT" },
    };
  }

  const resolvedUserId = await resolveAuthenticatedUserId();
  if (!resolvedUserId) {
    return {
      success: false,
      message: "You must be logged in to create events",
      error: {
        code: "UNAUTHENTICATED",
      },
    };
  }

  // Coerce empty string -> null up-front so downstream metadata,
  // ownership, and federation event payloads see "no group" rather
  // than "group id of empty string".
  const normalizedGroupId = normalizeGroupId(input.groupId);

  if (normalizedGroupId) {
    // Group-linked events must be created by a member with group write capability.
    const allowed = await hasGroupWriteAccess(resolvedUserId, normalizedGroupId);
    if (!allowed) {
      return {
        success: false,
        message: "You do not have permission to create events for this group.",
        error: { code: "FORBIDDEN" },
      };
    }
  }

  const ownerId = input.ownerId ?? normalizedGroupId ?? resolvedUserId;
  if (ownerId !== resolvedUserId) {
    const allowed = await hasGroupWriteAccess(resolvedUserId, ownerId);
    if (!allowed) {
      return {
        success: false,
        message: "You do not have permission to post this event as that group.",
        error: { code: "FORBIDDEN" },
      };
    };
  }

  const normalizedTickets = normalizeEventTickets({ ticketTypes: input.ticketTypes, price: input.price });
  const isPaidTicketedEvent = normalizedTickets.some((ticket) => ticket.priceCents > 0);
  if (isPaidTicketedEvent) {
    // Paid ticketing is gated by the "host" tier (or higher).
    const canSellTickets = await hasEntitlement(resolvedUserId, "host");
    if (!canSellTickets) {
      return {
        success: false,
        message: "Paid ticketed events require a Host membership or higher.",
        error: {
          code: "SUBSCRIPTION_REQUIRED",
          details: "Subscribe to Host (or higher) to sell event tickets.",
          requiredTier: "host",
        },
      };
    }
  }

  // Determine visibility from scoping selections.
  const hasScopedLocales = Array.isArray(input.scopedLocaleIds) && input.scopedLocaleIds.length > 0;
  const hasScopedGroups = Array.isArray(input.scopedGroupIds) && input.scopedGroupIds.length > 0;
  const hasScopedUsers = Array.isArray(input.scopedUserIds) && input.scopedUserIds.length > 0;
  const hasAnyScoping = hasScopedLocales || hasScopedGroups || hasScopedUsers;

  // isGlobal defaults to true — events are globally discoverable unless the user opts out.
  const isGlobal = input.isGlobal !== false;
  let eventVisibility: VisibilityLevel = "public";
  if (!isGlobal) {
    // User explicitly opted out of global visibility.
    eventVisibility = hasScopedGroups || hasScopedUsers ? "private" : hasScopedLocales ? "locale" : "members";
  } else if (hasAnyScoping) {
    // Globally visible but also tagged for locale/group discovery.
    eventVisibility = "public";
  }

  const derivedLocaleId =
    (Array.isArray(input.scopedLocaleIds) && input.scopedLocaleIds.length > 0
      ? input.scopedLocaleIds[0]
      : input.localeId && input.localeId !== "all"
        ? input.localeId
        : null);
  const baseChapterTags = derivedLocaleId ? [derivedLocaleId] : [];
  const allScopeTags = Array.from(new Set([
    ...baseChapterTags,
    ...(input.scopedLocaleIds ?? []),
    ...(input.scopedGroupIds ?? []),
    ...(input.scopedUserIds ?? []),
  ]));

  const eventTargetAgentId = ownerId;
  const facadeResult = await updateFacade.execute(
    {
      type: "createEventResource",
      actorId: resolvedUserId,
      targetAgentId: eventTargetAgentId,
      payload: input,
    },
    async () => {
      const result = await createResourceWithLedger({
        ownerId,
        name: input.title,
        type: "event",
        description: input.description,
        content: input.description,
        visibility: eventVisibility,
        tags: allScopeTags,
        metadata: {
          entityType: "event",
          resourceKind: "event",
          date: input.date,
          time: input.time,
          location: input.location,
          imageUrl: input.imageUrl ?? null,
          images: input.imageUrl ? [input.imageUrl] : [],
          chapterTags: Array.from(new Set([...baseChapterTags, ...(input.scopedLocaleIds ?? [])])),
          eventType: input.eventType,
          price: normalizedTickets[0]?.priceCents ? normalizedTickets[0].priceCents / 100 : input.price ?? null,
          groupId: normalizedGroupId ?? (ownerId !== resolvedUserId ? ownerId : null),
          projectId: input.projectId ?? null,
          managingProjectId: input.projectId ?? null,
          venueId: input.venueId ?? null,
          venueStartTime: input.venueStartTime ?? null,
          venueEndTime: input.venueEndTime ?? null,
          localeId: derivedLocaleId,
          ticketTypes: normalizedTickets.map((ticket) => ({
            id: ticket.id,
            name: ticket.name,
            description: ticket.description,
            quantity: ticket.quantity,
            priceCents: ticket.priceCents,
          })),
          hosts: input.hosts ?? [],
          hostIds: (input.hosts ?? []).map((host) => host.agentId).filter(Boolean),
          sessions: input.sessions ?? [],
          payouts: input.payouts ?? [],
          financialSummary: input.financialSummary ?? undefined,
          workItems: input.workItems ?? [],
          linkedJobIds: (input.workItems ?? [])
            .filter((item) => item.kind === "job")
            .map((item) => item.resourceId),
          linkedTaskIds: (input.workItems ?? [])
            .filter((item) => item.kind === "task")
            .map((item) => item.resourceId),
          isGlobal,
          scopedLocaleIds: input.scopedLocaleIds ?? [],
          scopedGroupIds: input.scopedGroupIds ?? [],
          scopedUserIds: input.scopedUserIds ?? [],
          ...(input.eftValues ? { eftValues: input.eftValues } : {}),
          ...(input.capitalValues ? { capitalValues: input.capitalValues } : {}),
          ...(input.auditValues ? { auditValues: input.auditValues } : {}),
        },
      });

      if (!result.success || !result.resourceId) return result;

      try {
        await syncEventTicketOfferings({
          eventId: result.resourceId,
          ownerId,
          eventName: input.title,
          eventDescription: input.description,
          visibility: eventVisibility,
          tags: allScopeTags,
          scopedLocaleIds: input.scopedLocaleIds,
          scopedGroupIds: input.scopedGroupIds,
          scopedUserIds: input.scopedUserIds,
          ticketTypes: normalizedTickets,
        });
      } catch (error) {
        console.error("[createEventResource] companion offering creation failed:", error);
      }

      // Create ledger grants for scoped groups and users
      if (hasAnyScoping && result.resourceId) {
        const grantEntries: Array<{ subjectId: string }> = [
          ...(input.scopedGroupIds ?? []).map(id => ({ subjectId: id })),
          ...(input.scopedUserIds ?? []).map(id => ({ subjectId: id })),
        ];

        if (grantEntries.length > 0) {
          try {
            await db.insert(ledger).values(
              grantEntries.map(entry => ({
                verb: "grant" as const,
                subjectId: entry.subjectId,
                objectId: result.resourceId!,
                objectType: "resource" as const,
                resourceId: result.resourceId!,
                isActive: true,
                metadata: { action: "view", source: "visibility-scope" },
              } as NewLedgerEntry))
            );
          } catch (error) {
            console.error("[createEventResource] grant creation failed:", error);
          }
        }
      }

      return result;
    },
  );

  if (!facadeResult.success) {
    return {
      success: false,
      message: facadeResult.error ?? "Failed to create event",
      error: { code: facadeResult.errorCode ?? "SERVER_ERROR" },
    };
  }

  const actionResult = facadeResult.data as ActionResult;

  if (actionResult?.success && actionResult.resourceId) {
    // Surface the same scoping fields the importer's scope filter
    // reads (`metadata.scopedGroupIds`, `metadata.groupId`, `ownerId`)
    // so peer instances can route the event without re-deriving scope
    // from the resource's metadata via a separate query.
    const eventPayloadScopedGroupIds = (input.scopedGroupIds ?? []).filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    emitDomainEvent({
      eventType: EVENT_TYPES.EVENT_CREATED,
      entityType: "resource",
      entityId: actionResult.resourceId,
      actorId: resolvedUserId,
      payload: {
        eventType: input.eventType,
        groupId: normalizedGroupId,
        ownerId,
        metadata: {
          groupId: normalizedGroupId,
          scopedGroupIds: eventPayloadScopedGroupIds,
        },
      },
    }).catch(() => {});
  }

  return actionResult;
}
