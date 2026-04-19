"use client";

/**
 * FederationBanner — contextual banner displayed when viewing content
 * that originates from a different federation instance.
 *
 * Shows a subtle, non-intrusive notification: "This [resource type] is
 * from [instance name]" with a link to view it on the home instance.
 *
 * Complements FederationSessionBanner (which shows the user's own
 * federated browsing context) by indicating the origin of the content
 * being viewed rather than the viewer's identity.
 *
 * Usage:
 *
 *   <FederationBanner
 *     resourceType="profile"
 *     instanceName="Camalot"
 *     instanceBaseUrl="https://rivr.camalot.me"
 *     canonicalPath="/profile/cameron"
 *   />
 */

import { ExternalLink, Globe, Users, MapPin, Layers, User } from "lucide-react";
import type { ReactNode } from "react";

/** Supported resource types with human-readable labels and icons */
const RESOURCE_TYPE_CONFIG = {
  profile: { label: "profile", Icon: User },
  group: { label: "group", Icon: Users },
  locale: { label: "locale", Icon: MapPin },
  region: { label: "region", Icon: Layers },
  post: { label: "post", Icon: Globe },
  event: { label: "event", Icon: Globe },
  listing: { label: "listing", Icon: Globe },
  document: { label: "document", Icon: Globe },
  resource: { label: "resource", Icon: Globe },
} as const;

type FederationResourceType = keyof typeof RESOURCE_TYPE_CONFIG;

interface FederationBannerProps {
  /** The type of federated resource being viewed */
  resourceType: FederationResourceType;
  /** Human-readable name of the home instance (e.g., "Camalot", "Boulder Commons") */
  instanceName: string;
  /** Base URL of the home instance */
  instanceBaseUrl: string;
  /**
   * Path to the canonical resource on the home instance.
   * Combined with instanceBaseUrl to form the "View on [instance]" link.
   */
  canonicalPath?: string;
  /**
   * Instance type label (e.g., "person", "group", "locale").
   * Shown as additional context if provided.
   */
  instanceType?: string;
  /** Optional override for the banner content */
  children?: ReactNode;
  /** Whether the banner can be dismissed. Defaults to false. */
  dismissible?: boolean;
  /** Callback when dismissed */
  onDismiss?: () => void;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Renders a subtle banner indicating the viewed content is federated
 * from another instance.
 */
export function FederationBanner({
  resourceType,
  instanceName,
  instanceBaseUrl,
  canonicalPath,
  instanceType,
  children,
  dismissible = false,
  onDismiss,
  className = "",
}: FederationBannerProps) {
  const config = RESOURCE_TYPE_CONFIG[resourceType];
  const { Icon } = config;

  const cleanBaseUrl = instanceBaseUrl.replace(/\/+$/, "");
  const canonicalUrl = canonicalPath
    ? `${cleanBaseUrl}${canonicalPath.startsWith("/") ? canonicalPath : `/${canonicalPath}`}`
    : cleanBaseUrl;

  const instanceLabel = instanceType
    ? `${instanceName} (${instanceType})`
    : instanceName;

  return (
    <div
      className={`flex items-center justify-between gap-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 rounded-lg px-3 py-2 text-sm ${className}`}
      role="status"
      aria-label={`Federated content from ${instanceName}`}
    >
      <div className="flex items-center gap-2 text-muted-foreground min-w-0">
        <Icon className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        {children || (
          <span className="truncate">
            This {config.label} is from{" "}
            <span className="font-medium text-foreground">{instanceLabel}</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <a
          href={canonicalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline whitespace-nowrap"
        >
          View on {instanceName}
          <ExternalLink className="h-3 w-3" />
        </a>
        {dismissible && onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Dismiss federation banner"
          >
            <span className="sr-only">Dismiss</span>
            <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

export type { FederationBannerProps, FederationResourceType };
