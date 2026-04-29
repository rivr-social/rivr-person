import { randomUUID } from "crypto";
import { getInstanceConfig } from "@/lib/federation/instance-config";

export type PersonInstanceSetupCheckStatus = "ok" | "warning" | "error";

export interface PersonInstanceSetupCheck {
  id: string;
  label: string;
  status: PersonInstanceSetupCheckStatus;
  detail: string;
}

export interface PersonInstanceSetupVerification {
  checkedAt: string | null;
  checks: PersonInstanceSetupCheck[];
}

export interface PersonInstanceSetupState {
  status: "not_started" | "draft" | "bundle_ready" | "verified";
  targetDomain: string;
  targetBaseUrl: string;
  targetSlug: string;
  targetNodeId: string;
  username: string;
  requestedAt: string | null;
  updatedAt: string | null;
  notes: string;
  deployBundle: string;
  verification: PersonInstanceSetupVerification | null;
}

type JsonRecord = Record<string, unknown>;

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function deriveBaseUrl(domain: string): string {
  return domain ? `https://${normalizeDomain(domain)}` : "";
}

function resolveRegistryUrl(config: ReturnType<typeof getInstanceConfig>): string {
  if (config.registryUrl) return config.registryUrl;
  return `${config.baseUrl.replace(/\/+$/, "")}/api/federation/registry`;
}

function getSetupRecord(metadata: JsonRecord): JsonRecord {
  const raw = metadata.personInstanceSetup;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as JsonRecord) : {};
}

export function buildPersonInstanceSetupState(input: {
  metadata: JsonRecord;
  fallbackName: string;
  fallbackUsername: string;
  agentId: string;
}): PersonInstanceSetupState {
  const config = getInstanceConfig();
  const setup = getSetupRecord(input.metadata);
  const username = normalizeUsername(
    typeof setup.username === "string" && setup.username
      ? setup.username
      : typeof input.metadata.username === "string" && input.metadata.username
        ? input.metadata.username
        : input.fallbackUsername
  );
  const targetDomain = normalizeDomain(typeof setup.targetDomain === "string" ? setup.targetDomain : "");
  const targetBaseUrl = deriveBaseUrl(typeof setup.targetBaseUrl === "string" && setup.targetBaseUrl ? setup.targetBaseUrl : targetDomain);
  const targetSlug = normalizeSlug(
    typeof setup.targetSlug === "string" && setup.targetSlug
      ? setup.targetSlug
      : targetDomain.split(".")[0] || username || "person"
  );
  const targetNodeId =
    typeof setup.targetNodeId === "string" && setup.targetNodeId
      ? setup.targetNodeId
      : randomUUID();
  const requestedAt = typeof setup.requestedAt === "string" ? setup.requestedAt : null;
  const updatedAt = typeof setup.updatedAt === "string" ? setup.updatedAt : null;
  const notes = typeof setup.notes === "string" ? setup.notes : "";
  const verification = parseVerification(setup.verification);
  const status = deriveStatus({
    targetDomain,
    verification,
    explicitStatus: typeof setup.status === "string" ? setup.status : "",
  });

  return {
    status,
    targetDomain,
    targetBaseUrl,
    targetSlug,
    targetNodeId,
    username,
    requestedAt,
    updatedAt,
    notes,
    deployBundle: buildDeployBundle({
      agentId: input.agentId,
      username,
      targetDomain,
      targetBaseUrl,
      targetSlug,
      targetNodeId,
      fallbackName: input.fallbackName,
      registryUrl: resolveRegistryUrl(config),
      currentBaseUrl: config.baseUrl,
    }),
    verification,
  };
}

export function buildNextPersonInstanceSetupMetadata(input: {
  metadata: JsonRecord;
  targetDomain: string;
  username: string;
  notes?: string;
}): JsonRecord {
  const previous = getSetupRecord(input.metadata);
  const normalizedUsername = normalizeUsername(input.username);
  const targetDomain = normalizeDomain(input.targetDomain);
  const targetBaseUrl = deriveBaseUrl(targetDomain);
  const targetSlug = normalizeSlug(previous.targetSlug as string || targetDomain.split(".")[0] || normalizedUsername || "person");
  const targetNodeId =
    typeof previous.targetNodeId === "string" && previous.targetNodeId
      ? previous.targetNodeId
      : randomUUID();
  const now = new Date().toISOString();

  return {
    ...input.metadata,
    username: normalizedUsername || input.metadata.username,
    personInstanceSetup: {
      ...previous,
      status: "bundle_ready",
      targetDomain,
      targetBaseUrl,
      targetSlug,
      targetNodeId,
      username: normalizedUsername,
      requestedAt: typeof previous.requestedAt === "string" ? previous.requestedAt : now,
      updatedAt: now,
      notes: input.notes?.trim() ?? "",
    },
  };
}

export function mergePersonInstanceVerification(input: {
  metadata: JsonRecord;
  verification: PersonInstanceSetupVerification;
}): JsonRecord {
  const previous = getSetupRecord(input.metadata);
  return {
    ...input.metadata,
    personInstanceSetup: {
      ...previous,
      status: allChecksOk(input.verification) ? "verified" : "bundle_ready",
      verification: input.verification,
      updatedAt: new Date().toISOString(),
    },
  };
}

function parseVerification(value: unknown): PersonInstanceSetupVerification | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  const checks = Array.isArray(record.checks)
    ? record.checks
        .filter((entry): entry is JsonRecord => !!entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry): PersonInstanceSetupCheck => ({
          id: typeof entry.id === "string" ? entry.id : "check",
          label: typeof entry.label === "string" ? entry.label : "Check",
          status:
            entry.status === "ok" || entry.status === "warning" || entry.status === "error"
              ? entry.status
              : "warning",
          detail: typeof entry.detail === "string" ? entry.detail : "",
        }))
    : [];
  return {
    checkedAt: typeof record.checkedAt === "string" ? record.checkedAt : null,
    checks,
  };
}

function deriveStatus(input: {
  targetDomain: string;
  verification: PersonInstanceSetupVerification | null;
  explicitStatus: string;
}): PersonInstanceSetupState["status"] {
  if (!input.targetDomain) return "not_started";
  if (input.explicitStatus === "verified") return "verified";
  if (input.verification && allChecksOk(input.verification)) return "verified";
  return "bundle_ready";
}

function allChecksOk(verification: PersonInstanceSetupVerification): boolean {
  return verification.checks.length > 0 && verification.checks.every((check) => check.status === "ok");
}

function buildDeployBundle(input: {
  agentId: string;
  username: string;
  targetDomain: string;
  targetBaseUrl: string;
  targetSlug: string;
  targetNodeId: string;
  fallbackName: string;
  registryUrl: string;
  currentBaseUrl: string;
}): string {
  if (!input.targetDomain) {
    return "Enter a target domain to generate the deploy bundle.";
  }

  return [
    "# 1. Runtime env",
    `INSTANCE_TYPE=person`,
    `INSTANCE_ID=${input.targetNodeId}`,
    `INSTANCE_SLUG=${input.targetSlug}`,
    `PRIMARY_AGENT_ID=${input.agentId}`,
    `REGISTRY_URL=${input.registryUrl}`,
    `NEXTAUTH_URL=${input.targetBaseUrl}`,
    `NEXT_PUBLIC_BASE_URL=${input.targetBaseUrl}`,
    "",
    "# 2. Clone the canonical monorepo and build the person app image",
    "git clone https://github.com/rivr-social/rivr-monorepo.git /opt/rivr-monorepo",
    "cd /opt/rivr-monorepo",
    "docker build --build-arg APP_NAME=person -f Dockerfile.app -t rivr-person:latest .",
    "",
    "# 3. Export from the current home instance DB",
    `DATABASE_URL=<source-db-url> PERSON_AGENT_ID=${input.agentId} OUTPUT_PATH=tmp/${input.targetSlug}-person.manifest.json pnpm federation:person:export`,
    "",
    "# 4. Import into the target DB",
    `DATABASE_URL=<target-db-url> MANIFEST_PATH=tmp/${input.targetSlug}-person.manifest.json pnpm federation:person:import`,
    "",
    "# 5. Cut over the registry",
    `REGISTRY_URL=${input.registryUrl} NODE_ADMIN_KEY=<registry-admin-key> SOURCE_INSTANCE_ID=<source-instance-id> SOURCE_INSTANCE_SLUG=<source-slug> SOURCE_BASE_URL=${input.currentBaseUrl} SOURCE_PRIMARY_AGENT_ID=${input.agentId} TARGET_INSTANCE_ID=${input.targetNodeId} TARGET_INSTANCE_SLUG=${input.targetSlug} TARGET_BASE_URL=${input.targetBaseUrl} TARGET_PRIMARY_AGENT_ID=${input.agentId} TARGET_DISPLAY_NAME=\"${input.fallbackName}\" TARGET_PUBLIC_KEY=<target-node-public-key> CUTOVER_PHASE=complete pnpm federation:person:cutover`,
    "",
    "# 6. Verify public and self profile contracts",
    `BASE_URL=${input.targetBaseUrl} PROFILE_USERNAME=${input.username} SESSION_COOKIE='<session-cookie>' pnpm federation:verify:e2e`,
  ].join("\n");
}
