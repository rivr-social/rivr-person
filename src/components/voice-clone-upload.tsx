"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  CheckCircle2,
  Loader2,
  Mic2,
  Pause,
  Play,
  Square,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { VoiceSample } from "@/lib/autobot-user-settings";

const ACCEPTED_AUDIO_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/ogg",
  "audio/webm",
] as const;

const ACCEPTED_EXTENSIONS = ".mp3,.wav,.m4a,.ogg,.webm,.mp4";
const MAX_FILE_SIZE_MB = 25;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;
const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
] as const;
const SAMPLE_PROMPTS = [
  "Hello, this is my Rivr voice sample. I am recording a calm, clear baseline voice for my autobot.",
  "I care about local relationships, practical coordination, and speaking clearly enough for transcripts and live collaboration.",
  "Please use this voice as the reference sample for my cloned speech when a GPU-backed voice runtime is active.",
] as const;

type CloneStatus = "none" | "uploading" | "uploaded" | "active";

interface VoiceCloneUploadProps {
  initialSample?: VoiceSample | null;
  onVoiceSampleChange?: (sample: VoiceSample | null) => void;
  className?: string;
}

export function VoiceCloneUpload({
  initialSample = null,
  onVoiceSampleChange,
  className,
}: VoiceCloneUploadProps) {
  const [status, setStatus] = useState<CloneStatus>(initialSample ? "uploaded" : "none");
  const [fileName, setFileName] = useState<string | null>(initialSample?.fileName ?? null);
  const [fileSize, setFileSize] = useState<number>(initialSample?.size ?? 0);
  const [uploadedAt, setUploadedAt] = useState<string | null>(initialSample?.uploadedAt ?? null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  const promptText = useMemo(() => SAMPLE_PROMPTS.join(" "), []);

  useEffect(() => {
    if (!initialSample) return;
    setStatus("uploaded");
    setFileName(initialSample.fileName);
    setFileSize(initialSample.size);
    setUploadedAt(initialSample.uploadedAt);
  }, [initialSample]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (previewAudioRef.current) previewAudioRef.current.pause();
    };
  }, [previewUrl]);

  const getSupportedMimeType = useCallback((): string => {
    if (typeof MediaRecorder === "undefined") return "audio/webm";
    for (const mimeType of RECORDING_MIME_TYPES) {
      if (MediaRecorder.isTypeSupported(mimeType)) return mimeType;
    }
    return "audio/webm";
  }, []);

  const persistSample = useCallback(
    async (sample: VoiceSample | null) => {
      if (sample) {
        localStorage.setItem("rivr_voice_clone_sample", JSON.stringify(sample));
      } else {
        localStorage.removeItem("rivr_voice_clone_sample");
      }

      await fetch("/api/autobot/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceSample: sample }),
      }).catch(() => {});

      onVoiceSampleChange?.(sample);
    },
    [onVoiceSampleChange],
  );

  const uploadAudioFile = useCallback(
    async (file: File) => {
      setStatus("uploading");
      setUploadProgress(0);
      setError(null);
      setFileName(file.name);
      setFileSize(file.size);

      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => (prev >= 90 ? 90 : prev + 10));
      }, 120);

      try {
        const formData = new FormData();
        formData.append("audio", file);

        const response = await fetch("/api/autobot/voice/upload", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(
            typeof data.error === "string" ? data.error : `Upload failed (${response.status})`,
          );
        }

        const data = (await response.json()) as {
          sample?: VoiceSample;
        };
        const uploadedAt = data.sample?.uploadedAt || new Date().toISOString();
        const sample: VoiceSample = {
          fileName: data.sample?.fileName || file.name,
          size: data.sample?.size ?? file.size,
          mimeType: data.sample?.mimeType || file.type || undefined,
          uploadedAt,
        };

        clearInterval(progressInterval);
        setUploadProgress(100);
        setUploadedAt(uploadedAt);
        setStatus("uploaded");
        await persistSample(sample);
      } catch (err) {
        clearInterval(progressInterval);
        setStatus("none");
        setUploadProgress(0);
        setError(err instanceof Error ? err.message : "Failed to upload voice sample.");
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [persistSample],
  );

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setError(null);
      const isAccepted = ACCEPTED_AUDIO_TYPES.some((type) => file.type === type);
      const extensionMatch = file.name.match(/\.(mp3|wav|m4a|ogg|webm|mp4)$/i);
      if (!isAccepted && !extensionMatch) {
        setError("Unsupported file format. Please upload MP3, WAV, M4A, OGG, WebM, or MP4.");
        return;
      }
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setError(`File is too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`);
        return;
      }

      await uploadAudioFile(file);
    },
    [uploadAudioFile],
  );

  const handleRemoveSample = useCallback(() => {
    setStatus("none");
    setFileName(null);
    setFileSize(0);
    setUploadedAt(null);
    setUploadProgress(0);
    setError(null);
    setRecordedBlob(null);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    }
    persistSample(null);
  }, [persistSample, previewUrl]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 24000,
        },
      });
      streamRef.current = stream;
      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mimeType });
        setRecordedBlob(blob);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(URL.createObjectURL(blob));
        setRecording(false);
      };

      recorder.start();
      setError(null);
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Microphone access failed.");
    }
  }, [getSupportedMimeType, previewUrl]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const togglePreviewPlayback = useCallback(() => {
    if (!previewUrl) return;
    if (!previewAudioRef.current) {
      const audio = new Audio(previewUrl);
      audio.onended = () => setIsPreviewPlaying(false);
      previewAudioRef.current = audio;
    }
    const audio = previewAudioRef.current;
    if (isPreviewPlaying) {
      audio.pause();
      audio.currentTime = 0;
      setIsPreviewPlaying(false);
      return;
    }
    audio.play().then(() => setIsPreviewPlaying(true)).catch(() => {
      setIsPreviewPlaying(false);
      setError("Could not play back the recording preview.");
    });
  }, [isPreviewPlaying, previewUrl]);

  const uploadRecordedSample = useCallback(async () => {
    if (!recordedBlob) return;
    const extension = recordedBlob.type.includes("mp4")
      ? "mp4"
      : recordedBlob.type.includes("ogg")
        ? "ogg"
        : "webm";
    const file = new File([recordedBlob], `voice-sample.${extension}`, {
      type: recordedBlob.type || "audio/webm",
    });
    await uploadAudioFile(file);
  }, [recordedBlob, uploadAudioFile]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const statusBadge = () => {
    switch (status) {
      case "none":
        return <Badge variant="secondary" className="text-xs">No voice sample</Badge>;
      case "uploading":
        return <Badge variant="outline" className="text-xs">Uploading...</Badge>;
      case "uploaded":
        return (
          <Badge variant="default" className="text-xs gap-1 bg-emerald-600 hover:bg-emerald-700">
            <CheckCircle2 className="h-3 w-3" />
            Voice sample saved
          </Badge>
        );
      case "active":
        return (
          <Badge variant="default" className="text-xs gap-1">
            <Mic2 className="h-3 w-3" />
            Clone active
          </Badge>
        );
    }
  };

  return (
    <Card className={cn("border-dashed", className)}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mic2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Voice Sample</span>
          </div>
          {statusBadge()}
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        {status === "uploading" && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate max-w-[200px]">{fileName}</span>
              <span>{uploadProgress}%</span>
            </div>
            <Progress value={uploadProgress} className="h-1.5" />
          </div>
        )}

        {status === "uploaded" && fileName && (
          <div className="space-y-1 text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                <span className="truncate max-w-[180px]">{fileName}</span>
                <span>({formatFileSize(fileSize)})</span>
              </div>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={handleRemoveSample}>
                <X className="h-3 w-3" />
              </Button>
            </div>
            {uploadedAt && (
              <p className="text-[10px] text-muted-foreground">
                Saved {new Date(uploadedAt).toLocaleString()}
              </p>
            )}
          </div>
        )}

        <div className="rounded-md border bg-muted/20 p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium">Create a voice sample here</p>
              <p className="text-[10px] text-muted-foreground">
                Read the prompt below in a steady voice for 15-30 seconds.
              </p>
            </div>
            <Button
              type="button"
              variant={recording ? "destructive" : "outline"}
              size="sm"
              className="gap-2 text-xs shrink-0"
              onClick={recording ? stopRecording : startRecording}
            >
              {recording ? <Square className="h-3.5 w-3.5" /> : <Mic2 className="h-3.5 w-3.5" />}
              {recording ? "Stop" : "Record"}
            </Button>
          </div>
          <div className="rounded-md bg-background p-3 text-xs leading-relaxed text-foreground/90">
            {promptText}
          </div>
          {previewUrl && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Recording ready</span>
              <Button type="button" variant="outline" size="sm" className="gap-2 text-xs" onClick={togglePreviewPlayback}>
                {isPreviewPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {isPreviewPlaying ? "Stop preview" : "Preview"}
              </Button>
              <Button
                type="button"
                size="sm"
                className="gap-2 text-xs"
                onClick={uploadRecordedSample}
                disabled={status === "uploading"}
              >
                {status === "uploading" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                Upload recording
              </Button>
            </div>
          )}
        </div>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS}
            onChange={handleFileSelect}
            className="hidden"
            aria-label="Upload voice sample"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            className="w-full gap-2 text-xs"
          >
            <Upload className="h-3.5 w-3.5" />
            {status === "uploaded" ? "Replace with uploaded file" : "Upload an existing sample"}
          </Button>
          <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
            MP3, WAV, M4A, OGG, or WebM. Max {MAX_FILE_SIZE_MB}MB.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
