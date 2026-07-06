/**
 * Typed `rivr-app.json` application manifest.
 *
 * This is the ONLY contract the builder session can use to describe an app.
 * The manifest is strictly allowlisted: unknown keys are rejected, and no
 * Dockerfile, Compose fragment, host path, capability, device, network, raw
 * command, or container name can be expressed. The host broker re-validates
 * the manifest independently (`tools/camalot/rivr-app-broker.py`); this module
 * is the app-side half of that shared contract.
 */

export const APP_MANIFEST_FILE_NAME = "rivr-app.json";
export const APP_MANIFEST_VERSION = 1;

export const APP_RUNTIMES = ["static", "node-22"] as const;
export type AppRuntime = (typeof APP_RUNTIMES)[number];

export const APP_RESOURCE_CLASSES = ["tiny", "small", "medium"] as const;
export type AppResourceClass = (typeof APP_RESOURCE_CLASSES)[number];

export const APP_DATABASE_KINDS = ["none", "postgres"] as const;
export type AppDatabaseKind = (typeof APP_DATABASE_KINDS)[number];

/** Internal container port range a node app may listen on. */
export const APP_INTERNAL_PORT_MIN = 3000;
export const APP_INTERNAL_PORT_MAX = 8999;

export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
export const APP_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const APP_HEALTH_PATH_PATTERN = /^\/[A-Za-z0-9/._-]{0,127}$/;
export const APP_NAME_MAX_LENGTH = 80;
export const APP_MAX_SECRET_NAMES = 16;

/**
 * Identifiers that may never be claimed as an appId: the platform stack,
 * infra dependencies, agent services, and reserved hostnames. Deleting or
 * deploying over any of these from the builder must be impossible.
 */
export const APP_ID_DENYLIST = new Set([
  "camalot",
  "rivr",
  "rivr-person",
  "pm-core",
  "postgres",
  "redis",
  "minio",
  "synapse",
  "traefik",
  "dashboard",
  "whisperx",
  "livekit",
  "camtron",
  "parachute",
  "socket-proxy",
  "mautrix",
  "api",
  "www",
  "mail",
  "smtp",
  "admin",
  "current",
  "queue",
  "status",
  "releases",
  "secrets",
]);

const MANIFEST_ALLOWED_KEYS = new Set([
  "version",
  "appId",
  "name",
  "runtime",
  "internalPort",
  "resourceClass",
  "database",
  "secretNames",
  "healthPath",
]);

export interface RivrAppManifest {
  version: typeof APP_MANIFEST_VERSION;
  appId: string;
  name: string;
  runtime: AppRuntime;
  /** Required for node runtimes; forbidden for static. */
  internalPort?: number;
  resourceClass: AppResourceClass;
  database: AppDatabaseKind;
  /** Names of secrets the app needs. Values are NEVER carried here. */
  secretNames: string[];
  /** Path the broker health-gates before promoting a release. */
  healthPath: string;
}

export type ManifestParseResult =
  | { ok: true; manifest: RivrAppManifest }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strictly parse and validate a candidate manifest. Collects every violation
 * rather than failing on the first so the session gets one actionable answer.
 */
export function parseAppManifest(raw: unknown): ManifestParseResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["Manifest must be a JSON object"] };
  }

  for (const key of Object.keys(raw)) {
    if (!MANIFEST_ALLOWED_KEYS.has(key)) {
      errors.push(`Unknown manifest key: "${key}"`);
    }
  }

  if (raw.version !== APP_MANIFEST_VERSION) {
    errors.push(`version must be ${APP_MANIFEST_VERSION}`);
  }

  const appId = typeof raw.appId === "string" ? raw.appId : "";
  if (!APP_ID_PATTERN.test(appId)) {
    errors.push(
      "appId must be 2-32 chars of lowercase letters, digits, and hyphens, starting with a letter",
    );
  } else if (APP_ID_DENYLIST.has(appId) || appId.startsWith("mautrix")) {
    errors.push(`appId "${appId}" is reserved by the platform`);
  }

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > APP_NAME_MAX_LENGTH) {
    errors.push(`name is required (max ${APP_NAME_MAX_LENGTH} chars)`);
  }

  const runtime = raw.runtime as AppRuntime;
  if (!APP_RUNTIMES.includes(runtime)) {
    errors.push(`runtime must be one of: ${APP_RUNTIMES.join(", ")}`);
  }

  const resourceClass = (raw.resourceClass ?? "tiny") as AppResourceClass;
  if (!APP_RESOURCE_CLASSES.includes(resourceClass)) {
    errors.push(`resourceClass must be one of: ${APP_RESOURCE_CLASSES.join(", ")}`);
  }

  const database = (raw.database ?? "none") as AppDatabaseKind;
  if (!APP_DATABASE_KINDS.includes(database)) {
    errors.push(`database must be one of: ${APP_DATABASE_KINDS.join(", ")}`);
  }

  let internalPort: number | undefined;
  if (raw.internalPort !== undefined) {
    if (
      typeof raw.internalPort !== "number" ||
      !Number.isInteger(raw.internalPort) ||
      raw.internalPort < APP_INTERNAL_PORT_MIN ||
      raw.internalPort > APP_INTERNAL_PORT_MAX
    ) {
      errors.push(
        `internalPort must be an integer in [${APP_INTERNAL_PORT_MIN}, ${APP_INTERNAL_PORT_MAX}]`,
      );
    } else {
      internalPort = raw.internalPort;
    }
  }
  if (runtime === "static" && internalPort !== undefined) {
    errors.push("internalPort is not allowed for static apps");
  }
  if (runtime === "node-22" && internalPort === undefined) {
    errors.push("internalPort is required for node-22 apps");
  }
  if (runtime === "static" && database !== "none") {
    errors.push("static apps cannot declare a database");
  }

  const rawSecretNames = raw.secretNames ?? [];
  const secretNames: string[] = [];
  if (!Array.isArray(rawSecretNames)) {
    errors.push("secretNames must be an array of secret NAMES (never values)");
  } else if (rawSecretNames.length > APP_MAX_SECRET_NAMES) {
    errors.push(`secretNames is capped at ${APP_MAX_SECRET_NAMES} entries`);
  } else {
    for (const entry of rawSecretNames) {
      if (typeof entry !== "string" || !APP_SECRET_NAME_PATTERN.test(entry)) {
        errors.push(
          `secretNames entries must match ${APP_SECRET_NAME_PATTERN} (got ${JSON.stringify(entry)})`,
        );
      } else if (!secretNames.includes(entry)) {
        secretNames.push(entry);
      }
    }
  }

  const healthPath = typeof raw.healthPath === "string" ? raw.healthPath : "/";
  if (!APP_HEALTH_PATH_PATTERN.test(healthPath)) {
    errors.push("healthPath must be an absolute path of safe characters (max 128 chars)");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest: {
      version: APP_MANIFEST_VERSION,
      appId,
      name,
      runtime,
      ...(internalPort !== undefined ? { internalPort } : {}),
      resourceClass,
      database,
      secretNames,
      healthPath,
    },
  };
}

/** The platform subdomain an app is served on. Derived, never user-supplied. */
export function appSubdomain(appId: string, baseDomain: string): string {
  return `${appId}.${baseDomain}`;
}
