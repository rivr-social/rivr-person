// ---------------------------------------------------------------------------
// Builder Data Source Registry
//
// Defines the available data source kinds with metadata and provides a
// unified fetcher that normalizes results into { label, data, error }.
// ---------------------------------------------------------------------------

import type { DataSourceKind, DataSourceConfig } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Source metadata
// ---------------------------------------------------------------------------

export interface DataSourceMeta {
  kind: DataSourceKind;
  label: string;
  description: string;
  iconHint: string;
  defaultConfig: DataSourceConfig;
  /** Fields the user can edit in the UI for this source kind. */
  configurableFields: ConfigurableField[];
  /**
   * REA sources are configured with a scope picker (kinds + specific objects),
   * not free-text fields. `scopeVocabulary` tells the picker which catalog of
   * "kinds" to offer: resource types, agent types, or ledger verb types.
   */
  scopeVocabulary?: "resource-types" | "agent-types" | "verb-types";
}

export interface ConfigurableField {
  key: keyof DataSourceConfig;
  label: string;
  placeholder: string;
  required: boolean;
}

export const DATA_SOURCE_REGISTRY: readonly DataSourceMeta[] = [
  {
    kind: "myprofile",
    label: "My Profile",
    description: "Your private profile bundle (name, bio, posts, events, groups, offerings, connections).",
    iconHint: "User",
    defaultConfig: {},
    configurableFields: [],
  },
  {
    kind: "public-profile",
    label: "Public Profile",
    description: "A public profile by username. Useful for previewing how others see you.",
    iconHint: "Globe",
    defaultConfig: { username: "" },
    configurableFields: [
      { key: "username", label: "Username", placeholder: "e.g. cameron", required: true },
    ],
  },
  {
    kind: "solid-pod",
    label: "Solid Pod",
    description: "Import profile data from a Solid Pod via WebID.",
    iconHint: "Database",
    defaultConfig: { webId: "" },
    configurableFields: [
      { key: "webId", label: "WebID URI", placeholder: "https://pod.example.com/profile/card#me", required: true },
    ],
  },
  {
    kind: "universal-manifest",
    label: "Universal Manifest",
    description: "Fetch a portable UM envelope by kind and ID.",
    iconHint: "FileCode2",
    defaultConfig: { umKind: "", umId: "" },
    configurableFields: [
      { key: "umKind", label: "Kind", placeholder: "e.g. person", required: true },
      { key: "umId", label: "ID", placeholder: "e.g. abc-123", required: true },
    ],
  },
  {
    kind: "rivr-resources",
    label: "My Resources",
    description: "Scope which of your Resources the built site may read — by type and/or specific items. Bounded by your own view-permissions.",
    iconHint: "Database",
    defaultConfig: { scopeTypes: [], scopeIds: [] },
    configurableFields: [],
    scopeVocabulary: "resource-types",
  },
  {
    kind: "rivr-agents",
    label: "Agents",
    description: "Scope which Agents (people, groups, orgs) the built site may read — by type and/or specific agents. Bounded by your own view-permissions.",
    iconHint: "User",
    defaultConfig: { scopeTypes: [], scopeIds: [] },
    configurableFields: [],
    scopeVocabulary: "agent-types",
  },
  {
    kind: "rivr-ledger",
    label: "Ledger",
    description: "Scope which Ledger relationships the built site may read — by verb and/or specific subjects/objects. Bounded by your own predicate-visibility.",
    iconHint: "FileCode2",
    defaultConfig: { scopeTypes: [], scopeIds: [] },
    configurableFields: [],
    scopeVocabulary: "verb-types",
  },
] as const;

// ---------------------------------------------------------------------------
// Fetch result
// ---------------------------------------------------------------------------

export interface DataSourceFetchResult {
  label: string;
  data: unknown | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Fetcher
// ---------------------------------------------------------------------------

/**
 * Fetch content from a data source. Runs client-side against app API routes.
 * All fetches use same-origin credentials so auth cookies propagate.
 */
export async function fetchDataSourceContent(
  kind: DataSourceKind,
  config: DataSourceConfig,
): Promise<DataSourceFetchResult> {
  const meta = DATA_SOURCE_REGISTRY.find((m) => m.kind === kind);
  const label = meta?.label ?? kind;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let url: string;

    switch (kind) {
      case "myprofile":
        url = "/api/myprofile";
        break;

      case "public-profile": {
        const username = config.username?.trim();
        if (!username) {
          return { label, data: null, error: "Username is required for public-profile source." };
        }
        url = `/api/profile/${encodeURIComponent(username)}`;
        break;
      }

      case "solid-pod": {
        const webId = config.webId?.trim();
        if (!webId) {
          return { label, data: null, error: "WebID is required for solid-pod source." };
        }
        url = `/api/builder/import-solid?webId=${encodeURIComponent(webId)}`;
        break;
      }

      case "universal-manifest": {
        const umKind = config.umKind?.trim();
        const umId = config.umId?.trim();
        if (!umKind || !umId) {
          return { label, data: null, error: "Both kind and ID are required for universal-manifest source." };
        }
        url = `/api/universal-manifest/${encodeURIComponent(umKind)}/${encodeURIComponent(umId)}`;
        break;
      }

      case "rivr-agents":
      case "rivr-ledger":
      case "rivr-resources": {
        const params = new URLSearchParams({ kind });
        const types = (config.scopeTypes ?? []).filter((t) => t.trim().length > 0);
        const ids = (config.scopeIds ?? []).filter((i) => i.trim().length > 0);
        if (ids.length === 0) {
          return { label, data: null, error: `${label} requires at least one selected source item.` };
        }
        if (types.length > 0) params.set("types", types.join(","));
        params.set("ids", ids.join(","));
        url = `/api/builder/rea-source?${params.toString()}`;
        break;
      }

      default:
        return { label, data: null, error: `Unknown data source kind: ${kind}` };
    }

    const response = await fetch(url, {
      method: "GET",
      credentials: "same-origin",
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        label,
        data: null,
        error: `Fetch failed (${response.status}): ${body.slice(0, 200)}`,
      };
    }

    const data: unknown = await response.json();
    return { label, data, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { label, data: null, error: message };
  }
}

/**
 * Look up registry metadata for a given kind.
 */
export function getDataSourceMeta(kind: DataSourceKind): DataSourceMeta | undefined {
  return DATA_SOURCE_REGISTRY.find((m) => m.kind === kind);
}
