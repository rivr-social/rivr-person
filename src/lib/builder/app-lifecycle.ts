/**
 * App lifecycle request queue — the app-side half of the broker contract.
 *
 * The builder session never touches Docker, Compose, or the host shell. It
 * writes ONE typed request file per app into the broker spool
 * (`<workspaceRoot>/.rivr-apps/queue/<appId>.json`, atomic rename) and reads
 * broker-written status back from `.rivr-apps/status/<appId>.json`. The host
 * broker (`rivr-app-broker` systemd path unit) re-validates everything
 * independently; nothing written here is trusted by the host.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentAppWorkspaceRoot } from "@/lib/agent-hq";
import {
  APP_ID_PATTERN,
  APP_MANIFEST_FILE_NAME,
  parseAppManifest,
  type RivrAppManifest,
} from "@/lib/builder/app-manifest";

export const APP_BROKER_DIR_NAME = ".rivr-apps";
export const APP_QUEUE_DIR_NAME = "queue";
export const APP_STATUS_DIR_NAME = "status";
export const APP_REQUEST_VERSION = 1;

export const APP_LIFECYCLE_ACTIONS = [
  "deploy",
  "stop",
  "start",
  "rollback",
  "archive",
  "delete",
] as const;
export type AppLifecycleAction = (typeof APP_LIFECYCLE_ACTIONS)[number];

/** Broker-side phases surfaced back to the builder UI. */
export const APP_PHASES = [
  "queued",
  "validating",
  "building",
  "deploying",
  "running",
  "stopped",
  "archived",
  "deleted",
  "failed",
] as const;
export type AppPhase = (typeof APP_PHASES)[number];

export interface AppLifecycleRequest {
  version: typeof APP_REQUEST_VERSION;
  requestId: string;
  appId: string;
  action: AppLifecycleAction;
  requestedAt: string;
  /** Present only for deploy requests; broker re-validates it regardless. */
  manifest?: RivrAppManifest;
  /**
   * Two-phase delete guard: delete is only honored when the caller echoes the
   * appId back as the confirm token AND the app is already archived.
   */
  confirmToken?: string;
}

export interface AppBrokerStatus {
  version: number;
  appId: string;
  phase: AppPhase;
  requestId?: string;
  action?: AppLifecycleAction;
  updatedAt?: string;
  release?: string;
  releases?: string[];
  url?: string;
  error?: string;
  detail?: string;
}

export class AppLifecycleError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "AppLifecycleError";
    this.statusCode = statusCode;
  }
}

function brokerRoot(): string {
  return path.resolve(getAgentAppWorkspaceRoot(), "..", APP_BROKER_DIR_NAME);
}

export function appQueueDir(): string {
  return path.join(brokerRoot(), APP_QUEUE_DIR_NAME);
}

export function appStatusDir(): string {
  return path.join(brokerRoot(), APP_STATUS_DIR_NAME);
}

export function appWorkspaceDir(appId: string): string {
  return path.join(getAgentAppWorkspaceRoot(), appId);
}

function assertValidAppId(appId: string): void {
  if (!APP_ID_PATTERN.test(appId)) {
    throw new AppLifecycleError("Invalid app id", 400);
  }
}

/** Read and validate the manifest checked into an app workspace. */
export async function readAppManifest(appId: string): Promise<
  | { ok: true; manifest: RivrAppManifest }
  | { ok: false; errors: string[] }
> {
  assertValidAppId(appId);
  const manifestPath = path.join(appWorkspaceDir(appId), APP_MANIFEST_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, errors: [`${APP_MANIFEST_FILE_NAME} not found in workspace`] };
    }
    throw new AppLifecycleError(
      `Failed to read ${APP_MANIFEST_FILE_NAME}: ${(error as Error).message}`,
      500,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false, errors: [`${APP_MANIFEST_FILE_NAME} is not valid JSON`] };
  }

  const parsed = parseAppManifest(parsedJson);
  if (!parsed.ok) return parsed;
  if (parsed.manifest.appId !== appId) {
    return {
      ok: false,
      errors: [
        `Manifest appId "${parsed.manifest.appId}" does not match workspace "${appId}"`,
      ],
    };
  }
  return parsed;
}

/**
 * Queue one lifecycle request for an app. One pending request per app: a new
 * request supersedes an unprocessed one (atomic rename over the same path).
 */
export async function queueAppLifecycleRequest(input: {
  appId: string;
  action: AppLifecycleAction;
  confirmToken?: string;
}): Promise<AppLifecycleRequest> {
  const { appId, action } = input;
  assertValidAppId(appId);
  if (!APP_LIFECYCLE_ACTIONS.includes(action)) {
    throw new AppLifecycleError("Unknown lifecycle action", 400);
  }

  const request: AppLifecycleRequest = {
    version: APP_REQUEST_VERSION,
    requestId: randomUUID(),
    appId,
    action,
    requestedAt: new Date().toISOString(),
  };

  if (action === "deploy") {
    const manifest = await readAppManifest(appId);
    if (!manifest.ok) {
      throw new AppLifecycleError(
        `Manifest invalid: ${manifest.errors.join("; ")}`,
        422,
      );
    }
    request.manifest = manifest.manifest;
  }

  if (action === "delete") {
    if (input.confirmToken !== appId) {
      throw new AppLifecycleError(
        "Delete requires confirmToken equal to the appId (two-phase: archive first, then confirm delete)",
        400,
      );
    }
    request.confirmToken = input.confirmToken;
  }

  const queueDir = appQueueDir();
  await mkdir(queueDir, { recursive: true, mode: 0o755 });
  const finalPath = path.join(queueDir, `${appId}.json`);
  const tempPath = path.join(queueDir, `.${appId}.${request.requestId}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(request, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, finalPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new AppLifecycleError(
      `Failed to queue request: ${(error as Error).message}`,
      500,
    );
  }
  return request;
}

/** Read broker-written status for one app. Null when the broker has none. */
export async function readAppStatus(appId: string): Promise<AppBrokerStatus | null> {
  assertValidAppId(appId);
  try {
    const raw = await readFile(path.join(appStatusDir(), `${appId}.json`), "utf8");
    const parsed = JSON.parse(raw) as AppBrokerStatus;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AppLifecycleError(
      `Failed to read app status: ${(error as Error).message}`,
      500,
    );
  }
}

/** True when an unprocessed request is still sitting in the spool. */
export async function hasPendingRequest(appId: string): Promise<boolean> {
  assertValidAppId(appId);
  try {
    const entries = await readdir(appQueueDir());
    return entries.includes(`${appId}.json`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new AppLifecycleError(
      `Failed to read queue: ${(error as Error).message}`,
      500,
    );
  }
}
