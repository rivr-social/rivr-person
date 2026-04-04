"use client";

/**
 * FederationLink — a Link component that is federation-aware.
 *
 * Wraps Next.js Link for local resources and renders a standard anchor
 * with an external indicator for resources homed on other federation
 * instances. Resolves instance URLs from pre-resolved home instance info
 * or from the federation registry cache so callers can pass lightweight
 * props without needing async resolution in the render path.
 *
 * Usage:
 *
 *   // Local resource — renders a normal Next.js Link
 *   <FederationLink href="/groups/abc">My Group</FederationLink>
 *
 *   // Federated resource — renders with external indicator
 *   <FederationLink
 *     href="/profile/cameron"
 *     instanceBaseUrl="https://rivr.camalot.me"
 *     instanceName="Camalot"
 *   >
 *     Cameron
 *   </FederationLink>
 *
 *   // Auto-detect from home instance info
 *   <FederationLink
 *     href="/profile/cameron"
 *     homeInstance={{ isLocal: false, baseUrl: "https://rivr.camalot.me", slug: "camalot", ... }}
 *   >
 *     Cameron
 *   </FederationLink>
 */

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/** Minimal subset of HomeInstanceInfo needed for link resolution */
interface HomeInstanceRef {
  isLocal: boolean;
  baseUrl: string;
  slug: string;
  instanceType?: string;
}

interface FederationLinkProps
  extends Omit<ComponentPropsWithoutRef<typeof Link>, "href" | "target" | "rel"> {
  /** Path to the resource (e.g., "/profile/cameron", "/groups/abc") */
  href: string;
  /** Children to render inside the link */
  children: ReactNode;

  /**
   * Pre-resolved home instance info. When provided and `isLocal` is false,
   * the link renders as an external federation link pointing to the
   * instance's baseUrl + href.
   */
  homeInstance?: HomeInstanceRef;

  /**
   * Explicit override: base URL of the remote instance.
   * Takes precedence over homeInstance.baseUrl when both are provided.
   */
  instanceBaseUrl?: string;

  /**
   * Human-readable name of the remote instance (shown in tooltip).
   * Falls back to the instance slug or domain extracted from the URL.
   */
  instanceName?: string;

  /**
   * Whether to show the external link icon indicator.
   * Defaults to true for federated links, false for local links.
   */
  showExternalIcon?: boolean;

  /** Additional CSS classes for the outer element */
  className?: string;
}

/**
 * Extracts a human-readable domain label from a URL string.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Determines whether a link should be treated as federated (external).
 */
function isFederatedLink(props: FederationLinkProps): boolean {
  // Explicit remote base URL always means federated
  if (props.instanceBaseUrl) return true;

  // Home instance info says it's remote
  if (props.homeInstance && !props.homeInstance.isLocal) return true;

  return false;
}

/**
 * Builds the full URL for a federated resource on a remote instance.
 */
function buildFederatedUrl(href: string, baseUrl: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const cleanPath = href.startsWith("/") ? href : `/${href}`;
  return `${cleanBase}${cleanPath}`;
}

export function FederationLink(props: FederationLinkProps) {
  const {
    href,
    children,
    homeInstance,
    instanceBaseUrl,
    instanceName,
    showExternalIcon,
    className = "",
    ...restProps
  } = props;

  const isFederated = isFederatedLink(props);

  if (!isFederated) {
    // Local resource — render a standard Next.js Link
    return (
      <Link href={href} className={className} {...restProps}>
        {children}
      </Link>
    );
  }

  // Federated resource — resolve the full external URL
  const baseUrl = instanceBaseUrl || homeInstance?.baseUrl || "";
  const fullUrl = buildFederatedUrl(href, baseUrl);

  const displayName =
    instanceName ||
    homeInstance?.slug ||
    extractDomain(baseUrl);

  const shouldShowIcon = showExternalIcon !== undefined ? showExternalIcon : true;

  return (
    <a
      href={fullUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 ${className}`}
      title={`Opens on ${displayName}`}
      {...restProps}
    >
      {children}
      {shouldShowIcon && (
        <ExternalLink
          className="h-3 w-3 shrink-0 opacity-60"
          aria-label={`External link to ${displayName}`}
        />
      )}
    </a>
  );
}

export type { FederationLinkProps, HomeInstanceRef };
