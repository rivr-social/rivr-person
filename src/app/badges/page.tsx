import { getBadgeDefinitions, getShifts } from "@/lib/queries/resources"
import { BadgesPageClient } from "./badges-page"
import { getSession } from "@/lib/auth/get-session"
import { fetchUserBadges } from "@/app/actions/graph"

export default async function BadgesPage() {
  // Unified session so an SSO-landed remote viewer (cookie-only, no NextAuth
  // session) still resolves to their own actor and sees their earned badges.
  const session = await getSession()
  const userId = session?.user?.id

  const [allBadges, jobShifts, userBadgeResources] = await Promise.all([
    getBadgeDefinitions(),
    getShifts(),
    userId ? fetchUserBadges(userId) : Promise.resolve([]),
  ])

  // Map serialized badge resources to UserBadge shape for the client
  const userBadges = allBadges.filter((badge) =>
    userBadgeResources.some((r) => r.id === badge.id)
  )

  return (
    <BadgesPageClient
      allBadges={allBadges}
      userBadges={userBadges}
      jobShifts={jobShifts}
    />
  )
}
