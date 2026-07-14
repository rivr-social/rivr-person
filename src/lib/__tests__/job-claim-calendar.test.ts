import { describe, expect, it } from "vitest";
import {
  CLAIMED_JOB_RESOURCE_KIND,
  buildClaimedJobProjectionMetadata,
  claimantMatchesLocalOwner,
  claimedJobResourceToCalendarItem,
  parseJobClaimCalendarPayload,
  syntheticClaimedJobEntityKey,
  type JobClaimCalendarPayload,
} from "@/lib/job-claim-calendar";

/**
 * Unit coverage for the A8 consumer-side pure lane: wire-payload parsing, owner
 * matching, the idempotency key, the projection metadata blob, and the read-side
 * mapping back to a calendar item. No DB/IO — this is the pure mapping the
 * federation importer + profile calendar depend on.
 */

const OWNER_ID = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "22222222-2222-2222-2222-222222222222";
const GROUP_ID = "33333333-3333-3333-3333-333333333333";

/** A complete, well-formed wire payload as the group emitter sends it. */
function validRawPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "job_claimed",
    claimantId: OWNER_ID,
    jobId: JOB_ID,
    jobName: "Trail maintenance",
    startDate: "2026-08-01T09:00:00.000Z",
    deadline: "2026-08-01T17:00:00.000Z",
    projectId: null,
    groupId: GROUP_ID,
    groupName: "Spirit of the Front Range",
    jobUrl: "https://spirit.rivr.social/jobs/22222222-2222-2222-2222-222222222222",
    originInstanceId: "spirit",
    claimedAt: "2026-07-14T12:00:00.000Z",
    ...overrides,
  };
}

describe("parseJobClaimCalendarPayload", () => {
  it("narrows a well-formed payload, preserving every wire field", () => {
    const parsed = parseJobClaimCalendarPayload(validRawPayload());
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      action: "job_claimed",
      claimantId: OWNER_ID,
      jobId: JOB_ID,
      jobName: "Trail maintenance",
      startDate: "2026-08-01T09:00:00.000Z",
      deadline: "2026-08-01T17:00:00.000Z",
      groupId: GROUP_ID,
      groupName: "Spirit of the Front Range",
      jobUrl: "https://spirit.rivr.social/jobs/22222222-2222-2222-2222-222222222222",
      originInstanceId: "spirit",
      claimedAt: "2026-07-14T12:00:00.000Z",
    });
  });

  it("rejects non-objects and the wrong action discriminator", () => {
    expect(parseJobClaimCalendarPayload(null)).toBeNull();
    expect(parseJobClaimCalendarPayload("job_claimed")).toBeNull();
    expect(parseJobClaimCalendarPayload(validRawPayload({ action: "job_released" }))).toBeNull();
  });

  it("rejects a payload missing the claimant or job identity", () => {
    expect(parseJobClaimCalendarPayload(validRawPayload({ claimantId: "" }))).toBeNull();
    expect(parseJobClaimCalendarPayload(validRawPayload({ jobId: undefined }))).toBeNull();
  });

  it("defaults optional descriptive fields and coerces missing dates to null/epoch", () => {
    const parsed = parseJobClaimCalendarPayload({
      action: "job_claimed",
      claimantId: OWNER_ID,
      jobId: JOB_ID,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.jobName).toBe("Claimed job");
    expect(parsed?.groupName).toBe("Group");
    expect(parsed?.startDate).toBeNull();
    expect(parsed?.deadline).toBeNull();
    expect(parsed?.claimedAt).toBe(new Date(0).toISOString());
  });
});

describe("claimantMatchesLocalOwner", () => {
  const payload = parseJobClaimCalendarPayload(validRawPayload()) as JobClaimCalendarPayload;

  it("matches when the raw claimant id already equals the primary agent id", () => {
    expect(claimantMatchesLocalOwner(payload, OWNER_ID, null)).toBe(true);
  });

  it("matches when a per-origin alias resolves to the primary agent id", () => {
    const aliased = parseJobClaimCalendarPayload(
      validRawPayload({ claimantId: "remote-alias-id" }),
    ) as JobClaimCalendarPayload;
    expect(claimantMatchesLocalOwner(aliased, OWNER_ID, OWNER_ID)).toBe(true);
  });

  it("does not match a claim for someone other than the local owner", () => {
    const other = parseJobClaimCalendarPayload(
      validRawPayload({ claimantId: "someone-else" }),
    ) as JobClaimCalendarPayload;
    expect(claimantMatchesLocalOwner(other, OWNER_ID, "some-other-local-id")).toBe(false);
  });

  it("never matches when this instance has no configured owner", () => {
    expect(claimantMatchesLocalOwner(payload, null, OWNER_ID)).toBe(false);
  });
});

describe("syntheticClaimedJobEntityKey", () => {
  it("is namespaced, deterministic on {owner, job}, and clear of the real id space", () => {
    const key = syntheticClaimedJobEntityKey(OWNER_ID, JOB_ID);
    expect(key).toBe(`${CLAIMED_JOB_RESOURCE_KIND}:${OWNER_ID}:${JOB_ID}`);
    // Same inputs → same key (idempotent re-delivery); different job → different key.
    expect(syntheticClaimedJobEntityKey(OWNER_ID, JOB_ID)).toBe(key);
    expect(syntheticClaimedJobEntityKey(OWNER_ID, "other-job")).not.toBe(key);
  });
});

describe("projection metadata ↔ calendar item round-trip", () => {
  const payload = parseJobClaimCalendarPayload(validRawPayload()) as JobClaimCalendarPayload;
  const source = { nodeId: "node-1", nodeSlug: "spirit" };

  it("stamps the resourceKind discriminator, the canonical URL, and provenance", () => {
    const metadata = buildClaimedJobProjectionMetadata(payload, source);
    expect(metadata.resourceKind).toBe(CLAIMED_JOB_RESOURCE_KIND);
    expect(metadata.canonicalUrl).toBe(payload.jobUrl);
    expect(metadata.claimedJobId).toBe(JOB_ID);
    expect(metadata.sourceNodeId).toBe("node-1");
    expect(metadata.sourceNodeSlug).toBe("spirit");
  });

  it("maps a stored projection resource back to a calendar item", () => {
    const metadata = buildClaimedJobProjectionMetadata(payload, source);
    const item = claimedJobResourceToCalendarItem({
      id: "local-projection-id",
      name: payload.jobName,
      metadata,
    });
    expect(item).not.toBeNull();
    expect(item).toMatchObject({
      id: "local-projection-id",
      jobId: JOB_ID,
      title: "Trail maintenance",
      jobUrl: payload.jobUrl,
      groupName: "Spirit of the Front Range",
      startDate: "2026-08-01T09:00:00.000Z",
      deadline: "2026-08-01T17:00:00.000Z",
    });
  });

  it("ignores resources that are not claimed-job projections", () => {
    expect(
      claimedJobResourceToCalendarItem({ id: "x", name: "A post", metadata: { resourceKind: "post" } }),
    ).toBeNull();
    expect(claimedJobResourceToCalendarItem({ id: "x", name: "No metadata", metadata: null })).toBeNull();
  });

  it("drops a projection that lost its canonical URL (nothing to link to)", () => {
    const item = claimedJobResourceToCalendarItem({
      id: "x",
      name: "Orphan",
      metadata: { resourceKind: CLAIMED_JOB_RESOURCE_KIND, canonicalUrl: "", jobUrl: "" },
    });
    expect(item).toBeNull();
  });
});
