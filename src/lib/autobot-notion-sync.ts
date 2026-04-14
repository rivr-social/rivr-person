import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, resources } from "@/db/schema";
import type { Resource } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import { getResourcesByOwnerAndType } from "@/lib/queries/resources";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

type NotionSearchPage = {
  object: string;
  id: string;
  url?: string;
  public_url?: string | null;
  last_edited_time?: string;
  properties?: Record<string, unknown>;
};

type NotionSearchResponse = {
  results?: NotionSearchPage[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type NotionMarkdownResponse = {
  id: string;
  markdown: string;
  truncated?: boolean;
  unknown_block_ids?: string[];
};

type NotionTokenRecord = {
  accountId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
};

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2026-03-11";

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

function notionBasicAuth(): string {
  const clientId = process.env.NOTION_CLIENT_ID?.trim();
  const clientSecret = process.env.NOTION_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Notion OAuth is not configured on this instance.");
  }
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function getNotionAccountToken(userId: string): Promise<NotionTokenRecord> {
  const [account] = await db
    .select({
      accountId: accounts.id,
      accessToken: accounts.access_token,
      refreshToken: accounts.refresh_token,
      expiresAt: accounts.expires_at,
    })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, "notion")))
    .limit(1);

  if (!account?.accessToken) {
    throw new Error("No Notion account is linked for this user.");
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

  if (!account.refreshToken) {
    throw new Error("Notion access expired and no refresh token is available. Reconnect Notion.");
  }

  const response = await fetch(`${NOTION_API_BASE}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${notionBasicAuth()}`,
      "Content-Type": "application/json",
      "Notion-Version": NOTION_API_VERSION,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Notion token: ${errorText.slice(0, 300)}`);
  }

  const refreshed = (await response.json()) as {
    access_token?: string;
    refresh_token?: string | null;
    expires_in?: number;
  };

  if (!refreshed.access_token) {
    throw new Error("Notion token refresh did not return an access token.");
  }

  const nextExpiresAt =
    typeof refreshed.expires_in === "number"
      ? Math.floor(Date.now() / 1000) + refreshed.expires_in
      : null;

  await db
    .update(accounts)
    .set({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? account.refreshToken,
      expires_at: nextExpiresAt,
    })
    .where(eq(accounts.id, account.accountId));

  return {
    accountId: account.accountId,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? account.refreshToken,
    expiresAt: nextExpiresAt,
  };
}

async function notionJson<T>(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_API_VERSION,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Notion API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

function extractNotionTitle(page: NotionSearchPage): string {
  const properties = page.properties ?? {};
  for (const property of Object.values(properties)) {
    if (
      property &&
      typeof property === "object" &&
      !Array.isArray(property) &&
      "type" in property &&
      (property as { type?: unknown }).type === "title" &&
      Array.isArray((property as { title?: unknown[] }).title)
    ) {
      const title = (property as unknown as { title: Array<{ plain_text?: string }> }).title
        .map((part) => part.plain_text ?? "")
        .join("")
        .trim();
      if (title) return title;
    }
  }
  return "Untitled Notion Page";
}

function extractExternalSync(
  resource: Resource,
): { provider?: string; externalId?: string; workspaceId?: string } {
  const metadata =
    resource.metadata && typeof resource.metadata === "object" && !Array.isArray(resource.metadata)
      ? (resource.metadata as Record<string, unknown>)
      : {};
  const externalSync =
    metadata.externalSync &&
    typeof metadata.externalSync === "object" &&
    !Array.isArray(metadata.externalSync)
      ? (metadata.externalSync as Record<string, unknown>)
      : {};

  return {
    provider: typeof externalSync.provider === "string" ? externalSync.provider : undefined,
    externalId: typeof externalSync.externalId === "string" ? externalSync.externalId : undefined,
    workspaceId: typeof externalSync.workspaceId === "string" ? externalSync.workspaceId : undefined,
  };
}

function mergeExternalSyncMetadata(
  resource: Resource,
  externalSyncPatch: Record<string, unknown>,
  basePatch: Record<string, unknown> = {},
): Record<string, unknown> {
  const metadata =
    resource.metadata && typeof resource.metadata === "object" && !Array.isArray(resource.metadata)
      ? (resource.metadata as Record<string, unknown>)
      : {};
  const currentExternalSync =
    metadata.externalSync &&
    typeof metadata.externalSync === "object" &&
    !Array.isArray(metadata.externalSync)
      ? (metadata.externalSync as Record<string, unknown>)
      : {};

  return {
    ...metadata,
    ...basePatch,
    externalSync: {
      ...currentExternalSync,
      ...externalSyncPatch,
    },
  };
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
        sql`${resources.metadata}->'externalSync'->>'provider' = 'notion'`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function upsertNotionDocumentResource(
  userId: string,
  workspaceId: string,
  page: NotionSearchPage,
  markdown: string,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedResourceId(userId, page.id);
  const title = extractNotionTitle(page);
  const now = new Date();
  const metadata = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Notion",
    externalSync: {
      provider: "notion",
      externalId: page.id,
      workspaceId,
      webViewLink: page.url ?? page.public_url ?? null,
      modifiedTime: page.last_edited_time ?? null,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: title,
        description: "Imported from Notion",
        content: markdown,
        contentType: "text/markdown",
        url: page.url ?? page.public_url ?? null,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: title,
    type: "document",
    description: "Imported from Notion",
    content: markdown,
    contentType: "text/markdown",
    url: page.url ?? page.public_url ?? null,
    ownerId: userId,
    visibility: "private",
    tags: ["notion", "docs", "imported"],
    metadata,
  });
  return "created";
}

async function createNotionPage(
  accessToken: string,
  resource: Resource,
  parentPageId: string | null,
): Promise<{ id: string; url?: string }> {
  return notionJson<{ id: string; url?: string }>(accessToken, "/pages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...(parentPageId
        ? { parent: { page_id: parentPageId } }
        : { parent: { workspace: true } }),
      properties: {
        title: [
          {
            text: {
              content: resource.name,
            },
          },
        ],
      },
      children: [],
    }),
  });
}

async function replaceNotionMarkdown(
  accessToken: string,
  pageId: string,
  content: string,
): Promise<void> {
  await notionJson<NotionMarkdownResponse>(accessToken, `/pages/${encodeURIComponent(pageId)}/markdown`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "replace_content",
      replace_content: {
        new_str: content,
      },
    }),
  });
}

async function exportRivrDocsToNotion(
  userId: string,
  workspaceId: string,
  connection: AutobotConnection,
  accessToken: string,
): Promise<Pick<ConnectorSyncResult, "imported" | "updated" | "skipped">> {
  const docs = await getResourcesByOwnerAndType(userId, "document", 200);
  const rootPageId = connection.config.rootPageId?.trim() || null;
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const docResource of docs) {
    const metadata =
      docResource.metadata && typeof docResource.metadata === "object" && !Array.isArray(docResource.metadata)
        ? (docResource.metadata as Record<string, unknown>)
        : {};
    if (metadata.resourceSubtype === "event-transcript") {
      skipped += 1;
      continue;
    }

    const externalSync = extractExternalSync(docResource);
    if (externalSync.provider && externalSync.provider !== "notion") {
      skipped += 1;
      continue;
    }

    const content = (docResource.content ?? "").trim();
    if (!content) {
      skipped += 1;
      continue;
    }

    if (externalSync.externalId) {
      await replaceNotionMarkdown(accessToken, externalSync.externalId, content);
      await db
        .update(resources)
        .set({
          metadata: mergeExternalSyncMetadata(
            docResource,
            {
              provider: "notion",
              externalId: externalSync.externalId,
              workspaceId,
              exportedAt: new Date().toISOString(),
            },
            {
              personalOwnerId: userId,
              entityType: "document",
              resourceKind: "document",
            },
          ),
          updatedAt: new Date(),
        })
        .where(eq(resources.id, docResource.id));
      updated += 1;
      continue;
    }

    const page = await createNotionPage(accessToken, docResource, rootPageId);
    await replaceNotionMarkdown(accessToken, page.id, content);
    await db
      .update(resources)
      .set({
        url: page.url ?? docResource.url,
        metadata: mergeExternalSyncMetadata(
          docResource,
          {
            provider: "notion",
            externalId: page.id,
            workspaceId,
            exportedAt: new Date().toISOString(),
          },
          {
            personalOwnerId: userId,
            entityType: "document",
            resourceKind: "document",
            category: "Notion",
          },
        ),
        updatedAt: new Date(),
      })
      .where(eq(resources.id, docResource.id));
    imported += 1;
  }

  return { imported, updated, skipped };
}

export async function syncNotionConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const token = await getNotionAccountToken(userId);
  const pageSize = parsePositiveInteger(connection.config.maxResults, 20, 50);
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (connection.syncDirection === "import" || connection.syncDirection === "bidirectional") {
    const searchResponse = await notionJson<NotionSearchResponse>(token.accessToken, "/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: connection.config.query?.trim() || undefined,
        filter: {
          property: "object",
          value: "page",
        },
        sort: {
          direction: "descending",
          timestamp: "last_edited_time",
        },
        page_size: pageSize,
      }),
    });

    const pages = Array.isArray(searchResponse.results) ? searchResponse.results : [];
    for (const page of pages) {
      const markdownResponse = await notionJson<NotionMarkdownResponse>(
        token.accessToken,
        `/pages/${encodeURIComponent(page.id)}/markdown`,
      );
      const markdown = (markdownResponse.markdown ?? "").trim();
      if (!markdown) {
        skipped += 1;
        continue;
      }

      const status = await upsertNotionDocumentResource(
        userId,
        connection.config.workspaceId?.trim() || token.accountId,
        page,
        markdown,
      );
      if (status === "created") imported += 1;
      else updated += 1;
    }
  }

  if (connection.syncDirection === "export" || connection.syncDirection === "bidirectional") {
    const exportCounts = await exportRivrDocsToNotion(
      userId,
      connection.config.workspaceId?.trim() || token.accountId,
      connection,
      token.accessToken,
    );
    imported += exportCounts.imported;
    updated += exportCounts.updated;
    skipped += exportCounts.skipped;
  }

  return {
    provider: "notion",
    imported,
    updated,
    skipped,
    message:
      connection.syncDirection === "import"
        ? "Imported Notion pages into Rivr personal documents."
        : connection.syncDirection === "export"
          ? "Exported Rivr personal documents into Notion."
          : "Synced Notion pages and Rivr personal documents in both directions.",
    accountLabel: connection.accountLabel ?? "Notion",
    externalAccountId: connection.config.workspaceId?.trim() || undefined,
  };
}
