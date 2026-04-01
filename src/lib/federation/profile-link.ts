// src/lib/federation/profile-link.ts

/**
 * Federated profile link resolution.
 *
 * Resolves the correct profile URL for any agent, routing to their
 * home instance when remote or returning a local path when the agent
 * lives on this instance.
 */

import { resolveHomeInstance } from "./resolution";

/**
 * Resolve the full profile URL for a given agent.
 *
 * - If the agent's home instance is the current (local) instance, returns a relative path.
 * - If the agent lives on a remote instance, returns an absolute URL on that instance.
 *
 * @param agentId - UUID of the agent to resolve.
 * @param username - Optional username slug for the profile path.
 * @returns The profile URL string (relative for local, absolute for remote).
 */
export async function getProfileUrl(
  agentId: string,
  username?: string | null,
): Promise<string> {
  const profilePath = username ? `/profile/${username}` : "/profile";

  try {
    const homeInstance = await resolveHomeInstance(agentId);

    if (homeInstance.isLocal) {
      return profilePath;
    }

    // Remote instance — construct absolute URL
    const baseUrl = homeInstance.baseUrl.replace(/\/+$/, "");
    return `${baseUrl}${profilePath}`;
  } catch {
    // Resolution failed — fall back to local profile path
    return profilePath;
  }
}

/**
 * Synchronous client-side profile URL builder for cases where
 * home instance info has already been resolved.
 *
 * @param isLocal - Whether the agent's home is the current instance.
 * @param baseUrl - The base URL of the agent's home instance.
 * @param username - Optional username slug.
 * @returns The profile URL string.
 */
export function buildProfileUrl(
  isLocal: boolean,
  baseUrl: string,
  username?: string | null,
): string {
  const profilePath = username ? `/profile/${username}` : "/profile";

  if (isLocal) {
    return profilePath;
  }

  const cleanBase = baseUrl.replace(/\/+$/, "");
  return `${cleanBase}${profilePath}`;
}
