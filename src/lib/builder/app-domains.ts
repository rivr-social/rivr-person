/**
 * Verified custom domains for builder apps.
 *
 * The session may only ATTACH a domain after a node:dns verification proves it
 * points at this instance (same rail as the site custom-domain panel). Bound
 * domains are persisted to `.rivr-apps/domains/<appId>.json`; the host broker
 * re-verifies DNS server-side before it ever adds a route for one, so a stale
 * or forged entry cannot capture traffic.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppLifecycleError, appQueueDir } from "@/lib/builder/app-lifecycle";
import { APP_ID_PATTERN } from "@/lib/builder/app-manifest";
import { normalizeHost } from "@/lib/builder/site-host-resolve";

export const APP_DOMAINS_DIR_NAME = "domains";
export const APP_MAX_CUSTOM_DOMAINS = 8;

/** Conservative RFC-1123 hostname shape; no wildcards, no ports, no paths. */
export const APP_CUSTOM_DOMAIN_PATTERN =
  /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export interface AppDomainsFile {
  version: 1;
  appId: string;
  domains: string[];
  updatedAt: string;
}

function domainsDir(): string {
  return path.join(path.dirname(appQueueDir()), APP_DOMAINS_DIR_NAME);
}

function domainsPath(appId: string): string {
  return path.join(domainsDir(), `${appId}.json`);
}

function assertValidAppId(appId: string): void {
  if (!APP_ID_PATTERN.test(appId)) {
    throw new AppLifecycleError("Invalid app id", 400);
  }
}

export function normalizeCustomDomain(domain: string): string | null {
  const host = normalizeHost(domain);
  return APP_CUSTOM_DOMAIN_PATTERN.test(host) ? host : null;
}

export async function readAppDomains(appId: string): Promise<string[]> {
  assertValidAppId(appId);
  try {
    const raw = await readFile(domainsPath(appId), "utf8");
    const parsed = JSON.parse(raw) as AppDomainsFile;
    return Array.isArray(parsed.domains) ? parsed.domains : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AppLifecycleError(
      `Failed to read app domains: ${(error as Error).message}`,
      500,
    );
  }
}

async function writeAppDomains(appId: string, domains: string[]): Promise<void> {
  await mkdir(domainsDir(), { recursive: true, mode: 0o755 });
  const payload: AppDomainsFile = {
    version: 1,
    appId,
    domains,
    updatedAt: new Date().toISOString(),
  };
  const finalPath = domainsPath(appId);
  const tempPath = `${finalPath}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, finalPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw new AppLifecycleError(
      `Failed to persist app domains: ${(error as Error).message}`,
      500,
    );
  }
}

/** Attach a VERIFIED domain. Caller must have run DNS verification first. */
export async function attachAppDomain(appId: string, domain: string): Promise<string[]> {
  assertValidAppId(appId);
  const host = normalizeCustomDomain(domain);
  if (!host) throw new AppLifecycleError("Invalid domain name", 400);
  const existing = await readAppDomains(appId);
  if (existing.includes(host)) return existing;
  if (existing.length >= APP_MAX_CUSTOM_DOMAINS) {
    throw new AppLifecycleError(
      `An app is capped at ${APP_MAX_CUSTOM_DOMAINS} custom domains`,
      400,
    );
  }
  const next = [...existing, host];
  await writeAppDomains(appId, next);
  return next;
}

export async function detachAppDomain(appId: string, domain: string): Promise<string[]> {
  assertValidAppId(appId);
  const host = normalizeCustomDomain(domain);
  if (!host) throw new AppLifecycleError("Invalid domain name", 400);
  const existing = await readAppDomains(appId);
  const next = existing.filter((entry) => entry !== host);
  if (next.length !== existing.length) {
    await writeAppDomains(appId, next);
  }
  return next;
}
