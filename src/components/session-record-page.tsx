"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowLeft, CheckCircle2, FileText, Loader2, Mic, RotateCcw, Save } from "lucide-react";
import { createPersonalDocumentAction } from "@/app/actions/create-resources";
import { VoiceRecorder, type VoiceRecorderError } from "@/components/voice-recorder";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";

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

export function SessionRecordPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState(buildDefaultTitle);
  const [summary, setSummary] = useState("");
  const [transcript, setTranscript] = useState("");
  const [segmentCount, setSegmentCount] = useState(0);
  const [lastSavedDocumentId, setLastSavedDocumentId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const handleTranscription = (text: string) => {
    const cleaned = text.trim();
    if (!cleaned) return;

    setLastError(null);
    setLastSavedDocumentId(null);
    setSegmentCount((current) => current + 1);
    setTranscript((current) => (current.trim().length > 0 ? `${current.trim()}\n\n${cleaned}` : cleaned));
  };

  const handleRecorderError = (error: VoiceRecorderError) => {
    setLastError(error.message);
    toast({
      title: "Recording failed",
      description: error.message,
      variant: "destructive",
    });
  };

  const handleReset = () => {
    setSummary("");
    setTranscript("");
    setSegmentCount(0);
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
      const description = summary.trim() || `Transcript captured from ${segmentCount || 1} recording segment${segmentCount === 1 ? "" : "s"}.`;
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
        toast({
          title: "Save failed",
          description: message,
          variant: "destructive",
        });
        return;
      }

      setLastSavedDocumentId(result.resourceId);
      setLastError(null);
      toast({
        title: "Session record saved",
        description: "Your transcript was saved to personal documents.",
      });
    });
  };

  return (
    <div className="container mx-auto max-w-5xl px-4 py-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <Link href="/profile" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back to profile
          </Link>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Session Record</h1>
            <p className="text-sm text-muted-foreground">
              Record voice notes, transcribe them, and save the result as a personal document.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">{segmentCount} segment{segmentCount === 1 ? "" : "s"}</Badge>
          <Badge variant={transcript.trim().length > 0 ? "default" : "outline"}>
            {transcript.trim().length > 0 ? "Transcript ready" : "Waiting to record"}
          </Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mic className="h-5 w-5" />
              Recorder
            </CardTitle>
            <CardDescription>
              Tap the mic, speak, then tap again to transcribe that segment.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <VoiceRecorder onTranscription={handleTranscription} onError={handleRecorderError} className="h-12 w-12" />
              <div className="text-sm text-muted-foreground">
                Each stop appends a new transcript block.
              </div>
            </div>

            {lastSavedDocumentId ? (
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
            ) : null}

            {lastError ? (
              <Alert variant="destructive">
                <AlertTitle>Recorder issue</AlertTitle>
                <AlertDescription>{lastError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground space-y-2">
              <p className="font-medium text-foreground">Workflow</p>
              <p>1. Record one or more segments.</p>
              <p>2. Clean up the transcript and add a short summary.</p>
              <p>3. Save it as a personal document.</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Transcript Editor
            </CardTitle>
            <CardDescription>
              Review the text before saving. This creates a private document in your personal docs.
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
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                placeholder="Your transcript will appear here after recording."
                className="min-h-[420px]"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {transcript.trim().length > 0 ? `${transcript.trim().split(/\s+/).length} words captured` : "No transcript yet"}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" onClick={handleReset} disabled={isPending}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset
                </Button>
                <Button type="button" variant="outline" onClick={() => router.push("/profile?tab=docs")} disabled={isPending}>
                  View Docs
                </Button>
                <Button type="button" onClick={handleSave} disabled={isPending || !title.trim() || !transcript.trim()}>
                  {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  Save Session Record
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
