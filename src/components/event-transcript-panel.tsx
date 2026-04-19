"use client";

import { useCallback, useRef, useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Clock,
  Globe,
  Loader2,
  Mic,
  Send,
  Square,
  User,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;

/** Status of the transcription pipeline for display. */
type PipelineStatus = "idle" | "recording" | "uploading" | "processing" | "complete" | "error";

const STATUS_LABELS: Record<PipelineStatus, string> = {
  idle: "Ready to record",
  recording: "Recording...",
  uploading: "Uploading audio...",
  processing: "Transcribing with WhisperX...",
  complete: "Transcription complete",
  error: "Transcription failed",
};

const STATUS_COLORS: Record<PipelineStatus, string> = {
  idle: "bg-muted text-muted-foreground",
  recording: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  uploading: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  processing: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  complete: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  error: "bg-destructive/10 text-destructive",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TranscriptSegment = {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
};

type EventTranscriptPanelProps = {
  eventId: string;
  initialTranscript: string;
  initialAggregateTranscript: string;
  transcriptDocumentId?: string | null;
  transcriptionAvailable: boolean;
  aggregateDocumentCount?: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function getSupportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "audio/webm";
  for (const mimeType of RECORDING_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
  return "audio/webm";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EventTranscriptPanel({
  eventId,
  initialTranscript,
  initialAggregateTranscript,
  transcriptDocumentId,
  transcriptionAvailable,
  aggregateDocumentCount = 0,
}: EventTranscriptPanelProps) {
  const { toast } = useToast();

  // Transcript state
  const [transcript, setTranscript] = useState(initialTranscript);
  const [aggregateTranscript, setAggregateTranscript] = useState(initialAggregateTranscript);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [detectedLanguage, setDetectedLanguage] = useState<string | null>(null);
  const [docCount, setDocCount] = useState(aggregateDocumentCount);

  // Recording state
  const [pipelineStatus, setPipelineStatus] = useState<PipelineStatus>("idle");
  const [speakerLabel, setSpeakerLabel] = useState("");
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [kgPushPending, setKgPushPending] = useState(false);

  // Refs for recording
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---------------------------------------------------------------------------
  // Recording lifecycle
  // ---------------------------------------------------------------------------

  const stopTracks = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const submitAudio = useCallback(
    async (blob: Blob) => {
      setPipelineStatus("uploading");

      const formData = new FormData();
      formData.append(
        "audio",
        new File([blob], `event-${eventId}-${Date.now()}.webm`, { type: blob.type }),
      );
      if (speakerLabel.trim()) {
        formData.append("speakerLabel", speakerLabel.trim());
      }

      try {
        setPipelineStatus("processing");

        const response = await fetch(`/api/events/${eventId}/transcribe`, {
          method: "POST",
          body: formData,
        });

        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          text?: string;
          language?: string | null;
          segments?: TranscriptSegment[];
          transcriptContent?: string;
          aggregateTranscriptContent?: string;
          aggregateTranscriptDocumentCount?: number;
        };

        if (!response.ok) {
          throw new Error(payload.error || "Failed to transcribe audio.");
        }

        // Update transcript content
        if (typeof payload.transcriptContent === "string") {
          setTranscript(payload.transcriptContent);
        }
        if (typeof payload.aggregateTranscriptContent === "string") {
          setAggregateTranscript(payload.aggregateTranscriptContent);
        }
        if (typeof payload.aggregateTranscriptDocumentCount === "number") {
          setDocCount(payload.aggregateTranscriptDocumentCount);
        }

        // Update segments from WhisperX response
        if (Array.isArray(payload.segments) && payload.segments.length > 0) {
          setSegments((prev) => [...prev, ...payload.segments as TranscriptSegment[]]);
        }

        // Update detected language
        if (payload.language) {
          setDetectedLanguage(payload.language);
        }

        setPipelineStatus("complete");

        toast({
          title: "Transcript updated",
          description: payload.text
            ? `Added: "${payload.text.slice(0, 100)}${payload.text.length > 100 ? "..." : ""}"`
            : "Transcript segment added.",
        });

        // Auto-reset status after a few seconds
        setTimeout(() => {
          setPipelineStatus((current) => (current === "complete" ? "idle" : current));
        }, 3000);
      } catch (error) {
        setPipelineStatus("error");
        toast({
          title: "Transcription failed",
          description: error instanceof Error ? error.message : "Failed to transcribe audio.",
          variant: "destructive",
        });

        // Auto-reset error status
        setTimeout(() => {
          setPipelineStatus((current) => (current === "error" ? "idle" : current));
        }, 5000);
      }
    },
    [eventId, speakerLabel, toast],
  );

  const handleStartRecording = useCallback(async () => {
    if (!transcriptionAvailable) {
      toast({
        title: "Transcription unavailable",
        description: "Configure WhisperX or an audio transcription provider on this deployment.",
        variant: "destructive",
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });

      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        stopTracks();
        if (blob.size > 0) {
          submitAudio(blob);
        } else {
          setPipelineStatus("idle");
        }
      };

      recorder.onerror = () => {
        stopTracks();
        setPipelineStatus("error");
        toast({
          title: "Recording failed",
          description: "An error occurred while recording audio.",
          variant: "destructive",
        });
      };

      // Start duration timer
      setRecordingDuration(0);
      timerRef.current = setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);

      recorder.start();
      setPipelineStatus("recording");
    } catch (error) {
      stopTracks();
      const isDenied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      toast({
        title: isDenied ? "Microphone access denied" : "Recording failed",
        description: isDenied
          ? "Please allow microphone access and try again."
          : error instanceof Error
            ? error.message
            : "Failed to start recording.",
        variant: "destructive",
      });
    }
  }, [transcriptionAvailable, stopTracks, submitAudio, toast]);

  const handleStopRecording = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // KG Push
  // ---------------------------------------------------------------------------

  const handlePushToKg = useCallback(async () => {
    if (!transcript.trim() && !aggregateTranscript.trim()) {
      toast({
        title: "Nothing to push",
        description: "Record transcript segments first before pushing to KG.",
        variant: "destructive",
      });
      return;
    }

    setKgPushPending(true);
    try {
      const response = await fetch("/api/autobot/kg/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Event Transcript — ${eventId}`,
          content: aggregateTranscript.trim() || transcript.trim(),
          doc_type: "event-transcript",
          scope_type: "event",
          scope_id: eventId,
          metadata: {
            eventId,
            language: detectedLanguage,
            segmentCount: segments.length,
            source: "whisperx-live-transcription",
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          (errorData as { error?: string }).error ?? `KG ingest failed (${response.status})`,
        );
      }

      toast({
        title: "Pushed to Knowledge Graph",
        description: "Transcript has been ingested into the Autobot KG for context and retrieval.",
      });
    } catch (error) {
      toast({
        title: "KG push failed",
        description: error instanceof Error ? error.message : "Failed to push transcript to KG.",
        variant: "destructive",
      });
    } finally {
      setKgPushPending(false);
    }
  }, [transcript, aggregateTranscript, eventId, detectedLanguage, segments.length, toast]);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const isRecording = pipelineStatus === "recording";
  const isBusy = pipelineStatus === "uploading" || pipelineStatus === "processing";
  const hasTranscript = transcript.trim().length > 0 || aggregateTranscript.trim().length > 0;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="bg-background rounded-lg border p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <BookOpen className="h-5 w-5" />
            Live Event Transcription
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Record segments during the event. WhisperX provides speaker diarization and
            timestamped transcripts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {transcriptDocumentId ? (
            <Badge variant="secondary" className="text-xs">
              <CheckCircle2 className="mr-1 h-3 w-3" />
              Doc active
            </Badge>
          ) : null}
          {detectedLanguage ? (
            <Badge variant="outline" className="text-xs">
              <Globe className="mr-1 h-3 w-3" />
              {detectedLanguage.toUpperCase()}
            </Badge>
          ) : null}
        </div>
      </div>

      {/* Pipeline status indicator */}
      <div
        className={cn(
          "flex items-center gap-3 rounded-md px-4 py-2 text-sm font-medium transition-colors",
          STATUS_COLORS[pipelineStatus],
        )}
      >
        {pipelineStatus === "recording" && (
          <span className="relative flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
          </span>
        )}
        {(pipelineStatus === "uploading" || pipelineStatus === "processing") && (
          <Loader2 className="h-4 w-4 animate-spin" />
        )}
        {pipelineStatus === "complete" && <CheckCircle2 className="h-4 w-4" />}
        <span>{STATUS_LABELS[pipelineStatus]}</span>
        {isRecording && (
          <span className="ml-auto tabular-nums font-mono text-xs">
            {formatTimestamp(recordingDuration)}
          </span>
        )}
        {isBusy && (
          <Progress className="ml-auto w-24 h-2" value={pipelineStatus === "uploading" ? 40 : 75} />
        )}
      </div>

      {/* Recording controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          value={speakerLabel}
          onChange={(event) => setSpeakerLabel(event.target.value)}
          placeholder="Speaker label (optional)"
          className="sm:max-w-xs"
          disabled={isRecording || isBusy}
        />
        <Button
          type="button"
          onClick={isRecording ? handleStopRecording : handleStartRecording}
          disabled={isBusy}
          variant={isRecording ? "destructive" : "default"}
          className="min-w-[180px]"
        >
          {isBusy ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : isRecording ? (
            <Square className="mr-2 h-4 w-4" />
          ) : (
            <Mic className="mr-2 h-4 w-4" />
          )}
          {isBusy ? "Transcribing..." : isRecording ? "Stop recording" : "Record transcript"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={handlePushToKg}
          disabled={!hasTranscript || kgPushPending || isBusy}
          className="min-w-[140px]"
        >
          {kgPushPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-2 h-4 w-4" />
          )}
          Push to KG
        </Button>
      </div>

      {/* Timestamped segments from WhisperX */}
      {segments.length > 0 && (
        <div className="rounded-md border bg-muted/10 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-medium text-foreground">
              Timestamped segments ({segments.length})
            </div>
            {detectedLanguage && (
              <Badge variant="outline" className="text-xs">
                Language: {detectedLanguage}
              </Badge>
            )}
          </div>
          <ScrollArea className="max-h-[300px]">
            <div className="space-y-2">
              {segments.map((seg, idx) => (
                <div
                  key={`${seg.start}-${seg.end}-${idx}`}
                  className="flex items-start gap-3 rounded px-2 py-1.5 text-sm hover:bg-muted/30 transition-colors"
                >
                  <span className="shrink-0 tabular-nums font-mono text-xs text-muted-foreground pt-0.5 min-w-[90px]">
                    <Clock className="inline h-3 w-3 mr-1" />
                    {formatTimestamp(seg.start)} - {formatTimestamp(seg.end)}
                  </span>
                  {seg.speaker && (
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      <User className="mr-1 h-3 w-3" />
                      {seg.speaker}
                    </Badge>
                  )}
                  <span className="text-foreground">{seg.text}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      <Separator />

      {/* Personal transcript */}
      <div className="rounded-md border bg-muted/20 p-4">
        <div className="mb-3 text-sm font-medium text-foreground">Your transcript</div>
        <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
          {transcript.trim() || "No personal transcript yet. Record the first segment to create your event transcript document."}
        </pre>
      </div>

      {/* Aggregate transcript */}
      <div className="rounded-md border bg-muted/10 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">Aggregate event transcript</div>
          <div className="text-xs text-muted-foreground">
            {docCount} {docCount === 1 ? "attendee doc" : "attendee docs"}
          </div>
        </div>
        <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
          {aggregateTranscript.trim() || "No attendee transcripts have been recorded yet."}
        </pre>
      </div>
    </div>
  );
}
