/**
 * @fileoverview Service layer for builder site publications (publish -> serve on
 * custom domains).
 *
 * Ties together three lanes so the routes/host-dispatch stay thin:
 *
 *   - Publish: snapshots the workspace `SiteFiles` into a `site_versions` row
 *     AND writes them into MinIO (see {@link putPublishedSite}); records/updates
 *     the owner's `site_publications` row.
 *   - Host-dispatch: {@link resolveBoundPublicationByHost} maps an incoming
 *     foreign Host header to the bound publication whose files should be served.
 *   - Custom-domain: {@link verifyDomainPointsToApp} (node:dns, injectable) and
 *     {@link bindCustomDomain} / {@link resolveDnsCredentialForOwner} for the
 *     one-click "Set DNS for me" via the owner's autobot DNS connector.
 *
 * Owner identity is ALWAYS the caller's authenticated agent id (derived from
 * `auth()` at the route boundary); credentials are decrypted server-side from
 * the connector lane and NEVER accepted from the client.
 *
 * The pure helpers ({@link normalizeHost}, {@link matchPublicationForHost},
 * {@link computeDomainVerification}) carry no I/O and are unit-tested directly.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  siteVersions,
  sitePublications,
  type SitePublicationRecord,
} from "@/db/schema";
import type { SiteFiles } from "@/lib/bespoke/site-files";
import { getAutobotUserSettings } from "@/lib/autobot-user-settings";
import { decryptConnectorConfig } from "@/lib/autobot-connector-secrets";
import { putPublishedSite } from "@/lib/builder/site-publish-storage";
import {
  DnsBindError,
  isDnsWriteProvider,
  type ResolvedDnsCredential,
} from "@/lib/builder/dns-write";
import {
  DOMAIN_STATUS_BOUND,
  DOMAIN_STATUS_UNBOUND,
  SiteServiceError,
  matchPublicationForHost,
  normalizeHost,
} from "@/lib/builder/site-host-resolve";

// Re-export the pure host-dispatch/verify surface so route + host handlers can
// import everything site-publication from this one service module.
export {
  DOMAIN_STATUS_UNBOUND,
  DOMAIN_STATUS_PENDING,
  DOMAIN_STATUS_BOUND,
  DOMAIN_STATUS_ERROR,
  DOMAIN_STATUS_MANUAL,
  SERVABLE_DOMAIN_STATUSES,
  SiteServiceError,
  normalizeHost,
  matchPublicationForHost,
  computeDomainVerification,
  getAppHostname,
  verifyDomainPointsToApp,
  defaultDnsResolver,
} from "@/lib/builder/site-host-resolve";
export type {
  ServablePublication,
  DomainVerification,
  DnsResolver,
} from "@/lib/builder/site-host-resolve";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Snapshot trigger recorded on the version row a publish creates. */
export const SITE_TRIGGER_PUBLISH = "publish";

/** Connector config keys that may hold the DNS provider's secret token. */
const SECRET_TOKEN_KEYS = ["apiKey", "apiToken", "token", "secret"] as const;

// ---------------------------------------------------------------------------
// Publication projection
// ---------------------------------------------------------------------------

/** Client-safe projection of a publication row. */
export interface PublicSitePublication {
  agentId: string;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  theme: string | null;
  customDomain: string | null;
  domainProvider: string | null;
  domainStatus: string;
  domainError: string | null;
  fileCount: number;
  publishedAt: string | null;
}

function toPublic(row: SitePublicationRecord): PublicSitePublication {
  return {
    agentId: row.agentId,
    publishedVersionId: row.publishedVersionId,
    publishedVersionNumber: row.publishedVersionNumber,
    theme: row.theme,
    customDomain: row.customDomain,
    domainProvider: row.domainProvider,
    domainStatus: row.domainStatus,
    domainError: row.domainError,
    fileCount: Array.isArray(row.fileManifest) ? row.fileManifest.length : 0,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Publication persistence
// ---------------------------------------------------------------------------

/** Upserts the owner's single publication row with a partial patch. */
async function upsertPublication(
  agentId: string,
  patch: Partial<Omit<SitePublicationRecord, "id" | "agentId" | "createdAt">>,
): Promise<SitePublicationRecord> {
  const [row] = await db
    .insert(sitePublications)
    .values({ agentId, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: sitePublications.agentId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning();
  return row;
}

/** Reads the owner's publication state, or null when never published. */
export async function getSitePublication(agentId: string): Promise<PublicSitePublication | null> {
  const [row] = await db
    .select()
    .from(sitePublications)
    .where(eq(sitePublications.agentId, agentId))
    .limit(1);
  return row ? toPublic(row) : null;
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/** Result of a publish operation. */
export interface PublishResult {
  publication: PublicSitePublication;
  versionId: string;
  versionNumber: number;
  fileCount: number;
}

/**
 * Publishes the current workspace `files`: snapshots them into a `site_versions`
 * row, writes them into MinIO under a fresh publication-storage prefix, and
 * upserts the owner's `site_publications` row to point at both. Any existing
 * custom-domain binding is preserved.
 *
 * @throws {SiteServiceError} When `files` is empty.
 */
export async function publishSite(
  agentId: string,
  files: SiteFiles,
  options: { commitMessage?: string | null; theme?: string | null } = {},
): Promise<PublishResult> {
  if (!files || typeof files !== "object" || Object.keys(files).length === 0) {
    throw new SiteServiceError("EMPTY_FILES", "Cannot publish an empty site.");
  }

  // 1. Snapshot a version (reuses the existing site_versions history).
  const [{ maxVersion } = { maxVersion: 0 }] = await db
    .select({ maxVersion: sql<number>`COALESCE(MAX(${siteVersions.versionNumber}), 0)` })
    .from(siteVersions)
    .where(eq(siteVersions.agentId, agentId));
  const nextVersion = (maxVersion ?? 0) + 1;

  const [version] = await db
    .insert(siteVersions)
    .values({
      agentId,
      versionNumber: nextVersion,
      commitMessage: options.commitMessage ?? "Published site",
      filesSnapshot: files,
      trigger: SITE_TRIGGER_PUBLISH,
    })
    .returning({ id: siteVersions.id, versionNumber: siteVersions.versionNumber });

  // 2. Write files to storage under a fresh immutable prefix.
  const storageId = randomUUID();
  const put = await putPublishedSite(storageId, files);

  // 3. Record the publication (preserve any existing domain binding).
  const row = await upsertPublication(agentId, {
    publishedVersionId: version.id,
    publishedVersionNumber: version.versionNumber,
    storageBucket: put.bucket,
    storagePrefix: put.prefix,
    fileManifest: put.paths,
    theme: options.theme ?? undefined,
    publishedAt: new Date(),
  });

  return {
    publication: toPublic(row),
    versionId: version.id,
    versionNumber: version.versionNumber,
    fileCount: put.paths.length,
  };
}

// ---------------------------------------------------------------------------
// Host-dispatch resolution
// ---------------------------------------------------------------------------

/** Storage coordinates for serving a bound publication's files. */
export interface ServeTarget {
  bucket: string;
  prefix: string;
}

/**
 * Resolves an incoming foreign Host header to the bound publication whose files
 * should be served, or null when the host is not a bound custom domain. Used by
 * the `/site-host` dispatch route.
 */
export async function resolveBoundPublicationByHost(
  host: string,
): Promise<ServeTarget | null> {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  const rows = await db
    .select({
      customDomain: sitePublications.customDomain,
      domainStatus: sitePublications.domainStatus,
      storageBucket: sitePublications.storageBucket,
      storagePrefix: sitePublications.storagePrefix,
    })
    .from(sitePublications)
    .where(eq(sitePublications.customDomain, normalized))
    .limit(1);

  const match = matchPublicationForHost(normalized, rows);
  if (!match || !match.storageBucket || !match.storagePrefix) return null;
  return { bucket: match.storageBucket, prefix: match.storagePrefix };
}

// ---------------------------------------------------------------------------
// Custom-domain binding
// ---------------------------------------------------------------------------

/**
 * Binds a custom domain to the owner's published site (host-dispatch will then
 * serve it). Requires that the owner has published (a storage prefix exists) and
 * that no OTHER owner already claims the domain.
 *
 * @throws {SiteServiceError} When unpublished, the domain is taken, or invalid.
 */
export async function bindCustomDomain(
  agentId: string,
  domain: string,
  options: { provider?: string | null } = {},
): Promise<PublicSitePublication> {
  const normalized = normalizeHost(domain);
  if (!normalized) {
    throw new SiteServiceError("INVALID_DOMAIN", "A valid custom domain is required.");
  }

  const [existing] = await db
    .select()
    .from(sitePublications)
    .where(eq(sitePublications.agentId, agentId))
    .limit(1);
  if (!existing || !existing.storagePrefix) {
    throw new SiteServiceError("NOT_PUBLISHED", "Publish your site before binding a custom domain.");
  }

  const [conflict] = await db
    .select({ agentId: sitePublications.agentId })
    .from(sitePublications)
    .where(eq(sitePublications.customDomain, normalized))
    .limit(1);
  if (conflict && conflict.agentId !== agentId) {
    throw new SiteServiceError("DOMAIN_TAKEN", "This domain is already bound to another site.");
  }

  const row = await upsertPublication(agentId, {
    customDomain: normalized,
    domainProvider: options.provider ?? existing.domainProvider ?? null,
    domainStatus: DOMAIN_STATUS_BOUND,
    domainError: null,
  });
  return toPublic(row);
}

/** Records a domain status transition (e.g. pending/error) without binding. */
export async function setDomainStatus(
  agentId: string,
  status: string,
  patch: { customDomain?: string | null; domainProvider?: string | null; domainError?: string | null } = {},
): Promise<PublicSitePublication> {
  const row = await upsertPublication(agentId, {
    domainStatus: status,
    ...(patch.customDomain !== undefined ? { customDomain: normalizeHost(patch.customDomain) || null } : {}),
    ...(patch.domainProvider !== undefined ? { domainProvider: patch.domainProvider } : {}),
    ...(patch.domainError !== undefined ? { domainError: patch.domainError } : {}),
  });
  return toPublic(row);
}

/** Clears any custom-domain binding (does not touch the DNS provider). */
export async function unbindCustomDomain(agentId: string): Promise<PublicSitePublication> {
  const row = await upsertPublication(agentId, {
    customDomain: null,
    domainProvider: null,
    domainStatus: DOMAIN_STATUS_UNBOUND,
    domainError: null,
  });
  return toPublic(row);
}

// ---------------------------------------------------------------------------
// DNS-write credential resolution (server-side; never from the client)
// ---------------------------------------------------------------------------

/**
 * Resolves the owner's autobot DNS connector into a decrypted credential for the
 * DNS-write adapters. The secret is decrypted through the same connector
 * secret-box used at write time; non-secret config (zoneId/apiUser/domain) comes
 * from the connector config.
 *
 * @throws {DnsBindError} When the provider is unsupported, no connector exists,
 *                        or the connector has no stored secret.
 */
export async function resolveDnsCredentialForOwner(
  agentId: string,
  provider: string,
): Promise<ResolvedDnsCredential> {
  if (!isDnsWriteProvider(provider)) {
    throw new DnsBindError("UNSUPPORTED_PROVIDER", `DNS provider "${provider}" is not supported.`);
  }
  const settings = await getAutobotUserSettings(agentId);
  const connection = settings.connections.find((c) => c.provider === provider);
  if (!connection) {
    throw new DnsBindError("NO_CONNECTION", `No ${provider} DNS connector is configured for this owner.`);
  }
  const config = decryptConnectorConfig(connection.config ?? {});
  let secret = "";
  for (const key of SECRET_TOKEN_KEYS) {
    const value = config[key]?.trim();
    if (value) {
      secret = value;
      break;
    }
  }
  if (!secret) {
    throw new DnsBindError("NO_CREDENTIAL", `The ${provider} connector has no stored API credential.`);
  }
  return { provider, secret, config };
}

/** Lists distinct DNS-write providers the owner has a connector for. */
export async function listOwnerDnsProviders(agentId: string): Promise<string[]> {
  const settings = await getAutobotUserSettings(agentId);
  return settings.connections
    .map((c) => c.provider)
    .filter((p) => isDnsWriteProvider(p));
}
