"use client";

import { useRef, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";

type EventTranscriptPanelProps = {
  eventId: string;
  initialTranscript: string;
  initialAggregateTranscript: string;
  transcriptDocumentId?: string | null;
  transcriptionAvailable: boolean;
  aggregateDocumentCount?: number;
};

export function EventTranscriptPanel({
  eventId,
  initialTranscript,
  initialAggregateTranscript,
  transcriptDocumentId,
  transcriptionAvailable,
  aggregateDocumentCount = 0,
}: EventTranscriptPanelProps) {
  const { toast } = useToast();
  const [transcript, setTranscript] = useState(initialTranscript);
  const [aggregateTranscript, setAggregateTranscript] = useState(initialAggregateTranscript);
  const [speakerLabel, setSpeakerLabel] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const handleStartRecording = async () => {
    if (!transcriptionAvailable) {
      toast({
        title: "Transcription unavailable",
        description: "Configure Whisper or an audio transcription provider on this deployment.",
        variant: "destructive",
      });
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        stopTracks();
        if (blob.size === 0) return;

        const formData = new FormData();
        formData.append("audio", new File([blob], `event-${eventId}-${Date.now()}.webm`, { type: blob.type }));
        if (speakerLabel.trim()) {
          formData.append("speakerLabel", speakerLabel.trim());
        }

        setIsSubmitting(true);
        try {
          const response = await fetch(`/api/events/${eventId}/transcribe`, {
            method: "POST",
            body: formData,
          });
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string;
            text?: string;
            transcriptContent?: string;
            aggregateTranscriptContent?: string;
          };

          if (!response.ok) {
            throw new Error(payload.error || "Failed to transcribe audio.");
          }

          if (typeof payload.transcriptContent === "string") {
            setTranscript(payload.transcriptContent);
          }
          if (typeof payload.aggregateTranscriptContent === "string") {
            setAggregateTranscript(payload.aggregateTranscriptContent);
          }

          toast({
            title: "Transcript updated",
            description: payload.text ? `Added segment: ${payload.text.slice(0, 120)}` : "Transcript segment added.",
          });
        } catch (error) {
          toast({
            title: "Transcript failed",
            description: error instanceof Error ? error.message : "Failed to transcribe audio.",
            variant: "destructive",
          });
        } finally {
          setIsSubmitting(false);
        }
      };

      recorder.start();
      setIsRecording(true);
    } catch (error) {
      stopTracks();
      toast({
        title: "Microphone unavailable",
        description: error instanceof Error ? error.message : "Unable to access microphone.",
        variant: "destructive",
      });
    }
  };

  const handleStopRecording = () => {
    if (!recorderRef.current) return;
    recorderRef.current.stop();
    recorderRef.current = null;
    setIsRecording(false);
  };

  return (
    <div className="bg-background rounded-lg border p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Meeting Transcript</h2>
          <p className="text-sm text-muted-foreground">
            Group members with an active RSVP can record transcript segments into their own event transcript document.
          </p>
        </div>
        {transcriptDocumentId ? (
          <div className="text-xs text-muted-foreground">Your transcript document is active</div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          value={speakerLabel}
          onChange={(event) => setSpeakerLabel(event.target.value)}
          placeholder="Speaker label (optional)"
          className="sm:max-w-xs"
        />
        <Button
          type="button"
          onClick={isRecording ? handleStopRecording : handleStartRecording}
          disabled={isSubmitting}
          variant={isRecording ? "destructive" : "default"}
        >
          {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : isRecording ? <Square className="mr-2 h-4 w-4" /> : <Mic className="mr-2 h-4 w-4" />}
          {isSubmitting ? "Transcribing…" : isRecording ? "Stop recording" : "Record transcript"}
        </Button>
      </div>

      <div className="mt-4 rounded-md border bg-muted/20 p-4">
        <div className="mb-3 text-sm font-medium text-foreground">Your transcript</div>
        <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
          {transcript.trim() || "No personal transcript yet. Record the first segment to create your event transcript document."}
        </pre>
      </div>

      <div className="mt-4 rounded-md border bg-muted/10 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">Aggregate event transcript</div>
          <div className="text-xs text-muted-foreground">
            {aggregateDocumentCount} {aggregateDocumentCount === 1 ? "attendee doc" : "attendee docs"}
          </div>
        </div>
        <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
          {aggregateTranscript.trim() || "No attendee transcripts have been recorded yet."}
        </pre>
      </div>
    </div>
  );
}
