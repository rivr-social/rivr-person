/**
 * @fileoverview Maps a Google OAuth grant onto the agent's connector lane (A5).
 *
 * The single Google sign-in requests the FULL connector scope set up front
 * (Calendar + Gmail + Drive + Docs). Google may return a PARTIAL grant when the
 * user unticks scopes on the consent screen, so this module is grant-driven: it
 * inspects the *granted* scope string and provisions exactly the connectors the
 * user actually authorized, leaving the rest unset for an incremental re-link.
 *
 * The `linkAccount` auth event calls {@link linkGoogleConnectorsFromGrant} to
 * upsert `connected` connector rows for the granted providers into
 * `agents.metadata.autobotSettings.connections`. No OAuth token material is
 * stored in the connector blob here — NextAuth persists the tokens in its own
 * `accounts` table; the connector row only records that the capability is
 * authorized plus the granted scopes for reference.
 *
 * Server-only: imports the settings store (Node/db). Never import from a client
 * component.
 */
import {
  getAutobotConnectorDefinition,
  type AutobotConnection,
  type AutobotConnectionProvider,
} from "@/lib/autobot-connectors";
import {
  getAutobotUserSettings,
  saveAutobotUserSettings,
} from "@/lib/autobot-user-settings";

/** Identity scopes always requested; they do not map to a connector. */
export const GOOGLE_BASE_SCOPES = ["openid", "email", "profile"] as const;

/**
 * Maps each requested Google feature scope to the connector it authorizes.
 * Multiple scopes may resolve to the same connector (e.g. Drive + Docs both
 * power the Google Drive connector; Gmail modify + send both power Gmail).
 */
export const GOOGLE_SCOPE_TO_CONNECTOR_MAP: Readonly<
  Record<string, AutobotConnectionProvider>
> = {
  "https://www.googleapis.com/auth/calendar": "google_calendar",
  "https://www.googleapis.com/auth/documents": "google_docs",
  "https://www.googleapis.com/auth/drive.file": "google_docs",
  "https://www.googleapis.com/auth/gmail.modify": "gmail",
  "https://www.googleapis.com/auth/gmail.send": "gmail",
};

/**
 * The full scope set requested at sign-in: identity scopes plus every
 * connector-bearing feature scope. Requesting them together means one consent
 * screen grants the whole connector suite; partial grants are handled at link
 * time.
 */
export const GOOGLE_OAUTH_SCOPES: string[] = [
  ...GOOGLE_BASE_SCOPES,
  ...Object.keys(GOOGLE_SCOPE_TO_CONNECTOR_MAP),
];

/** A connector provider plus the granted scopes that authorized it. */
export interface GoogleConnectorGrant {
  provider: AutobotConnectionProvider;
  scopes: string[];
}

/**
 * Reduces a space-separated granted-scope string to the connector providers it
 * authorizes. Unknown/identity scopes are ignored; each provider is returned
 * once with the granted scopes that mapped to it.
 */
export function mapGrantedScopesToProviders(
  grantedScope: string | null | undefined,
): GoogleConnectorGrant[] {
  const granted = (grantedScope ?? "")
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  const byProvider = new Map<AutobotConnectionProvider, string[]>();
  for (const scope of granted) {
    const provider = GOOGLE_SCOPE_TO_CONNECTOR_MAP[scope];
    if (!provider) continue;
    const scopes = byProvider.get(provider) ?? [];
    scopes.push(scope);
    byProvider.set(provider, scopes);
  }

  return [...byProvider.entries()].map(([provider, scopes]) => ({ provider, scopes }));
}

/**
 * Upserts `connected` connector rows for the providers authorized by a Google
 * grant. Idempotent and merge-preserving: an existing connector keeps its
 * sync direction, modules, label, and any prior config, gaining only the
 * refreshed `grantedScopes`. Returns the providers that were linked.
 */
export async function linkGoogleConnectorsFromGrant(params: {
  agentId: string;
  grantedScope: string | null | undefined;
  externalAccountId?: string | null;
  accountLabel?: string | null;
}): Promise<AutobotConnectionProvider[]> {
  const grants = mapGrantedScopesToProviders(params.grantedScope);
  if (grants.length === 0) return [];

  const settings = await getAutobotUserSettings(params.agentId);
  const byProvider = new Map<string, AutobotConnection>(
    settings.connections.map((connection) => [connection.provider, connection]),
  );

  const externalAccountId = params.externalAccountId?.trim() || undefined;
  const accountLabel = params.accountLabel?.trim() || undefined;

  for (const { provider, scopes } of grants) {
    const definition = getAutobotConnectorDefinition(provider);
    if (!definition) continue;
    const existing = byProvider.get(provider);
    byProvider.set(provider, {
      provider,
      status: "connected",
      syncDirection: existing?.syncDirection ?? "import",
      modules: existing?.modules ?? definition.modules,
      accountLabel: accountLabel ?? existing?.accountLabel ?? definition.label,
      externalAccountId: externalAccountId ?? existing?.externalAccountId,
      lastSyncedAt: existing?.lastSyncedAt,
      error: undefined,
      shared: existing?.shared,
      config: {
        ...(existing?.config ?? {}),
        grantedScopes: scopes.join(" "),
      },
    });
  }

  const nextConnections = [...byProvider.values()].sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
  await saveAutobotUserSettings(params.agentId, { connections: nextConnections });

  return grants.map((grant) => grant.provider);
}
