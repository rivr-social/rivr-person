/**
 * Builder app custom domains.
 *
 * GET  /api/builder/apps/[appId]/domains → bound domains
 * POST /api/builder/apps/[appId]/domains
 *   { action: "verify", domain }  → node:dns check (no state change)
 *   { action: "bind",   domain }  → verify + persist; broker re-verifies at route time
 *   { action: "unbind", domain }  → remove
 *
 * Binding while the app is running queues a `start` request so the broker
 * refreshes the app's routes.
 */

import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { assertAgentHqAccess } from "@/lib/agent-hq";
import {
  attachAppDomain,
  detachAppDomain,
  normalizeCustomDomain,
  readAppDomains,
} from "@/lib/builder/app-domains";
import { appSubdomain } from "@/lib/builder/app-manifest";
import {
  AppLifecycleError,
  appWorkspaceDir,
  queueAppLifecycleRequest,
  readAppStatus,
} from "@/lib/builder/app-lifecycle";
import { APP_ID_PATTERN } from "@/lib/builder/app-manifest";
import { isOwnerError, resolveBuilderOwner } from "@/lib/builder/site-owner";
import { resolveDnsCredentialForOwner } from "@/lib/builder/site-publications";
import { applyDnsRecords, planDnsRecords } from "@/lib/builder/dns-write";
import { verifyDomainPointsToApp } from "@/lib/builder/site-host-resolve";
import {
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_ERROR,
  STATUS_NOT_FOUND,
  STATUS_OK,
} from "@/lib/http-status";

export const dynamic = "force-dynamic";

const CACHE_CONTROL_NO_STORE = "private, no-store, max-age=0, must-revalidate";

const DOMAIN_ACTIONS = ["verify", "bind", "unbind", "set-dns"] as const;
type DomainAction = (typeof DOMAIN_ACTIONS)[number];

function response(body: unknown, status = STATUS_OK) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": CACHE_CONTROL_NO_STORE },
  });
}

async function requireApp(
  context: { params: Promise<{ appId: string }> },
): Promise<{ appId: string; agentId: string } | { error: NextResponse }> {
  try {
    await assertAgentHqAccess();
  } catch (error) {
    return {
      error: response(
        { error: error instanceof Error ? error.message : "Access denied" },
        STATUS_FORBIDDEN,
      ),
    };
  }
  const owner = await resolveBuilderOwner();
  if (isOwnerError(owner)) return { error: owner.error };

  const { appId } = await context.params;
  if (!APP_ID_PATTERN.test(appId)) {
    return { error: response({ error: "Invalid app id" }, STATUS_BAD_REQUEST) };
  }
  if (!existsSync(appWorkspaceDir(appId))) {
    return {
      error: response({ error: `App workspace "${appId}" not found` }, STATUS_NOT_FOUND),
    };
  }
  return { appId, agentId: owner.agentId };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ appId: string }> },
) {
  const resolved = await requireApp(context);
  if ("error" in resolved) return resolved.error;
  try {
    const domains = await readAppDomains(resolved.appId);
    return response({ success: true, appId: resolved.appId, domains });
  } catch (error) {
    if (error instanceof AppLifecycleError) {
      return response({ error: error.message }, error.statusCode);
    }
    return response({ error: "Failed to read domains" }, STATUS_INTERNAL_ERROR);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ appId: string }> },
) {
  const resolved = await requireApp(context);
  if ("error" in resolved) return resolved.error;
  const { appId } = resolved;

  let body: { action?: unknown; domain?: unknown; provider?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return response({ error: "Invalid JSON body" }, STATUS_BAD_REQUEST);
  }

  const action = body.action as DomainAction;
  if (!DOMAIN_ACTIONS.includes(action)) {
    return response(
      { error: `action must be one of: ${DOMAIN_ACTIONS.join(", ")}` },
      STATUS_BAD_REQUEST,
    );
  }
  const domain = normalizeCustomDomain(typeof body.domain === "string" ? body.domain : "");
  if (!domain) {
    return response({ error: "Invalid domain name" }, STATUS_BAD_REQUEST);
  }

  try {
    if (action === "set-dns") {
      const provider = typeof body.provider === "string" ? body.provider : "";
      if (!provider) {
        return response({ error: "A DNS provider is required" }, STATUS_BAD_REQUEST);
      }
      const baseDomain = process.env.BUILDER_APPS_BASE_DOMAIN ?? process.env.DOMAIN;
      if (!baseDomain) {
        return response({ error: "Apps base domain is not configured" }, STATUS_INTERNAL_ERROR);
      }
      const credential = await resolveDnsCredentialForOwner(resolved.agentId, provider);
      const records = planDnsRecords(domain, {
        cnameTarget: appSubdomain(appId, baseDomain),
      });
      const apply = await applyDnsRecords(records, credential);
      return response({ success: apply.ok, appId, domain, apply, records });
    }

    if (action === "unbind") {
      const domains = await detachAppDomain(appId, domain);
      return response({ success: true, appId, domains });
    }

    const verification = await verifyDomainPointsToApp(domain);
    if (action === "verify") {
      return response({ success: true, appId, domain, verification });
    }

    if (!verification.verified) {
      return response(
        {
          error: `Domain is not pointing at this instance yet: ${verification.detail}`,
          verification,
        },
        STATUS_BAD_REQUEST,
      );
    }

    const domains = await attachAppDomain(appId, domain);
    const status = await readAppStatus(appId).catch(() => null);
    let routeRefreshQueued = false;
    if (status?.phase === "running") {
      await queueAppLifecycleRequest({ appId, action: "start" });
      routeRefreshQueued = true;
    }
    return response({ success: true, appId, domains, routeRefreshQueued });
  } catch (error) {
    if (error instanceof AppLifecycleError) {
      return response({ error: error.message }, error.statusCode);
    }
    return response(
      { error: `Domain action failed: ${error instanceof Error ? error.message : "unknown"}` },
      STATUS_INTERNAL_ERROR,
    );
  }
}
