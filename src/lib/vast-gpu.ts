/**
 * Vast.ai GPU lifecycle for the Chatterbox voice worker.
 *
 * First-party replacement for the retired OpenClaw token-server GPU lane.
 * The instance is provisioned from the user's own Vast API key (stored in
 * their autobot settings), boots via a self-contained onstart script that
 * fetches the worker source from this instance, self-STOPS after ~35 idle
 * minutes (stopped boxes bill storage only, restart in ~30s), and is
 * destroyed on explicit decommission.
 */

import {
  buildOnstartScript,
  CHATTERBOX_WORKER_PORT,
} from "@/lib/chatterbox/worker-source";

const VAST_API_BASE = "https://console.vast.ai/api/v0";
const VAST_TIMEOUT_MS = 30_000;

/** Offer constraints: cheap single-GPU box able to hold Chatterbox (+bake). */
const OFFER_QUERY = {
  verified: { eq: true },
  external: { eq: false },
  rentable: { eq: true },
  num_gpus: { eq: 1 },
  gpu_ram: { gte: 15_000 }, // MB
  reliability2: { gte: 0.95 },
  dph_total: { lte: 0.45 },
  cuda_max_good: { gte: 12.0 },
  inet_down: { gte: 100 },
  disk_space: { gte: 40 },
  type: "on-demand",
} as const;

const INSTANCE_LABEL = "rivr-chatterbox";
const INSTANCE_DISK_GB = 40;
const INSTANCE_IMAGE = "pytorch/pytorch:2.3.1-cuda12.1-cudnn8-runtime";

export class VastApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "VastApiError";
    this.status = status;
  }
}

export interface VastInstanceSummary {
  instanceId: number;
  /** Vast lifecycle state: running | stopped | loading | ... */
  actualStatus: string;
  publicIp: string | null;
  /** Host port mapped to the worker port, when running. */
  workerPort: number | null;
  dphTotal: number | null;
  gpuName: string | null;
  label: string | null;
}

const VAST_ORIGIN = "https://console.vast.ai";

async function vastFetch(
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  // A path starting with "/api/" is absolute (lets callers pick the API
  // version, e.g. the v1 instances list); everything else is v0-relative.
  const url = path.startsWith("/api/")
    ? `${VAST_ORIGIN}${path}`
    : `${VAST_API_BASE}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(VAST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new VastApiError(
      error instanceof Error ? `Vast.ai unreachable: ${error.message}` : "Vast.ai unreachable",
      502,
    );
  }

  const text = await response.text();
  let payload: unknown = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 300) };
  }

  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "msg" in payload
        ? String((payload as Record<string, unknown>).msg)
        : text.slice(0, 300);
    throw new VastApiError(`Vast.ai ${response.status}: ${detail}`, response.status);
  }
  return payload;
}

export async function getVastBalance(apiKey: string): Promise<number | null> {
  const data = (await vastFetch(apiKey, "/users/current/")) as Record<string, unknown>;
  const credit = data.credit ?? data.balance;
  return typeof credit === "number" && Number.isFinite(credit) ? credit : null;
}

/** Returns the cheapest matching rentable offer id. */
export async function findCheapestOffer(apiKey: string): Promise<number> {
  // Verified live against the endpoint: POST /bundles/ with the query
  // FLATTENED at the top level (NOT wrapped in `q`), constraints as
  // {op: value}, order/limit/type siblings. Bearer auth. (My earlier
  // `q`-wrapped PUT/`/search/asks/` guesses 404'd/400'd — that was the
  // silent Start-Voice failure.)
  const body = JSON.stringify({
    ...OFFER_QUERY,
    order: [["dph_total", "asc"]],
    limit: 10,
  });

  const payload = await vastFetch(apiKey, "/bundles/", { method: "POST", body });
  const record = payload as Record<string, unknown>;
  const offers = (record.offers ?? record.bundles ?? []) as Array<Record<string, unknown>>;
  const usable = offers
    .filter((offer) => typeof offer.id === "number")
    .sort(
      (a, b) =>
        (Number(a.dph_total) || Number.MAX_VALUE) -
        (Number(b.dph_total) || Number.MAX_VALUE),
    );
  if (usable.length === 0) {
    throw new VastApiError("No matching GPU offers found (try again shortly)", 503);
  }
  return usable[0].id as number;
}

export interface CreateInstanceOptions {
  /** Public URL to the user's stored voice sample (the clone reference). */
  voiceSampleUrl: string;
}

/** Creates the instance; returns the new contract/instance id. */
export async function createChatterboxInstance(
  apiKey: string,
  offerId: number,
  options: CreateInstanceOptions,
): Promise<number> {
  const onstart = buildOnstartScript(options);
  // Body shape + field names verified against the vastai SDK's
  // instances.create_instance. CRITICAL: runtype must be a VALID launch
  // mode ("ssh_proxy"), never "onstart" — an invalid runtype made the host
  // fail container creation (OCI runtime create failed) on every box.
  // `env` port mapping matches the CLI's parse_env output ({"-p a:b":"1"}).
  const payload = (await vastFetch(apiKey, `/asks/${offerId}/`, {
    method: "PUT",
    body: JSON.stringify({
      client_id: "me",
      image: INSTANCE_IMAGE,
      disk: INSTANCE_DISK_GB,
      label: INSTANCE_LABEL,
      onstart,
      runtype: "ssh_proxy",
      env: { [`-p ${CHATTERBOX_WORKER_PORT}:${CHATTERBOX_WORKER_PORT}`]: "1" },
    }),
  })) as Record<string, unknown>;

  const newId = payload.new_contract ?? payload.new_id ?? payload.id;
  if (typeof newId !== "number") {
    throw new VastApiError(
      `Instance create returned no id (${JSON.stringify(payload).slice(0, 200)})`,
      502,
    );
  }
  return newId;
}

function summarizeInstance(raw: Record<string, unknown>): VastInstanceSummary {
  const ports = (raw.ports ?? {}) as Record<
    string,
    Array<{ HostPort?: string }> | undefined
  >;
  const mapped = ports[`${CHATTERBOX_WORKER_PORT}/tcp`];
  const workerPort =
    Array.isArray(mapped) && mapped[0]?.HostPort
      ? Number(mapped[0].HostPort)
      : null;

  return {
    instanceId: Number(raw.id),
    actualStatus: String(raw.actual_status ?? raw.status_msg ?? "unknown"),
    publicIp:
      typeof raw.public_ipaddr === "string" ? raw.public_ipaddr.trim() : null,
    workerPort: Number.isFinite(workerPort) ? workerPort : null,
    dphTotal: typeof raw.dph_total === "number" ? raw.dph_total : null,
    gpuName: typeof raw.gpu_name === "string" ? raw.gpu_name : null,
    label: typeof raw.label === "string" ? raw.label : null,
  };
}

export async function listChatterboxInstances(
  apiKey: string,
): Promise<VastInstanceSummary[]> {
  // The v0 /instances?owner=me list is deprecated and 301-redirects; the
  // SDK pages the v1 endpoint. One page (25) is plenty for our per-user
  // instances (we cap at one live box).
  const params = new URLSearchParams({
    select_filters: JSON.stringify({}),
    order_by: JSON.stringify([{ col: "id", dir: "asc" }]),
    limit: "25",
  });
  const payload = (await vastFetch(
    apiKey,
    `/api/v1/instances/?${params.toString()}`,
  )) as Record<string, unknown>;
  const instances = (payload.instances ?? []) as Array<Record<string, unknown>>;
  return instances
    .map(summarizeInstance)
    .filter((instance) => instance.label === INSTANCE_LABEL);
}

export async function getInstance(
  apiKey: string,
  instanceId: number,
): Promise<VastInstanceSummary | null> {
  const instances = (await listChatterboxInstances(apiKey)).filter(
    (instance) => instance.instanceId === instanceId,
  );
  return instances[0] ?? null;
}

/** Restart a stopped instance (fast path — no re-provision). */
export async function startInstance(apiKey: string, instanceId: number): Promise<void> {
  await vastFetch(apiKey, `/instances/${instanceId}/`, {
    method: "PUT",
    body: JSON.stringify({ state: "running" }),
  });
}

export async function stopInstance(apiKey: string, instanceId: number): Promise<void> {
  await vastFetch(apiKey, `/instances/${instanceId}/`, {
    method: "PUT",
    body: JSON.stringify({ state: "stopped" }),
  });
}

export async function destroyInstance(apiKey: string, instanceId: number): Promise<void> {
  await vastFetch(apiKey, `/instances/${instanceId}/`, { method: "DELETE" });
}

/** The worker's public base URL once the instance is running. */
export function workerUrl(instance: VastInstanceSummary): string | null {
  if (!instance.publicIp || !instance.workerPort) return null;
  return `http://${instance.publicIp}:${instance.workerPort}`;
}
