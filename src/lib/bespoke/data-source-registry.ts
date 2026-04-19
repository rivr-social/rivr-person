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
