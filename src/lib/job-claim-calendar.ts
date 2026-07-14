/**
 * @fileoverview Consumer-side contract for the cross-instance `job.claimed`
 * calendar projection (A8).
 *
 * The sovereign GROUP app emits a self-describing `job.claimed` domain event
 * when a worker claims a job (see rivr-group
 * `src/lib/federation/job-claim-event.ts` — the wire authority; this file MUST
 * stay in lockstep with that payload). This person app is a MATERIALIZE side:
 * when the claimant resolves to THIS instance's locally-homed owner
 * (`PRIMARY_AGENT_ID`), the federation importer upserts a lightweight local
 * "claimed job" calendar projection — a private `resources` row — that the
 * profile calendar reads.
 *
 * This module holds the PURE parts of that lane: payload parsing, owner
 * matching, the projection id/metadata shape, and the read-side mapping to a
 * calendar item. It intentionally imports NO database or server-config module
 * so it is safe to import from BOTH the server importer (`@/lib/federation`)
 * and the client calendar surface (`profile-calendar` / `profile-client`).
 */

/**
 * Dedicated event type for a cross-instance job claim. Kept identical to the
 * group emitter's constant so the consumer can key on it deterministically.
 */
export const JOB_CLAIMED_EVENT_TYPE = "job.claimed" as const;

/**
 * `resources.metadata.resourceKind` discriminator for a claimed-job calendar
 * projection. Mirrors the group app's `resourceKind` convention (`workperiod`,
 * `fund`): a generic `type: 'resource'` row tagged by its metadata kind, so no
 * `resource_type` enum value and no schema migration are needed.
 */
export const CLAIMED_JOB_RESOURCE_KIND = "claimed_job" as const;

/**
 * Wire payload for {@link JOB_CLAIMED_EVENT_TYPE}. Self-describing so this home
 * instance renders a calendar item with no round-trip back to the origin. Keep
 * in lockstep with the group emitter's `JobClaimCalendarPayload`.
 */
export interface JobClaimCalendarPayload {
  action: "job_claimed";
  /** Claimant agent id (in the ORIGIN instance's id space). */
  claimantId: string;
  /** The claimed job's resource id on the origin instance. */
  jobId: string;
  /** Human-readable job name for the calendar entry title. */
  jobName: string;
  /** ISO work-window start, when the job carries one (else null). */
  startDate: string | null;
  /** ISO work-window end / deadline, when the job carries one (else null). */
  deadline: string | null;
  /** Parent project id, when the job belongs to one (else null). */
  projectId: string | null;
  /** Owning group agent id. */
  groupId: string;
  /** Owning group display name (so the home entry is self-labeled). */
  groupName: string;
  /** Canonical (cross-origin) URL to the job on the origin instance. */
  jobUrl: string;
  /** Origin instance id (the emitter), for provenance + dedup. */
  originInstanceId: string;
  /** ISO timestamp of the claim. */
  claimedAt: string;
}

/** Reads a required non-empty string field, returning null when absent. */
function readString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Reads a nullable string field: a valid string or null (missing → null). */
function readNullableString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Validates and narrows a raw federation payload to a
 * {@link JobClaimCalendarPayload}. Returns null when the payload is not a
 * well-formed job-claim event (missing the required claimant/job identity or
 * the fixed `action` discriminator), so a malformed or spoofed-shape event is
 * ignored rather than materialized. Pure — no IO.
 */
export function parseJobClaimCalendarPayload(
  raw: unknown,
): JobClaimCalendarPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.action !== "job_claimed") return null;

  const claimantId = readString(record, "claimantId");
  const jobId = readString(record, "jobId");
  if (!claimantId || !jobId) return null;

  return {
    action: "job_claimed",
    claimantId,
    jobId,
    jobName: readString(record, "jobName") ?? "Claimed job",
    startDate: readNullableString(record, "startDate"),
    deadline: readNullableString(record, "deadline"),
    projectId: readNullableString(record, "projectId"),
    groupId: readString(record, "groupId") ?? "",
    groupName: readString(record, "groupName") ?? "Group",
    jobUrl: readString(record, "jobUrl") ?? "",
    originInstanceId: readString(record, "originInstanceId") ?? "",
    claimedAt: readNullableString(record, "claimedAt") ?? new Date(0).toISOString(),
  };
}

/**
 * True when the claim's `claimantId` is THIS instance's locally-homed owner.
 * This app hosts exactly one person, so a claim is projected onto the calendar
 * ONLY when it belongs to that owner. Two id spaces can name the owner:
 *
 *  1. The canonical agent id — equal across instances in this ecosystem, so the
 *     raw `claimantId` may already equal `primaryAgentId`.
 *  2. A per-origin alias — the origin knew the owner under a different id that
 *     `federation_entity_map` collapses to a local id (`mappedLocalClaimantId`).
 *
 * Pure — the caller resolves `mappedLocalClaimantId` from the entity map.
 */
export function claimantMatchesLocalOwner(
  payload: JobClaimCalendarPayload,
  primaryAgentId: string | null | undefined,
  mappedLocalClaimantId: string | null | undefined,
): boolean {
  if (!primaryAgentId) return false;
  return payload.claimantId === primaryAgentId || mappedLocalClaimantId === primaryAgentId;
}

/**
 * Namespaced synthetic external id for the projection's `federation_entity_map`
 * row, keyed on {claimant, job}. Namespacing (`claimed_job:`) keeps it clear of
 * the real job/resource external-id space so the minted local id never collides
 * with an actual imported resource, and makes re-delivery idempotent (the same
 * key returns the same local id → an in-place upsert).
 */
export function syntheticClaimedJobEntityKey(
  localClaimantId: string,
  jobId: string,
): string {
  return `${CLAIMED_JOB_RESOURCE_KIND}:${localClaimantId}:${jobId}`;
}

/** Provenance stamped onto the projection so its origin peer is auditable. */
export interface ClaimedJobProjectionSource {
  nodeId: string;
  nodeSlug: string;
}

/**
 * Builds the `resources.metadata` blob for a claimed-job calendar projection
 * from the wire payload. Carries the canonical cross-origin job URL plus the
 * self-describing calendar fields the read path renders, tagged with
 * {@link CLAIMED_JOB_RESOURCE_KIND}. Pure.
 */
export function buildClaimedJobProjectionMetadata(
  payload: JobClaimCalendarPayload,
  source: ClaimedJobProjectionSource,
): Record<string, unknown> {
  return {
    resourceKind: CLAIMED_JOB_RESOURCE_KIND,
    federatedClaimProjection: true,
    claimedJobId: payload.jobId,
    claimantId: payload.claimantId,
    // Canonical URL keys the cross-origin anchor; `jobUrl` kept as an alias for
    // symmetry with the wire payload.
    canonicalUrl: payload.jobUrl,
    jobUrl: payload.jobUrl,
    startDate: payload.startDate,
    deadline: payload.deadline,
    projectId: payload.projectId,
    groupId: payload.groupId,
    groupName: payload.groupName,
    originInstanceId: payload.originInstanceId,
    claimedAt: payload.claimedAt,
    sourceNodeId: source.nodeId,
    sourceNodeSlug: source.nodeSlug,
  };
}

/** A claimed-job calendar entry, as read back from a projection resource. */
export interface ClaimedJobCalendarItem {
  /** The projection resource id (local). */
  id: string;
  /** The origin job's resource id. */
  jobId: string;
  /** Job name (calendar entry title). */
  title: string;
  /** Canonical cross-origin URL to the job on the sovereign origin. */
  jobUrl: string;
  /** Owning group id + display name. */
  groupId: string;
  groupName: string;
  /** Parent project id, when the job belongs to one. */
  projectId: string | null;
  /** ISO work-window start / end. */
  startDate: string | null;
  deadline: string | null;
  /** ISO claim timestamp. */
  claimedAt: string | null;
}

/** Minimal resource shape the read mapper needs (server + serialized). */
export interface ClaimedJobResourceLike {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Maps a stored projection resource to a {@link ClaimedJobCalendarItem}, or
 * null when the resource is not a claimed-job projection. Pure — used by the
 * client calendar surface to render claimed jobs alongside events/services.
 */
export function claimedJobResourceToCalendarItem(
  resource: ClaimedJobResourceLike,
): ClaimedJobCalendarItem | null {
  const meta = resource.metadata ?? {};
  if (meta.resourceKind !== CLAIMED_JOB_RESOURCE_KIND) return null;

  const jobUrl =
    (typeof meta.canonicalUrl === "string" && meta.canonicalUrl) ||
    (typeof meta.jobUrl === "string" && meta.jobUrl) ||
    "";
  if (!jobUrl) return null;

  const asString = (value: unknown): string | null =>
    typeof value === "string" && value.trim().length > 0 ? value : null;

  return {
    id: resource.id,
    jobId: asString(meta.claimedJobId) ?? resource.id,
    title: resource.name || "Claimed job",
    jobUrl,
    groupId: asString(meta.groupId) ?? "",
    groupName: asString(meta.groupName) ?? "",
    projectId: asString(meta.projectId),
    startDate: asString(meta.startDate),
    deadline: asString(meta.deadline),
    claimedAt: asString(meta.claimedAt),
  };
}
