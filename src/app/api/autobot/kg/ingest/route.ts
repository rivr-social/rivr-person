import { NextResponse } from "next/server";
import { auth } from "@/auth";
import * as kg from "@/lib/kg/autobot-kg-client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTOBOT_KG_URL = process.env.AUTOBOT_KG_URL?.trim();

// ---------------------------------------------------------------------------
// POST /api/autobot/kg/ingest
// Create a KG doc and ingest content into the Autobot knowledge graph.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  if (!AUTOBOT_KG_URL) {
    return NextResponse.json(
      { error: "Autobot KG is not configured on this deployment." },
      { status: 503 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const docType = typeof body.doc_type === "string" ? body.doc_type : "transcript";
  const scopeType = typeof body.scope_type === "string" ? body.scope_type : "user";
  const scopeId = typeof body.scope_id === "string" ? body.scope_id : session.user.id;
  const metadata = body.metadata && typeof body.metadata === "object"
    ? body.metadata as Record<string, unknown>
    : {};

  if (!title || !content) {
    return NextResponse.json(
      { error: "Both 'title' and 'content' are required." },
      { status: 400 },
    );
  }

  try {
    // Step 1: Create the doc record in the KG
    const doc = await kg.createDoc({
      title,
      doc_type: docType,
      scope_type: scopeType,
      scope_id: scopeId,
      metadata: {
        ...metadata,
        ingestedBy: session.user.id,
        ingestedAt: new Date().toISOString(),
      },
    });

    // Step 2: Ingest content (triggers triple extraction)
    const ingestResult = await kg.ingestDoc(doc.id, content, "markdown", title);

    return NextResponse.json({
      success: true,
      docId: doc.id,
      title: doc.title,
      triplesExtracted: ingestResult.regexTriplesExtracted + (ingestResult.llmChunksQueued ?? 0),
      ingestResult,
    });
  } catch (error) {
    console.error("[autobot-kg-ingest] failed:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to ingest content into KG.",
      },
      { status: 500 },
    );
  }
}
