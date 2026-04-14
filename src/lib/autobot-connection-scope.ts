import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getActivePersonaId, setActivePersonaCookie } from "@/lib/persona";

export type AutobotConnectionScope = {
  actorId: string;
  ownerId: string;
  scopeType: "person" | "persona";
  scopeLabel: string;
  personaName?: string;
};

export async function resolveAutobotConnectionScope(
  ownerId: string,
): Promise<AutobotConnectionScope> {
  const activePersonaId = await getActivePersonaId();
  if (!activePersonaId) {
    return {
      actorId: ownerId,
      ownerId,
      scopeType: "person",
      scopeLabel: "Main profile",
    };
  }

  const [persona] = await db
    .select({
      id: agents.id,
      name: agents.name,
      parentAgentId: agents.parentAgentId,
    })
    .from(agents)
    .where(
      and(
        eq(agents.id, activePersonaId),
        eq(agents.parentAgentId, ownerId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (!persona) {
    await setActivePersonaCookie(null);
    return {
      actorId: ownerId,
      ownerId,
      scopeType: "person",
      scopeLabel: "Main profile",
    };
  }

  return {
    actorId: persona.id,
    ownerId,
    scopeType: "persona",
    scopeLabel: persona.name?.trim() ? persona.name.trim() : "Persona",
    personaName: persona.name?.trim() ? persona.name.trim() : undefined,
  };
}

export function buildConnectionsRedirectUrl(
  baseUrl: string,
  params?: Record<string, string | null | undefined>,
): string {
  const normalizedBaseUrl = baseUrl.trim() || "http://localhost:3000";
  const url = new URL("/autobot", normalizedBaseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value.trim()) {
        url.searchParams.set(key, value.trim());
      }
    }
  }
  url.hash = "connections";
  return url.toString();
}
