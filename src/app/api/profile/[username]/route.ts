import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { fetchProfileData, fetchUserEvents, fetchUserGroups, fetchUserPosts } from "@/app/actions/graph";
import { findAutobotEnabledPersona } from "@/app/actions/personas";
import { PUBLIC_PROFILE_MODULE_ID, resolvePublicProfileAgent } from "@/lib/bespoke/modules/public-profile";
import type { CanonicalProfileRef, HomeAuthorityRef } from "@/lib/federation/cross-instance-types";
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
    const [profile, posts, events, groups, homeInstance, autobotPersona] = await Promise.all([
      fetchProfileData(agent.id).catch(() => null),
      fetchUserPosts(agent.id, 30).catch(() => ({ posts: [], owner: null })),
      fetchUserEvents(agent.id, 30).catch(() => []),
      fetchUserGroups(agent.id, 30).catch(() => []),
      resolveHomeInstance(agent.id).catch(() => null),
      findAutobotEnabledPersona(agent.id).catch(() => null),
    ]);

    const config = getInstanceConfig();
    const canonicalUrl = `${homeInstance?.baseUrl ?? config.baseUrl}/profile/${encodeURIComponent(username)}`;
    const homeAuthority: HomeAuthorityRef | null = homeInstance
      ? {
          homeBaseUrl: homeInstance.baseUrl,
          homeAgentId: agent.id,
          homeInstanceType: homeInstance.instanceType as HomeAuthorityRef["homeInstanceType"],
          globalIndexAgentId: homeInstance.nodeId === config.instanceId ? undefined : agent.id,
          manifestUrl: `${homeInstance.baseUrl}/api/profile/${encodeURIComponent(username)}/manifest`,
          canonicalProfileUrl: canonicalUrl,
        }
      : null;
    const canonicalProfile: CanonicalProfileRef | null = homeAuthority
      ? {
          agentId: agent.id,
          displayName: agent.name || profile?.agent.name || username,
          username,
          avatarUrl: agent.image ?? profile?.agent.image ?? undefined,
          homeAuthority,
          isLocallyHomed: homeInstance?.nodeId === config.instanceId,
          canonicalUrl,
          globalIndexUrl:
            homeInstance?.nodeId === config.instanceId
              ? undefined
              : `${config.baseUrl}/profile/${encodeURIComponent(username)}`,
        }
      : null;

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
        autobotPersona: autobotPersona
          ? {
              id: autobotPersona.id,
              name: autobotPersona.name,
              image: autobotPersona.image,
            }
          : null,
        module: {
          moduleId: PUBLIC_PROFILE_MODULE_ID,
          manifestEndpoint: `/api/profile/${encodeURIComponent(username)}/manifest`,
        },
        federation: {
          localInstanceId: config.instanceId,
          localInstanceType: config.instanceType,
          localInstanceSlug: config.instanceSlug,
          homeInstance,
          homeAuthority,
          canonicalProfile,
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
