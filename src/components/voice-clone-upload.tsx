"use client";

import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Upload, CheckCircle2, Mic2, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

type CloneStatus = "none" | "uploading" | "uploaded" | "active";

interface VoiceCloneUploadProps {
  onVoiceSampleChange?: (sample: { fileName: string; size: number } | null) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function VoiceCloneUpload({
  onVoiceSampleChange,
  className,
}: VoiceCloneUploadProps) {
  const [status, setStatus] = useState<CloneStatus>("none");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number>(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      setError(null);

      // Validate file type
      const isAccepted = ACCEPTED_AUDIO_TYPES.some(
        (type) => file.type === type,
      );
      const extensionMatch = file.name.match(/\.(mp3|wav|m4a|ogg|webm|mp4)$/i);
      if (!isAccepted && !extensionMatch) {
        setError(
          "Unsupported file format. Please upload an MP3, WAV, M4A, OGG, or WebM file.",
        );
        return;
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setError(`File is too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`);
        return;
      }

      setStatus("uploading");
      setFileName(file.name);
      setFileSize(file.size);
      setUploadProgress(0);

      // Simulate upload progress (actual upload integration will come later
      // with VAST.ai / ElevenLabs)
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 90) {
            clearInterval(progressInterval);
            return 90;
          }
          return prev + 10;
        });
      }, 100);

      // Store the voice sample reference locally
      // In production, this would upload to object storage
      try {
        // Store reference in localStorage for now
        const sampleRef = {
          fileName: file.name,
          size: file.size,
          type: file.type,
          uploadedAt: new Date().toISOString(),
        };

        localStorage.setItem(
          "rivr_voice_clone_sample",
          JSON.stringify(sampleRef),
        );

        clearInterval(progressInterval);
        setUploadProgress(100);

        // Brief delay to show 100%
        await new Promise((resolve) => setTimeout(resolve, 300));

        setStatus("uploaded");
        onVoiceSampleChange?.({ fileName: file.name, size: file.size });
      } catch (err) {
        clearInterval(progressInterval);
        setError("Failed to store voice sample.");
        setStatus("none");
        setFileName(null);
      }

      // Reset the input so the same file can be re-selected
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [onVoiceSampleChange],
  );

  const handleRemoveSample = useCallback(() => {
    localStorage.removeItem("rivr_voice_clone_sample");
    setStatus("none");
    setFileName(null);
    setFileSize(0);
    setUploadProgress(0);
    setError(null);
    onVoiceSampleChange?.(null);
  }, [onVoiceSampleChange]);

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const statusBadge = () => {
    switch (status) {
      case "none":
        return (
          <Badge variant="secondary" className="text-xs">
            No voice clone
          </Badge>
        );
      case "uploading":
        return (
          <Badge variant="outline" className="text-xs">
            Uploading...
          </Badge>
        );
      case "uploaded":
        return (
          <Badge
            variant="default"
            className="text-xs gap-1 bg-emerald-600 hover:bg-emerald-700"
          >
            <CheckCircle2 className="h-3 w-3" />
            Voice sample uploaded
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
            <span className="text-sm font-medium">Voice Clone</span>
          </div>
          {statusBadge()}
        </div>

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

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
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
              <span className="truncate max-w-[180px]">{fileName}</span>
              <span>({formatFileSize(fileSize)})</span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={handleRemoveSample}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}

        {(status === "none" || status === "uploaded") && (
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
              {status === "uploaded"
                ? "Replace voice sample"
                : "Upload voice sample"}
            </Button>
            <p className="text-[10px] text-muted-foreground mt-1.5 text-center">
              MP3, WAV, M4A, OGG, or WebM. Max {MAX_FILE_SIZE_MB}MB.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
