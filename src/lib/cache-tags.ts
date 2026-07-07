/**
 * Data-cache tags and TTLs shared between cached feed readers and the
 * mutation paths that must revalidate them.
 *
 * Every `revalidateTag` call MUST reference these constants — a stringly
 * typed tag that drifts from the reader's tag silently stops revalidating.
 *
 * PUBLIC_POST_FEED_CACHE_TAG invalidators (keep this list current):
 * - post create/update/delete server actions (resource-creation, create-resources)
 * - federation event import (materialized post upserts/deletes)
 * - manifest-reference upserts/retirements (federated reference cards)
 * The TTL is only the backstop for any path this list misses.
 */
export const PUBLIC_POST_FEED_CACHE_TAG = "feed-public-posts";
export const PUBLIC_POST_FEED_TTL_SECONDS = 60;
