import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
} from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";

const DIGITAL_TWIN_WORKER_URL =
  process.env.DIGITAL_TWIN_WORKER_URL || "http://localhost:8011";

type RouteContext = { params: Promise<{ jobId: string }> };

/**
 * GET /api/autobot/digital-twin/[jobId]
 *
 * Returns the status and result for a single digital twin job.
 * If the job has a workerJobId and is still processing, optionally
 * polls the worker for updated status.
 */
export async function GET(
  _request: Request,
  context: RouteContext,
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await context.params;
  if (!jobId || typeof jobId !== "string") {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const settings = await getAutobotUserSettings(session.user.id);
  const job = settings.digitalTwin.jobs.find((j) => j.id === jobId);

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // If the job is still processing and has a workerJobId, try polling the worker
  if (job.status === "processing" && job.workerJobId) {
    try {
      const workerRes = await fetch(
        `${DIGITAL_TWIN_WORKER_URL}/jobs/${encodeURIComponent(job.workerJobId)}/status`,
        { method: "GET", signal: AbortSignal.timeout(5000) },
      );
      if (workerRes.ok) {
        const workerData = await workerRes.json();
        const workerStatus = workerData?.status;
        if (workerStatus === "completed" || workerStatus === "failed") {
          const now = new Date().toISOString();
          const updatedJobs = settings.digitalTwin.jobs.map((j) =>
            j.id === jobId
              ? {
                  ...j,
                  status: workerStatus as typeof j.status,
                  videoUrl: workerData.outputUrl || workerData.videoUrl || j.videoUrl,
                  outputPath: workerData.outputPath || j.outputPath,
                  errorDetail: workerStatus === "failed" ? (workerData.detail || workerData.error || "Worker job failed") : j.errorDetail,
                  updatedAt: now,
                }
              : j,
          );
          const saved = await saveAutobotUserSettings(session.user.id, {
            digitalTwin: { ...settings.digitalTwin, jobs: updatedJobs, updatedAt: now },
          });
          const refreshedJob = saved.digitalTwin.jobs.find((j) => j.id === jobId);
          return NextResponse.json({ job: refreshedJob });
        }
      }
    } catch {
      // Worker unreachable -- return stale local job state rather than erroring
    }
  }

  return NextResponse.json({ job });
}

/**
 * DELETE /api/autobot/digital-twin/[jobId]
 *
 * Cancels a running job (best-effort worker cancellation) and removes
 * the job from the user's stored job list.
 */
export async function DELETE(
  _request: Request,
  context: RouteContext,
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { jobId } = await context.params;
  if (!jobId || typeof jobId !== "string") {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const settings = await getAutobotUserSettings(session.user.id);
  const job = settings.digitalTwin.jobs.find((j) => j.id === jobId);

  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Best-effort cancel on the worker if the job is still active
  if ((job.status === "queued" || job.status === "processing") && job.workerJobId) {
    try {
      await fetch(
        `${DIGITAL_TWIN_WORKER_URL}/jobs/${encodeURIComponent(job.workerJobId)}/cancel`,
        { method: "POST", signal: AbortSignal.timeout(5000) },
      );
    } catch {
      // Worker cancel is best-effort -- continue with local removal
    }
  }

  const now = new Date().toISOString();
  const remainingJobs = settings.digitalTwin.jobs.filter((j) => j.id !== jobId);
  await saveAutobotUserSettings(session.user.id, {
    digitalTwin: { ...settings.digitalTwin, jobs: remainingJobs, updatedAt: now },
  });

  return NextResponse.json({ ok: true, deleted: jobId });
}
