const WHISPER_TRANSCRIBE_URL = process.env.WHISPER_TRANSCRIBE_URL?.trim();
const WHISPER_TRANSCRIBE_API_KEY = process.env.WHISPER_TRANSCRIBE_API_KEY?.trim();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
const OPENAI_TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";

export type TranscriptionSegment = {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
};

type TranscriptionResult = {
  text: string;
  provider: "whisper" | "openai";
  segments?: TranscriptionSegment[];
};

export function isTranscriptionConfigured(): boolean {
  return Boolean(WHISPER_TRANSCRIBE_URL || OPENAI_API_KEY);
}

function extractTranscriptText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.text,
    record.transcript,
    record.output_text,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "";
}

function extractSegments(payload: unknown): TranscriptionSegment[] | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.segments)) return undefined;
  const segments: TranscriptionSegment[] = [];
  for (const seg of record.segments) {
    if (seg && typeof seg === "object") {
      const s = seg as Record<string, unknown>;
      segments.push({
        start: typeof s.start === "number" ? s.start : 0,
        end: typeof s.end === "number" ? s.end : 0,
        text: typeof s.text === "string" ? s.text.trim() : "",
        speaker: typeof s.speaker === "string" ? s.speaker : null,
      });
    }
  }
  return segments.length > 0 ? segments : undefined;
}

export async function transcribeAudioFile(file: File): Promise<TranscriptionResult> {
  if (!isTranscriptionConfigured()) {
    throw new Error("Transcription is not configured on this deployment.");
  }

  if (WHISPER_TRANSCRIBE_URL) {
    const formData = new FormData();
    formData.append("file", file, file.name || "event-segment.webm");
    if (process.env.WHISPER_TRANSCRIBE_MODEL?.trim()) {
      formData.append("model", process.env.WHISPER_TRANSCRIBE_MODEL.trim());
    }
    const response = await fetch(WHISPER_TRANSCRIBE_URL, {
      method: "POST",
      headers: WHISPER_TRANSCRIBE_API_KEY
        ? { Authorization: `Bearer ${WHISPER_TRANSCRIBE_API_KEY}` }
        : undefined,
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Whisper transcription failed with status ${response.status}`);
    }

    const payload = await response.json().catch(() => ({}));
    const text = extractTranscriptText(payload);
    if (!text) {
      throw new Error("Whisper transcription returned no text.");
    }
    const segments = extractSegments(payload);
    return { text, provider: "whisper", segments };
  }

  const formData = new FormData();
  formData.append("file", file, file.name || "event-segment.webm");
  formData.append("model", OPENAI_TRANSCRIPTION_MODEL);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`OpenAI transcription failed with status ${response.status}`);
  }

  const payload = await response.json().catch(() => ({}));
  const text = extractTranscriptText(payload);
  if (!text) {
    throw new Error("OpenAI transcription returned no text.");
  }

  return { text, provider: "openai" };
}
