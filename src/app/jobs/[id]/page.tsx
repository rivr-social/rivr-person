/**
 * Job detail page for `/jobs/[id]`.
 *
 * Purpose:
 * - Displays a single job/shift with header stats, progress bar, and
 *   tabbed sections for About, Tasks, and Timer.
 *
 * Rendering: Server Component (fetches data) wrapping a client component for interactivity.
 * Data requirements:
 * - Fetches shifts, projects, and user badge IDs from the database.
 *
 * Auth: Public route. Badge permissions and claim/manage affordances are
 *   derived from the unified session — NextAuth locals AND SSO-landed
 *   remote viewers (who hold only the `rivr_remote_viewer` cookie, never a
 *   NextAuth session). Resolving via bare `auth()` rendered a sovereign-homed
 *   admin as anonymous and stripped every claim/attest affordance.
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module jobs/[id]/page
 */
import { getSession } from "@/lib/auth/get-session"
import { getJobById, getShifts, getProjects, getUserBadgeIds } from "@/lib/queries/resources"
import { JobDetailClient } from "./job-detail"

export default async function JobPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const jobId = params.id as string
  const session = await getSession()
  const currentUserId = session?.user?.id ?? null

  // Fetch the job DIRECTLY by id (type job OR legacy shift). Resolving via
  // getShifts() alone capped at 100 rows and 404'd every older job.
  const [job, jobShifts, projects, userBadgeIds] = await Promise.all([
    getJobById(jobId),
    getShifts(),
    getProjects(),
    currentUserId ? getUserBadgeIds(currentUserId) : Promise.resolve<string[]>([]),
  ])

  return (
    <JobDetailClient
      jobId={jobId}
      initialJob={job}
      jobShifts={jobShifts}
      projects={projects}
      userBadgeIds={userBadgeIds}
      currentUserId={currentUserId}
    />
  )
}
