import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

type FacebookPost = {
  id: string;
  message?: string;
  created_time?: string;
  permalink_url?: string;
};

type FacebookPostsResponse = {
  data?: FacebookPost[];
  paging?: { next?: string };
};

type FacebookAccountToken = {
  accountId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
};

const FACEBOOK_GRAPH_API = "https://graph.facebook.com/v19.0";

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

async function getFacebookAccountToken(userId: string): Promise<FacebookAccountToken> {
  const [account] = await db
    .select({
      accountId: accounts.id,
      accessToken: accounts.access_token,
      refreshToken: accounts.refresh_token,
      expiresAt: accounts.expires_at,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "facebook")))
    .limit(1);

  if (!account?.accessToken) {
    throw new Error("No Facebook account is linked for this user.");
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

  // Facebook long-lived tokens last ~60 days; refresh by exchanging again
  const clientId = process.env.FACEBOOK_CLIENT_ID?.trim();
  const clientSecret = process.env.FACEBOOK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Facebook OAuth is not configured on this instance.");
  }

  const refreshUrl = new URL(`${FACEBOOK_GRAPH_API}/oauth/access_token`);
  refreshUrl.searchParams.set("grant_type", "fb_exchange_token");
  refreshUrl.searchParams.set("client_id", clientId);
  refreshUrl.searchParams.set("client_secret", clientSecret);
  refreshUrl.searchParams.set("fb_exchange_token", account.accessToken);

  const refreshResponse = await fetch(refreshUrl.toString(), { cache: "no-store" });

  if (!refreshResponse.ok) {
    const errorText = await refreshResponse.text();
    throw new Error(`Failed to refresh Facebook token: ${errorText.slice(0, 300)}`);
  }

  const refreshed = (await refreshResponse.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!refreshed.access_token) {
    throw new Error("Facebook token refresh did not return an access token.");
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

async function fetchFacebookJson<T>(accessToken: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Facebook API error (${response.status}): ${errorText.slice(0, 300)}`);
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
        sql`${resources.metadata}->'externalSync'->>'provider' = 'facebook'`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function upsertFacebookPostResource(
  userId: string,
  post: FacebookPost,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedResourceId(userId, post.id);
  const now = new Date();
  const content = post.message?.trim() || "";
  const name = content
    ? content.slice(0, 80) + (content.length > 80 ? "..." : "")
    : `Facebook Post ${post.id}`;

  const metadata = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Facebook",
    externalSync: {
      provider: "facebook",
      externalId: post.id,
      permalinkUrl: post.permalink_url ?? null,
      createdTime: post.created_time ?? null,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name,
        description: "Imported from Facebook",
        content,
        contentType: "text/plain",
        url: post.permalink_url ?? null,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name,
    type: "document",
    description: "Imported from Facebook",
    content,
    contentType: "text/plain",
    url: post.permalink_url ?? null,
    ownerId: userId,
    visibility: "private",
    tags: ["facebook", "posts", "imported"],
    metadata,
  });
  return "created";
}

export async function syncFacebookConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const { accessToken } = await getFacebookAccountToken(userId);
  const pageId = connection.config.pageId?.trim() || "me";
  const maxResults = parsePositiveInteger(connection.config.maxResults, 25, 100);
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (connection.syncDirection === "import" || connection.syncDirection === "bidirectional") {
    const postsUrl = new URL(`${FACEBOOK_GRAPH_API}/${encodeURIComponent(pageId)}/posts`);
    postsUrl.searchParams.set("fields", "message,created_time,id,permalink_url");
    postsUrl.searchParams.set("limit", String(maxResults));

    const postsResponse = await fetchFacebookJson<FacebookPostsResponse>(
      accessToken,
      postsUrl.toString(),
    );

    const posts = Array.isArray(postsResponse.data) ? postsResponse.data : [];

    for (const post of posts) {
      if (!post.message?.trim()) {
        skipped += 1;
        continue;
      }

      const status = await upsertFacebookPostResource(userId, post);
      if (status === "created") imported += 1;
      else updated += 1;
    }
  }

  if (connection.syncDirection === "export" || connection.syncDirection === "bidirectional") {
    return {
      provider: "facebook",
      imported,
      updated,
      skipped,
      message: connection.syncDirection === "bidirectional"
        ? `Imported ${imported} Facebook post${imported === 1 ? "" : "s"}. Export is not yet supported.`
        : "Facebook export is not yet supported.",
      accountLabel: "Facebook",
      externalAccountId: pageId,
    };
  }

  return {
    provider: "facebook",
    imported,
    updated,
    skipped,
    message: `Imported ${imported} Facebook post${imported === 1 ? "" : "s"} into personal documents.`,
    accountLabel: "Facebook",
    externalAccountId: pageId,
  };
}
