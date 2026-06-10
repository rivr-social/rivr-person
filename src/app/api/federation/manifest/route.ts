import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, nodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getInstanceConfig } from "@/lib/federation/instance-config";
import {
  signUniversalManifest,
  publicKeyPemToSpkiB64,
} from "@/lib/federation-crypto";
import { randomUUID } from "node:crypto";

/** Manifest expiry: 30 days from issuance. */
const MANIFEST_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** Cache manifest responses for 1 hour. */
const CACHE_MAX_AGE_SECONDS = 3600;

/** UM v0.3 context namespace. */
const UM_CONTEXT = "https://universalmanifest.net/ns/v0.3";

/**
 * Build a DID for this instance's primary agent.
 * Prefers did:web when a real domain is available, falls back to did:rivr:<uuid>.
 */
function buildSubjectDid(config: ReturnType<typeof getInstanceConfig>, agentId: string): string {
  try {
    const url = new URL(config.baseUrl);
    if (url.hostname !== "localhost" && !url.hostname.startsWith("127.")) {
      // did:web encoding: host:port → host%3Aport, path segments separated by :
      const host = url.port && url.port !== "443"
        ? `${url.hostname}%3A${url.port}`
        : url.hostname;
      return `did:web:${host}`;
    }
  } catch {
    // Fall through to UUID-based DID
  }
  return `did:rivr:${agentId}`;
}

/**
 * GET /api/federation/manifest
 *
 * Returns a conformant Universal Manifest v0.3 for this instance's primary agent.
 * The manifest is Ed25519-signed using the instance's node keypair (Signature Profile A).
 *
 * Privacy settings are expressed as UM consent entries. Identity pointers reference
 * PeerMesh, AT Protocol, Matrix, and RIVR federation endpoints.
 */
export async function GET() {
  const config = getInstanceConfig();

  if (!config.primaryAgentId) {
    return NextResponse.json(
      { success: false, error: "No primary agent configured for this instance" },
      { status: 404 },
    );
  }

  // Fetch agent and node keypair in parallel
  const [[agent], [node]] = await Promise.all([
    db.select().from(agents).where(eq(agents.id, config.primaryAgentId)).limit(1),
    db.select().from(nodes).where(eq(nodes.id, config.instanceId)).limit(1),
  ]);

  if (!agent) {
    return NextResponse.json(
      { success: false, error: "Primary agent not found" },
      { status: 404 },
    );
  }

  const meta = (agent.metadata || {}) as Record<string, unknown>;
  const privacy = (meta.privacySettings || {}) as Record<string, unknown>;
  const username = meta.username as string | undefined;

  const now = new Date();
  const expiresAt = new Date(now.getTime() + MANIFEST_EXPIRY_MS);
  const subjectDid = buildSubjectDid(config, agent.id);
  const keyRef = `${subjectDid}#keys-1`;

  // ── Build UM v0.3 consent entries from privacy settings ──────────────

  const consents = Object.entries(privacy)
    .filter(
      ([key]) =>
        key.startsWith("attribute") ||
        key.startsWith("activity") ||
        key.startsWith("transaction"),
    )
    .map(([key, value]) => {
      const facetRef = `urn:um:facet:rivr:${key}`;
      const scope = value === "public"
        ? ["read", "display", "cache"]
        : value === "connections"
          ? ["read", "display"]
          : ["read"];

      return {
        "@id": `urn:um:consent:${randomUUID()}`,
        "@type": "um:Consent",
        facetRef,
        scope,
        purpose: "federation-disclosure",
        grantedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        grantor: subjectDid,
      };
    });

  // ── Build UM v0.3 pointers ────────────────────────────────────────────

  const pointers: Array<Record<string, unknown>> = [
    {
      "@type": "um:instanceReference",
      target: config.baseUrl,
      label: `RIVR ${config.instanceType} instance`,
      createdAt: now.toISOString(),
    },
    {
      "@type": "um:registryReference",
      target: config.registryUrl || config.baseUrl,
      label: "RIVR federation registry",
      createdAt: now.toISOString(),
    },
  ];

  if (agent.peermeshManifestUrl) {
    pointers.push({
      "@type": "um:externalIdentity",
      target: agent.peermeshManifestUrl,
      label: "PeerMesh manifest",
      createdAt: now.toISOString(),
    });
  }
  if (agent.peermeshDid) {
    pointers.push({
      "@type": "um:externalIdentity",
      target: agent.peermeshDid,
      label: "PeerMesh DID",
      createdAt: now.toISOString(),
    });
  }
  if (agent.atprotoHandle) {
    pointers.push({
      "@type": "um:externalIdentity",
      target: `at://${agent.atprotoHandle}`,
      label: "AT Protocol handle",
      createdAt: now.toISOString(),
    });
  }
  if (agent.matrixUserId) {
    pointers.push({
      "@type": "um:externalIdentity",
      target: agent.matrixUserId,
      label: "Matrix user",
      createdAt: now.toISOString(),
    });
  }

  // ── Build UM v0.3 claims ──────────────────────────────────────────────

  const claims: Array<Record<string, unknown>> = [
    {
      "@type": "identity.role",
      issuer: subjectDid,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      subject: subjectDid,
      role: config.instanceType === "person" ? "person" : config.instanceType,
    },
    {
      "@type": "identity.displayName",
      issuer: subjectDid,
      issuedAt: now.toISOString(),
      subject: subjectDid,
      name: agent.name,
    },
    {
      "@type": "identity.verification",
      issuer: subjectDid,
      issuedAt: now.toISOString(),
      subject: subjectDid,
      status: agent.emailVerified ? "email-verified" : "self-asserted",
    },
  ];

  // ── Build UM v0.3 facets (federation capabilities) ────────────────────

  const facets = [
    {
      "@id": "urn:um:facet:rivr:federation",
      "@type": "um:Facet",
      name: "RIVR Federation Endpoints",
      entity: {
        "@id": `urn:um:entity:rivr:federation:${config.instanceId}`,
        "@type": ["um:Entity", "rivr:FederationConfig"],
        homeInstance: config.instanceId,
        homeUrl: config.baseUrl,
        registryUrl: config.registryUrl,
        instanceType: config.instanceType,
        queryEndpoint: `${config.baseUrl}/api/federation/query`,
        eventsEndpoint: `${config.baseUrl}/api/federation/events`,
        mutationsEndpoint: `${config.baseUrl}/api/federation/mutations`,
        manifestEndpoint: `${config.baseUrl}/api/federation/manifest`,
      },
    },
  ];

  // ── Assemble unsigned manifest ────────────────────────────────────────

  const manifest: Record<string, unknown> = {
    "@context": [UM_CONTEXT],
    "@id": `urn:uuid:${randomUUID()}`,
    "@type": ["um:Manifest"],
    manifestVersion: "0.3",
    subject: subjectDid,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    requiredTrustTier: 0,
    facets,
    claims,
    consents,
    pointers,
  };

  // ── Sign with node keypair (Signature Profile A) ──────────────────────

  if (node?.privateKey && node?.publicKey) {
    const publicKeySpkiB64 = publicKeyPemToSpkiB64(node.publicKey);
    manifest.signature = signUniversalManifest(
      manifest,
      node.privateKey,
      keyRef,
      publicKeySpkiB64,
    );
  }

  // ── Backward-compatible: include flat federation section for v0.1 consumers

  (manifest as Record<string, unknown>).federation = {
    homeInstance: config.instanceId,
    homeUrl: config.baseUrl,
    registryUrl: config.registryUrl,
    instanceType: config.instanceType,
    queryEndpoint: `${config.baseUrl}/api/federation/query`,
    eventsEndpoint: `${config.baseUrl}/api/federation/events`,
    mutationsEndpoint: `${config.baseUrl}/api/federation/mutations`,
  };

  return NextResponse.json(manifest, {
    headers: {
      "Content-Type": "application/ld+json",
      "Cache-Control": `public, max-age=${CACHE_MAX_AGE_SECONDS}`,
    },
  });
}
