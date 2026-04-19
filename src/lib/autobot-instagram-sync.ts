import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

type InstagramMedia = {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  timestamp?: string;
  permalink?: string;
};

type InstagramMediaResponse = {
  data?: InstagramMedia[];
  paging?: { next?: string };
};

type InstagramAccountToken = {
  accountId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
};

const INSTAGRAM_GRAPH_API = "https://graph.instagram.com";

function parsePositiveInteger(
  input: string | undefined,
  fallback: number,
  max = 100,
): number {
  if (!input) return fallback;
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

async function getInstagramAccountToken(userId: string): Promise<InstagramAccountToken> {
  const [account] = await db
    .select({
      accountId: accounts.id,
      accessToken: accounts.access_token,
      refreshToken: accounts.refresh_token,
      expiresAt: accounts.expires_at,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "instagram")))
    .limit(1);

  if (!account?.accessToken) {
    throw new Error("No Instagram account is linked for this user.");
  }

  const expiresSoon =
    typeof account.expiresAt === "number" &&
    Number.isFinite(account.expiresAt) &&
    account.expiresAt * 1000 <= Date.now() + 60_000;

  if (!expiresSoon) {
    return {
      accountId: account.accountId,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    };
  }

  // Refresh long-lived Instagram token
  const refreshUrl = new URL(`${INSTAGRAM_GRAPH_API}/refresh_access_token`);
  refreshUrl.searchParams.set("grant_type", "ig_refresh_token");
  refreshUrl.searchParams.set("access_token", account.accessToken);

  const refreshResponse = await fetch(refreshUrl.toString(), { cache: "no-store" });

  if (!refreshResponse.ok) {
    const errorText = await refreshResponse.text();
    throw new Error(`Failed to refresh Instagram token: ${errorText.slice(0, 300)}`);
  }

  const refreshed = (await refreshResponse.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!refreshed.access_token) {
    throw new Error("Instagram token refresh did not return an access token.");
  }

  const nextExpiresAt =
    typeof refreshed.expires_in === "number"
      ? Math.floor(Date.now() / 1000) + refreshed.expires_in
      : null;

  await db
    .update(accounts)
    .set({
      access_token: refreshed.access_token,
      expires_at: nextExpiresAt,
    })
    .where(eq(accounts.id, account.accountId));

  return {
    accountId: account.accountId,
    accessToken: refreshed.access_token,
    refreshToken: account.refreshToken,
    expiresAt: nextExpiresAt,
  };
}

async function fetchInstagramJson<T>(accessToken: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Instagram API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

async function findSyncedResourceId(
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
        sql`${resources.metadata}->'externalSync'->>'provider' = 'instagram'`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function upsertInstagramMediaResource(
  userId: string,
  media: InstagramMedia,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedResourceId(userId, media.id);
  const now = new Date();
  const content = media.caption?.trim() || "";
  const name = content
    ? content.slice(0, 80) + (content.length > 80 ? "..." : "")
    : `Instagram ${media.media_type ?? "Media"} ${media.id}`;

  const metadata = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Instagram",
    externalSync: {
      provider: "instagram",
      externalId: media.id,
      mediaUrl: media.media_url ?? null,
      mediaType: media.media_type ?? null,
      permalink: media.permalink ?? null,
      timestamp: media.timestamp ?? null,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name,
        description: "Imported from Instagram",
        content,
        contentType: "text/plain",
        url: media.permalink ?? null,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name,
    type: "document",
    description: "Imported from Instagram",
    content,
    contentType: "text/plain",
    url: media.permalink ?? null,
    ownerId: userId,
    visibility: "private",
    tags: ["instagram", "media", "imported"],
    metadata,
  });
  return "created";
}

export async function syncInstagramConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const { accessToken } = await getInstagramAccountToken(userId);
  const accountId = connection.config.accountId?.trim() || "me";
  const maxResults = parsePositiveInteger(connection.config.maxResults, 25, 100);
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (connection.syncDirection === "import" || connection.syncDirection === "bidirectional") {
    const mediaUrl = new URL(`${INSTAGRAM_GRAPH_API}/${encodeURIComponent(accountId)}/media`);
    mediaUrl.searchParams.set("fields", "id,caption,media_type,media_url,timestamp,permalink");
    mediaUrl.searchParams.set("limit", String(maxResults));

    const mediaResponse = await fetchInstagramJson<InstagramMediaResponse>(
      accessToken,
      mediaUrl.toString(),
    );

    const mediaItems = Array.isArray(mediaResponse.data) ? mediaResponse.data : [];

    for (const media of mediaItems) {
      const status = await upsertInstagramMediaResource(userId, media);
      if (status === "created") imported += 1;
      else updated += 1;
    }
  }

  if (connection.syncDirection === "export" || connection.syncDirection === "bidirectional") {
    return {
      provider: "instagram",
      imported,
      updated,
      skipped,
      message: connection.syncDirection === "bidirectional"
        ? `Imported ${imported} Instagram media item${imported === 1 ? "" : "s"}. Export is not yet supported.`
        : "Instagram export is not yet supported.",
      accountLabel: "Instagram",
      externalAccountId: accountId,
    };
  }

  return {
    provider: "instagram",
    imported,
    updated,
    skipped,
    message: `Imported ${imported} Instagram media item${imported === 1 ? "" : "s"} into personal documents.`,
    accountLabel: "Instagram",
    externalAccountId: accountId,
  };
}
