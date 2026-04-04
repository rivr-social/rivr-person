"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Progress } from "@/components/ui/progress";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Download,
  Loader2,
  Play,
  Trash2,
  Video,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DigitalTwinJob } from "@/lib/autobot-user-settings";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const JOB_STATUS_ENDPOINT = "/api/autobot/digital-twin";
const JOB_POLL_INTERVAL_MS = 4000;
const MAX_DISPLAYED_JOBS = 20;

const STATUS_LABELS: Record<DigitalTwinJob["status"], string> = {
  draft: "Draft",
  queued: "Queued",
  processing: "Processing",
  completed: "Completed",
  failed: "Failed",
};

const STATUS_VARIANTS: Record<DigitalTwinJob["status"], "default" | "secondary" | "destructive" | "outline"> = {
  draft: "outline",
  queued: "secondary",
  processing: "default",
  completed: "default",
  failed: "destructive",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DigitalTwinPreviewProps = {
  jobs: DigitalTwinJob[];
  onJobsChange: (jobs: DigitalTwinJob[]) => void;
  className?: string;
};

// ---------------------------------------------------------------------------
// StatusIcon
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: DigitalTwinJob["status"] }) {
  switch (status) {
    case "draft":
      return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
    case "queued":
      return <Clock className="h-3.5 w-3.5 text-amber-500" />;
    case "processing":
      return <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin" />;
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />;
    case "failed":
      return <XCircle className="h-3.5 w-3.5 text-destructive" />;
  }
}

// ---------------------------------------------------------------------------
// VideoPlayer
// ---------------------------------------------------------------------------

function VideoPlayer({ url, jobId }: { url: string; jobId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-4 text-xs text-muted-foreground">
        <AlertCircle className="h-4 w-4 shrink-0" />
        <span>Video unavailable. The output may still be processing on the worker.</span>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-md border bg-black">
      <video
        ref={videoRef}
        src={url}
        controls
        preload="metadata"
        className="w-full max-h-[320px] object-contain"
        onError={() => setHasError(true)}
        aria-label={`Digital twin video output for job ${jobId}`}
      >
        <track kind="captions" />
      </video>
    </div>
  );
}

// ---------------------------------------------------------------------------
// JobCard
// ---------------------------------------------------------------------------

function JobCard({
  job,
  onDelete,
  onRefresh,
  isDeleting,
  isRefreshing,
}: {
  job: DigitalTwinJob;
  onDelete: (jobId: string) => void;
  onRefresh: (jobId: string) => void;
  isDeleting: boolean;
  isRefreshing: boolean;
}) {
  const isActive = job.status === "queued" || job.status === "processing";
  const isComplete = job.status === "completed";
  const isFailed = job.status === "failed";

  return (
    <Card className={cn("transition-colors", isActive && "border-blue-500/30 bg-blue-500/5")}>
      <CardContent className="px-3 py-3 space-y-2">
        {/* Header row */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <StatusIcon status={job.status} />
            <span className="text-xs font-medium truncate">{job.mode}</span>
            <Badge variant={STATUS_VARIANTS[job.status]} className="text-[9px] py-0 h-4 shrink-0">
              {STATUS_LABELS[job.status]}
            </Badge>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {isActive && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                disabled={isRefreshing}
                onClick={() => onRefresh(job.id)}
                title="Check status"
              >
                {isRefreshing ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              disabled={isDeleting}
              onClick={() => onDelete(job.id)}
              title="Delete job"
            >
              {isDeleting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Trash2 className="h-3 w-3" />
              )}
            </Button>
          </div>
        </div>

        {/* Source text preview */}
        <p className="text-[10px] text-muted-foreground line-clamp-2">{job.sourceText}</p>

        {/* Processing indicator */}
        {job.status === "processing" && (
          <div className="space-y-1">
            <Progress value={undefined} className="h-1" />
            <p className="text-[9px] text-muted-foreground">
              Worker is generating video{job.workerJobId ? ` (${job.workerJobId})` : ""}...
            </p>
          </div>
        )}

        {/* Error detail */}
        {isFailed && job.errorDetail && (
          <div className="flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5">
            <AlertCircle className="h-3 w-3 text-destructive shrink-0 mt-0.5" />
            <p className="text-[10px] text-destructive break-words">{job.errorDetail}</p>
          </div>
        )}

        {/* Completed video preview */}
        {isComplete && job.videoUrl && (
          <div className="space-y-2">
            <VideoPlayer url={job.videoUrl} jobId={job.id} />
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[10px] gap-1"
                asChild
              >
                <a
                  href={job.videoUrl}
                  download={`digital-twin-${job.id}.mp4`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download className="h-3 w-3" />
                  Download
                </a>
              </Button>
              {job.workerJobId && (
                <span className="text-[9px] text-muted-foreground">
                  Worker: {job.workerJobId}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Completed but no video URL yet */}
        {isComplete && !job.videoUrl && (
          <div className="flex items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5 text-[10px] text-muted-foreground">
            <Video className="h-3 w-3 shrink-0" />
            <span>
              Job completed on worker but video URL is not yet available.
              {job.outputPath ? ` Output: ${job.outputPath}` : ""}
            </span>
          </div>
        )}

        {/* Timestamp */}
        <div className="text-[9px] text-muted-foreground">
          {job.updatedAt !== job.createdAt
            ? `Updated ${formatTimestamp(job.updatedAt)}`
            : `Created ${formatTimestamp(job.createdAt)}`}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  try {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// DigitalTwinPreview
// ---------------------------------------------------------------------------

export function DigitalTwinPreview({ jobs, onJobsChange, className }: DigitalTwinPreviewProps) {
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Auto-poll for active jobs
  const hasActiveJobs = jobs.some((j) => j.status === "queued" || j.status === "processing");

  const pollActiveJobs = useCallback(async () => {
    const active = jobs.filter((j) => j.status === "queued" || j.status === "processing");
    if (active.length === 0) return;

    const results = await Promise.allSettled(
      active.map(async (job) => {
        const res = await fetch(`${JOB_STATUS_ENDPOINT}/${encodeURIComponent(job.id)}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data?.job as DigitalTwinJob | null;
      }),
    );

    let changed = false;
    const nextJobs = [...jobs];
    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const updated = result.value;
      const idx = nextJobs.findIndex((j) => j.id === updated.id);
      if (idx >= 0 && (nextJobs[idx].status !== updated.status || nextJobs[idx].videoUrl !== updated.videoUrl)) {
        nextJobs[idx] = updated;
        changed = true;
      }
    }

    if (changed) {
      onJobsChange(nextJobs);
    }
  }, [jobs, onJobsChange]);

  useEffect(() => {
    if (hasActiveJobs) {
      pollRef.current = setInterval(() => {
        void pollActiveJobs();
      }, JOB_POLL_INTERVAL_MS);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [hasActiveJobs, pollActiveJobs]);

  const handleRefresh = useCallback(async (jobId: string) => {
    setRefreshingIds((prev) => new Set(prev).add(jobId));
    try {
      const res = await fetch(`${JOB_STATUS_ENDPOINT}/${encodeURIComponent(jobId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data?.job) {
          onJobsChange(jobs.map((j) => (j.id === jobId ? (data.job as DigitalTwinJob) : j)));
        }
      }
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  }, [jobs, onJobsChange]);

  const handleDelete = useCallback(async (jobId: string) => {
    setDeletingIds((prev) => new Set(prev).add(jobId));
    try {
      const res = await fetch(`${JOB_STATUS_ENDPOINT}/${encodeURIComponent(jobId)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        onJobsChange(jobs.filter((j) => j.id !== jobId));
      }
    } finally {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  }, [jobs, onJobsChange]);

  const displayJobs = jobs.slice(0, MAX_DISPLAYED_JOBS);
  const completedCount = jobs.filter((j) => j.status === "completed").length;
  const activeCount = jobs.filter((j) => j.status === "queued" || j.status === "processing").length;
  const failedCount = jobs.filter((j) => j.status === "failed").length;

  if (jobs.length === 0) {
    return (
      <Card className={className}>
        <CardContent className="flex flex-col items-center justify-center py-8 text-center">
          <Video className="h-8 w-8 text-muted-foreground/50 mb-2" />
          <p className="text-xs text-muted-foreground">No digital twin jobs yet.</p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Queue a job above to generate a video avatar clip.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="px-3 py-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xs font-medium">Video generation queue</CardTitle>
          <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
            {activeCount > 0 && (
              <span className="flex items-center gap-1">
                <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
                {activeCount} active
              </span>
            )}
            {completedCount > 0 && (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-green-500" />
                {completedCount}
              </span>
            )}
            {failedCount > 0 && (
              <span className="flex items-center gap-1">
                <XCircle className="h-3 w-3 text-destructive" />
                {failedCount}
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <Separator />
      <ScrollArea className="max-h-[480px]">
        <div className="p-2 space-y-2">
          {displayJobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              onDelete={handleDelete}
              onRefresh={handleRefresh}
              isDeleting={deletingIds.has(job.id)}
              isRefreshing={refreshingIds.has(job.id)}
            />
          ))}
          {jobs.length > MAX_DISPLAYED_JOBS && (
            <p className="text-[9px] text-center text-muted-foreground py-1">
              Showing {MAX_DISPLAYED_JOBS} of {jobs.length} jobs
            </p>
          )}
        </div>
      </ScrollArea>
    </Card>
  );
}
