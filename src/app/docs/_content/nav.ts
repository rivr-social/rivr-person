/**
 * Static navigation manifest for the sovereign person /docs site.
 *
 * This is the person-instance port of global's docs nav. The WIKI side-nav is
 * authored here (prose pages, human-curated order) and emphasises the surfaces a
 * personal sovereign home leads with — personas/autobot, the builder, the docs
 * vault, and the MCP act-as surface. The API side-nav is a STATIC hand-authored
 * list (overview / auth / federation): unlike global, this sovereign build does
 * not ship the machine-generated per-registry MCP / per-endpoint REST reference,
 * so there is no `_generated/*` manifest to assemble from.
 */

export type NavLink = { href: string; label: string };
export type NavSection = { title: string; links: NavLink[] };

/** WIKI surfaces — one page per user-facing surface, ported from global. */
export const WIKI_SECTIONS: NavSection[] = [
  {
    title: "Overview",
    links: [{ href: "/docs/wiki", label: "Wiki index" }],
  },
  {
    title: "Personas & agents",
    links: [
      { href: "/docs/wiki/live-avatar", label: "Live avatar & voice" },
      { href: "/docs/wiki/autobot-agents", label: "Autobot & agents" },
      { href: "/docs/wiki/builder", label: "Builder" },
    ],
  },
  {
    title: "Your content",
    links: [
      { href: "/docs/wiki/feeds-posts", label: "Feeds & posts" },
      { href: "/docs/wiki/docs-vault", label: "Docs & vault" },
      { href: "/docs/wiki/calendar-events", label: "Calendar, events & meetings" },
      { href: "/docs/wiki/messages", label: "Messages" },
    ],
  },
  {
    title: "Money",
    links: [
      { href: "/docs/wiki/marketplace", label: "Marketplace" },
      { href: "/docs/wiki/wallet-treasury", label: "Wallet & money" },
    ],
  },
  {
    title: "Identity & instance",
    links: [
      { href: "/docs/wiki/account-settings", label: "Account & settings" },
      { href: "/docs/wiki/federation-identity", label: "Federation & identity" },
      { href: "/docs/wiki/admin", label: "Instance owner" },
      { href: "/docs/wiki/badges-stake", label: "Badges" },
    ],
  },
  {
    title: "Hosted elsewhere",
    links: [
      { href: "/docs/wiki/groups", label: "Groups" },
      { href: "/docs/wiki/explore-search", label: "Discovery & search" },
      { href: "/docs/wiki/locales-regions", label: "Places" },
    ],
  },
];

/** Every wiki slug (for validation / completeness checks). */
export const WIKI_SLUGS = WIKI_SECTIONS.flatMap((s) => s.links)
  .map((l) => l.href.replace("/docs/wiki/", ""))
  .filter((slug) => slug !== "/docs/wiki" && !slug.startsWith("/docs/wiki"));

/** Top-of-tab links for the API side-nav. */
export const API_TOP_LINKS: NavLink[] = [
  { href: "/docs/api", label: "API overview" },
  { href: "/docs/api/auth", label: "Auth models" },
  { href: "/docs/api/federation", label: "Federation protocol" },
];

/** Static API side-nav sections (no generated manifests on this sovereign build). */
export const API_SECTIONS: NavSection[] = [{ title: "Developer docs", links: API_TOP_LINKS }];

export const DOCS_TABS: NavLink[] = [
  { href: "/docs/wiki", label: "Wiki" },
  { href: "/docs/api", label: "API" },
];
