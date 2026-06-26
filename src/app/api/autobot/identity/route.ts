import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { resolveDirectAgent } from "@/lib/assistant/resolve-direct-agent";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_OK = 200;
const STATUS_BAD_REQUEST = 400;
const STATUS_UNAUTHORIZED = 401;
const STATUS_NOT_FOUND = 404;
const STATUS_INTERNAL = 500;

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const MIN_NAME_LENGTH = 1;
const MAX_NAME_LENGTH = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpdateIdentityBody {
  name: string;
}

interface IdentityResponse {
  directAgentId: string;
  controllerId: string;
  isPersona: boolean;
  name: string;
  image: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readDirectAgentIdentity(
  directAgentId: string,
): Promise<{ name: string; image: string | null } | null> {
  const [row] = await db
    .select({ name: agents.name, image: agents.image })
    .from(agents)
    .where(eq(agents.id, directAgentId))
    .limit(1);
  if (!row) return null;
  return { name: row.name ?? "", image: row.image ?? null };
}

// ---------------------------------------------------------------------------
// GET — read the direct agent's display name (the assistant's name)
// ---------------------------------------------------------------------------

export async function GET(): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const { directAgentId, controllerId, isPersona } = await resolveDirectAgent(session.user.id);
    const identity = await readDirectAgentIdentity(directAgentId);
    if (!identity) {
      return NextResponse.json(
        { error: "Direct agent not found" },
        { status: STATUS_NOT_FOUND, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    const body: IdentityResponse = {
      directAgentId,
      controllerId,
      isPersona,
      name: identity.name,
      image: identity.image,
    };
    return NextResponse.json(body, {
      status: STATUS_OK,
      headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to read assistant identity";
    return NextResponse.json(
      { error: message },
      { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}

// ---------------------------------------------------------------------------
// PUT — rename the assistant (updates the direct agent's `name` column)
//
// Owner-only: the name is resolved + written against the caller's OWN direct
// agent (resolveDirectAgent keys off session.user.id), so a caller can never
// rename another account's assistant.
// ---------------------------------------------------------------------------

export async function PUT(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "Authentication required" },
      { status: STATUS_UNAUTHORIZED, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  let body: UpdateIdentityBody;
  try {
    body = (await request.json()) as UpdateIdentityBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < MIN_NAME_LENGTH) {
    return NextResponse.json(
      { error: "Name is required." },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
  if (name.length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` },
      { status: STATUS_BAD_REQUEST, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }

  try {
    const { directAgentId, controllerId, isPersona } = await resolveDirectAgent(session.user.id);
    const existing = await readDirectAgentIdentity(directAgentId);
    if (!existing) {
      return NextResponse.json(
        { error: "Direct agent not found" },
        { status: STATUS_NOT_FOUND, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
      );
    }

    await db
      .update(agents)
      .set({ name, updatedAt: new Date() })
      .where(eq(agents.id, directAgentId));

    const response: IdentityResponse = {
      directAgentId,
      controllerId,
      isPersona,
      name,
      image: existing.image,
    };
    return NextResponse.json(response, {
      status: STATUS_OK,
      headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to rename assistant";
    return NextResponse.json(
      { error: message },
      { status: STATUS_INTERNAL, headers: { "Cache-Control": CACHE_CONTROL_NO_STORE } },
    );
  }
}
