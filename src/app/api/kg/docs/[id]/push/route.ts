/**
 * POST /api/kg/docs/[id]/push — Push a resource's content into the KG for extraction
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { eq } from "drizzle-orm";
import * as kg from "@/lib/kg/autobot-kg-client";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const docId = parseInt(id, 10);
  if (isNaN(docId)) {
    return NextResponse.json({ error: "Invalid doc ID" }, { status: 400 });
  }

  // Get the doc to find its source_uri
  let doc;
  try {
    doc = await kg.getDoc(docId);
  } catch {
    return NextResponse.json({ error: "Doc not found in KG" }, { status: 404 });
  }

  // Resolve content — either from request body or from the linked Rivr resource
  const body = await req.json().catch(() => ({}));
  let content = body.content;

  if (!content && doc.source_uri) {
    // Parse rivr://person/resources/{id}
    const resourceMatch = doc.source_uri.match(/^rivr:\/\/\w+\/resources\/(.+)$/);
    if (resourceMatch) {
      const resource = await db.query.resources.findFirst({
        where: eq(resources.id, resourceMatch[1]),
      });
      if (!resource) {
        return NextResponse.json({ error: "Linked resource not found" }, { status: 404 });
      }
      if (resource.ownerId !== session.user.id) {
        return NextResponse.json({ error: "Not your resource" }, { status: 403 });
      }
      content = resource.content || "";
    }
  }

  if (!content) {
    return NextResponse.json(
      { error: "No content to ingest. Provide content in body or link a resource with content." },
      { status: 400 },
    );
  }

  try {
    const result = await kg.ingestDoc(docId, content, body.format, body.title);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Ingestion failed" },
      { status: 500 },
    );
  }
}
