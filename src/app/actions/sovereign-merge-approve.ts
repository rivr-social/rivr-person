"use server";

/**
 * Sovereign side of the global → sovereign merge handshake.
 *
 * The user lands on `/sovereign-merge-confirm` with a signed merge token from
 * the global instance. After they click "Approve", this action:
 *
 * 1. Verifies the user is signed in to this sovereign instance.
 * 2. Looks up this sovereign's local node row (slug, baseUrl, public key,
 *    private key).
 * 3. Builds the canonical merge-confirmation payload, signs it with the local
 *    node's Ed25519 private key, and returns the redirect URL the popup
 *    should navigate to. The redirect target is the global callback route,
 *    with the proof signature, sovereign identifiers, and the original token
 *    attached as query params.
 *
 * The action does not perform the redirect itself — it returns the URL and
 * the client navigates the popup so the user clearly sees the round trip.
 */

import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { nodes } from "@/db/schema";
import { ensureLocalNode } from "@/lib/federation";
import { signPayload } from "@/lib/federation-crypto";

/** Lifetime of the proof signature. Mirrors the global token TTL. */
const PROOF_TTL_MS = 5 * 60 * 1000;

type ApproveResult =
  | { ok: true; redirectUrl: string }
  | { ok: false; error: string };

export async function approveSovereignMergeAction(input: {
  mergeRequestId: string;
  globalUrl: string;
  globalAgentId: string;
  callbackUrl: string;
  token: string;
}): Promise<ApproveResult> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { ok: false, error: "You must be signed in to approve this merge." };
    }
    const sovereignAgentId = session.user.id;

    if (
      !input.mergeRequestId ||
      !input.globalAgentId ||
      !input.callbackUrl ||
      !input.token
    ) {
      return { ok: false, error: "Missing required merge parameters." };
    }

    // The global side will verify the callback host matches what it issued
    // the token to, but we still validate the URL up front so we never
    // redirect into something obviously broken.
    let callback: URL;
    try {
      callback = new URL(input.callbackUrl);
    } catch {
      return { ok: false, error: "Invalid callback URL." };
    }
    if (callback.protocol !== "https:" && callback.protocol !== "http:") {
      return { ok: false, error: "Callback URL must be http(s)." };
    }

    // Look up this sovereign's own node row to source the signing key. We
    // backfill via ensureLocalNode in case the deployment never explicitly
    // created one (e.g. a brand-new sovereign that hasn't federated yet).
    const localNode = await ensureLocalNode(sovereignAgentId);
    const [refreshed] = await db
      .select({
        id: nodes.id,
        slug: nodes.slug,
        baseUrl: nodes.baseUrl,
        publicKey: nodes.publicKey,
        privateKey: nodes.privateKey,
      })
      .from(nodes)
      .where(eq(nodes.id, localNode.id))
      .limit(1);

    if (!refreshed?.privateKey || !refreshed?.publicKey) {
      return {
        ok: false,
        error:
          "Sovereign node is missing a signing key; cannot produce merge proof.",
      };
    }

    // Build the proof payload. signPayload canonicalizes the object before
    // signing so the receiver can verify regardless of key order in transit.
    const expiresAt = Date.now() + PROOF_TTL_MS;
    const proofPayload: Record<string, unknown> = {
      expiresAt,
      global_agent_id: input.globalAgentId,
      merge_request_id: input.mergeRequestId,
      sovereign_agent_id: sovereignAgentId,
    };
    const proofSignature = signPayload(proofPayload, refreshed.privateKey);

    callback.searchParams.set("merge_request_id", input.mergeRequestId);
    callback.searchParams.set("sovereign_agent_id", sovereignAgentId);
    callback.searchParams.set("sovereign_node_id", refreshed.id);
    callback.searchParams.set("sovereign_base_url", refreshed.baseUrl);
    callback.searchParams.set("sovereign_pubkey", refreshed.publicKey);
    callback.searchParams.set("proof_signature", proofSignature);
    callback.searchParams.set("proof_expires_at", String(expiresAt));
    callback.searchParams.set("original_token", input.token);

    return { ok: true, redirectUrl: callback.toString() };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Unable to approve sovereign merge.",
    };
  }
}
