import { describe, expect, it } from "vitest";

import {
  AGENT_DETERMINERS,
  AGENT_VERBS,
  ALL_VERBS,
  KNOWN_DETERMINERS,
  RESOURCE_DETERMINERS,
  RESOURCE_TYPE_VERBS,
  VERB_GROUPS,
  VERB_RESOURCE_TYPES,
  WILDCARD_AGENTS,
} from "./composer-vocab";

describe("shared composer vocabulary", () => {
  it("keeps grouped verbs and parser verbs in sync", () => {
    const grouped = VERB_GROUPS.flatMap((group) => group.verbs);

    expect(new Set(ALL_VERBS)).toEqual(new Set(grouped));
    expect(ALL_VERBS).toEqual(expect.arrayContaining(["view", "grant", "revoke", "use"]));
  });

  it("derives resource-type verb mappings from verb resource mappings", () => {
    for (const [verb, resourceTypes] of Object.entries(VERB_RESOURCE_TYPES)) {
      for (const resourceType of resourceTypes) {
        expect(RESOURCE_TYPE_VERBS[resourceType]).toContain(verb);
      }
    }

    expect(RESOURCE_TYPE_VERBS.document).toEqual(
      expect.arrayContaining(["create", "update", "view", "share"]),
    );
    expect(RESOURCE_TYPE_VERBS.permission_policy).toEqual(
      expect.arrayContaining(["grant", "revoke", "request"]),
    );
  });

  it("keeps agent-targeting verbs out of resource object selection", () => {
    for (const verb of AGENT_VERBS) {
      expect(VERB_RESOURCE_TYPES[verb]).toEqual([]);
    }

    expect(AGENT_VERBS.has("follow")).toBe(true);
    expect(AGENT_VERBS.has("grant")).toBe(false);
  });

  it("shares determiner vocabulary for parser and authoring controls", () => {
    for (const determiner of [...AGENT_DETERMINERS, ...RESOURCE_DETERMINERS]) {
      expect(KNOWN_DETERMINERS.has(determiner)).toBe(true);
    }

    expect(KNOWN_DETERMINERS.has("every")).toBe(true);
    expect(WILDCARD_AGENTS.map((agent) => agent.id)).toEqual(
      expect.arrayContaining(["__everyone__", "__any_person__", "__any_group__"]),
    );
  });
});
