import { getBadgeDefinitions, userHasBadge, getShifts } from "@/lib/queries/resources"
import { BadgeDetailClient } from "./badge-detail"
import { getSession } from "@/lib/auth/get-session"

export default async function BadgeDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const badgeId = params.id as string
  // Unified session so a cookie-only remote viewer resolves to their own
  // actor and the "earned" state reflects their real badge holdings.
  const session = await getSession()
  const userId = session?.user?.id

  const [allBadges, isEarned, jobShifts] = await Promise.all([
    getBadgeDefinitions(),
    userId ? userHasBadge(userId, badgeId) : Promise.resolve(false),
    getShifts(),
  ])

  return (
    <BadgeDetailClient
      badgeId={badgeId}
      allBadges={allBadges}
      isEarned={isEarned}
      jobShifts={jobShifts}
    />
  )
}
