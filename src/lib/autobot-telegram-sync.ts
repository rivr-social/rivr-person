import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

const TELEGRAM_BOT_API = "https://api.telegram.org/bot";
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

type TelegramUser = {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
};

type TelegramChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TelegramMessage;
  message_thread_id?: number;
};

type TelegramGetUpdatesResponse = {
  ok: boolean;
  description?: string;
  result?: Array<{
    update_id: number;
    message?: TelegramMessage;
    channel_post?: TelegramMessage;
  }>;
};

type TelegramGetMeResponse = {
  ok: boolean;
  description?: string;
  result?: TelegramUser;
};

type TelegramGetChatResponse = {
  ok: boolean;
  description?: string;
  result?: TelegramChat;
};

function parsePositiveInteger(
  input: string | undefined,
  fallback: number,
  max: number,
): number {
  if (!input) return fallback;
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function formatSenderName(from: TelegramUser | undefined): string {
  if (!from) return "Unknown";
  const parts = [from.first_name];
  if (from.last_name) parts.push(from.last_name);
  if (from.username) parts.push(`(@${from.username})`);
  return parts.join(" ");
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

function messageToMarkdown(message: TelegramMessage): string {
  const sender = formatSenderName(message.from);
  const timestamp = formatTimestamp(message.date);
  const content = message.text ?? message.caption ?? "";
  if (!content.trim()) return "";

  const lines: string[] = [];
  lines.push(`**${sender}** — ${timestamp}`);
  if (message.reply_to_message) {
    const replySnippet = (message.reply_to_message.text ?? message.reply_to_message.caption ?? "").slice(0, 80);
    if (replySnippet) {
      lines.push(`> Replying to: ${replySnippet}`);
    }
  }
  lines.push("");
  lines.push(content);
  return lines.join("\n");
}

async function telegramBotJson<T>(botToken: string, method: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${TELEGRAM_BOT_API}${botToken}/${method}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), { cache: "no-store" });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Telegram Bot API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  const body = (await response.json()) as T;
  return body;
}

export async function validateBotToken(botToken: string): Promise<TelegramUser> {
  const response = await telegramBotJson<TelegramGetMeResponse>(botToken, "getMe");
  if (!response.ok || !response.result) {
    throw new Error(response.description ?? "Failed to validate Telegram bot token.");
  }
  return response.result;
}

async function getChatInfo(botToken: string, chatId: string): Promise<TelegramChat> {
  const response = await telegramBotJson<TelegramGetChatResponse>(botToken, "getChat", {
    chat_id: chatId,
  });
  if (!response.ok || !response.result) {
    throw new Error(response.description ?? `Failed to get Telegram chat info for ${chatId}.`);
  }
  return response.result;
}

async function fetchRecentMessages(
  botToken: string,
  chatId: string,
  threadId: string | undefined,
  limit: number,
): Promise<TelegramMessage[]> {
  const params: Record<string, string> = {
    limit: String(Math.min(limit, 100)),
  };
  if (threadId) {
    params.allowed_updates = JSON.stringify(["message"]);
  }

  const response = await telegramBotJson<TelegramGetUpdatesResponse>(botToken, "getUpdates", params);

  if (!response.ok || !Array.isArray(response.result)) {
    throw new Error(response.description ?? "Failed to fetch Telegram updates.");
  }

  const numericChatId = Number(chatId);
  const numericThreadId = threadId ? Number(threadId) : undefined;

  const messages: TelegramMessage[] = [];
  for (const update of response.result) {
    const msg = update.message ?? update.channel_post;
    if (!msg) continue;
    if (msg.chat.id !== numericChatId) continue;
    if (numericThreadId && msg.message_thread_id !== numericThreadId) continue;
    if (!msg.text && !msg.caption) continue;
    messages.push(msg);
  }

  return messages.slice(0, limit);
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
        sql`${resources.metadata}->'externalSync'->>'provider' = 'telegram'`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function upsertTelegramMessageResource(
  userId: string,
  chatId: string,
  chatTitle: string,
  message: TelegramMessage,
  markdown: string,
): Promise<"created" | "updated"> {
  const externalId = String(message.message_id);
  const existingId = await findSyncedResourceId(userId, externalId);
  const now = new Date();
  const timestamp = formatTimestamp(message.date);
  const sender = formatSenderName(message.from);
  const name = `Telegram: ${sender} — ${timestamp.slice(0, 10)}`;

  const metadata = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Telegram",
    externalSync: {
      provider: "telegram",
      externalId,
      chatId,
      chatTitle,
      senderId: message.from?.id ? String(message.from.id) : null,
      senderName: sender,
      messageDate: timestamp,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name,
        description: `Imported from Telegram chat: ${chatTitle}`,
        content: markdown,
        contentType: "text/markdown",
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name,
    type: "document",
    description: `Imported from Telegram chat: ${chatTitle}`,
    content: markdown,
    contentType: "text/markdown",
    ownerId: userId,
    visibility: "private",
    tags: ["telegram", "messages", "imported"],
    metadata,
  });
  return "created";
}

export async function syncTelegramConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const botToken = connection.config.botToken?.trim();
  const chatId = connection.config.chatId?.trim();
  const threadId = connection.config.threadId?.trim() || undefined;

  if (!botToken) {
    throw new Error("Telegram bot token is required. Set botToken in the connector config.");
  }
  if (!chatId) {
    throw new Error("Telegram chat ID is required. Set chatId in the connector config.");
  }

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (connection.syncDirection === "export") {
    return {
      provider: "telegram",
      imported: 0,
      updated: 0,
      skipped: 0,
      message: "Telegram export is not yet supported. Use import or bidirectional sync direction.",
      accountLabel: connection.accountLabel ?? "Telegram",
      externalAccountId: chatId,
    };
  }

  await validateBotToken(botToken);

  const chatInfo = await getChatInfo(botToken, chatId);
  const chatTitle = chatInfo.title ?? chatInfo.username ?? chatInfo.first_name ?? `Chat ${chatId}`;

  const limit = parsePositiveInteger(
    connection.config.maxResults,
    DEFAULT_MESSAGE_LIMIT,
    MAX_MESSAGE_LIMIT,
  );

  const messages = await fetchRecentMessages(botToken, chatId, threadId, limit);

  for (const message of messages) {
    const markdown = messageToMarkdown(message);
    if (!markdown.trim()) {
      skipped += 1;
      continue;
    }

    const status = await upsertTelegramMessageResource(
      userId,
      chatId,
      chatTitle,
      message,
      markdown,
    );
    if (status === "created") imported += 1;
    else updated += 1;
  }

  const threadSuffix = threadId ? ` (thread ${threadId})` : "";
  return {
    provider: "telegram",
    imported,
    updated,
    skipped,
    message: `Imported ${messages.length} message${messages.length === 1 ? "" : "s"} from Telegram chat "${chatTitle}"${threadSuffix}.`,
    accountLabel: connection.accountLabel ?? `Telegram: ${chatTitle}`,
    externalAccountId: chatId,
  };
}
