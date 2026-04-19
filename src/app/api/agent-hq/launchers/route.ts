import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { assertAgentHqAccess, listAgentLaunchers } from "@/lib/agent-hq";
import { getActivePersonaId } from "@/lib/persona";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const ownerId = session?.user?.id;
    if (!ownerId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [launchers, activePersonaId, personas] = await Promise.all([
      listAgentLaunchers(),
      getActivePersonaId(),
      db
        .select({
          id: agents.id,
          name: agents.name,
        })
        .from(agents)
        .where(and(eq(agents.parentAgentId, ownerId), isNull(agents.deletedAt)))
        .orderBy(agents.createdAt),
    ]);

    return NextResponse.json({
      ...launchers,
      activePersonaId: activePersonaId ?? null,
      personas: personas.map((persona) => ({
        id: persona.id,
        name: persona.name?.trim() || "Persona",
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list launchers";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
