import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { resources } from "@/db/schema";
import type { AutobotConnection } from "@/lib/autobot-connectors";
import type { ConnectorSyncResult } from "@/lib/autobot-google-sync";

const DEFAULT_WOLFRAM_CLOUD_BASE_URL = "https://www.wolframcloud.com";
const WOLFRAM_PROVIDER_KEY = "wolfram";

type WolframDeployment = {
  id: string;
  name?: string;
  url?: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
};

type WolframUserInfo = {
  uuid?: string;
  username?: string;
  email?: string;
};

type WolframEvaluateResult = {
  Result?: string;
  pods?: Array<{
    title?: string;
    subpods?: Array<{ plaintext?: string }>;
  }>;
};

function getCloudBaseUrl(connection: AutobotConnection): string {
  const configured = connection.config.cloudBaseUrl?.trim();
  return configured || DEFAULT_WOLFRAM_CLOUD_BASE_URL;
}

function getAuthHeaders(connection: AutobotConnection): Record<string, string> {
  const licenseKey = connection.config.licenseKey?.trim();
  if (!licenseKey) {
    throw new Error("Wolfram connection is missing a licenseKey in config.");
  }
  return {
    Authorization: `Bearer ${licenseKey}`,
  };
}

async function fetchWolframJson<T>(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  init?: RequestInit,
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Wolfram API error (${response.status}): ${errorText.slice(0, 300)}`,
    );
  }

  return (await response.json()) as T;
}

async function validateWolframToken(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<WolframUserInfo> {
  return fetchWolframJson<WolframUserInfo>(baseUrl, "/api/v1/me", headers);
}

async function fetchWolframDeployments(
  baseUrl: string,
  headers: Record<string, string>,
): Promise<WolframDeployment[]> {
  const result = await fetchWolframJson<{
    deployments?: WolframDeployment[];
  }>(baseUrl, "/api/v1/deployments", headers);
  return Array.isArray(result.deployments) ? result.deployments : [];
}

async function findSyncedWolframResourceId(
  ownerId: string,
  externalId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->'externalSync'->>'provider' = ${WOLFRAM_PROVIDER_KEY}`,
        sql`${resources.metadata}->'externalSync'->>'externalId' = ${externalId}`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

async function countExistingWolframResources(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(resources)
    .where(
      and(
        eq(resources.ownerId, ownerId),
        isNull(resources.deletedAt),
        sql`${resources.metadata}->'externalSync'->>'provider' = ${WOLFRAM_PROVIDER_KEY}`,
      ),
    );

  return row?.count ?? 0;
}

async function upsertWolframDeploymentResource(
  userId: string,
  deployment: WolframDeployment,
): Promise<"created" | "updated"> {
  const existingId = await findSyncedWolframResourceId(userId, deployment.id);
  const now = new Date();
  const metadata: Record<string, unknown> = {
    entityType: "document",
    resourceKind: "document",
    personalOwnerId: userId,
    createdBy: userId,
    category: "Wolfram",
    externalSync: {
      provider: WOLFRAM_PROVIDER_KEY,
      externalId: deployment.id,
      deploymentUrl: deployment.url ?? null,
      deploymentType: deployment.type ?? null,
      importedAt: now.toISOString(),
    },
  };

  if (existingId) {
    await db
      .update(resources)
      .set({
        name: deployment.name ?? `Wolfram Deployment ${deployment.id}`,
        description: "Imported from Wolfram Cloud",
        url: deployment.url ?? null,
        metadata,
        updatedAt: now,
      })
      .where(eq(resources.id, existingId));
    return "updated";
  }

  await db.insert(resources).values({
    name: deployment.name ?? `Wolfram Deployment ${deployment.id}`,
    type: "document",
    description: "Imported from Wolfram Cloud",
    content: "",
    contentType: "text/plain",
    url: deployment.url ?? null,
    ownerId: userId,
    visibility: "private",
    tags: ["wolfram", "deployment", "imported"],
    metadata,
  });
  return "created";
}

export async function syncWolframConnection(
  userId: string,
  connection: AutobotConnection,
): Promise<ConnectorSyncResult> {
  const baseUrl = getCloudBaseUrl(connection);
  const headers = getAuthHeaders(connection);

  await validateWolframToken(baseUrl, headers);

  const existingCount = await countExistingWolframResources(userId);

  let imported = 0;
  let updated = 0;
  let skipped = 0;

  if (
    connection.syncDirection === "import" ||
    connection.syncDirection === "bidirectional"
  ) {
    const deployments = await fetchWolframDeployments(baseUrl, headers);

    for (const deployment of deployments) {
      if (!deployment.id) {
        skipped += 1;
        continue;
      }

      const status = await upsertWolframDeploymentResource(userId, deployment);
      if (status === "created") imported += 1;
      else updated += 1;
    }
  }

  if (connection.syncDirection === "export") {
    return {
      provider: "wolfram",
      imported: 0,
      updated: 0,
      skipped: 0,
      message:
        "Wolfram export is managed through Wolfram Cloud directly.",
      accountLabel: "Wolfram",
      externalAccountId: connection.config.appId?.trim() ?? baseUrl,
    };
  }

  const totalAfterSync = existingCount + imported;

  return {
    provider: "wolfram",
    imported,
    updated,
    skipped,
    message:
      connection.syncDirection === "bidirectional"
        ? `Synced ${totalAfterSync} Wolfram resource${totalAfterSync === 1 ? "" : "s"}. Export is managed through Wolfram Cloud directly.`
        : `Imported ${imported} Wolfram deployment${imported === 1 ? "" : "s"} into personal documents (${existingCount} existing).`,
    accountLabel: "Wolfram",
    externalAccountId: connection.config.appId?.trim() ?? baseUrl,
  };
}

export async function queryWolfram(
  connection: AutobotConnection,
  input: string,
): Promise<{ result: string; podPlaintext?: string }> {
  const baseUrl = getCloudBaseUrl(connection);
  const headers = getAuthHeaders(connection);

  const evaluateResult = await fetchWolframJson<WolframEvaluateResult>(
    baseUrl,
    "/api/v1/evaluate",
    headers,
    {
      method: "POST",
      body: JSON.stringify({ input }),
    },
  );

  const resultText = evaluateResult.Result ?? "";

  let podPlaintext: string | undefined;
  if (Array.isArray(evaluateResult.pods)) {
    const plaintextParts: string[] = [];
    for (const pod of evaluateResult.pods) {
      if (pod.title) {
        plaintextParts.push(`## ${pod.title}`);
      }
      if (Array.isArray(pod.subpods)) {
        for (const subpod of pod.subpods) {
          if (subpod.plaintext) {
            plaintextParts.push(subpod.plaintext);
          }
        }
      }
    }
    if (plaintextParts.length > 0) {
      podPlaintext = plaintextParts.join("\n");
    }
  }

  return {
    result: resultText,
    podPlaintext,
  };
}
