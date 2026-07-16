/**
 * Pure helpers for the `/create` workspace tab selection.
 *
 * The create page reads a `?tab=` query param and maps it to one of the tabbed
 * composers. Keeping the mapping here (instead of inline in the client page)
 * makes the deep-link contract unit-testable — e.g. `/create?tab=offering`
 * (linked from the profile Offerings tab) MUST land on the offering composer.
 */

/** Composer tabs the `/create` page renders, in display order. */
export const CREATE_TABS = ["post", "event", "project", "group", "offering"] as const

export type CreateTab = (typeof CREATE_TABS)[number]

/** Default tab when no (or an unrecognized) `tab` param is supplied. */
export const DEFAULT_CREATE_TAB: CreateTab = "post"

const SUPPORTED_CREATE_TABS = new Set<string>(CREATE_TABS)

/**
 * Resolves the initial active tab from the `?tab=` query param.
 *
 * - `job` is an alias that opens the Project composer's job-creation flow.
 * - Any supported tab value passes through verbatim.
 * - Anything else (missing/unknown) falls back to {@link DEFAULT_CREATE_TAB}.
 *
 * @param urlTab Raw `tab` query param value (or null when absent).
 * @returns The tab the page should activate.
 */
export function resolveInitialCreateTab(urlTab: string | null | undefined): CreateTab {
  if (urlTab === "job") return "project"
  if (urlTab && SUPPORTED_CREATE_TABS.has(urlTab)) return urlTab as CreateTab
  return DEFAULT_CREATE_TAB
}
