import { NextResponse } from "next/server";
import { listInstances } from "@/lib/federation/resolution";
import { ensureLocalNode } from "@/lib/federation";

/**
 * GET /api/federation/registry
 *
 * Returns:
 * - `instances`: every registered federation instance.
 * - `local`: this sovereign's own identity (slug, baseUrl, publicKey,
 *   primaryAgentId, instanceId). Used by the global app's "Connect to
 *   Sovereign Instance" feature to discover the sovereign's signing key
 *   and node id at link time.
 *
 * The endpoint is unauthenticated — only public identity is exposed.
 */
export async function GET() {
  try {
    const instances = await listInstances();
    const localNode = await ensureLocalNode();
    return NextResponse.json({
      success: true,
      instances,
      local: {
        instanceId: localNode.id,
        nodeId: localNode.id,
        slug: localNode.slug,
        baseUrl: localNode.baseUrl,
        publicKey: localNode.publicKey,
        primaryAgentId: localNode.primaryAgentId ?? null,
        instanceType: localNode.instanceType ?? "person",
      },
    });
  } catch (error) {
    console.error("Failed to list federation instances:", error);
    return NextResponse.json(
      { success: false, error: "Failed to list instances" },
      { status: 500 },
    );
  }
}
