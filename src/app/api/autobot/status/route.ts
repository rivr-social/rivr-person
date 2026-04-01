import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { serializeAgent } from "@/lib/graph-serializers";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const config = getInstanceConfig();
  const mcpTokenConfigured = Boolean(process.env.AIAGENT_MCP_TOKEN?.trim());

  let primaryAgent = null;
  if (config.primaryAgentId) {
    const row = await db.query.agents.findFirst({
      where: eq(agents.id, config.primaryAgentId),
    });
    if (row) primaryAgent = serializeAgent(row);
  }

  return NextResponse.json({
    instance: {
      instanceId: config.instanceId,
      instanceType: config.instanceType,
      instanceSlug: config.instanceSlug,
      baseUrl: config.baseUrl,
      isGlobal: config.isGlobal,
    },
    autobot: {
      primaryAgentId: config.primaryAgentId,
      primaryAgent,
      mcpTokenConfigured,
      mcpEndpoint: "/api/mcp",
      discoveryEndpoint: "/.well-known/mcp",
    },
  });
}
