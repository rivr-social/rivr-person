import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { accounts, resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_PROVIDER_KEY = "discord";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DiscordGuild = {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  approximate_member_count?: number;
};

type DiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  discriminator: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getDiscordAccessToken(userId: string): Promise<string> {
  const [account] = await db
    .select({ accessToken: accounts.access_token })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.provider, DISCORD_PROVIDER_KEY)))
    .limit(1);

  if (!account?.accessToken) {
    throw new Error("No Discord OAuth token found. Please reconnect Discord first.");
  }

  return account.accessToken;
}

async function discordApiGet<T>(
  path: string,
  accessToken: string,
): Promise<T> {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord API error (${response.status}): ${errorText.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

async function findSyncedDiscordResourceId(
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
        sql`${resources.metadata}->'externalSync'->>'provider' = ${DISCORD_PROVIDER_KEY}`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function upsertDiscordGuildResource(
  userId: string,
  guild: DiscordGuild,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedDiscordResourceId(userId, guild.id);
  const now = new Date();
  const metadata: Record<string, unknown> = {
    entityType: "document",
    resourceKind: "guild",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Discord",
    externalSync: {
      provider: DISCORD_PROVIDER_KEY,
      externalId: guild.id,
      guildName: guild.name,
      isOwner: guild.owner,
      memberCount: guild.approximate_member_count ?? 0,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: guild.name,
        description: `Discord server: ${guild.name}`,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: guild.name,
    type: "document",
    description: `Discord server: ${guild.name}`,
    content: "",
    contentType: "text/plain",
    ownerId: userId,
    visibility: "private",
    tags: ["discord", "server", "imported"],
    metadata,
  });
  return "created";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function testDiscordConnection(
  userId: string,
): Promise<{ valid: boolean; label?: string; error?: string }> {
  try {
    const accessToken = await getDiscordAccessToken(userId);
    const user = await discordApiGet<DiscordUser>("/users/@me", accessToken);
    return { valid: true, label: user.global_name || user.username };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Failed to test Discord connection",
    };
  }
}

export async function syncDiscordConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const accessToken = await getDiscordAccessToken(userId);

  const user = await discordApiGet<DiscordUser>("/users/@me", accessToken);

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (
    connection.syncDirection === "import" ||
    connection.syncDirection === "bidirectional"
  ) {
    const guilds = await discordApiGet<DiscordGuild[]>(
      "/users/@me/guilds?with_counts=true",
      accessToken,
    );

    for (const guild of guilds) {
      if (!guild.id || !guild.name) {
        skipped += 1;
        continue;
      }
      const status = await upsertDiscordGuildResource(userId, guild);
      if (status === "created") imported += 1;
      else updated += 1;
    }
  }

  return {
    provider: "discord",
    imported,
    updated,
    skipped,
    message: `Synced ${imported + updated} Discord server${imported + updated === 1 ? "" : "s"}.`,
    accountLabel: user.global_name || user.username,
    externalAccountId: user.id,
  };
}
