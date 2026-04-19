"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Mic, Square, Loader2 } from "lucide-react";
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

type RecordingState = "idle" | "recording" | "processing";

export type VoiceRecorderError = {
  message: string;
  type: "permission-denied" | "not-supported" | "recording" | "transcription";
};

interface VoiceRecorderProps {
  onTranscription: (text: string) => void;
  onError?: (error: VoiceRecorderError) => void;
  disabled?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VoiceRecorder({
  onTranscription,
  onError,
  disabled = false,
  className,
}: VoiceRecorderProps) {
  const [state, setState] = useState<RecordingState>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const getSupportedMimeType = useCallback((): string => {
    if (typeof MediaRecorder === "undefined") return "audio/webm";
    for (const mimeType of RECORDING_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
    }
    return "audio/webm";
  }, []);

  const stopMediaStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const transcribeAudio = useCallback(
    async (blob: Blob) => {
      setState("processing");
      try {
        const formData = new FormData();
        const extension = blob.type.includes("webm") ? "webm" : "ogg";
        formData.append(
          "audio",
          blob,
          `recording.${extension}`,
        );

        const response = await fetch("/api/autobot/transcribe", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error ?? `Transcription failed (${response.status})`,
          );
        }

        const data = await response.json();
        if (data.text && typeof data.text === "string") {
          onTranscription(data.text);
        } else {
          throw new Error("No transcription text returned.");
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Transcription failed.";
        onError?.({ message, type: "transcription" });
      } finally {
        setState("idle");
      }
    },
    [onTranscription, onError],
  );

  const startRecording = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) {
      onError?.({
        message: "Microphone access is not available in this browser.",
        type: "not-supported",
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
      streamRef.current = stream;

      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        stopMediaStream();
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        if (blob.size > 0) {
          transcribeAudio(blob);
        } else {
          setState("idle");
        }
      };

      recorder.onerror = () => {
        stopMediaStream();
        setState("idle");
        onError?.({ message: "Recording failed.", type: "recording" });
      };

      recorder.start();
      setState("recording");
    } catch (error) {
      stopMediaStream();
      const isDenied =
        error instanceof DOMException &&
        (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
      onError?.({
        message: isDenied
          ? "Microphone access was denied. Please allow microphone access and try again."
          : error instanceof Error
            ? error.message
            : "Failed to start recording.",
        type: isDenied ? "permission-denied" : "recording",
      });
    }
  }, [getSupportedMimeType, stopMediaStream, transcribeAudio, onError]);

  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === "recording"
    ) {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const handleClick = useCallback(() => {
    if (state === "idle") {
      startRecording();
    } else if (state === "recording") {
      stopRecording();
    }
  }, [state, startRecording, stopRecording]);

  const isDisabled = disabled || state === "processing";

  return (
    <Button
      type="button"
      variant={state === "recording" ? "destructive" : "outline"}
      size="icon"
      onClick={handleClick}
      disabled={isDisabled}
      className={cn("relative shrink-0", className)}
      aria-label={
        state === "idle"
          ? "Start recording"
          : state === "recording"
            ? "Stop recording"
            : "Processing audio"
      }
    >
      {state === "idle" && <Mic className="h-4 w-4" />}
      {state === "recording" && (
        <>
          <Square className="h-3.5 w-3.5" />
          <span className="absolute -top-1 -right-1 h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
          </span>
        </>
      )}
      {state === "processing" && (
        <Loader2 className="h-4 w-4 animate-spin" />
      )}
    </Button>
  );
}
