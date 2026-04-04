"use server";

/**
 * Server actions for group SMS gateway management via TextBee.
 *
 * Purpose:
 * - Configure, test, and remove TextBee SMS gateway settings per group.
 * - Send SMS messages to group members who have opted in with phone numbers.
 * - Query gateway configuration status.
 * - Update user phone number and SMS opt-in preference.
 *
 * Key exports:
 * - `configureGroupSmsGateway` — stores gateway config in group agent metadata.
 * - `removeGroupSmsGateway` — removes gateway config from metadata.
 * - `testGroupSmsGateway` — sends a health check to verify connectivity.
 * - `sendGroupSms` — sends SMS to group members with phone numbers.
 * - `getGroupSmsStatus` — returns gateway configuration status.
 * - `updatePhoneNumber` — updates user phone number and SMS opt-in.
 *
 * Dependencies:
 * - `@/auth` for session authentication.
 * - `@/db` and `@/db/schema` for agent metadata reads/writes.
 * - `@/lib/sms/textbee-client` for TextBee API communication.
 * - `@/app/actions/group-admin` for admin authorization checks.
 * - `@/lib/rate-limit` for per-user rate limiting.
 */

import { auth } from "@/auth";
import { db } from "@/db";
import { agents, ledger } from "@/db/schema";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { isGroupAdmin } from "@/app/actions/group-admin";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import {
  TextBeeError,
  createTextBeeClientFromMetadata,
} from "@/lib/sms/textbee-client";

// =============================================================================
// Constants
// =============================================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Minimum length for TextBee API key to catch obvious user errors. */
const MIN_API_KEY_LENGTH = 8;

/** URL pattern for basic validation of the TextBee server URL. */
const URL_PATTERN = /^https?:\/\/.+/;

/** Maximum SMS sends per user per minute to prevent bulk abuse. */
const SMS_SEND_RATE_LIMIT = 10;
const SMS_SEND_RATE_WINDOW_MS = 60_000;

// =============================================================================
// Result types
// =============================================================================

type SmsActionResult = {
  success: boolean;
  error?: string;
};

type SmsGatewayStatus = {
  configured: boolean;
  textbeeUrl?: string;
  deviceOnline?: boolean;
  deviceId?: string;
  lastSeen?: string;
  lastTestAt?: string;
  lastTestResult?: "success" | "failure";
};

type SmsSendResult = {
  success: boolean;
  error?: string;
  totalSent?: number;
  totalFailed?: number;
  recipientCount?: number;
};

// =============================================================================
// Server actions
// =============================================================================

/**
 * Stores TextBee SMS gateway configuration in the group agent metadata.
 *
 * Auth: Requires authenticated session + group admin role.
 *
 * @param groupId - UUID of the target group.
 * @param textbeeUrl - Base URL of the TextBee server.
 * @param textbeeApiKey - API key for TextBee authentication.
 * @returns Success/error result.
 */
export async function configureGroupSmsGateway(
  groupId: string,
  textbeeUrl: string,
  textbeeApiKey: string
): Promise<SmsActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  if (!textbeeUrl || !URL_PATTERN.test(textbeeUrl)) {
    return { success: false, error: "Invalid TextBee URL. Must start with http:// or https://." };
  }

  if (!textbeeApiKey || textbeeApiKey.length < MIN_API_KEY_LENGTH) {
    return { success: false, error: `API key must be at least ${MIN_API_KEY_LENGTH} characters.` };
  }

  const actorId = session.user.id;

  const rateLimitCheck = await rateLimit(`sms:${actorId}`, RATE_LIMITS.SOCIAL.limit, RATE_LIMITS.SOCIAL.windowMs);
  if (!rateLimitCheck.success) {
    return { success: false, error: "Rate limit exceeded. Please try again later." };
  }

  const admin = await isGroupAdmin(actorId, groupId);
  if (!admin) {
    return { success: false, error: "Only group admins can configure the SMS gateway." };
  }

  // Verify the group exists and fetch current metadata.
  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  const existingMetadata = (group.metadata ?? {}) as Record<string, unknown>;

  // Normalize URL: strip trailing slash.
  const normalizedUrl = textbeeUrl.replace(/\/+$/, "");

  const updatedMetadata = {
    ...existingMetadata,
    textbeeUrl: normalizedUrl,
    textbeeApiKey,
    smsGatewayConfiguredAt: new Date().toISOString(),
    smsGatewayConfiguredBy: actorId,
  };

  await db
    .update(agents)
    .set({ metadata: updatedMetadata, updatedAt: new Date() })
    .where(eq(agents.id, groupId));

  revalidatePath(`/groups/${groupId}`);
  revalidatePath(`/groups/${groupId}/settings`);

  return { success: true };
}

/**
 * Removes TextBee SMS gateway configuration from the group agent metadata.
 *
 * Auth: Requires authenticated session + group admin role.
 *
 * @param groupId - UUID of the target group.
 * @returns Success/error result.
 */
export async function removeGroupSmsGateway(
  groupId: string
): Promise<SmsActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const actorId = session.user.id;

  const admin = await isGroupAdmin(actorId, groupId);
  if (!admin) {
    return { success: false, error: "Only group admins can remove the SMS gateway." };
  }

  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  const existingMetadata = (group.metadata ?? {}) as Record<string, unknown>;

  // Remove all SMS gateway-related keys from metadata.
  const {
    textbeeUrl: _url,
    textbeeApiKey: _key,
    textbeeDeviceId: _device,
    smsGatewayConfiguredAt: _configAt,
    smsGatewayConfiguredBy: _configBy,
    smsLastTestAt: _testAt,
    smsLastTestResult: _testResult,
    ...cleanedMetadata
  } = existingMetadata;

  await db
    .update(agents)
    .set({ metadata: cleanedMetadata, updatedAt: new Date() })
    .where(eq(agents.id, groupId));

  revalidatePath(`/groups/${groupId}`);
  revalidatePath(`/groups/${groupId}/settings`);

  return { success: true };
}

/**
 * Tests the TextBee gateway connection by checking device health.
 *
 * Auth: Requires authenticated session + group admin role.
 *
 * @param groupId - UUID of the target group.
 * @returns Success/error result with device status details.
 */
export async function testGroupSmsGateway(
  groupId: string
): Promise<SmsActionResult & { deviceOnline?: boolean; deviceId?: string }> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const actorId = session.user.id;

  const admin = await isGroupAdmin(actorId, groupId);
  if (!admin) {
    return { success: false, error: "Only group admins can test the SMS gateway." };
  }

  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  const metadata = (group.metadata ?? {}) as Record<string, unknown>;
  const client = createTextBeeClientFromMetadata(metadata);

  if (!client) {
    return { success: false, error: "SMS gateway is not configured for this group." };
  }

  try {
    const health = await client.checkHealth();

    // Store test result in metadata.
    const testResult = health.online ? "success" : "failure";
    const updatedMetadata = {
      ...metadata,
      smsLastTestAt: new Date().toISOString(),
      smsLastTestResult: testResult,
      ...(health.deviceId ? { textbeeDeviceId: health.deviceId } : {}),
    };

    await db
      .update(agents)
      .set({ metadata: updatedMetadata, updatedAt: new Date() })
      .where(eq(agents.id, groupId));

    if (!health.online) {
      return {
        success: false,
        error: "Gateway device is offline. Ensure the TextBee app is running on the Android device.",
        deviceOnline: false,
        deviceId: health.deviceId,
      };
    }

    return {
      success: true,
      deviceOnline: true,
      deviceId: health.deviceId,
    };
  } catch (err) {
    const errorMessage =
      err instanceof TextBeeError
        ? err.message
        : "Failed to connect to TextBee gateway.";

    // Store failure in metadata.
    const updatedMetadata = {
      ...metadata,
      smsLastTestAt: new Date().toISOString(),
      smsLastTestResult: "failure",
    };

    await db
      .update(agents)
      .set({ metadata: updatedMetadata, updatedAt: new Date() })
      .where(eq(agents.id, groupId));

    return { success: false, error: errorMessage };
  }
}

/**
 * Sends an SMS to group members who have opted in with phone numbers.
 *
 * Auth: Requires authenticated session + group admin role.
 * Rate limited to prevent bulk abuse.
 *
 * @param groupId - UUID of the target group.
 * @param message - SMS body text to send.
 * @param recipientFilter - Optional array of specific member agent IDs. If omitted, sends to all opted-in members.
 * @returns Send result with delivery statistics.
 */
export async function sendGroupSms(
  groupId: string,
  message: string,
  recipientFilter?: string[]
): Promise<SmsSendResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  if (!message || message.trim().length === 0) {
    return { success: false, error: "Message body is required." };
  }

  const actorId = session.user.id;

  const rateLimitCheck = await rateLimit(`sms-send:${actorId}`, SMS_SEND_RATE_LIMIT, SMS_SEND_RATE_WINDOW_MS);
  if (!rateLimitCheck.success) {
    return { success: false, error: "SMS send rate limit exceeded. Please try again later." };
  }

  const admin = await isGroupAdmin(actorId, groupId);
  if (!admin) {
    return { success: false, error: "Only group admins can send group SMS messages." };
  }

  // Fetch group with metadata.
  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  const metadata = (group.metadata ?? {}) as Record<string, unknown>;
  const client = createTextBeeClientFromMetadata(metadata);

  if (!client) {
    return { success: false, error: "SMS gateway is not configured for this group." };
  }

  // Resolve members with phone numbers.
  // Members are found via active ledger join/belong entries targeting this group.
  const memberEntries = await db
    .select({ subjectId: ledger.subjectId })
    .from(ledger)
    .where(
      and(
        eq(ledger.objectId, groupId),
        eq(ledger.isActive, true),
        or(eq(ledger.verb, "join"), eq(ledger.verb, "belong"))
      )
    );

  const memberIds = [...new Set(memberEntries.map((e) => e.subjectId))];

  if (memberIds.length === 0) {
    return { success: false, error: "No members found in this group." };
  }

  // Fetch member agents with phone numbers from metadata.
  const memberAgents = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(
      and(
        sql`${agents.id} = ANY(${memberIds}::uuid[])`,
        isNull(agents.deletedAt)
      )
    );

  // Extract phone numbers from members who have opted in.
  const phoneRecipients: string[] = [];
  for (const member of memberAgents) {
    // If a recipientFilter is provided, only include matching members.
    if (recipientFilter && !recipientFilter.includes(member.id)) continue;

    const memberMeta = (member.metadata ?? {}) as Record<string, unknown>;
    const phone = typeof memberMeta.phoneNumber === "string" ? memberMeta.phoneNumber : null;
    const smsOptIn = memberMeta.smsOptIn === true;

    if (phone && smsOptIn) {
      phoneRecipients.push(phone);
    }
  }

  if (phoneRecipients.length === 0) {
    return {
      success: false,
      error: "No group members have opted in to SMS notifications with a valid phone number.",
    };
  }

  try {
    const result = await client.sendBulkSms(phoneRecipients, message);

    return {
      success: result.success,
      totalSent: result.totalSent,
      totalFailed: result.totalFailed,
      recipientCount: phoneRecipients.length,
      ...(result.totalFailed > 0
        ? { error: `${result.totalFailed} message(s) failed to send.` }
        : {}),
    };
  } catch (err) {
    const errorMessage =
      err instanceof TextBeeError
        ? err.message
        : "Failed to send SMS messages.";

    return { success: false, error: errorMessage };
  }
}

/**
 * Returns the SMS gateway configuration status for a group.
 *
 * Auth: Requires authenticated session + group admin role.
 *
 * @param groupId - UUID of the target group.
 * @returns Gateway status including configuration state and last test result.
 */
export async function getGroupSmsStatus(
  groupId: string
): Promise<{ success: boolean; error?: string; status?: SmsGatewayStatus }> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  if (!groupId || !UUID_RE.test(groupId)) {
    return { success: false, error: "Invalid group identifier." };
  }

  const actorId = session.user.id;

  const admin = await isGroupAdmin(actorId, groupId);
  if (!admin) {
    return { success: false, error: "Only group admins can view SMS gateway status." };
  }

  const [group] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, groupId), isNull(agents.deletedAt)))
    .limit(1);

  if (!group) {
    return { success: false, error: "Group not found." };
  }

  const metadata = (group.metadata ?? {}) as Record<string, unknown>;
  const textbeeUrl = typeof metadata.textbeeUrl === "string" ? metadata.textbeeUrl : undefined;
  const configured = Boolean(textbeeUrl && typeof metadata.textbeeApiKey === "string");

  const status: SmsGatewayStatus = {
    configured,
    textbeeUrl: configured ? textbeeUrl : undefined,
    deviceId: typeof metadata.textbeeDeviceId === "string" ? metadata.textbeeDeviceId : undefined,
    lastTestAt: typeof metadata.smsLastTestAt === "string" ? metadata.smsLastTestAt : undefined,
    lastTestResult:
      metadata.smsLastTestResult === "success" || metadata.smsLastTestResult === "failure"
        ? metadata.smsLastTestResult
        : undefined,
  };

  return { success: true, status };
}

/**
 * Updates a user's phone number and SMS opt-in preference in their agent metadata.
 *
 * Auth: Requires authenticated session. Users can only update their own profile.
 *
 * @param phoneNumber - Phone number in E.164 format, or empty string to remove.
 * @param smsOptIn - Whether the user consents to receiving SMS from groups.
 * @returns Success/error result.
 */
export async function updatePhoneNumber(
  phoneNumber: string,
  smsOptIn: boolean
): Promise<SmsActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Authentication required." };
  }

  const actorId = session.user.id;

  // Basic phone number validation when provided.
  if (phoneNumber) {
    const stripped = phoneNumber.replace(/[\s\-()]/g, "");
    if (!/^\+?\d{7,15}$/.test(stripped)) {
      return { success: false, error: "Invalid phone number format. Use E.164 format (e.g. +15551234567)." };
    }
  }

  const [agent] = await db
    .select({ id: agents.id, metadata: agents.metadata })
    .from(agents)
    .where(and(eq(agents.id, actorId), isNull(agents.deletedAt)))
    .limit(1);

  if (!agent) {
    return { success: false, error: "User profile not found." };
  }

  const existingMetadata = (agent.metadata ?? {}) as Record<string, unknown>;

  const updatedMetadata: Record<string, unknown> = {
    ...existingMetadata,
    smsOptIn,
  };

  if (phoneNumber) {
    // Normalize: strip whitespace and dashes, ensure "+" prefix.
    const normalized = phoneNumber.replace(/[\s\-()]/g, "");
    updatedMetadata.phoneNumber = normalized.startsWith("+") ? normalized : `+${normalized}`;
  } else {
    // Remove phone number if cleared.
    delete updatedMetadata.phoneNumber;
    updatedMetadata.smsOptIn = false;
  }

  await db
    .update(agents)
    .set({ metadata: updatedMetadata, updatedAt: new Date() })
    .where(eq(agents.id, actorId));

  revalidatePath("/settings");

  return { success: true };
}
