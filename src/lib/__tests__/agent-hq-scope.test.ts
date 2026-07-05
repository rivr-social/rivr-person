import { describe, expect, it } from "vitest";

/**
 * Unit coverage for the agent-hq filesystem scope model helpers.
 *
 * Invariants under test: membership-verb precedence for labeling (own >
 * manage > join/belong), the admin-vs-member display split, and the
 * member-visible levels never including "private" (private stays grant-gated).
 */

import {
  MEMBERSHIP_VERBS,
  MEMBER_VISIBLE_LEVELS,
  membershipVerbLabel,
  strongerMembershipVerb,
  type MembershipVerb,
} from "../agent-hq-scope";

describe("strongerMembershipVerb — own > manage > join/belong", () => {
  it("returns the next verb when there is no prior", () => {
    for (const verb of MEMBERSHIP_VERBS) {
      expect(strongerMembershipVerb(undefined, verb)).toBe(verb);
    }
  });

  it("own always wins", () => {
    expect(strongerMembershipVerb("own", "manage")).toBe("own");
    expect(strongerMembershipVerb("manage", "own")).toBe("own");
    expect(strongerMembershipVerb("join", "own")).toBe("own");
    expect(strongerMembershipVerb("own", "belong")).toBe("own");
  });

  it("manage beats join/belong in either order", () => {
    expect(strongerMembershipVerb("manage", "join")).toBe("manage");
    expect(strongerMembershipVerb("belong", "manage")).toBe("manage");
  });

  it("join/belong keep the prior between themselves", () => {
    expect(strongerMembershipVerb("join", "belong")).toBe("join");
    expect(strongerMembershipVerb("belong", "join")).toBe("belong");
  });
});

describe("membershipVerbLabel", () => {
  it("labels own/manage as admin and the rest as member", () => {
    expect(membershipVerbLabel("own")).toBe("admin");
    expect(membershipVerbLabel("manage")).toBe("admin");
    expect(membershipVerbLabel("join")).toBe("member");
    expect(membershipVerbLabel("belong")).toBe("member");
    expect(membershipVerbLabel(undefined)).toBe("member");
  });
});

describe("MEMBER_VISIBLE_LEVELS", () => {
  it("never includes private — private stays owner/grant-gated", () => {
    expect(MEMBER_VISIBLE_LEVELS).toEqual(["public", "locale", "members"]);
    expect(MEMBER_VISIBLE_LEVELS as readonly string[]).not.toContain("private");
  });
});

describe("MEMBERSHIP_VERBS", () => {
  it("covers exactly the tree-relating verbs", () => {
    expect([...MEMBERSHIP_VERBS].sort()).toEqual(["belong", "join", "manage", "own"]);
    // Type-level guard: a MembershipVerb is assignable from each member.
    const sample: MembershipVerb = "join";
    expect(MEMBERSHIP_VERBS).toContain(sample);
  });
});
