import { NextResponse } from "next/server"
import { syncAllMurmurationsProfiles, syncMurmurationsProfilesForActor } from "@/lib/murmurations"

function isAuthorized(request: Request): boolean {
  const secret = process.env.MURMURATIONS_CRON_SECRET?.trim()
  if (!secret) return false
  const authHeader = request.headers.get("authorization") || ""
  return authHeader === `Bearer ${secret}`
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const url = new URL(request.url)
  const actorId = url.searchParams.get("actorId")

  try {
    if (actorId) {
      const result = await syncMurmurationsProfilesForActor(actorId)
      return NextResponse.json({ actorId, ...result })
    }

    const result = await syncAllMurmurationsProfiles()
    return NextResponse.json(result)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sync Murmurations profiles." },
      { status: 500 }
    )
  }
}
