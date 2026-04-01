/**
 * Instance-aware root page.
 *
 * - Global instance: renders the full home feed
 * - Group instance: renders the group page for PRIMARY_AGENT_ID
 * - Locale instance: renders the locale page for PRIMARY_AGENT_ID
 */
import { notFound } from "next/navigation"
import { Suspense } from "react"
import Link from "next/link"
import { MessageSquare, Settings } from "lucide-react"
import { auth } from "@/auth"
import { fetchHomeFeed, fetchBasins, fetchLocales, fetchPublicResources, fetchGroupDetail, fetchAgentFeed, fetchPublicAgentById } from "@/app/actions/graph"
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
import { readGroupMembershipPlans } from "@/lib/group-memberships"
import { buildProfileStructuredData, buildGroupStructuredData, serializeJsonLd } from "@/lib/structured-data"
import HomeClient from "./home-client"
import { AgentPageShell } from "@/components/agent-page-shell"
import { Button } from "@/components/ui/button"
import { GroupJoinControl } from "@/components/group-join-control"
import { GroupActions } from "@/components/group-actions"
import { GroupTabsClient } from "@/components/group-tabs-client"
import { GroupProfileHeader } from "@/components/group-profile-header"
import { PublicProfilePageClient } from "@/components/public-profile-page-client"

export default async function HomeOrInstance() {
  const instanceType = process.env.INSTANCE_TYPE || 'global';
  const primaryAgentId = process.env.PRIMARY_AGENT_ID;

  if (instanceType === 'person' && primaryAgentId) {
    return renderPersonPage(primaryAgentId);
  }

  if (instanceType !== 'global' && primaryAgentId) {
    return renderGroupPage(primaryAgentId);
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
async function renderHomeFeed() {
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
    const [feed, basinAgents, localeAgents, publicResources] = await Promise.all([
      fetchHomeFeed(50),
      fetchBasins(),
      fetchLocales(),
      fetchPublicResources(300),
    ])
    const postResources = publicResources.filter((r) => {
      const meta = (r.metadata ?? {}) as Record<string, unknown>
      return meta.entityType === "post" || r.type === "post" || r.type === "note"
    })
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

// ── Group instance page ───────────────────────────────────────
async function renderGroupPage(id: string) {
  const [detail, activity, session] = await Promise.all([
    fetchGroupDetail(id),
    fetchAgentFeed(id, 40).catch(() => []),
    auth(),
  ])

  if (!detail) {
    notFound()
  }

  const group = agentToGroup(detail.group)
  const members = detail.members.map(agentToUser)
  const domainGroups = detail.subgroups.map(agentToGroup)
  const groupMeta = (detail.group.metadata ?? {}) as Record<string, unknown>
  const rawGroupType = String(groupMeta.groupType ?? "").toLowerCase()
  const canonicalGroupType = rawGroupType === "org" ? "organization" : (rawGroupType || "basic")
  const ownerId = typeof groupMeta.creatorId === "string" ? groupMeta.creatorId : undefined
  const currentUserId = session?.user?.id ?? null
  const isGroupAdmin = !!(currentUserId && (
    groupMeta.creatorId === currentUserId ||
    (Array.isArray(groupMeta.adminIds) && (groupMeta.adminIds as unknown[]).includes(currentUserId))
  ))
  const isMember = !!(currentUserId && members.some((m) => m.id === currentUserId))
  const membershipPlans = readGroupMembershipPlans(groupMeta)

  const eventResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "event" || meta.resourceKind === "event"
  })
  const groupPostResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "post" || r.type === "note" || String(meta.entityType ?? "") === "post"
  })
  const projectResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "project" || meta.resourceKind === "project"
  })
  const listingResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return (
      (r.type === "listing" || r.type === "resource" || r.type === "skill" || r.type === "venue")
      && (typeof meta.listingType === "string" || String(meta.listingKind ?? "").toLowerCase() === "marketplace-listing")
    )
  })
  const governanceItems = [
    ...(((groupMeta.proposals as unknown[]) ?? []) as unknown[]),
    ...(((groupMeta.polls as unknown[]) ?? []) as unknown[]),
    ...(((groupMeta.issues as unknown[]) ?? []) as unknown[]),
  ]
  const documentResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "resource" && (String(meta.resourceSubtype ?? "").toLowerCase() === "document" || typeof r.content === "string")
  })
  const jobResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "job" || r.type === "task" || meta.resourceKind === "job" || meta.resourceKind === "task"
  })
  const jobOnlyResources = jobResources.filter((r) => r.type === "job" || String(((r.metadata ?? {}) as Record<string, unknown>).resourceKind ?? "") === "job")
  const taskResources = jobResources.filter((r) => r.type === "task" || String(((r.metadata ?? {}) as Record<string, unknown>).resourceKind ?? "") === "task")
  const badgeResources = detail.resources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    return r.type === "badge" || meta.resourceKind === "badge"
  })
  const pressResources = documentResources.filter((r) => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    const category = String(meta.category ?? "").toLowerCase()
    return category.includes("press") || category.includes("news") || category.includes("media")
  })

  const activityEntries = (activity as Array<{ id: string; verb: string; timestamp: string; [key: string]: unknown }>)
  const stakeActivity = activityEntries.filter((entry) => entry.verb === "fund")
  const treasuryActivity = activityEntries.filter((entry) => entry.verb === "transfer")
  const publishActivity = activityEntries.filter((entry) => entry.verb === "publish" || entry.verb === "create")

  const groupTags = Array.isArray(groupMeta.tags) ? groupMeta.tags.filter((tag): tag is string => typeof tag === "string") : []
  const groupContact = (groupMeta.contactInfo ?? groupMeta.contact ?? {}) as Record<string, unknown>
  const groupAdmins = members.filter((member) =>
    member.id === (groupMeta.creatorId as string) ||
    (Array.isArray(groupMeta.adminIds) && (groupMeta.adminIds as unknown[]).includes(member.id))
  )
  const groupCreator = groupAdmins.find((member) => member.id === (groupMeta.creatorId as string))
  const groupLocationText =
    typeof group.location === "string"
      ? group.location
      : group.location && typeof group.location === "object"
        ? String((group.location as Record<string, unknown>).address ?? (group.location as Record<string, unknown>).name ?? "Location not provided")
        : "Location not provided"

  const structuredData = buildGroupStructuredData(group, {
    path: `/`,
    visibility: detail.group.visibility ?? null,
    groupType: String(groupMeta.groupType ?? "organization"),
    memberCount: members.length || group.memberCount || 0,
  })

  // Project/job/task trees (simplified — full tree logic in groups/[id]/page.tsx)
  const projectJobTrees = projectResources.map((project) => {
    const pMeta = (project.metadata ?? {}) as Record<string, unknown>
    const jobs = jobOnlyResources.filter((job) => {
      const jMeta = (job.metadata ?? {}) as Record<string, unknown>
      return String(jMeta.projectId ?? jMeta.projectDbId ?? "") === project.id
    })
    const tasksByJob: Record<string, typeof taskResources> = {}
    for (const job of jobs) {
      tasksByJob[job.id] = taskResources.filter((task) => {
        const tMeta = (task.metadata ?? {}) as Record<string, unknown>
        return String(tMeta.jobId ?? tMeta.jobDbId ?? "") === job.id
      })
    }
    const projectLevelTasks = taskResources.filter((task) => {
      const tMeta = (task.metadata ?? {}) as Record<string, unknown>
      return String(tMeta.projectId ?? tMeta.projectDbId ?? "") === project.id &&
        !Object.values(tasksByJob).flat().some((t) => t.id === task.id)
    })
    return { project, jobs, tasksByJob, projectLevelTasks }
  })
  const assignedJobIds = new Set(projectJobTrees.flatMap((tree) => tree.jobs.map((job) => job.id)))
  const assignedTaskIds = new Set(
    projectJobTrees.flatMap((tree) => [
      ...tree.projectLevelTasks.map((task) => task.id),
      ...Object.values(tree.tasksByJob).flat().map((task) => task.id),
    ])
  )
  const unassignedJobs = jobOnlyResources.filter((job) => !assignedJobIds.has(job.id))
  const unassignedTasks = taskResources.filter((task) => !assignedTaskIds.has(task.id))

  const header = (
    <GroupProfileHeader
      groupId={group.id}
      name={group.name}
      description={group.description}
      avatar={group.image || "/placeholder.svg"}
      coverImage={
        typeof groupMeta.coverImage === "string" && groupMeta.coverImage
          ? groupMeta.coverImage as string
          : "/vibrant-garden-tending.png"
      }
      location={groupLocationText}
      memberCount={members.length || group.memberCount || 0}
      tags={group.chapterTags ?? []}
      isAdmin={isGroupAdmin}
      groupType={canonicalGroupType}
      commissionBps={typeof groupMeta.commissionBps === "number" ? groupMeta.commissionBps as number : undefined}
    >
      <div className="flex items-center gap-2">
        {isGroupAdmin && (
          <Link href={`/groups/${group.id}/settings`}>
            <Button variant="outline" size="sm">
              <Settings className="h-4 w-4 mr-2" />
              Edit Group
            </Button>
          </Link>
        )}
        {isMember && (
          <Link href={`/messages?group=${group.id}`}>
            <Button variant="outline" size="sm">
              <MessageSquare className="h-4 w-4 mr-2" />
              Chat
            </Button>
          </Link>
        )}
        <GroupActions
          groupId={group.id}
          groupName={group.name}
          groupDescription={group.description}
          ownerId={ownerId}
        />
        <GroupJoinControl
          groupId={group.id}
          groupName={group.name}
          joinSettings={group.joinSettings}
          initiallyJoined={isMember}
        />
      </div>
    </GroupProfileHeader>
  )

  return (
    <AgentPageShell
      backHref="/"
      backLabel=""
      header={header}
      structuredDataJson={structuredData ? serializeJsonLd(structuredData) : null}
    >
      <GroupTabsClient
        groupId={group.id}
        groupName={group.name}
        groupDescription={group.description}
        groupType={canonicalGroupType}
        groupLocation={groupLocationText}
        groupTags={groupTags}
        groupContact={groupContact}
        groupAdmins={groupAdmins.map((a) => ({ id: a.id, name: a.name }))}
        groupCreatorName={groupCreator?.name ?? null}
        isGroupAdmin={!!isGroupAdmin}
        currentUserId={currentUserId}
        membershipPlans={membershipPlans}
        members={members.map((m) => ({ id: m.id, name: m.name, username: m.username, image: m.avatar }))}
        groupPostResources={groupPostResources}
        eventResources={eventResources}
        domainGroups={domainGroups.map((d) => ({ id: d.id, name: d.name, description: d.description }))}
        affiliatedGroups={[]}
        projectJobTrees={projectJobTrees}
        unassignedJobs={unassignedJobs}
        unassignedTasks={unassignedTasks}
        listingResources={listingResources}
        governanceItems={governanceItems}
        badgeResources={badgeResources}
        stakeActivity={stakeActivity}
        pressResources={pressResources}
        documentResources={documentResources.map((r) => {
          const meta = (r.metadata ?? {}) as Record<string, unknown>
          return {
            id: r.id,
            title: r.name,
            description: r.description || "",
            content: typeof r.content === "string" ? r.content : "",
            createdAt: r.createdAt,
            updatedAt: r.updatedAt ?? r.createdAt,
            createdBy: r.ownerId,
            groupId: id,
            tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
            category: typeof meta.category === "string" ? meta.category : undefined,
            showOnAbout: meta.showOnAbout === true,
          }
        })}
        projectResources={projectResources}
        jobResources={jobOnlyResources}
        treasuryActivity={treasuryActivity}
        publishActivity={publishActivity}
        resourceCount={detail.resources.length}
        passwordRequired={Boolean(group.joinSettings?.passwordRequired)}
      />
    </AgentPageShell>
  )
}
