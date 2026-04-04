import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
  type DigitalTwinJob,
} from "@/lib/autobot-user-settings";

export const dynamic = "force-dynamic";

const DIGITAL_TWIN_WORKER_URL =
  process.env.DIGITAL_TWIN_WORKER_URL || "http://localhost:8011";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    jobId?: string;
    mode?: string;
    sourceText?: string;
    audioUrl?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const settings = await getAutobotUserSettings(session.user.id);
  const digitalTwin = settings.digitalTwin;
  const hostVideo = digitalTwin.assets.find((asset) => asset.kind === "host-video");
  const referencePortrait = digitalTwin.assets.find((asset) => asset.kind === "reference-portrait");

  if (!hostVideo && !referencePortrait) {
    return NextResponse.json(
      { error: "Upload a host video or reference portrait before running a digital twin job." },
      { status: 400 },
    );
  }

  // Mark the job as processing before dispatching to the worker
  const now = new Date().toISOString();
  let targetJob: DigitalTwinJob | undefined;
  if (body.jobId) {
    targetJob = digitalTwin.jobs.find((j) => j.id === body.jobId);
  }

  if (targetJob) {
    const updatedJobs = digitalTwin.jobs.map((j) =>
      j.id === targetJob!.id ? { ...j, status: "processing" as const, updatedAt: now } : j,
    );
    await saveAutobotUserSettings(session.user.id, {
      digitalTwin: { ...digitalTwin, jobs: updatedJobs, updatedAt: now },
    });
  }

  let workerResponse: {
    ok?: boolean;
    jobId?: string;
    status?: string;
    outputPath?: string;
    detail?: string;
    notes?: string[];
  };

  try {
    const response = await fetch(`${DIGITAL_TWIN_WORKER_URL}/jobs/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipeline: digitalTwin.pipeline,
        model: digitalTwin.model,
        script: body.sourceText || "",
        audio_url: body.audioUrl || undefined,
        host_video_url: hostVideo?.url || undefined,
        reference_image_url: referencePortrait?.url || undefined,
        host_framing: digitalTwin.hostFraming,
        background_mode: digitalTwin.backgroundMode,
        mode: body.mode || undefined,
        jobId: body.jobId || undefined,
      }),
    });

    const text = await response.text();
    try {
      workerResponse = JSON.parse(text);
    } catch {
      workerResponse = { detail: text };
    }

    if (!response.ok) {
      // Mark job as failed
      if (targetJob) {
        const failNow = new Date().toISOString();
        const refetch = await getAutobotUserSettings(session.user.id);
        const failedJobs = refetch.digitalTwin.jobs.map((j) =>
          j.id === targetJob!.id
            ? {
                ...j,
                status: "failed" as const,
                errorDetail: workerResponse.detail || `Worker returned ${response.status}`,
                updatedAt: failNow,
              }
            : j,
        );
        await saveAutobotUserSettings(session.user.id, {
          digitalTwin: { ...refetch.digitalTwin, jobs: failedJobs, updatedAt: failNow },
        });
      }
      return NextResponse.json(workerResponse, { status: response.status });
    }
  } catch (error) {
    // Network/connection failure -- mark job failed
    const errMessage = error instanceof Error ? error.message : "Worker connection failed";
    if (targetJob) {
      const failNow = new Date().toISOString();
      const refetch = await getAutobotUserSettings(session.user.id);
      const failedJobs = refetch.digitalTwin.jobs.map((j) =>
        j.id === targetJob!.id
          ? { ...j, status: "failed" as const, errorDetail: errMessage, updatedAt: failNow }
          : j,
      );
      await saveAutobotUserSettings(session.user.id, {
        digitalTwin: { ...refetch.digitalTwin, jobs: failedJobs, updatedAt: failNow },
      });
    }
    return NextResponse.json({ error: errMessage }, { status: 502 });
  }

  // Worker returned success -- update job record with results
  if (targetJob) {
    const doneNow = new Date().toISOString();
    const refetch = await getAutobotUserSettings(session.user.id);
    const completedJobs = refetch.digitalTwin.jobs.map((j) =>
      j.id === targetJob!.id
        ? {
            ...j,
            status: (workerResponse.status === "completed" ? "completed" : "processing") as DigitalTwinJob["status"],
            workerJobId: workerResponse.jobId || undefined,
            outputPath: workerResponse.outputPath || undefined,
            videoUrl: workerResponse.outputPath
              ? `${DIGITAL_TWIN_WORKER_URL}/outputs/${encodeURIComponent(workerResponse.jobId || "")}`
              : undefined,
            updatedAt: doneNow,
          }
        : j,
    );
    const saved = await saveAutobotUserSettings(session.user.id, {
      digitalTwin: { ...refetch.digitalTwin, jobs: completedJobs, updatedAt: doneNow },
    });
    return NextResponse.json({
      ...workerResponse,
      job: saved.digitalTwin.jobs.find((j) => j.id === targetJob!.id),
    });
  }

  return NextResponse.json(workerResponse);
}
