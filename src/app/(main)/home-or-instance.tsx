/**
 * Instance-aware root page.
 *
 * - Person instance (INSTANCE_TYPE=person + PRIMARY_AGENT_ID): renders that
 *   person's public profile as the site root — this is what every deploy of
 *   this repo actually does.
 * - Anything else: renders the full home feed.
 *
 * A third branch used to render a GROUP page at the root for
 * `INSTANCE_TYPE` values that were neither "person" nor "global". It was
 * unreachable in this repo — the person branch always returns first, and no
 * person deploy sets a group-ish INSTANCE_TYPE — so it and its exclusive
 * component tree were removed on 2026-07-22. The group root page lives in the
 * rivr-group repo, which is the app type that serves it.
 */
import { notFound } from "next/navigation"
import { Suspense } from "react"
import { fetchHomeFeed, fetchBasins, fetchLocales, fetchPublicPostResources, fetchPublicAgentById } from "@/app/actions/graph"
import {
  agentToUser,
  agentToGroup,
  agentToEvent,
  agentToPlace,
  agentToBasin,
  agentToLocale,
  resourceToMarketplaceListing,
  resourceToPost,
} from "@/lib/graph-adapters"
import type { SerializedResource } from "@/lib/graph-serializers"
import { buildProfileStructuredData, serializeJsonLd } from "@/lib/structured-data"
import HomeClient from "./home-client"
import MainLoading from "./loading"
import { PublicProfilePageClient } from "@/components/public-profile-page-client"

const PERSON_INSTANCE_TYPE = 'person';
const DEFAULT_INSTANCE_TYPE = 'global';

export default async function HomeOrInstance() {
  const instanceType = process.env.INSTANCE_TYPE || DEFAULT_INSTANCE_TYPE;
  const primaryAgentId = process.env.PRIMARY_AGENT_ID;

  if (instanceType === PERSON_INSTANCE_TYPE && primaryAgentId) {
    return renderPersonPage(primaryAgentId);
  }

  return renderHomeFeed();
}

// ── Person instance page ──────────────────────────────────────
async function renderPersonPage(agentId: string) {
  const agent = await fetchPublicAgentById(agentId);
  if (!agent) notFound();

  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;
  const profile = {
    id: agent.id,
    name: agent.name,
    description: agent.description || (typeof metadata.bio === "string" ? metadata.bio : null),
    image: agent.image,
    username: typeof metadata.username === "string" ? metadata.username : agent.name,
    location: typeof metadata.location === "string" ? metadata.location : null,
    chapterTags: Array.isArray(metadata.chapterTags) ? metadata.chapterTags.filter((tag): tag is string => typeof tag === "string") : [],
    skills: Array.isArray(metadata.skills) ? metadata.skills.filter((skill): skill is string => typeof skill === "string") : [],
    metadata,
  };

  const structuredData = buildProfileStructuredData(profile, {
    visibility: agent.visibility ?? null,
  });

  return (
    <>
      {structuredData ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
        />
      ) : null}
      <PublicProfilePageClient agentId={profile.username} />
    </>
  );
}

// ── Global home feed ──────────────────────────────────────────
function renderHomeFeed() {
  // Suspense boundary inside the page: the shell (header/nav) streams on the
  // initial document request while the feed queries resolve, instead of
  // blocking first paint on all of them. The route-level loading.tsx only
  // covers client-side navigations; this covers the cold hit. Fallback reuses
  // the same skeleton so both paths look identical.
  return (
    <Suspense fallback={<MainLoading />}>
      <HomeFeedLoader />
    </Suspense>
  );
}

async function HomeFeedLoader() {
  const result = await loadHomeFeed();
  return (
    <HomeClient
      initialPeople={result.people}
      initialGroups={result.groups}
      initialEvents={result.events}
      initialPlaces={result.places}
      initialMarketplace={result.marketplace}
      initialPosts={result.posts}
      initialBasins={result.basins}
      initialLocales={result.locales}
    />
  );
}

async function loadHomeFeed() {
  try {
    const [feed, basinAgents, localeAgents, postResources] = await Promise.all([
      fetchHomeFeed(50),
      fetchBasins(),
      fetchLocales(),
      // Post-type filter is pushed into SQL (getPublicPostResources) — no JS
      // post-discrimination needed, and the over-fetch drops 300 → 60.
      fetchPublicPostResources(60),
    ])
    return {
      people: feed.people.map(agentToUser),
      groups: feed.groups.map(agentToGroup),
      events: feed.events.map(agentToEvent),
      places: feed.places.map(agentToPlace),
      marketplace: feed.marketplace.map((item) =>
        resourceToMarketplaceListing(item as unknown as SerializedResource)
      ),
      posts: postResources.map((r) => resourceToPost(r)) as import("@/lib/types").Post[],
      basins: basinAgents.map(agentToBasin),
      locales: localeAgents.map(agentToLocale),
    }
  } catch (err) {
    console.error(`[Home] Server-side data fetch failed:`, err)
    return { people: [], groups: [], events: [], places: [], marketplace: [], posts: [], basins: [], locales: [] }
  }
}
