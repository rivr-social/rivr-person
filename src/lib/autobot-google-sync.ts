import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, resources } from "@/db/schema";
import type { Resource } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import { getResourcesByOwnerAndType } from "@/lib/queries/resources";

type GoogleDriveFile = {
  id: string;
  name: string;
  modifiedTime?: string;
  webViewLink?: string;
};

type GoogleCalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  updated?: string;
};

type GoogleAccountToken = {
  accountId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
};

export type ConnectorSyncResult = {
  provider: AutobotConnection["provider"];
  imported: number;
  updated: number;
  skipped: number;
  message: string;
  accountLabel?: string;
  externalAccountId?: string;
};

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const GOOGLE_DOCS_API = "https://docs.googleapis.com/v1/documents";
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
const GOOGLE_CONNECTOR_PROVIDER = "google_workspace";

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

function normalizeDocContent(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

function toIsoDateTime(raw: string | undefined, endOfDay = false): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw}T${endOfDay ? "23:59:59.000" : "00:00:00.000"}Z`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function formatEventDate(isoString: string): string {
  return isoString.slice(0, 10);
}

function formatEventTime(isoString: string): string {
  return isoString.slice(11, 16);
}

async function getGoogleAccountToken(userId: string): Promise<GoogleAccountToken> {
  const googleAccounts = await db
    .select({
      accountId: accounts.id,
      accessToken: accounts.access_token,
      refreshToken: accounts.refresh_token,
      expiresAt: accounts.expires_at,
      provider: accounts.provider,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.userId, userId),
        or(
          eq(accounts.provider, GOOGLE_CONNECTOR_PROVIDER),
          eq(accounts.provider, "google"),
        ),
      ),
    )
    .limit(2);

  const account =
    googleAccounts.find((entry) => entry.provider === GOOGLE_CONNECTOR_PROVIDER) ??
    googleAccounts.find((entry) => entry.provider === "google");

  if (!account?.accessToken) {
    throw new Error("No Google account is linked for this user.");
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
    throw new Error("Google access expired and no refresh token is available. Reconnect Google.");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error("Google OAuth is not configured on this instance.");
  }

  const refreshResponse = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
    }),
  });

  if (!refreshResponse.ok) {
    const errorText = await refreshResponse.text();
    throw new Error(`Failed to refresh Google token: ${errorText.slice(0, 300)}`);
  }

  const refreshed = (await refreshResponse.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  if (!refreshed.access_token) {
    throw new Error("Google token refresh did not return an access token.");
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
      refresh_token: refreshed.refresh_token ?? account.refreshToken,
    })
    .where(eq(accounts.id, account.accountId));

  return {
    accountId: account.accountId,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? account.refreshToken,
    expiresAt: nextExpiresAt,
  };
}

async function fetchGoogleJson<T>(accessToken: string, url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

async function fetchGoogleJsonWithInit<T>(
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

async function fetchGoogleText(accessToken: string, url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return response.text();
}

async function findSyncedResourceId(
  ownerId: string,
  provider: "google_docs" | "google_calendar",
  externalId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->'externalSync'->>'provider' = ${provider}`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function upsertGoogleDocumentResource(
  userId: string,
  file: GoogleDriveFile,
  content: string,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedResourceId(userId, "google_docs", file.id);
  const now = new Date();
  const metadata = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Google Docs",
    externalSync: {
      provider: "google_docs",
      externalId: file.id,
      webViewLink: file.webViewLink ?? null,
      modifiedTime: file.modifiedTime ?? null,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: file.name,
        description: "Imported from Google Docs",
        content,
        contentType: "text/plain",
        url: file.webViewLink ?? null,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: file.name,
    type: "document",
    description: "Imported from Google Docs",
    content,
    contentType: "text/plain",
    url: file.webViewLink ?? null,
    ownerId: userId,
    visibility: "private",
    tags: ["google", "docs", "imported"],
    metadata,
  });
  return "created";
}

async function upsertGoogleCalendarEventResource(
  userId: string,
  calendarId: string,
  event: GoogleCalendarEvent,
): Promise<"created" | "updated" | "skipped"> {
  const startIso = toIsoDateTime(event.start?.dateTime ?? event.start?.date);
  if (!startIso) return "skipped";

  const endIso =
    toIsoDateTime(event.end?.dateTime ?? event.end?.date, true) ?? startIso;
  const eventDate = formatEventDate(startIso);
  const eventTime = formatEventTime(startIso);
  const existingId = await findSyncedResourceId(userId, "google_calendar", event.id);
  const now = new Date();
  const metadata = {
    entityType: "event",
    resourceKind: "event",
    date: eventDate,
    time: eventTime,
    startDate: startIso,
    endDate: endIso,
    timeframe: {
      start: startIso,
      end: endIso,
    },
    location: event.location ?? "",
    eventType: "online",
    organizerId: userId,
    creatorId: userId,
    isGlobal: false,
    externalSync: {
      provider: "google_calendar",
      externalId: event.id,
      calendarId,
      htmlLink: event.htmlLink ?? null,
      status: event.status ?? null,
      updated: event.updated ?? null,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: event.summary?.trim() || "Google Calendar Event",
        description: event.description?.trim() || "Imported from Google Calendar",
        content: event.description?.trim() || "",
        visibility: "private",
        tags: ["google", "calendar", "imported"],
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: event.summary?.trim() || "Google Calendar Event",
    type: "event",
    description: event.description?.trim() || "Imported from Google Calendar",
    content: event.description?.trim() || "",
    ownerId: userId,
    visibility: "private",
    tags: ["google", "calendar", "imported"],
    metadata,
  });
  return "created";
}

function extractExternalSync(
  resource: Resource,
): { provider?: string; externalId?: string; calendarId?: string } {
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
    calendarId: typeof externalSync.calendarId === "string" ? externalSync.calendarId : undefined,
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

async function createGoogleDocFromResource(
  accessToken: string,
  resource: Resource,
  folderId: string | null,
): Promise<{ id: string; webViewLink?: string }> {
  const doc = await fetchGoogleJsonWithInit<{ documentId: string }>(
    accessToken,
    GOOGLE_DOCS_API,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: resource.name,
      }),
    },
  );

  const content = normalizeDocContent(resource.content ?? "");
  if (content) {
    await fetchGoogleJsonWithInit(
      accessToken,
      `${GOOGLE_DOCS_API}/${encodeURIComponent(doc.documentId)}:batchUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: content,
              },
            },
          ],
        }),
      },
    );
  }

  if (folderId) {
    await fetchGoogleJsonWithInit(
      accessToken,
      `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(doc.documentId)}?addParents=${encodeURIComponent(folderId)}&fields=id,webViewLink`,
      {
        method: "PATCH",
      },
    );
  }

  return fetchGoogleJsonWithInit<{ id: string; webViewLink?: string }>(
    accessToken,
    `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(doc.documentId)}?fields=id,webViewLink`,
  );
}

async function replaceGoogleDocContent(
  accessToken: string,
  documentId: string,
  resource: Resource,
): Promise<void> {
  const doc = await fetchGoogleJsonWithInit<{ body?: { content?: Array<{ endIndex?: number }> } }>(
    accessToken,
    `${GOOGLE_DOCS_API}/${encodeURIComponent(documentId)}`,
  );

  const endIndex =
    Array.isArray(doc.body?.content) && doc.body?.content.length
      ? doc.body.content[doc.body.content.length - 1]?.endIndex ?? 1
      : 1;

  const requests: Array<Record<string, unknown>> = [];
  if (typeof endIndex === "number" && endIndex > 1) {
    requests.push({
      deleteContentRange: {
        range: {
          startIndex: 1,
          endIndex: endIndex - 1,
        },
      },
    });
  }

  const content = normalizeDocContent(resource.content ?? "");
  if (content) {
    requests.push({
      insertText: {
        location: { index: 1 },
        text: content,
      },
    });
  }

  requests.push({
    updateDocumentStyle: {
      documentStyle: {
        title: resource.name,
      },
      fields: "title",
    },
  });

  if (requests.length === 0) return;

  await fetchGoogleJsonWithInit(
    accessToken,
    `${GOOGLE_DOCS_API}/${encodeURIComponent(documentId)}:batchUpdate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    },
  );
}

async function exportRivrDocsToGoogle(
  userId: string,
  connection: AutobotConnection,
  accessToken: string,
): Promise<Pick<ConnectorSyncResult, "imported" | "updated" | "skipped">> {
  const docs = await getResourcesByOwnerAndType(userId, "document", 200);
  const folderId = connection.config.folderId?.trim() || null;
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
    if (externalSync.provider && externalSync.provider !== "google_docs") {
      skipped += 1;
      continue;
    }

    if (externalSync.externalId) {
      await replaceGoogleDocContent(accessToken, externalSync.externalId, docResource);
      await db
        .update(resources)
        .set({
          url: docResource.url,
          metadata: mergeExternalSyncMetadata(docResource, {
            provider: "google_docs",
            externalId: externalSync.externalId,
            exportedAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        })
        .where(eq(resources.id, docResource.id));
      updated += 1;
      continue;
    }

    const created = await createGoogleDocFromResource(accessToken, docResource, folderId);
    await db
      .update(resources)
      .set({
        url: created.webViewLink ?? docResource.url,
        metadata: mergeExternalSyncMetadata(
          docResource,
          {
            provider: "google_docs",
            externalId: created.id,
            webViewLink: created.webViewLink ?? null,
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
    imported += 1;
  }

  return { imported, updated, skipped };
}

async function createGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  resource: Resource,
): Promise<{ id: string; htmlLink?: string }> {
  const metadata =
    resource.metadata && typeof resource.metadata === "object" && !Array.isArray(resource.metadata)
      ? (resource.metadata as Record<string, unknown>)
      : {};
  const start =
    typeof metadata.startDate === "string"
      ? metadata.startDate
      : typeof metadata.date === "string"
        ? `${metadata.date}T${typeof metadata.time === "string" ? metadata.time : "09:00"}:00.000Z`
        : null;
  const end =
    typeof metadata.endDate === "string"
      ? metadata.endDate
      : start
        ? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString()
        : null;
  if (!start || !end) {
    throw new Error(`Event ${resource.id} is missing a start/end date.`);
  }

  return fetchGoogleJsonWithInit<{ id: string; htmlLink?: string }>(
    accessToken,
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: resource.name,
        description: resource.description ?? resource.content ?? "",
        location: typeof metadata.location === "string" ? metadata.location : "",
        start: { dateTime: start },
        end: { dateTime: end },
      }),
    },
  );
}

async function updateGoogleCalendarEvent(
  accessToken: string,
  calendarId: string,
  eventId: string,
  resource: Resource,
): Promise<{ id: string; htmlLink?: string }> {
  const metadata =
    resource.metadata && typeof resource.metadata === "object" && !Array.isArray(resource.metadata)
      ? (resource.metadata as Record<string, unknown>)
      : {};
  const start =
    typeof metadata.startDate === "string"
      ? metadata.startDate
      : typeof metadata.date === "string"
        ? `${metadata.date}T${typeof metadata.time === "string" ? metadata.time : "09:00"}:00.000Z`
        : null;
  const end =
    typeof metadata.endDate === "string"
      ? metadata.endDate
      : start
        ? new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString()
        : null;
  if (!start || !end) {
    throw new Error(`Event ${resource.id} is missing a start/end date.`);
  }

  return fetchGoogleJsonWithInit<{ id: string; htmlLink?: string }>(
    accessToken,
    `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: resource.name,
        description: resource.description ?? resource.content ?? "",
        location: typeof metadata.location === "string" ? metadata.location : "",
        start: { dateTime: start },
        end: { dateTime: end },
      }),
    },
  );
}

async function exportRivrEventsToGoogle(
  userId: string,
  connection: AutobotConnection,
  accessToken: string,
): Promise<Pick<ConnectorSyncResult, "imported" | "updated" | "skipped">> {
  const eventResources = await getResourcesByOwnerAndType(userId, "event", 200);
  const calendarId = connection.config.calendarId?.trim() || "primary";
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const eventResource of eventResources) {
    const externalSync = extractExternalSync(eventResource);
    if (externalSync.provider && externalSync.provider !== "google_calendar") {
      skipped += 1;
      continue;
    }

    if (externalSync.externalId) {
      const updatedEvent = await updateGoogleCalendarEvent(
        accessToken,
        externalSync.calendarId ?? calendarId,
        externalSync.externalId,
        eventResource,
      );
      await db
        .update(resources)
        .set({
          metadata: mergeExternalSyncMetadata(
            eventResource,
            {
              provider: "google_calendar",
              externalId: updatedEvent.id,
              calendarId: externalSync.calendarId ?? calendarId,
              htmlLink: updatedEvent.htmlLink ?? null,
              exportedAt: new Date().toISOString(),
            },
            {
              entityType: "event",
              resourceKind: "event",
            },
          ),
          updatedAt: new Date(),
        })
        .where(eq(resources.id, eventResource.id));
      updated += 1;
      continue;
    }

    const createdEvent = await createGoogleCalendarEvent(accessToken, calendarId, eventResource);
    await db
      .update(resources)
      .set({
        metadata: mergeExternalSyncMetadata(
          eventResource,
          {
            provider: "google_calendar",
            externalId: createdEvent.id,
            calendarId,
            htmlLink: createdEvent.htmlLink ?? null,
            exportedAt: new Date().toISOString(),
          },
          {
            entityType: "event",
            resourceKind: "event",
          },
        ),
        updatedAt: new Date(),
      })
      .where(eq(resources.id, eventResource.id));
    imported += 1;
  }

  return { imported, updated, skipped };
}

export async function syncGoogleDocsConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const { accessToken } = await getGoogleAccountToken(userId);
  const folderId = connection.config.folderId?.trim() || null;
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let importCount = 0;

  if (connection.syncDirection === "import" || connection.syncDirection === "bidirectional") {
  const pageSize = parsePositiveInteger(connection.config.maxResults, 20, 50);
  const queryParts = [
    `mimeType='${GOOGLE_DOC_MIME_TYPE}'`,
    "trashed=false",
  ];
  if (folderId) {
    queryParts.push(`'${folderId.replace(/'/g, "\\'")}' in parents`);
  }

  const filesUrl = new URL(`${GOOGLE_DRIVE_API}/files`);
  filesUrl.searchParams.set("q", queryParts.join(" and "));
  filesUrl.searchParams.set("pageSize", String(pageSize));
  filesUrl.searchParams.set("orderBy", "modifiedTime desc");
  filesUrl.searchParams.set("fields", "files(id,name,modifiedTime,webViewLink)");

  const driveListing = await fetchGoogleJson<{ files?: GoogleDriveFile[] }>(
    accessToken,
    filesUrl.toString(),
  );
  const files = Array.isArray(driveListing.files) ? driveListing.files : [];
  importCount = files.length;

  for (const file of files) {
    const exportUrl = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent("text/plain")}`;
    const content = normalizeDocContent(await fetchGoogleText(accessToken, exportUrl));

    if (!content) {
      skipped += 1;
      continue;
    }

    const status = await upsertGoogleDocumentResource(userId, file, content);
    if (status === "created") imported += 1;
    else updated += 1;
  }
  }

  if (connection.syncDirection === "export" || connection.syncDirection === "bidirectional") {
    const exportCounts = await exportRivrDocsToGoogle(userId, connection, accessToken);
    imported += exportCounts.imported;
    updated += exportCounts.updated;
    skipped += exportCounts.skipped;
  }

  return {
    provider: "google_docs",
    imported,
    updated,
    skipped,
    message:
      connection.syncDirection === "import"
        ? `Synced ${importCount} Google Docs file${importCount === 1 ? "" : "s"} into personal documents.`
        : connection.syncDirection === "export"
          ? "Exported Rivr personal documents to Google Docs."
          : "Synced Google Docs in both directions.",
    accountLabel: "Google Docs",
    externalAccountId: folderId ?? "drive:root",
  };
}

export async function syncGoogleCalendarConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const { accessToken } = await getGoogleAccountToken(userId);
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const calendarId = connection.config.calendarId?.trim() || "primary";

  if (connection.syncDirection === "import" || connection.syncDirection === "bidirectional") {
    const pageSize = parsePositiveInteger(connection.config.maxResults, 25, 100);
    const timeMin =
      connection.config.timeMin?.trim() ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const timeMax =
      connection.config.timeMax?.trim() ||
      new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();

    const eventsUrl = new URL(
      `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    eventsUrl.searchParams.set("singleEvents", "true");
    eventsUrl.searchParams.set("orderBy", "startTime");
    eventsUrl.searchParams.set("maxResults", String(pageSize));
    eventsUrl.searchParams.set("timeMin", timeMin);
    eventsUrl.searchParams.set("timeMax", timeMax);
    eventsUrl.searchParams.set(
      "fields",
      "items(id,summary,description,location,htmlLink,status,start,end,updated)",
    );

    const eventListing = await fetchGoogleJson<{ items?: GoogleCalendarEvent[] }>(
      accessToken,
      eventsUrl.toString(),
    );
    const events = Array.isArray(eventListing.items) ? eventListing.items : [];

    for (const event of events) {
      const status = await upsertGoogleCalendarEventResource(userId, calendarId, event);
      if (status === "created") imported += 1;
      else if (status === "updated") updated += 1;
      else skipped += 1;
    }
  }

  if (connection.syncDirection === "export" || connection.syncDirection === "bidirectional") {
    const exportCounts = await exportRivrEventsToGoogle(userId, connection, accessToken);
    imported += exportCounts.imported;
    updated += exportCounts.updated;
    skipped += exportCounts.skipped;
  }

  return {
    provider: "google_calendar",
    imported,
    updated,
    skipped,
    message: `Synced Google Calendar with Rivr events.`,
    accountLabel: "Google Calendar",
    externalAccountId: calendarId,
  };
}
