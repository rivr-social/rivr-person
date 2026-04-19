/**
 * @module api/groups/[id]/sms
 *
 * API route for sending SMS messages to group members via TextBee.
 *
 * Purpose:
 * - Provides a REST endpoint for group admins to send SMS to opted-in members.
 * - Delegates to the `sendGroupSms` server action for business logic.
 * - Returns structured JSON responses with delivery statistics.
 *
 * Key exports:
 * - POST: send SMS to group members who have opted in with phone numbers.
 *
 * Dependencies:
 * - `@/auth` for session authentication.
 * - `@/app/actions/sms` for the underlying send logic.
 * - `@/lib/http-status` for consistent status code constants.
 *
 * Security:
 * - Requires authenticated session via NextAuth.
 * - Group admin role enforced by `sendGroupSms`.
 * - Rate limited per-user to prevent bulk abuse.
 */

import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { sendGroupSms } from "@/app/actions/sms";
import {
  STATUS_OK,
  STATUS_BAD_REQUEST,
  STATUS_UNAUTHORIZED,
  STATUS_INTERNAL_ERROR,
} from "@/lib/http-status";

// =============================================================================
// Constants
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Maximum allowed SMS message length (multi-segment SMS). */
const MAX_MESSAGE_LENGTH = 1600;

// =============================================================================
// Types
// =============================================================================

/** Expected shape of the POST request body. */
type SmsSendRequestBody = {
  /** SMS body text to send to group members. */
  message: string;
  /** Optional array of specific member agent UUIDs to target. */
  memberIds?: string[];
};

// =============================================================================
// Route handler
// =============================================================================

/**
 * POST /api/groups/[id]/sms
 *
 * Sends an SMS message to group members who have opted in with phone numbers.
 *
 * Request body:
 * - `message` (string, required) — SMS body text.
 * - `memberIds` (string[], optional) — Filter to specific member UUIDs.
 *
 * Response:
 * - 200: `{ success, totalSent, totalFailed, recipientCount }`
 * - 400: validation errors
 * - 401: not authenticated
 * - 500: unexpected server error
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: groupId } = await params;

  // Validate group ID format.
  if (!groupId || !UUID_RE.test(groupId)) {
    return NextResponse.json(
      { error: "Invalid group identifier." },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Verify authentication.
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: STATUS_UNAUTHORIZED }
    );
  }

  // Parse and validate the request body.
  let body: SmsSendRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: STATUS_BAD_REQUEST }
    );
  }

  const { message, memberIds } = body;

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return NextResponse.json(
      { error: "Message body is required and must be a non-empty string." },
      { status: STATUS_BAD_REQUEST }
    );
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH} characters.` },
      { status: STATUS_BAD_REQUEST }
    );
  }

  // Validate memberIds if provided.
  if (memberIds !== undefined) {
    if (!Array.isArray(memberIds)) {
      return NextResponse.json(
        { error: "memberIds must be an array of UUID strings." },
        { status: STATUS_BAD_REQUEST }
      );
    }

    const invalidIds = memberIds.filter((id) => typeof id !== "string" || !UUID_RE.test(id));
    if (invalidIds.length > 0) {
      return NextResponse.json(
        { error: `Invalid member IDs: ${invalidIds.slice(0, 5).join(", ")}` },
        { status: STATUS_BAD_REQUEST }
      );
    }
  }

  try {
    const result = await sendGroupSms(groupId, message.trim(), memberIds);

    if (!result.success) {
      // Determine appropriate status code from error context.
      const statusCode = result.error?.includes("Authentication")
        ? STATUS_UNAUTHORIZED
        : STATUS_BAD_REQUEST;

      return NextResponse.json(
        { error: result.error },
        { status: statusCode }
      );
    }

    return NextResponse.json(
      {
        success: true,
        totalSent: result.totalSent,
        totalFailed: result.totalFailed,
        recipientCount: result.recipientCount,
        ...(result.error ? { warning: result.error } : {}),
      },
      { status: STATUS_OK }
    );
  } catch (err) {
    console.error("[api/groups/sms] Unexpected error sending group SMS:", err);
    return NextResponse.json(
      { error: "An unexpected error occurred while sending SMS messages." },
      { status: STATUS_INTERNAL_ERROR }
    );
  }
}
