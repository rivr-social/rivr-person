import { NextResponse } from "next/server"
import {
  buildOfferMurmurationsProfile,
  buildOrganizationMurmurationsProfile,
  buildPersonMurmurationsProfile,
  buildProjectMurmurationsProfile,
} from "@/lib/murmurations"

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> }
) {
  const { kind, id } = await params

  const profile =
    kind === "person"
      ? await buildPersonMurmurationsProfile(id)
      : kind === "organization"
        ? await buildOrganizationMurmurationsProfile(id)
        : kind === "project"
          ? await buildProjectMurmurationsProfile(id)
          : kind === "offer"
            ? await buildOfferMurmurationsProfile(id)
            : null

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 })
  }

  return NextResponse.json(profile, {
    headers: {
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  })
}
