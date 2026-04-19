import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { serializeAgent } from "@/lib/graph-serializers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_HEALTH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Ollama health check
// ---------------------------------------------------------------------------

interface OllamaHealthResult {
  url: string;
  reachable: boolean;
  version: string | null;
  defaultModel: string;
  availableModels: Array<{ name: string; size: number }>;
  error?: string;
}

async function checkOllamaHealth(): Promise<OllamaHealthResult> {
  const base: OllamaHealthResult = {
    url: OLLAMA_URL,
    reachable: false,
    version: null,
    defaultModel: OLLAMA_MODEL,
    availableModels: [],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OLLAMA_HEALTH_TIMEOUT_MS);

    const [healthRes, tagsRes] = await Promise.allSettled([
      fetch(`${OLLAMA_URL}/api/version`, { signal: controller.signal }),
      fetch(`${OLLAMA_URL}/api/tags`, { signal: controller.signal }),
    ]);

    clearTimeout(timeout);

    if (healthRes.status === "fulfilled" && healthRes.value.ok) {
      base.reachable = true;
      try {
        const vData = await healthRes.value.json();
        base.version = vData.version || null;
      } catch {
        // version endpoint may not return JSON on all builds
      }
    }

    if (tagsRes.status === "fulfilled" && tagsRes.value.ok) {
      try {
        const tData = await tagsRes.value.json();
        base.availableModels = (tData.models || []).map(
          (m: { name: string; size: number }) => ({
            name: m.name,
            size: m.size,
          }),
        );
      } catch {
        // graceful degradation
      }
    }
  } catch (error) {
    base.error =
      error instanceof Error ? error.message : "Failed to reach Ollama";
  }

  return base;
}

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

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

  // Ollama health check runs in parallel with the rest
  const ollamaHealth = await checkOllamaHealth();

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
    ollama: ollamaHealth,
  });
}
