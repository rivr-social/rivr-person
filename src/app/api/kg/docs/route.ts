/**
 * GET  /api/kg/docs — List docs for a scope
 * POST /api/kg/docs — Create a doc from a Rivr resource
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { eq } from "drizzle-orm";
import * as kg from "@/lib/kg/autobot-kg-client";
import { isPersonaOf } from "@/lib/persona";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const personaId = url.searchParams.get("personaId");

  let scopeType = url.searchParams.get("scope_type") || "person";
  let scopeId = url.searchParams.get("scope_id") || session.user.id;

  // When personaId is provided, verify ownership and scope to the persona
  if (personaId) {
    const owned = await isPersonaOf(personaId, session.user.id);
    if (!owned) {
      return NextResponse.json({ error: "Persona not found or not owned by you" }, { status: 403 });
    }
    scopeType = "persona";
    scopeId = personaId;
  }

  const status = url.searchParams.get("status") || undefined;

  try {
    const docs = await kg.listDocs(scopeType, scopeId, status);
    return NextResponse.json(docs);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list docs" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { resourceId, scope_type, scope_id, title, doc_type, personaId } = body;

  // Resolve scope — persona takes precedence when provided
  let resolvedScopeType = scope_type || "person";
  let resolvedScopeId = scope_id || session.user.id;

  if (personaId) {
    const owned = await isPersonaOf(personaId, session.user.id);
    if (!owned) {
      return NextResponse.json({ error: "Persona not found or not owned by you" }, { status: 403 });
    }
    resolvedScopeType = "persona";
    resolvedScopeId = personaId;
  }

  // If creating from a Rivr resource, fetch it
  if (resourceId) {
    const resource = await db.query.resources.findFirst({
      where: eq(resources.id, resourceId),
    });
    if (!resource) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }
    // Only owner can push their resources
    if (resource.ownerId !== session.user.id) {
      return NextResponse.json({ error: "Not your resource" }, { status: 403 });
    }

    try {
      const doc = await kg.createDoc({
        title: title || resource.name || "Untitled",
        doc_type: doc_type || resource.type || "resource",
        scope_type: resolvedScopeType,
        scope_id: resolvedScopeId,
        source_uri: `rivr://person/resources/${resource.id}`,
      });
      return NextResponse.json(doc);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to create doc" },
        { status: 500 },
      );
    }
  }

  // Direct doc creation (no resource backing)
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  try {
    const doc = await kg.createDoc({
      title,
      doc_type: doc_type || "document",
      scope_type: resolvedScopeType,
      scope_id: resolvedScopeId,
    });
    return NextResponse.json(doc);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create doc" },
      { status: 500 },
    );
  }
}
