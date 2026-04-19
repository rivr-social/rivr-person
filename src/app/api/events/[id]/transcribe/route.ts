import { NextResponse } from "next/server";
import { resolveAuthenticatedUserId } from "@/app/actions/resource-creation/helpers";
import { appendEventTranscriptAction } from "@/app/actions/interactions/events-jobs";
import { getEventTranscriptAggregate, getEventTranscriptDocumentForAttendee } from "@/lib/queries/resources";
import { isTranscriptionConfigured, transcribeAudioFile } from "@/lib/transcription";
import type { TranscriptionSegment } from "@/lib/transcription";

export const maxDuration = 120;

// ---------------------------------------------------------------------------
// GET /api/events/[id]/transcribe
// Retrieve current transcription state for the authenticated attendee.
// ---------------------------------------------------------------------------

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const { id: eventId } = await params;

  const [personalTranscript, aggregateTranscript] = await Promise.all([
    getEventTranscriptDocumentForAttendee(eventId, userId),
    getEventTranscriptAggregate(eventId),
  ]);

  const hasPersonal = personalTranscript !== null;
  const hasAggregate = aggregateTranscript.documents.length > 0;

  // Derive a status from the stored state.
  const status = hasPersonal || hasAggregate ? "complete" : "idle";

  return NextResponse.json({
    success: true,
    eventId,
    status,
    transcriptionConfigured: isTranscriptionConfigured(),
    personal: {
      documentId: personalTranscript?.id ?? null,
      content: personalTranscript?.content ?? "",
    },
    aggregate: {
      content: aggregateTranscript.content,
      documentCount: aggregateTranscript.documents.length,
      contributors: aggregateTranscript.documents.map((doc) => ({
        documentId: doc.id,
        title: doc.title,
      })),
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/events/[id]/transcribe
// Upload audio, transcribe via WhisperX, and append to event transcript.
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const userId = await resolveAuthenticatedUserId();
  if (!userId) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  if (!isTranscriptionConfigured()) {
    return NextResponse.json({ error: "Transcription is not configured on this deployment." }, { status: 503 });
  }

  const { id: eventId } = await params;
  const formData = await request.formData().catch(() => null);
  const file = formData?.get("audio");
  const speakerLabel = formData?.get("speakerLabel");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "An audio file is required." }, { status: 400 });
  }

  try {
    const transcription = await transcribeAudioFile(file);

    // Resolve speaker label: prefer user-provided, fall back to dominant speaker from diarization segments.
    let resolvedSpeakerLabel: string | null = typeof speakerLabel === "string" && speakerLabel.trim() ? speakerLabel.trim() : null;
    if (!resolvedSpeakerLabel && transcription.segments?.length) {
      const speakerCounts = new Map<string, number>();
      for (const seg of transcription.segments) {
        if (seg.speaker) {
          speakerCounts.set(seg.speaker, (speakerCounts.get(seg.speaker) ?? 0) + 1);
        }
      }
      if (speakerCounts.size > 0) {
        let dominant = "";
        let maxCount = 0;
        for (const [speaker, count] of speakerCounts) {
          if (count > maxCount) {
            dominant = speaker;
            maxCount = count;
          }
        }
        resolvedSpeakerLabel = dominant;
      }
    }

    const appendResult = await appendEventTranscriptAction({
      eventId,
      text: transcription.text,
      speakerLabel: resolvedSpeakerLabel,
      source: transcription.provider === "whisper" ? "whisper" : "whisper-gateway",
    });

    if (!appendResult.success) {
      return NextResponse.json({ error: appendResult.message }, { status: 403 });
    }

    const [personalTranscript, aggregateTranscript] = await Promise.all([
      getEventTranscriptDocumentForAttendee(eventId, userId),
      getEventTranscriptAggregate(eventId),
    ]);

    // Build serializable segments with timestamps for the client.
    const responseSegments: TranscriptionSegment[] = transcription.segments ?? [];

    return NextResponse.json({
      success: true,
      text: transcription.text,
      language: transcription.language ?? null,
      segments: responseSegments,
      transcriptDocumentId: appendResult.linkedDocumentId ?? appendResult.resourceId ?? null,
      transcriptContent: personalTranscript?.content ?? "",
      aggregateTranscriptContent: aggregateTranscript.content,
      aggregateTranscriptDocumentCount: aggregateTranscript.documents.length,
    });
  } catch (error) {
    console.error("[event-transcribe] failed:", error);
    return NextResponse.json({ error: "Failed to transcribe audio." }, { status: 500 });
  }
}
