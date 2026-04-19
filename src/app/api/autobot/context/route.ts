import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { resolveAutobotConnectionScope } from "@/lib/autobot-connection-scope";
import { MCP_TOOL_DEFINITIONS } from "@/lib/federation/mcp-tools";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import { getScopeStats } from "@/lib/kg/autobot-kg-client";
import { resolveAutobotSoulContent } from "@/lib/bespoke/autobot-system-prompt";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ownerId = session.user.id;
  const subject = await resolveAutobotConnectionScope(ownerId);
  const settings = await getAutobotUserSettings(subject.actorId);
  const soul = await resolveAutobotSoulContent(subject.actorId);

  const personas = await db
    .select({
      id: agents.id,
      name: agents.name,
    })
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, ownerId),
        isNull(agents.deletedAt),
      ),
    )
    .orderBy(agents.createdAt);

  const [personStats, personaStats] = await Promise.all([
    getScopeStats("person", ownerId).catch(() => ({ docCount: 0, entityCount: 0, tripleCount: 0 })),
    Promise.all(
      personas.map(async (persona) => ({
        id: persona.id,
        name: persona.name,
        stats: await getScopeStats("persona", persona.id).catch(() => ({
          docCount: 0,
          entityCount: 0,
          tripleCount: 0,
        })),
      })),
    ),
  ]);

  return NextResponse.json({
    subject,
    soul: {
      source: soul.source,
      length: soul.content.length,
      content: soul.content,
      preview: soul.content.slice(0, 1200),
      hasCustom: Boolean(settings.customSoulMd.trim()),
    },
    runtime: {
      selectedModel: settings.selectedModel,
      ttsEnabled: settings.ttsEnabled,
      voiceMode: settings.voiceMode,
      gpuProvider: settings.gpuProvider,
    },
    connections: settings.connections.map((connection) => ({
      provider: connection.provider,
      status: connection.status,
      syncDirection: connection.syncDirection,
      lastSyncedAt: connection.lastSyncedAt ?? null,
    })),
    kg: {
      person: personStats,
      includedPersonaKgIds: settings.includedPersonaKgIds,
      personas: personaStats,
    },
    tools: MCP_TOOL_DEFINITIONS.filter((tool) => tool.enabledFor.includes("session")).map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  });
}
