"use client";

/**
 * FederationSessionBanner — informational banner that displays when a user
 * is browsing a remote instance (e.g., the global platform) from their
 * home person instance.
 *
 * Shows the user's identity and a link back to their home instance.
 * Actual SSO token exchange is a future step; this banner acknowledges
 * the federated context so users understand where they are.
 */

import { ExternalLink, Globe } from "lucide-react";

interface FederationSessionBannerProps {
  /** Display name of the browsing user */
  displayName: string;
  /** The user's home instance domain (e.g., "rivr.camalot.me") */
  homeInstanceDomain: string;
  /** Full URL of the home instance for the "Go home" link */
  homeInstanceUrl: string;
}

/**
 * Renders a slim banner indicating federated browsing context.
 *
 * @param props - Banner configuration with user identity and home instance info.
 */
export function FederationSessionBanner({
  displayName,
  homeInstanceDomain,
  homeInstanceUrl,
}: FederationSessionBannerProps) {
  return (
    <div className="flex items-center justify-between gap-3 bg-primary/5 border border-primary/10 rounded-lg px-3 py-2 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground min-w-0">
        <Globe className="h-4 w-4 shrink-0 text-primary" />
        <span className="truncate">
          Browsing as{" "}
          <span className="font-medium text-foreground">{displayName}</span>
          {" "}from{" "}
          <span className="font-medium text-foreground">{homeInstanceDomain}</span>
        </span>
      </div>
      <a
        href={homeInstanceUrl}
        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline whitespace-nowrap"
      >
        Go home
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
