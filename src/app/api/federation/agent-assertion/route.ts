import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { signPackedPayload } from "@/lib/federation-remote-session";
import { isPersonaOf } from "@/lib/persona";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ASSERTION_TTL_MS = 15 * 60 * 1000; // 15 minutes

const DEFAULT_SCOPES = [
  "federation.login",
  "federation.mutate",
  "federation.read",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentAssertionRequestBody {
  personaId?: string;
  targetInstanceUrl: string;
  scopes?: string[];
}

interface PersonaContext {
  name: string;
  bio: string | null;
  kgRefs: string[];
}

interface AgentAssertionPayload {
  "@context": "https://universalmanifest.net/ns/universal-manifest/v0.1/schema.jsonld";
  "@type": "um:AgentAssertion";
  actorId: string;
  actorType: "autobot";
  personaId: string | null;
  personaContext: PersonaContext | null;
  issuer: string;
  audience: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  scope: {
    capabilities: string[];
  };
}

// ---------------------------------------------------------------------------
// Auth helpers (mirrors mcp-server.ts pattern)
// ---------------------------------------------------------------------------

function getBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function getQueryToken(request: Request): string | null {
  const token = new URL(request.url).searchParams.get("token")?.trim();
  return token ? token : null;
}

function authenticateAgent(request: Request): string | null {
  const configuredToken = process.env.AIAGENT_MCP_TOKEN?.trim() || "";
  if (!configuredToken) return null;

  const providedToken = getBearerToken(request) ?? getQueryToken(request);
  if (!providedToken || providedToken !== configuredToken) return null;

  const config = getInstanceConfig();
  return config.primaryAgentId;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // 1. Authenticate via AIAGENT_MCP_TOKEN
  const primaryAgentId = authenticateAgent(request);
  if (!primaryAgentId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized. Valid AIAGENT_MCP_TOKEN required." },
      { status: 401 },
    );
  }

  // 2. Parse and validate request body
  let body: AgentAssertionRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const { personaId, targetInstanceUrl, scopes } = body;

  if (!targetInstanceUrl || typeof targetInstanceUrl !== "string") {
    return NextResponse.json(
      { success: false, error: "targetInstanceUrl is required and must be a string" },
      { status: 400 },
    );
  }

  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetInstanceUrl);
  } catch {
    return NextResponse.json(
      { success: false, error: "targetInstanceUrl must be a valid URL" },
      { status: 400 },
    );
  }

  if (scopes !== undefined && !Array.isArray(scopes)) {
    return NextResponse.json(
      { success: false, error: "scopes must be an array of strings" },
      { status: 400 },
    );
  }

  // 3. Validate persona ownership if personaId provided
  let personaContext: PersonaContext | null = null;

  if (personaId) {
    if (typeof personaId !== "string") {
      return NextResponse.json(
        { success: false, error: "personaId must be a string" },
        { status: 400 },
      );
    }

    const ownedPersona = await isPersonaOf(personaId, primaryAgentId);
    if (!ownedPersona) {
      return NextResponse.json(
        { success: false, error: "Persona not found or not owned by this agent" },
        { status: 403 },
      );
    }

    // 4. Fetch persona metadata
    const persona = await db.query.agents.findFirst({
      where: and(
        eq(agents.id, personaId),
        eq(agents.parentAgentId, primaryAgentId),
        isNull(agents.deletedAt),
      ),
      columns: {
        id: true,
        name: true,
        description: true,
        metadata: true,
      },
    });

    if (!persona) {
      return NextResponse.json(
        { success: false, error: "Persona not found" },
        { status: 404 },
      );
    }

    // Extract KG refs from metadata if present
    const metadata = persona.metadata as Record<string, unknown> | null;
    const kgRefs = Array.isArray(metadata?.kgRefs)
      ? (metadata.kgRefs as string[])
      : [];

    personaContext = {
      name: persona.name,
      bio: persona.description ?? null,
      kgRefs,
    };
  }

  // 5. Build and sign the assertion JWT
  const config = getInstanceConfig();
  const now = Date.now();
  const resolvedScopes =
    scopes && scopes.length > 0
      ? scopes.filter((s): s is string => typeof s === "string")
      : [...DEFAULT_SCOPES];

  const payload: AgentAssertionPayload = {
    "@context": "https://universalmanifest.net/ns/universal-manifest/v0.1/schema.jsonld",
    "@type": "um:AgentAssertion",
    actorId: primaryAgentId,
    actorType: "autobot",
    personaId: personaId ?? null,
    personaContext,
    issuer: config.baseUrl.replace(/\/+$/, ""),
    audience: parsedTarget.origin,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ASSERTION_TTL_MS).toISOString(),
    nonce: randomUUID(),
    scope: {
      capabilities: resolvedScopes,
    },
  };

  // 6. Sign with the same HMAC-SHA256 mechanism used by federation-remote-session
  const token = signPackedPayload(payload as unknown as Record<string, unknown>);

  return NextResponse.json({
    success: true,
    token,
    payload: {
      actorId: payload.actorId,
      actorType: payload.actorType,
      personaId: payload.personaId,
      personaContext: payload.personaContext,
      homeBaseUrl: payload.issuer,
      audience: payload.audience,
      scopes: payload.scope.capabilities,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
    },
  });
}
