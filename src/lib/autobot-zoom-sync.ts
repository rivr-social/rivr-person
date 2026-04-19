import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ZOOM_API_BASE = "https://api.zoom.us/v2";
const ZOOM_PROVIDER_KEY = "zoom";
const DEFAULT_MEETING_PAGE_SIZE = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ZoomUser = {
  id: string;
  email: string;
  display_name?: string;
  first_name?: string;
  last_name?: string;
};

type ZoomMeeting = {
  id: number;
  uuid: string;
  topic: string;
  type: number;
  start_time?: string;
  duration?: number;
  timezone?: string;
  join_url?: string;
  status?: string;
};

type ZoomMeetingsResponse = {
  page_count: number;
  page_number: number;
  page_size: number;
  total_records: number;
  meetings: ZoomMeeting[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getZoomAccessToken(userId: string): Promise<string> {
  const [account] = await db
    .select({ accessToken: accounts.access_token })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, ZOOM_PROVIDER_KEY)))
    .limit(1);

  if (!account?.accessToken) {
    throw new Error("No Zoom OAuth token found. Please reconnect Zoom first.");
  }

  return account.accessToken;
}

async function zoomApiGet<T>(
  path: string,
  accessToken: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${ZOOM_API_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Zoom API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

async function findSyncedZoomResourceId(
  ownerId: string,
  externalId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->'externalSync'->>'provider' = ${ZOOM_PROVIDER_KEY}`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function upsertZoomMeetingResource(
  userId: string,
  meeting: ZoomMeeting,
): Promise<"created" | "updated"> {
  const meetingId = String(meeting.id);
  const existingId = await findSyncedZoomResourceId(userId, meetingId);
  const now = new Date();
  const metadata: Record<string, unknown> = {
    entityType: "event",
    resourceKind: "meeting",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Zoom",
    externalSync: {
      provider: ZOOM_PROVIDER_KEY,
      externalId: meetingId,
      uuid: meeting.uuid,
      meetingType: meeting.type,
      joinUrl: meeting.join_url ?? null,
      startTime: meeting.start_time ?? null,
      duration: meeting.duration ?? null,
      timezone: meeting.timezone ?? null,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: meeting.topic || `Zoom Meeting ${meetingId}`,
        description: `Zoom meeting${meeting.start_time ? ` at ${meeting.start_time}` : ""}`,
        url: meeting.join_url ?? null,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: meeting.topic || `Zoom Meeting ${meetingId}`,
    type: "event",
    description: `Zoom meeting${meeting.start_time ? ` at ${meeting.start_time}` : ""}`,
    content: "",
    contentType: "text/plain",
    url: meeting.join_url ?? null,
    ownerId: userId,
    visibility: "private",
    tags: ["zoom", "meeting", "imported"],
    metadata,
  });
  return "created";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function testZoomConnection(
  userId: string,
): Promise<{ valid: boolean; label?: string; error?: string }> {
  try {
    const accessToken = await getZoomAccessToken(userId);
    const user = await zoomApiGet<ZoomUser>("/users/me", accessToken);
    return { valid: true, label: user.display_name || user.email };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Failed to test Zoom connection",
    };
  }
}

export async function syncZoomConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const accessToken = await getZoomAccessToken(userId);

  const user = await zoomApiGet<ZoomUser>("/users/me", accessToken);

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (
    connection.syncDirection === "import" ||
    connection.syncDirection === "bidirectional"
  ) {
    const meetingsResult = await zoomApiGet<ZoomMeetingsResponse>(
      "/users/me/meetings",
      accessToken,
      {
        page_size: String(DEFAULT_MEETING_PAGE_SIZE),
        type: "scheduled",
      },
    );

    for (const meeting of meetingsResult.meetings ?? []) {
      if (!meeting.id) {
        skipped += 1;
        continue;
      }
      const status = await upsertZoomMeetingResource(userId, meeting);
      if (status === "created") imported += 1;
      else updated += 1;
    }
  }

  return {
    provider: "zoom",
    imported,
    updated,
    skipped,
    message: `Synced ${imported + updated} Zoom meeting${imported + updated === 1 ? "" : "s"}.`,
    accountLabel: user.display_name || user.email,
    externalAccountId: user.id,
  };
}
