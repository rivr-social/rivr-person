import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { fetchProfileData, fetchUserEvents, fetchUserGroups, fetchUserPosts } from "@/app/actions/graph";
import { PUBLIC_PROFILE_MODULE_ID, resolvePublicProfileAgent } from "@/lib/bespoke/modules/public-profile";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveHomeInstance } from "@/lib/federation/resolution";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ username: string }> },
) {
  const { username } = await params;
  const session = await auth();
  const actorId = session?.user?.id ?? null;

  const agent = await resolvePublicProfileAgent(username);
  if (!agent) {
    return NextResponse.json(
      { success: false, error: "Profile not found" },
      { status: 404, headers: noStoreHeaders() },
    );
  }

  try {
    const [profile, posts, events, groups, homeInstance] = await Promise.all([
      fetchProfileData(agent.id).catch(() => null),
      fetchUserPosts(agent.id, 30).catch(() => ({ posts: [], owner: null })),
      fetchUserEvents(agent.id, 30).catch(() => []),
      fetchUserGroups(agent.id, 30).catch(() => []),
      resolveHomeInstance(agent.id).catch(() => null),
    ]);

    const config = getInstanceConfig();

    return NextResponse.json(
      {
        success: true,
        actorId,
        subjectId: agent.id,
        subjectUsername: username,
        agent,
        profile,
        posts,
        events,
        groups,
        module: {
          moduleId: PUBLIC_PROFILE_MODULE_ID,
          manifestEndpoint: `/api/profile/${encodeURIComponent(username)}/manifest`,
        },
        federation: {
          localInstanceId: config.instanceId,
          localInstanceType: config.instanceType,
          localInstanceSlug: config.instanceSlug,
          homeInstance,
          isHomeInstance: homeInstance ? homeInstance.nodeId === config.instanceId : true,
        },
      },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    console.error("[api/profile/[username]] Failed to load public profile bundle:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load public profile bundle",
      },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}

function noStoreHeaders(): HeadersInit {
  return {
    "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  };
}
