import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DROPBOX_API_BASE = "https://api.dropboxapi.com/2";
const DROPBOX_PROVIDER_KEY = "dropbox";
const DEFAULT_FILE_LIMIT = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DropboxAccount = {
  account_id: string;
  email: string;
  name: { display_name: string };
};

type DropboxEntry = {
  ".tag": "file" | "folder" | "deleted";
  id: string;
  name: string;
  path_display: string;
  client_modified?: string;
  server_modified?: string;
  size?: number;
};

type DropboxListFolderResult = {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getDropboxAccessToken(userId: string): Promise<string> {
  const [account] = await db
    .select({ accessToken: accounts.access_token })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, DROPBOX_PROVIDER_KEY)))
    .limit(1);

  if (!account?.accessToken) {
    throw new Error("No Dropbox OAuth token found. Please reconnect Dropbox first.");
  }

  return account.accessToken;
}

async function dropboxApiPost<T>(
  path: string,
  accessToken: string,
  body: unknown,
): Promise<T> {
  const response = await fetch(`${DROPBOX_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dropbox API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

async function findSyncedDropboxResourceId(
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
        sql`${resources.metadata}->'externalSync'->>'provider' = ${DROPBOX_PROVIDER_KEY}`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function upsertDropboxFileResource(
  userId: string,
  entry: DropboxEntry,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedDropboxResourceId(userId, entry.id);
  const now = new Date();
  const metadata: Record<string, unknown> = {
    entityType: "document",
    resourceKind: entry[".tag"],
    personalOwnerId: userId,
    createdBy: userId,
    category: "Dropbox",
    externalSync: {
      provider: DROPBOX_PROVIDER_KEY,
      externalId: entry.id,
      pathDisplay: entry.path_display,
      size: entry.size ?? 0,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: entry.name,
        description: `Dropbox: ${entry.path_display}`,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: entry.name,
    type: "document",
    description: `Dropbox: ${entry.path_display}`,
    content: "",
    contentType: "text/plain",
    ownerId: userId,
    visibility: "private",
    tags: ["dropbox", entry[".tag"], "imported"],
    metadata,
  });
  return "created";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function testDropboxConnection(
  userId: string,
): Promise<{ valid: boolean; label?: string; error?: string }> {
  try {
    const accessToken = await getDropboxAccessToken(userId);
    const account = await dropboxApiPost<DropboxAccount>(
      "/users/get_current_account",
      accessToken,
      null,
    );
    return { valid: true, label: account.name?.display_name || account.email };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Failed to test Dropbox connection",
    };
  }
}

export async function syncDropboxConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const accessToken = await getDropboxAccessToken(userId);

  const account = await dropboxApiPost<DropboxAccount>(
    "/users/get_current_account",
    accessToken,
    null,
  );

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (
    connection.syncDirection === "import" ||
    connection.syncDirection === "bidirectional"
  ) {
    const rootPath = connection.config.rootPath?.trim() || "";
    const result = await dropboxApiPost<DropboxListFolderResult>(
      "/files/list_folder",
      accessToken,
      {
        path: rootPath,
        recursive: false,
        limit: DEFAULT_FILE_LIMIT,
        include_deleted: false,
      },
    );

    for (const entry of result.entries) {
      if (!entry.id || !entry.name || entry[".tag"] === "deleted") {
        skipped += 1;
        continue;
      }
      const status = await upsertDropboxFileResource(userId, entry);
      if (status === "created") imported += 1;
      else updated += 1;
    }
  }

  return {
    provider: "dropbox",
    imported,
    updated,
    skipped,
    message: `Synced ${imported + updated} Dropbox item${imported + updated === 1 ? "" : "s"}.`,
    accountLabel: account.name?.display_name || account.email,
    externalAccountId: account.account_id,
  };
}
