import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_PROVIDER_KEY = "slack";
const DEFAULT_CHANNEL_LIMIT = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SlackChannel = {
  id: string;
  name: string;
  is_channel: boolean;
  is_group: boolean;
  is_private: boolean;
  purpose?: { value?: string };
  topic?: { value?: string };
  num_members?: number;
};

type SlackChannelsResponse = {
  ok: boolean;
  channels?: SlackChannel[];
  error?: string;
};

type SlackAuthTestResponse = {
  ok: boolean;
  user_id?: string;
  user?: string;
  team_id?: string;
  team?: string;
  error?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getSlackAccessToken(userId: string): Promise<string> {
  const [account] = await db
    .select({ accessToken: accounts.access_token })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, SLACK_PROVIDER_KEY)))
    .limit(1);

  if (!account?.accessToken) {
    throw new Error("No Slack OAuth token found. Please reconnect Slack first.");
  }

  return account.accessToken;
}

async function slackApiGet<T>(
  endpoint: string,
  accessToken: string,
  params?: Record<string, string>,
): Promise<T> {
  const url = new URL(`${SLACK_API_BASE}/${endpoint}`);
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
    throw new Error(`Slack API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

async function findSyncedSlackResourceId(
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
        sql`${resources.metadata}->'externalSync'->>'provider' = ${SLACK_PROVIDER_KEY}`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function upsertSlackChannelResource(
  userId: string,
  channel: SlackChannel,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedSlackResourceId(userId, channel.id);
  const now = new Date();
  const metadata: Record<string, unknown> = {
    entityType: "document",
    resourceKind: "channel",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Slack",
    externalSync: {
      provider: SLACK_PROVIDER_KEY,
      externalId: channel.id,
      channelName: channel.name,
      isPrivate: channel.is_private,
      numMembers: channel.num_members ?? 0,
      importedAt: now.toISOString(),
    },
  };

  const description = [
    channel.purpose?.value,
    channel.topic?.value,
  ]
    .filter(Boolean)
    .join(" | ") || "Imported Slack channel";

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: `#${channel.name}`,
        description,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: `#${channel.name}`,
    type: "document",
    description,
    content: "",
    contentType: "text/plain",
    ownerId: userId,
    visibility: "private",
    tags: ["slack", "channel", "imported"],
    metadata,
  });
  return "created";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function testSlackConnection(
  userId: string,
): Promise<{ valid: boolean; label?: string; error?: string }> {
  try {
    const accessToken = await getSlackAccessToken(userId);
    const result = await slackApiGet<SlackAuthTestResponse>("auth.test", accessToken);
    if (!result.ok) {
      return { valid: false, error: result.error || "Slack auth test failed" };
    }
    return { valid: true, label: result.team || result.user };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Failed to test Slack connection",
    };
  }
}

export async function syncSlackConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const accessToken = await getSlackAccessToken(userId);

  const authResult = await slackApiGet<SlackAuthTestResponse>("auth.test", accessToken);
  if (!authResult.ok) {
    throw new Error(`Slack auth test failed: ${authResult.error || "unknown error"}`);
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (
    connection.syncDirection === "import" ||
    connection.syncDirection === "bidirectional"
  ) {
    const channelResult = await slackApiGet<SlackChannelsResponse>(
      "conversations.list",
      accessToken,
      {
        types: "public_channel,private_channel",
        limit: String(DEFAULT_CHANNEL_LIMIT),
        exclude_archived: "true",
      },
    );

    if (!channelResult.ok) {
      throw new Error(`Failed to list Slack channels: ${channelResult.error || "unknown error"}`);
    }

    for (const channel of channelResult.channels ?? []) {
      if (!channel.id || !channel.name) {
        skipped += 1;
        continue;
      }
      const status = await upsertSlackChannelResource(userId, channel);
      if (status === "created") imported += 1;
      else updated += 1;
    }
  }

  return {
    provider: "slack",
    imported,
    updated,
    skipped,
    message: `Synced ${imported + updated} Slack channel${imported + updated === 1 ? "" : "s"}.`,
    accountLabel: authResult.team || authResult.user,
    externalAccountId: authResult.team_id || authResult.user_id,
  };
}
