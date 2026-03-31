import { NextResponse } from "next/server"
import {
  buildEventUniversalManifest,
  buildOfferUniversalManifest,
  buildOrganizationUniversalManifest,
  buildPersonUniversalManifest,
  buildPostUniversalManifest,
  buildProjectUniversalManifest,
} from "@/lib/universal-manifest"

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id } = await params

  if (!isUuid(id)) {
    return NextResponse.json({ error: "Manifest not found." }, { status: 404 })
  }

  const manifest =
    kind === "person"
      ? await buildPersonUniversalManifest(id)
      : kind === "organization"
        ? await buildOrganizationUniversalManifest(id)
        : kind === "project"
          ? await buildProjectUniversalManifest(id)
          : kind === "offer"
            ? await buildOfferUniversalManifest(id)
            : kind === "event"
              ? await buildEventUniversalManifest(id)
              : kind === "post"
                ? await buildPostUniversalManifest(id)
                : null

  if (!manifest) {
    return NextResponse.json({ error: "Manifest not found." }, { status: 404 })
  }

  return NextResponse.json(manifest, {
    headers: {
      "cache-control": "public, max-age=300, s-maxage=300",
    },
  })
}
