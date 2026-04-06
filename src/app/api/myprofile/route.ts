import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  fetchMarketplaceListings,
  fetchMyReceipts,
  fetchMySavedListingIds,
  fetchProfileData,
  fetchReactionCountsForUser,
  fetchUserConnections,
  fetchUserEvents,
  fetchUserGroups,
  fetchUserPosts,
} from "@/app/actions/graph";
import { getDocumentsForUser } from "@/lib/queries/resources";
import { getAllSubscriptionStatusesAction } from "@/app/actions/billing";
import {
  getMyTicketPurchasesAction,
  getMyWalletAction,
  getMyWalletsAction,
  getTransactionHistoryAction,
} from "@/app/actions/wallet";
import { MYPROFILE_MODULE_ID } from "@/lib/bespoke/modules/myprofile";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import { resolveHomeInstance } from "@/lib/federation/resolution";

export const dynamic = "force-dynamic";

/**
 * GET /api/myprofile
 *
 * Authenticated bundle endpoint for the current user's bespoke profile UI.
 * This intentionally exposes only the caller's own data and keeps the server
 * action/gating logic on the server side.
 */
export async function GET() {
  const session = await auth();
  const actorId = session?.user?.id ?? null;

  if (!actorId) {
    return NextResponse.json(
      { success: false, error: "Authentication required" },
      { status: 401, headers: noStoreHeaders() },
    );
  }

  try {
    const [profile, savedListingIds, wallet, wallets, transactions, ticketPurchases, subscriptions, receipts, posts, events, groups, marketplaceListings, reactionCounts, connections, documents, homeInstance] = await Promise.all([
      fetchProfileData(actorId).catch(() => null),
      fetchMySavedListingIds().catch(() => [] as string[]),
      getMyWalletAction().catch(() => ({ success: false as const })),
      getMyWalletsAction().catch(() => ({ success: false as const })),
      getTransactionHistoryAction({ limit: 30 }).catch(() => ({ success: false as const })),
      getMyTicketPurchasesAction().catch(() => ({ success: false as const })),
      getAllSubscriptionStatusesAction().catch(() => []),
      fetchMyReceipts().catch(() => ({ receipts: [] })),
      fetchUserPosts(actorId, 30).catch(() => ({ posts: [], owner: null })),
      fetchUserEvents(actorId, 30).catch(() => []),
      fetchUserGroups(actorId, 30).catch(() => []),
      fetchMarketplaceListings(50).catch(() => []),
      fetchReactionCountsForUser(actorId).catch(() => ({})),
      fetchUserConnections(actorId).catch(() => []),
      getDocumentsForUser(actorId).catch(() => []),
      resolveHomeInstance(actorId).catch(() => null),
    ]);

    const config = getInstanceConfig();

    return NextResponse.json(
      {
        success: true,
        actorId,
        profile,
        savedListingIds,
        wallet,
        wallets,
        transactions,
        ticketPurchases,
        subscriptions,
        receipts,
        posts,
        events,
        groups,
        marketplaceListings,
        reactionCounts,
        connections,
        documents,
        module: {
          moduleId: MYPROFILE_MODULE_ID,
          manifestEndpoint: "/api/myprofile/manifest",
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
    console.error("[api/myprofile] Failed to load bundle:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load myprofile bundle",
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
