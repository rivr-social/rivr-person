/**
 * GET  /api/personas/[id]/kg/docs — List KG docs for a persona's scope
 * POST /api/personas/[id]/kg/docs — Create a KG doc in a persona's scope
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { eq } from "drizzle-orm";
import * as kg from "@/lib/kg/autobot-kg-client";
import { isPersonaOf } from "@/lib/persona";

export const dynamic = "force-dynamic";

const SCOPE_TYPE_PERSONA = "persona";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: personaId } = await context.params;

  const owned = await isPersonaOf(personaId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: "Persona not found or not owned by you" }, { status: 403 });
  }

  const url = new URL(req.url);
  const status = url.searchParams.get("status") || undefined;

  try {
    const docs = await kg.listDocs(SCOPE_TYPE_PERSONA, personaId, status);
    return NextResponse.json({ docs, count: docs.length, scope: { type: SCOPE_TYPE_PERSONA, id: personaId } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list persona docs" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: personaId } = await context.params;

  const owned = await isPersonaOf(personaId, session.user.id);
  if (!owned) {
    return NextResponse.json({ error: "Persona not found or not owned by you" }, { status: 403 });
  }

  const body = await req.json();
  const { resourceId, title, doc_type, content } = body;

  // If creating from a Rivr resource, fetch and validate ownership
  if (resourceId) {
    const resource = await db.query.resources.findFirst({
      where: eq(resources.id, resourceId),
    });
    if (!resource) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }
    if (resource.ownerId !== session.user.id) {
      return NextResponse.json({ error: "Not your resource" }, { status: 403 });
    }

    try {
      const doc = await kg.createDoc({
        title: title || resource.name || "Untitled",
        doc_type: doc_type || resource.type || "resource",
        scope_type: SCOPE_TYPE_PERSONA,
        scope_id: personaId,
        source_uri: `rivr://person/resources/${resource.id}`,
      });

      // Auto-ingest if the resource has content
      const resourceContent = resource.content || "";
      if (resourceContent) {
        const ingestResult = await kg.ingestDoc(doc.id, resourceContent, undefined, doc.title);
        return NextResponse.json({ doc, ingested: true, ingestResult });
      }

      return NextResponse.json({ doc, ingested: false, reason: "Resource has no content to ingest" });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Failed to create persona doc from resource" },
        { status: 500 },
      );
    }
  }

  // Direct doc creation
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  try {
    const doc = await kg.createDoc({
      title,
      doc_type: doc_type || "document",
      scope_type: SCOPE_TYPE_PERSONA,
      scope_id: personaId,
    });

    // If inline content is provided, auto-ingest it
    if (content && typeof content === "string") {
      const ingestResult = await kg.ingestDoc(doc.id, content, undefined, title);
      return NextResponse.json({ doc, ingested: true, ingestResult });
    }

    return NextResponse.json({ doc, ingested: false });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create persona doc" },
      { status: 500 },
    );
  }
}
