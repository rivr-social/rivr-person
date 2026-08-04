/**
 * @fileoverview Pure predicates for the agent grant-target search.
 *
 * Kept out of the route so the reasoning below is testable: a route module in
 * the App Router may only export handlers and route config, so an inline helper
 * there can never be asserted on directly.
 */

/**
 * Whether a search term could possibly be a fragment of an agent id.
 *
 * `agents.id` is a uuid, whose text form contains ONLY hex digits and dashes.
 * A term with any other character therefore cannot match an id under any
 * comparison — so skipping the id predicate for those terms removes a
 * full-table `::text` cast without changing a single result.
 *
 * This exists because the id predicate must be written as an explicit
 * `id::text ILIKE ...`: Postgres has no `uuid ~~* text` operator, and the
 * un-cast version threw on every search rather than only on id-shaped ones.
 *
 * @param term Trimmed search term.
 * @returns True when the term is hex/dash only and worth matching against ids.
 */
export function couldMatchAgentId(term: string): boolean {
  return /^[0-9a-fA-F-]+$/.test(term);
}
