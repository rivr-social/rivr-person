/**
 * @module api/groups/[id]/sms-inbound
 *
 * Webhook handler for inbound SMS messages delivered by TextBee.
 *
 * Purpose:
 * - Receives POST webhooks from the TextBee Android gateway when an SMS is received.
 * - Validates the request against the group's stored webhook secret or API key.
 * - Parses inbound SMS for RSVP keywords and routes responses to the most recent event.
 * - Logs inbound messages in the ledger for audit trail.
 *
 * Key exports:
 * - POST: webhook receiver for TextBee inbound SMS delivery.
 *
 * Dependencies:
 * - `@/db` and `@/db/schema` for group metadata, ledger writes, and event lookups.
 * - `@/lib/http-status` for consistent status code constants.
 *
 * Security:
 * - Validates the `x-api-key` header against the group's stored TextBee API key.
 * - Group ID is validated as a proper UUID from the route parameter.
 * - No session auth required (this is a machine-to-machine webhook).
 */

import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import {
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_NOT_FOUND,
  STATUS_INTERNAL_ERROR,
  STATUS_OK,
} from "@/lib/http-status";

// =============================================================================
// Constants
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** RSVP keyword mappings -- normalized to lowercase for matching. */
const RSVP_KEYWORDS: Record<string, "attending" | "declined"> = {
  yes: "attending",
  going: "attending",
  attend: "attending",
  rsvp: "attending",
  "count me in": "attending",
  no: "declined",
  cancel: "declined",
  "not going": "declined",
  decline: "declined",
  skip: "declined",
};

// =============================================================================
// Types
// =============================================================================

/** Expected shape of the TextBee inbound webhook payload. */
type TextBeeInboundPayload = {
  /** Phone number that sent the SMS. */
  from?: string;
  senderPhoneNumber?: string;
  /** SMS message body. */
  message?: string;
  text?: string;
  body?: string;
  /** Timestamp of the received message. */
  receivedAt?: string;
  timestamp?: string;
  /** TextBee internal message ID. */
  messageId?: string;
  id?: string;
};

// =============================================================================
// Route handler
// =============================================================================

/**
 * POST /api/groups/[id]/sms-inbound
 *
 * Receives inbound SMS webhooks from a TextBee gateway device.
 * Validates the API key, parses RSVP keywords, and logs the message.
 *
 * @param request - Incoming webhook request with JSON body.
 * @param context - Route params containing the group ID.
 * @returns 200 on successful processing, 4xx/5xx on validation or processing errors.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: groupId } = await params;

  // Validate group ID format.
  if (!groupId || !UUID_RE.test(groupId)) {
    return NextResponse.json(
      { error: "Invalid group identifier" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Fetch group to validate API key and get metadata.
  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata, name: agents.name })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return NextResponse.json(
      { error: "Group not found" },
      { status: STATUS_NOT_FOUND }
    );
  }

  const metadata = (group.metadata ?? {}) as Record<string, unknown>;
  const storedApiKey = typeof metadata.textbeeApiKey === "string" ? metadata.textbeeApiKey : null;

  if (!storedApiKey) {
    return NextResponse.json(
      { error: "SMS gateway not configured for this group" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Validate the webhook's API key header against the group's stored key.
  const requestApiKey = request.headers.get("x-api-key");
  const webhookSecret = typeof metadata.smsWebhookSecret === "string" ? metadata.smsWebhookSecret : null;

  // Accept either the stored API key or a dedicated webhook secret.
  const isAuthorized =
    (requestApiKey && requestApiKey === storedApiKey) ||
    (requestApiKey && webhookSecret && requestApiKey === webhookSecret);

  if (!isAuthorized) {
    return NextResponse.json(
      { error: "Invalid or missing API key" },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  // Parse the webhook payload.
  let payload: TextBeeInboundPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Extract fields with fallbacks for different TextBee payload shapes.
  const senderPhone = payload.from ?? payload.senderPhoneNumber ?? "";
  const messageBody = payload.message ?? payload.text ?? payload.body ?? "";
  const receivedAt = payload.receivedAt ?? payload.timestamp ?? new Date().toISOString();
  const externalMessageId = payload.messageId ?? payload.id ?? null;

  if (!senderPhone || !messageBody) {
    return NextResponse.json(
      { error: "Missing required fields: from/senderPhoneNumber and message/text" },
      { status: STATUS_BAD_REQUEST }
    );
  }

  try {
    // Log the inbound message in the ledger for audit.
    await db.execute(sql`
      INSERT INTO ledger (
        subject_id, subject_type, verb, object_id, object_type,
        is_active, metadata, timestamp
      ) VALUES (
        ${groupId}::uuid, 'agent', 'receive', ${groupId}::uuid, 'agent',
        true,
        ${JSON.stringify({
          interactionType: "sms-inbound",
          senderPhone,
          messageBody,
          receivedAt,
          externalMessageId,
        })}::jsonb,
        NOW()
      )
    `);

    // Attempt RSVP keyword matching.
    const normalizedMessage = messageBody.trim().toLowerCase();
    const rsvpStatus = matchRsvpKeyword(normalizedMessage);

    if (rsvpStatus) {
      await processRsvpResponse(groupId, senderPhone, rsvpStatus);
    }

    return NextResponse.json({
      received: true,
      rsvpProcessed: rsvpStatus !== null,
      rsvpStatus,
    });
  } catch (err) {
    console.error("[sms-inbound] Failed to process inbound SMS:", err);
    return NextResponse.json(
      { error: "Internal server error processing inbound SMS" },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Matches the message body against known RSVP keywords.
 *
 * @param message - Lowercased, trimmed message body.
 * @returns RSVP status or null if no keyword matched.
 */
function matchRsvpKeyword(message: string): "attending" | "declined" | null {
  // Exact match first.
  if (RSVP_KEYWORDS[message]) {
    return RSVP_KEYWORDS[message];
  }

  // Check if the message starts with a keyword (handles "yes please", "no thanks", etc.).
  for (const [keyword, status] of Object.entries(RSVP_KEYWORDS)) {
    if (message.startsWith(keyword)) {
      return status;
    }
  }

  return null;
}

/**
 * Routes an RSVP response to the most recent event in the group.
 *
 * Finds the member by phone number, then records an RSVP ledger entry
 * against the group's most recent event.
 */
async function processRsvpResponse(
  groupId: string,
  senderPhone: string,
  rsvpStatus: "attending" | "declined"
): Promise<void> {
  // Find the member agent by phone number.
  const memberResult = await db.execute(sql`
    SELECT id FROM agents
    WHERE deleted_at IS NULL
      AND type = 'person'
      AND metadata->>'phoneNumber' = ${senderPhone}
      AND metadata->>'smsOptIn' = 'true'
    LIMIT 1
  `);

  const memberRows = memberResult as Array<Record<string, unknown>>;
  if (memberRows.length === 0) {
    console.warn(`[sms-inbound] No member found with phone ${senderPhone} opted in to SMS`);
    return;
  }

  const memberId = memberRows[0].id as string;

  // Find the most recent event associated with this group.
  // Events are linked via parentId or via metadata.groupId.
  const eventResult = await db.execute(sql`
    SELECT id FROM agents
    WHERE deleted_at IS NULL
      AND type = 'event'
      AND (
        parent_id = ${groupId}::uuid
        OR metadata->>'groupId' = ${groupId}
      )
    ORDER BY created_at DESC
    LIMIT 1
  `);

  const eventRows = eventResult as Array<Record<string, unknown>>;
  if (eventRows.length === 0) {
    console.warn(`[sms-inbound] No recent event found for group ${groupId}`);
    return;
  }

  const eventId = eventRows[0].id as string;

  // Deactivate any existing RSVP from this member for this event.
  await db.execute(sql`
    UPDATE ledger
    SET is_active = false, expires_at = NOW()
    WHERE subject_id = ${memberId}::uuid
      AND verb = 'join'
      AND is_active = true
      AND metadata->>'interactionType' = 'event-rsvp'
      AND metadata->>'targetId' = ${eventId}
  `);

  // Insert the new RSVP entry.
  await db.execute(sql`
    INSERT INTO ledger (
      subject_id, subject_type, verb, object_id, object_type,
      is_active, metadata, timestamp
    ) VALUES (
      ${memberId}::uuid, 'agent', 'join', ${eventId}::uuid, 'agent',
      true,
      ${JSON.stringify({
        interactionType: "event-rsvp",
        targetId: eventId,
        rsvpStatus,
        source: "sms",
        senderPhone,
      })}::jsonb,
      NOW()
    )
  `);

  console.info(
    `[sms-inbound] RSVP recorded: member=${memberId} event=${eventId} status=${rsvpStatus} via SMS from ${senderPhone}`
  );
}
