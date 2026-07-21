/**
 * Live-avatar worker client.
 *
 * Talks to the talking-picture worker (docs/live-avatar/) that turns a
 * single portrait into a realtime MJPEG stream with speech-driven mouth
 * motion. All calls are server-side; the browser only ever sees the
 * authenticated /api/autobot/live-avatar/* proxy routes.
 */

const LIVE_AVATAR_WORKER_URL = (process.env.LIVE_AVATAR_WORKER_URL || "").replace(
  /\/+$/,
  "",
);
const LIVE_AVATAR_WORKER_API_KEY = process.env.LIVE_AVATAR_WORKER_API_KEY || "";

const WORKER_TIMEOUT_MS = 30_000;

export class LiveAvatarWorkerError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LiveAvatarWorkerError";
    this.status = status;
  }
}

export type AvatarSessionInfo = {
  sessionId: string;
  width: number;
  height: number;
  faceDetected: boolean;
  /** "frames" when a viseme pack drives the mouth; "warp" otherwise. */
  mode?: "frames" | "warp";
  fps: number;
};

export type AvatarSessionOptions = {
  /** Baked viseme pack: bin label → frame URL. */
  visemeFrames?: Record<string, string>;
  /** Manual mouth/eye placement (normalized 0..1). */
  calibration?: {
    mouth: [number, number];
    leftEye: [number, number];
    rightEye: [number, number];
  };
};

export type AvatarSpeakResult = {
  ok: boolean;
  durationMs: number;
  frames: number;
  source: "audio" | "text";
};

export function isLiveAvatarConfigured(): boolean {
  return LIVE_AVATAR_WORKER_URL.length > 0;
}

function workerHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (LIVE_AVATAR_WORKER_API_KEY) {
    headers.Authorization = `Bearer ${LIVE_AVATAR_WORKER_API_KEY}`;
  }
  return headers;
}

async function workerFetch(path: string, init: RequestInit): Promise<Response> {
  if (!isLiveAvatarConfigured()) {
    throw new LiveAvatarWorkerError(
      "Live avatar worker is not configured (set LIVE_AVATAR_WORKER_URL).",
      503,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${LIVE_AVATAR_WORKER_URL}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(WORKER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new LiveAvatarWorkerError(
      error instanceof Error
        ? `Live avatar worker unreachable: ${error.message}`
        : "Live avatar worker unreachable",
      502,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new LiveAvatarWorkerError(
      `Live avatar worker returned ${response.status}: ${detail.slice(0, 500)}`,
      502,
    );
  }
  return response;
}

export async function createAvatarSession(
  imageBytes: ArrayBuffer,
  fileName: string,
  mimeType: string,
  options?: AvatarSessionOptions,
): Promise<AvatarSessionInfo> {
  const form = new FormData();
  form.append("file", new Blob([imageBytes], { type: mimeType }), fileName);
  if (options && (options.visemeFrames || options.calibration)) {
    form.append("options", JSON.stringify(options));
  }
  const response = await workerFetch("/sessions", {
    method: "POST",
    headers: workerHeaders(),
    body: form,
  });
  return (await response.json()) as AvatarSessionInfo;
}

export async function speakAudio(
  sessionId: string,
  audio: ArrayBuffer,
  contentType: string,
  text?: string,
): Promise<AvatarSpeakResult> {
  const form = new FormData();
  const extension = contentType.includes("mpeg") ? "mp3" : "wav";
  form.append(
    "file",
    new Blob([audio], { type: contentType }),
    `speech.${extension}`,
  );
  if (text) form.append("text", text);
  const response = await workerFetch(
    `/sessions/${encodeURIComponent(sessionId)}/speak`,
    { method: "POST", headers: workerHeaders(), body: form },
  );
  return (await response.json()) as AvatarSpeakResult;
}

export async function speakText(
  sessionId: string,
  text: string,
  durationMs?: number,
): Promise<AvatarSpeakResult> {
  const response = await workerFetch(
    `/sessions/${encodeURIComponent(sessionId)}/speak`,
    {
      method: "POST",
      headers: workerHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text, durationMs }),
    },
  );
  return (await response.json()) as AvatarSpeakResult;
}

export async function stopSpeaking(sessionId: string): Promise<void> {
  await workerFetch(`/sessions/${encodeURIComponent(sessionId)}/stop-speaking`, {
    method: "POST",
    headers: workerHeaders(),
  });
}

export async function deleteAvatarSession(sessionId: string): Promise<void> {
  await workerFetch(`/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    headers: workerHeaders(),
  });
}

/**
 * Open the worker's MJPEG stream. Returns the raw upstream Response so the
 * proxy route can pass the multipart body through untouched. No timeout —
 * the stream lives as long as the viewer watches it.
 */
export async function openAvatarStream(sessionId: string): Promise<Response> {
  if (!isLiveAvatarConfigured()) {
    throw new LiveAvatarWorkerError(
      "Live avatar worker is not configured (set LIVE_AVATAR_WORKER_URL).",
      503,
    );
  }

  let response: Response;
  try {
    response = await fetch(
      `${LIVE_AVATAR_WORKER_URL}/sessions/${encodeURIComponent(sessionId)}/stream`,
      { headers: workerHeaders() },
    );
  } catch (error) {
    throw new LiveAvatarWorkerError(
      error instanceof Error
        ? `Live avatar worker unreachable: ${error.message}`
        : "Live avatar worker unreachable",
      502,
    );
  }

  if (!response.ok || !response.body) {
    throw new LiveAvatarWorkerError(
      `Live avatar worker stream returned ${response.status}`,
      502,
    );
  }
  return response;
}
