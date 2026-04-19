import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
} from "@/lib/autobot-user-settings";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import { validateBotToken } from "@/lib/autobot-telegram-sync";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";

export const dynamic = "force-dynamic";

type LinkRequestBody = {
  botToken?: string;
  chatId?: string;
  threadId?: string;
  phoneNumber?: string;
};

/**
 * POST /api/autobot/connections/telegram/link
 *
 * Validates a Telegram bot token by calling the Bot API getMe endpoint,
 * then stores the validated config in the user's Telegram connection.
 */
export async function POST(request: Request) {
  const session = await auth();
  const ownerId = session?.user?.id ?? null;
  if (!ownerId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const subject = await resolveAutobotConnectionScope(ownerId);
  const actorId = subject.actorId;

  let body: LinkRequestBody;
  try {
    body = (await request.json()) as LinkRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
  const chatId = typeof body.chatId === "string" ? body.chatId.trim() : "";

  if (!botToken) {
    return NextResponse.json(
      { error: "botToken is required" },
      { status: 400 },
    );
  }

  let botUser: Awaited<ReturnType<typeof validateBotToken>>;
  try {
    botUser = await validateBotToken(botToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid bot token";
    return NextResponse.json(
      { error: `Bot token validation failed: ${message}` },
      { status: 400 },
    );
  }

  const settings = await getAutobotUserSettings(actorId);
  const existingConnection = settings.connections.find(
    (connection) => connection.provider === "telegram",
  );

  const config: Record<string, string> = {
    ...(existingConnection?.config ?? {}),
    botToken,
  };
  if (chatId) config.chatId = chatId;
  if (typeof body.threadId === "string" && body.threadId.trim()) {
    config.threadId = body.threadId.trim();
  }
  if (typeof body.phoneNumber === "string" && body.phoneNumber.trim()) {
    config.phoneNumber = body.phoneNumber.trim();
  }

  const telegramConnection: AutobotConnection = {
    provider: "telegram",
    status: "connected",
    syncDirection: existingConnection?.syncDirection ?? "import",
    modules: existingConnection?.modules ?? ["messages", "groups", "kg"],
    accountLabel: `@${botUser.username ?? botUser.first_name}`,
    externalAccountId: String(botUser.id),
    lastSyncedAt: existingConnection?.lastSyncedAt,
    config,
  };

  const nextConnections = settings.connections.some(
    (connection) => connection.provider === "telegram",
  )
    ? settings.connections.map((connection) =>
        connection.provider === "telegram" ? telegramConnection : connection,
      )
    : [...settings.connections, telegramConnection];

  const nextSettings = await saveAutobotUserSettings(actorId, {
    connections: nextConnections,
  });

  return NextResponse.json({
    ok: true,
    bot: {
      id: botUser.id,
      username: botUser.username,
      firstName: botUser.first_name,
    },
    connections: nextSettings.connections,
    subject,
  });
}
