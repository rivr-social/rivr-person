"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { ArrowLeft, CheckCircle2, FileText, Loader2, Mic, MicOff, RotateCcw, Save } from "lucide-react";
import { createPersonalDocumentAction } from "@/app/actions/create-resources";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// SpeechRecognition type bridge (vendor-prefixed in most browsers)
// ---------------------------------------------------------------------------

type SpeechRecognitionEvent = {
  resultIndex: number;
  results: SpeechRecognitionResultList;
};

type SpeechRecognitionErrorEvent = {
  error: string;
  message?: string;
};

type SpeechRecognitionInstance = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
};

function createSpeechRecognition(): SpeechRecognitionInstance | null {
  if (typeof window === "undefined") return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  return new SpeechRecognition() as SpeechRecognitionInstance;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildDefaultTitle() {
  const timestamp = new Date();
  const date = timestamp.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const time = timestamp.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `Session Record ${date} ${time}`;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SessionRecordPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();

  // Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [interimText, setInterimText] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shouldRestartRef = useRef(false);

  // Document state
  const [title, setTitle] = useState(buildDefaultTitle);
  const [summary, setSummary] = useState("");
  const [transcript, setTranscript] = useState("");
  const [lastSavedDocumentId, setLastSavedDocumentId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  // Ref to always have latest transcript in callbacks without stale closures
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  // Check browser support on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const has = !!(window as any).SpeechRecognition || !!(window as any).webkitSpeechRecognition;
      setSupported(has);
    }
  }, []);

  const appendFinalText = useCallback((text: string) => {
    const cleaned = text.trim();
    if (!cleaned) return;
    setTranscript((current) => {
      const trimmed = current.trim();
      return trimmed.length > 0 ? `${trimmed} ${cleaned}` : cleaned;
    });
    setLastSavedDocumentId(null);
    setLastError(null);
  }, []);

  const stopRecording = useCallback(() => {
    shouldRestartRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.onresult = null;
      recognitionRef.current.onerror = null;
      try { recognitionRef.current.stop(); } catch { /* already stopped */ }
      recognitionRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
    setInterimText("");
  }, []);

  const startRecording = useCallback(() => {
    const recognition = createSpeechRecognition();
    if (!recognition) {
      setSupported(false);
      return;
    }

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) {
          appendFinalText(text);
        } else {
          interim += text;
        }
      }
      setInterimText(interim);
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // "no-speech" and "aborted" are recoverable — just let onend restart
      if (event.error === "no-speech" || event.error === "aborted") return;
      stopRecording();
      const message =
        event.error === "not-allowed"
          ? "Microphone access was denied. Please allow microphone access and try again."
          : `Speech recognition error: ${event.error}`;
      setLastError(message);
      toast({ title: "Recording error", description: message, variant: "destructive" });
    };

    recognition.onend = () => {
      // Browser auto-stops recognition periodically — restart if we're still recording
      if (shouldRestartRef.current) {
        try {
          recognition.start();
        } catch {
          stopRecording();
        }
      }
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
      shouldRestartRef.current = true;
      setIsRecording(true);
      setLastError(null);
      setInterimText("");

      // Start elapsed timer
      const startTime = Date.now() - elapsed * 1000;
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start speech recognition.";
      setLastError(message);
      toast({ title: "Recording failed", description: message, variant: "destructive" });
    }
  }, [appendFinalText, stopRecording, elapsed, toast]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldRestartRef.current = false;
      if (recognitionRef.current) {
        try { recognitionRef.current.abort(); } catch { /* noop */ }
      }
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const handleToggle = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  const handleReset = () => {
    stopRecording();
    setSummary("");
    setTranscript("");
    setElapsed(0);
    setLastSavedDocumentId(null);
    setLastError(null);
    setTitle(buildDefaultTitle());
  };

  const handleSave = () => {
    const resolvedTitle = title.trim();
    const resolvedTranscript = transcript.trim();

    if (!resolvedTitle || !resolvedTranscript) {
      toast({
        title: "Nothing to save",
        description: "Record a session and give it a title before saving.",
        variant: "destructive",
      });
      return;
    }

    startTransition(async () => {
      const description = summary.trim() || "Transcript captured from live session recording.";
      const result = await createPersonalDocumentAction({
        title: resolvedTitle,
        description,
        content: resolvedTranscript,
        category: "Session Record",
        tags: ["session-record", "transcript"],
      });

      if (!result.success || !result.resourceId) {
        const message = result.message || "Failed to save session record.";
        setLastError(message);
        toast({ title: "Save failed", description: message, variant: "destructive" });
        return;
      }

      setLastSavedDocumentId(result.resourceId);
      setLastError(null);
      toast({ title: "Session record saved", description: "Your transcript was saved to personal documents." });
    });
  };

  const wordCount = transcript.trim().length > 0 ? transcript.trim().split(/\s+/).length : 0;

  return (
    <div className="container mx-auto max-w-5xl px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Link href="/profile" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back to profile
          </Link>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Session Record</h1>
            <p className="text-sm text-muted-foreground">
              Hit record and start talking. Your speech is transcribed in real time.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isRecording && (
            <Badge variant="destructive" className="animate-pulse">
              Recording {formatDuration(elapsed)}
            </Badge>
          )}
          <Badge variant={transcript.trim().length > 0 ? "default" : "outline"}>
            {wordCount > 0 ? `${wordCount} words` : "No transcript yet"}
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        {/* Left panel — Controls */}
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mic className="h-5 w-5" />
              Recorder
            </CardTitle>
            <CardDescription>
              Tap to start. Text appears as you speak.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!supported ? (
              <Alert variant="destructive">
                <AlertTitle>Not supported</AlertTitle>
                <AlertDescription>
                  Your browser does not support speech recognition. Try Chrome or Edge.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="flex flex-col items-center gap-3">
                <Button
                  type="button"
                  variant={isRecording ? "destructive" : "default"}
                  size="lg"
                  onClick={handleToggle}
                  disabled={isPending}
                  className={cn(
                    "relative h-20 w-20 rounded-full transition-all",
                    isRecording && "ring-4 ring-red-500/30",
                  )}
                  aria-label={isRecording ? "Stop recording" : "Start recording"}
                >
                  {isRecording ? (
                    <>
                      <MicOff className="h-8 w-8" />
                      <span className="absolute -top-1 -right-1 h-4 w-4">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                        <span className="relative inline-flex h-4 w-4 rounded-full bg-red-500" />
                      </span>
                    </>
                  ) : (
                    <Mic className="h-8 w-8" />
                  )}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {isRecording ? "Listening... tap to stop" : "Tap to start recording"}
                </span>
              </div>
            )}

            {/* Live interim preview */}
            {isRecording && interimText && (
              <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
                <p className="text-sm italic text-muted-foreground">{interimText}</p>
              </div>
            )}

            {lastSavedDocumentId && (
              <Alert>
                <CheckCircle2 className="h-4 w-4" />
                <AlertTitle>Saved to personal docs</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>Your session record is now available in your profile docs.</p>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/profile?tab=docs&doc=${lastSavedDocumentId}`}>Open saved document</Link>
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {lastError && (
              <Alert variant="destructive">
                <AlertTitle>Issue</AlertTitle>
                <AlertDescription>{lastError}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Right panel — Transcript Editor */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Transcript
            </CardTitle>
            <CardDescription>
              Text appears here as you speak. Edit before saving if needed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="session-record-title">Title</Label>
                <Input
                  id="session-record-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Session title"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="session-record-summary">Summary</Label>
                <Input
                  id="session-record-summary"
                  value={summary}
                  onChange={(event) => setSummary(event.target.value)}
                  placeholder="Optional short summary"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="session-record-transcript">Transcript</Label>
              <Textarea
                id="session-record-transcript"
                value={transcript + (interimText ? (transcript.trim() ? ` ${interimText}` : interimText) : "")}
                onChange={(event) => {
                  // Only allow editing when not actively receiving interim results
                  if (!isRecording) {
                    setTranscript(event.target.value);
                  }
                }}
                readOnly={isRecording}
                placeholder="Your transcript will appear here as you speak."
                className={cn("min-h-[420px]", isRecording && "border-primary/40")}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {wordCount > 0 ? `${wordCount} words captured` : "No transcript yet"}
                {elapsed > 0 && ` \u00b7 ${formatDuration(elapsed)} recorded`}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" onClick={handleReset} disabled={isPending || isRecording}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset
                </Button>
                <Button type="button" variant="outline" onClick={() => router.push("/profile?tab=docs")} disabled={isPending}>
                  View Docs
                </Button>
                <Button type="button" onClick={handleSave} disabled={isPending || isRecording || !title.trim() || !transcript.trim()}>
                  {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
