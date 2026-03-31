import { readEnvFallback } from "./mapbox-env";

type RegistryPhase =
  | "register-target"
  | "freeze-source"
  | "promote-target"
  | "archive-source"
  | "complete";

type InstancePayload = {
  instanceId: string;
  instanceType: "person";
  slug: string;
  baseUrl: string;
  primaryAgentId: string;
  displayName?: string;
  publicKey?: string;
  storageNamespace?: string;
  healthCheckUrl?: string;
  feeWalletAddress?: string;
  capabilities?: unknown[];
  migrationStatus: "active" | "migrating_out" | "migrating_in" | "archived";
};

function required(name: string): string {
  const value = readEnvFallback(name);
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main() {
  const registryUrl = required("REGISTRY_URL");
  const adminKey = required("NODE_ADMIN_KEY");
  const phase = (readEnvFallback("CUTOVER_PHASE") || "complete") as RegistryPhase;

  const source = readInstancePayload("SOURCE", "migrating_out");
  const target = readInstancePayload("TARGET", "migrating_in");

  const operations = buildOperations(phase, source, target);
  const results = [];

  for (const operation of operations) {
    const response = await fetch(registryUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-node-admin-key": adminKey,
      },
      body: JSON.stringify(operation.payload),
    });

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        `${operation.name} failed (${response.status}): ${JSON.stringify(json)}`,
      );
    }

    results.push({
      name: operation.name,
      status: response.status,
      body: json,
    });
  }

  console.log(JSON.stringify({ success: true, phase, results }, null, 2));
}

function readInstancePayload(
  prefix: "SOURCE" | "TARGET",
  defaultMigrationStatus: InstancePayload["migrationStatus"],
): InstancePayload {
  return {
    instanceId: required(`${prefix}_INSTANCE_ID`),
    instanceType: "person",
    slug: required(`${prefix}_INSTANCE_SLUG`),
    baseUrl: required(`${prefix}_BASE_URL`),
    primaryAgentId: required(`${prefix}_PRIMARY_AGENT_ID`),
    displayName: readEnvFallback(`${prefix}_DISPLAY_NAME`) || undefined,
    publicKey: readEnvFallback(`${prefix}_PUBLIC_KEY`) || undefined,
    storageNamespace: readEnvFallback(`${prefix}_STORAGE_NAMESPACE`) || undefined,
    healthCheckUrl: readEnvFallback(`${prefix}_HEALTH_CHECK_URL`) || undefined,
    feeWalletAddress: readEnvFallback(`${prefix}_FEE_WALLET_ADDRESS`) || undefined,
    capabilities: [{ bespokeUi: true }, { federation: true }, { myprofile: true }],
    migrationStatus:
      (readEnvFallback(`${prefix}_MIGRATION_STATUS`) as InstancePayload["migrationStatus"]) ||
      defaultMigrationStatus,
  };
}

function buildOperations(
  phase: RegistryPhase,
  source: InstancePayload,
  target: InstancePayload,
): Array<{ name: string; payload: InstancePayload }> {
  switch (phase) {
    case "register-target":
      return [{ name: "register-target", payload: { ...target, migrationStatus: "migrating_in" } }];
    case "freeze-source":
      return [{ name: "freeze-source", payload: { ...source, migrationStatus: "migrating_out" } }];
    case "promote-target":
      return [{ name: "promote-target", payload: { ...target, migrationStatus: "active" } }];
    case "archive-source":
      return [{ name: "archive-source", payload: { ...source, migrationStatus: "archived" } }];
    case "complete":
      return [
        { name: "register-target", payload: { ...target, migrationStatus: "migrating_in" } },
        { name: "freeze-source", payload: { ...source, migrationStatus: "migrating_out" } },
        { name: "promote-target", payload: { ...target, migrationStatus: "active" } },
        { name: "archive-source", payload: { ...source, migrationStatus: "archived" } },
      ];
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
