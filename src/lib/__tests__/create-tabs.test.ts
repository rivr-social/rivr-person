import { describe, it, expect } from "vitest"
import {
  CREATE_TABS,
  DEFAULT_CREATE_TAB,
  resolveInitialCreateTab,
} from "@/lib/create-tabs"

describe("resolveInitialCreateTab", () => {
  it("honors ?tab=offering so the profile 'Create Offering' deep link lands on the offering composer", () => {
    // Regression: /create?tab=offering previously fell through to the Post tab
    // because "offering" was missing from the supported set.
    expect(resolveInitialCreateTab("offering")).toBe("offering")
  })

  it.each(CREATE_TABS)("passes through every supported tab verbatim: %s", (tab) => {
    expect(resolveInitialCreateTab(tab)).toBe(tab)
  })

  it("maps the 'job' alias onto the project composer", () => {
    expect(resolveInitialCreateTab("job")).toBe("project")
  })

  it("falls back to the default tab for unknown values", () => {
    expect(resolveInitialCreateTab("nonsense")).toBe(DEFAULT_CREATE_TAB)
    expect(DEFAULT_CREATE_TAB).toBe("post")
  })

  it("falls back to the default tab when no param is present", () => {
    expect(resolveInitialCreateTab(null)).toBe(DEFAULT_CREATE_TAB)
    expect(resolveInitialCreateTab(undefined)).toBe(DEFAULT_CREATE_TAB)
    expect(resolveInitialCreateTab("")).toBe(DEFAULT_CREATE_TAB)
  })
})
