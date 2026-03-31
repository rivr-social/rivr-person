import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { PublicProfilePageClient } from "@/components/public-profile-page-client"
import { resolvePublicProfileAgent } from "@/lib/bespoke/modules/public-profile"
import { buildPersonMetadata } from "@/lib/object-metadata"
import { buildProfileStructuredData, serializeJsonLd } from "@/lib/structured-data"

async function getProfilePageData(username: string) {
  const agent = await resolvePublicProfileAgent(username)
  if (!agent) return null
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>

  return {
    agent,
    profile: {
      id: agent.id,
      name: agent.name,
      description: agent.description || (typeof metadata.bio === "string" ? metadata.bio : null),
      image: agent.image,
      username: typeof metadata.username === "string" ? metadata.username : username,
      location: typeof metadata.location === "string" ? metadata.location : null,
      chapterTags: Array.isArray(metadata.chapterTags) ? metadata.chapterTags.filter((tag): tag is string => typeof tag === "string") : [],
      skills: Array.isArray(metadata.skills) ? metadata.skills.filter((skill): skill is string => typeof skill === "string") : [],
      metadata,
    },
  }
}

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params
  const data = await getProfilePageData(username)

  if (!data) {
    return {
      title: "Profile Not Found | RIVR",
    }
  }

  return buildPersonMetadata(data.agent, data.profile.username || username)
}

export default async function UserProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const { username } = await params
  const data = await getProfilePageData(username)

  if (!data) {
    notFound()
  }

  const structuredData = buildProfileStructuredData(data.profile, {
    visibility: data.agent.visibility ?? null,
  })

  return (
    <>
      {structuredData ? (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(structuredData) }}
        />
      ) : null}
      <PublicProfilePageClient />
    </>
  )
}
