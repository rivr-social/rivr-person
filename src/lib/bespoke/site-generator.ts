import type { BespokeModuleManifest, MyProfileModuleBundle } from "@/lib/bespoke/types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSTANCE_TYPE_PERSON = "person";
const INSTANCE_TYPE_GROUP = "group";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface GeneratedSite {
  files: Map<string, string>;
  pages: string[];
}

export interface SiteOverrides {
  [key: string]: string;
}

export interface SitePreferences {
  preset: string;
  visibleSections: string[];
  siteTitle?: string;
  customTokens?: Partial<ThemeTokens>;
  overrides?: SiteOverrides;
  instanceType?: string;
}

// ---------------------------------------------------------------------------
// Theme preset definitions
// ---------------------------------------------------------------------------

interface ThemeTokens {
  background: string;
  foreground: string;
  primary: string;
  accent: string;
  border: string;
  cardRadius: string;
  cardShadow: string;
  primaryForeground: string;
  mutedForeground: string;
  surfaceBg: string;
}

const PRESET_DEFAULT = "default";
const PRESET_RED_GOLD = "red-gold";
const PRESET_FOREST_BRASS = "forest-brass";
const PRESET_EARTH_CLAY = "earth-clay";

const THEME_PRESETS: Record<string, ThemeTokens> = {
  [PRESET_DEFAULT]: {
    background: "#0a0a0a",
    foreground: "#fafafa",
    primary: "#7c3aed",
    accent: "#a78bfa",
    border: "#27272a",
    cardRadius: "12px",
    cardShadow: "0 1px 3px rgba(0,0,0,0.4)",
    primaryForeground: "#ffffff",
    mutedForeground: "#a1a1aa",
    surfaceBg: "#111113",
  },
  [PRESET_RED_GOLD]: {
    background: "#0f0808",
    foreground: "#faf5f0",
    primary: "#dc2626",
    accent: "#d4a017",
    border: "#2a1a1a",
    cardRadius: "8px",
    cardShadow: "0 2px 6px rgba(220,38,38,0.15)",
    primaryForeground: "#ffffff",
    mutedForeground: "#b09080",
    surfaceBg: "#140d0d",
  },
  [PRESET_FOREST_BRASS]: {
    background: "#060d06",
    foreground: "#e8f0e8",
    primary: "#16a34a",
    accent: "#b8860b",
    border: "#1a2e1a",
    cardRadius: "16px",
    cardShadow: "0 2px 8px rgba(22,163,74,0.12)",
    primaryForeground: "#ffffff",
    mutedForeground: "#7a9a7a",
    surfaceBg: "#0a140a",
  },
  [PRESET_EARTH_CLAY]: {
    background: "#0d0a08",
    foreground: "#f0e8e0",
    primary: "#b45309",
    accent: "#92400e",
    border: "#2a2018",
    cardRadius: "10px",
    cardShadow: "0 1px 4px rgba(180,83,9,0.18)",
    primaryForeground: "#ffffff",
    mutedForeground: "#a08a70",
    surfaceBg: "#12100c",
  },
};

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

function resolvePath(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function extractFieldValue(bundle: MyProfileModuleBundle, dataPath: string): unknown {
  return resolvePath(bundle, dataPath);
}

function asString(val: unknown): string {
  if (typeof val === "string") return val;
  if (val === null || val === undefined) return "";
  return String(val);
}

function asStringArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map((v) => asString(v)).filter(Boolean);
  return [];
}

function asRecordArray(val: unknown): Record<string, unknown>[] {
  if (Array.isArray(val)) return val as Record<string, unknown>[];
  return [];
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveOverride(overrides: SiteOverrides | undefined, key: string, fallback: string): string {
  if (overrides && overrides[key]) return overrides[key];
  return fallback;
}

/**
 * Resolves an override checking a primary key first, then an alias key, then fallback.
 * This allows new canonical keys (e.g. "about.heading") while still honoring legacy
 * keys (e.g. "about.title") for backwards compatibility.
 */
function resolveOverrideWithAlias(
  overrides: SiteOverrides | undefined,
  primaryKey: string,
  aliasKey: string,
  fallback: string,
): string {
  if (overrides) {
    if (overrides[primaryKey]) return overrides[primaryKey];
    if (overrides[aliasKey]) return overrides[aliasKey];
  }
  return fallback;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatShortDate(dateStr: string): string {
  if (!dateStr) return "";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

// ---------------------------------------------------------------------------
// Resolve theme tokens
// ---------------------------------------------------------------------------

function resolveTokens(preferences: SitePreferences): ThemeTokens {
  const presetName = preferences.preset || PRESET_DEFAULT;
  const baseTokens = THEME_PRESETS[presetName] ?? THEME_PRESETS[PRESET_DEFAULT];
  return preferences.customTokens ? { ...baseTokens, ...preferences.customTokens } : baseTokens;
}

// ---------------------------------------------------------------------------
// CSS generator (shared stylesheet)
// ---------------------------------------------------------------------------

function generateCSS(tokens: ThemeTokens): string {
  return `/* Rivr Bespoke Site — Generated Stylesheet */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root {
  --bg: ${tokens.background};
  --fg: ${tokens.foreground};
  --primary: ${tokens.primary};
  --accent: ${tokens.accent};
  --border: ${tokens.border};
  --card-radius: ${tokens.cardRadius};
  --card-shadow: ${tokens.cardShadow};
  --primary-fg: ${tokens.primaryForeground};
  --muted-fg: ${tokens.mutedForeground};
  --surface-bg: ${tokens.surfaceBg};
}

html {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  background: var(--bg);
  color: var(--fg);
  min-height: 100vh;
}

a {
  color: var(--accent);
  text-decoration: none;
  transition: color 0.2s ease;
}

a:hover {
  color: var(--primary);
}

/* Navigation */
.site-nav {
  position: sticky;
  top: 0;
  z-index: 100;
  background: ${tokens.background}ee;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border);
  padding: 0 1.25rem;
}

.nav-inner {
  max-width: 960px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 56px;
}

.nav-brand {
  font-size: 1rem;
  font-weight: 700;
  color: var(--fg);
  letter-spacing: -0.02em;
}

.nav-links {
  display: flex;
  gap: 0.25rem;
  list-style: none;
  flex-wrap: wrap;
}

.nav-links a {
  display: inline-block;
  padding: 0.35rem 0.65rem;
  font-size: 0.8rem;
  color: var(--muted-fg);
  border-radius: 6px;
  transition: background 0.2s ease, color 0.2s ease;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 500;
}

.nav-links a:hover,
.nav-links a.active {
  background: ${tokens.primary}18;
  color: var(--accent);
}

/* Layout */
.site-wrapper {
  max-width: 800px;
  margin: 0 auto;
  padding: 2.5rem 1.5rem 4rem;
}

.page-header {
  margin-bottom: 2.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
}

.page-title {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  margin-bottom: 0.35rem;
}

.page-subtitle {
  font-size: 0.95rem;
  color: var(--muted-fg);
  line-height: 1.5;
}

/* Hero Section */
.hero-section {
  text-align: center;
  padding: 4rem 0 3rem;
}

.avatar {
  width: 120px;
  height: 120px;
  border-radius: 50%;
  object-fit: cover;
  margin: 0 auto 1.25rem;
  border: 3px solid var(--primary);
  display: block;
}

.avatar-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 2rem;
  font-weight: 700;
  line-height: 120px;
  text-align: center;
}

.hero-name {
  font-size: 2.5rem;
  font-weight: 800;
  letter-spacing: -0.03em;
  margin-bottom: 0.35rem;
}

.hero-tagline {
  font-size: 1.15rem;
  color: var(--accent);
  margin-bottom: 0.35rem;
  font-weight: 400;
}

.hero-location {
  font-size: 0.875rem;
  color: var(--muted-fg);
  margin-bottom: 1.5rem;
}

.hero-mission {
  max-width: 600px;
  margin: 0 auto;
  font-size: 0.95rem;
  color: var(--muted-fg);
  line-height: 1.7;
}

.hero-cta {
  margin-top: 1.5rem;
  display: flex;
  gap: 0.75rem;
  justify-content: center;
  flex-wrap: wrap;
}

.btn {
  display: inline-block;
  padding: 0.6rem 1.5rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.2s ease;
  cursor: pointer;
  border: none;
}

.btn-primary {
  background: var(--primary);
  color: var(--primary-fg);
}

.btn-primary:hover {
  opacity: 0.9;
  color: var(--primary-fg);
}

.btn-outline {
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--border);
}

.btn-outline:hover {
  border-color: var(--primary);
  color: var(--primary);
}

/* Selected Focus on index */
.focus-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}

.focus-card {
  background: var(--surface-bg);
  border: 1px solid var(--border);
  border-radius: var(--card-radius);
  padding: 1.25rem;
  transition: border-color 0.2s ease;
}

.focus-card:hover {
  border-color: ${tokens.primary}60;
}

.focus-card-title {
  font-size: 0.95rem;
  font-weight: 600;
  margin-bottom: 0.35rem;
}

.focus-card-desc {
  font-size: 0.825rem;
  color: var(--muted-fg);
  line-height: 1.5;
}

/* Card Section (generic) */
.card-section {
  background: var(--surface-bg);
  border: 1px solid var(--border);
  border-radius: var(--card-radius);
  padding: 1.75rem;
  margin-bottom: 1.5rem;
  box-shadow: var(--card-shadow);
}

.section-title {
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 1.25rem;
  color: var(--primary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* About */
.bio-text {
  color: var(--fg);
  line-height: 1.8;
  margin-bottom: 1.25rem;
  font-size: 0.95rem;
}

.skills-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.skill-tag {
  display: inline-block;
  padding: 0.3rem 0.85rem;
  background: ${tokens.primary}14;
  color: var(--accent);
  border-radius: 20px;
  font-size: 0.8rem;
  border: 1px solid ${tokens.primary}30;
}

.social-links {
  display: flex;
  gap: 0.75rem;
  margin-top: 1.25rem;
  flex-wrap: wrap;
}

.social-link {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.85rem;
  font-size: 0.8rem;
  color: var(--accent);
  border: 1px solid var(--border);
  border-radius: 8px;
  transition: border-color 0.2s ease;
}

.social-link:hover {
  border-color: var(--primary);
}

/* Insights grid */
.insights-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.75rem;
}

.insight-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.85rem;
  background: var(--bg);
  border-radius: 8px;
  border: 1px solid var(--border);
}

.insight-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted-fg);
}

.insight-value {
  font-size: 0.9rem;
  color: var(--fg);
}

/* Roles / Groups */
.roles-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.role-item {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  background: var(--bg);
  border-radius: var(--card-radius);
  border: 1px solid var(--border);
  align-items: flex-start;
}

.role-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: ${tokens.primary}18;
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 1.1rem;
  flex-shrink: 0;
}

.role-details {
  flex: 1;
}

.role-name {
  font-size: 0.95rem;
  font-weight: 600;
  margin-bottom: 0.15rem;
}

.role-position {
  font-size: 0.8rem;
  color: var(--accent);
  margin-bottom: 0.35rem;
}

.role-desc {
  font-size: 0.825rem;
  color: var(--muted-fg);
  line-height: 1.5;
}

/* Offerings */
.offerings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 1rem;
}

.offering-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--card-radius);
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  transition: border-color 0.2s ease;
}

.offering-card:hover {
  border-color: ${tokens.primary}60;
}

.offering-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--fg);
}

.offering-desc {
  font-size: 0.825rem;
  color: var(--muted-fg);
  line-height: 1.5;
  flex: 1;
}

.offering-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 0.5rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.offering-price {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--accent);
}

.offering-category {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted-fg);
  padding: 0.2rem 0.5rem;
  background: ${tokens.primary}10;
  border-radius: 4px;
}

/* Posts / Writing */
.posts-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.post-item {
  padding: 1.25rem;
  background: var(--bg);
  border-radius: var(--card-radius);
  border: 1px solid var(--border);
}

.post-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.35rem;
}

.post-content {
  font-size: 0.875rem;
  color: var(--muted-fg);
  line-height: 1.6;
  margin-bottom: 0.5rem;
}

.post-meta {
  display: flex;
  gap: 1rem;
  align-items: center;
}

.post-date {
  font-size: 0.75rem;
  color: var(--muted-fg);
}

.post-group {
  font-size: 0.7rem;
  color: var(--accent);
  padding: 0.15rem 0.5rem;
  background: ${tokens.primary}10;
  border-radius: 4px;
}

/* Events */
.events-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.event-item {
  display: flex;
  gap: 1rem;
  padding: 1rem;
  background: var(--bg);
  border-radius: var(--card-radius);
  border: 1px solid var(--border);
  align-items: center;
}

.event-date-block {
  min-width: 56px;
  text-align: center;
  flex-shrink: 0;
}

.event-date-month {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--primary);
  font-weight: 600;
}

.event-date-day {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--fg);
  line-height: 1.2;
}

.event-details {
  flex: 1;
}

.event-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 0.15rem;
}

.event-location {
  font-size: 0.8rem;
  color: var(--muted-fg);
}

.event-group {
  font-size: 0.7rem;
  color: var(--accent);
}

.event-badge {
  font-size: 0.7rem;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-weight: 500;
}

.event-badge-upcoming {
  background: ${tokens.primary}18;
  color: var(--primary);
}

.event-badge-past {
  background: ${tokens.border};
  color: var(--muted-fg);
}

/* Connections */
.connections-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 1rem;
}

.connection-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  text-align: center;
  padding: 1rem;
  background: var(--bg);
  border-radius: var(--card-radius);
  border: 1px solid var(--border);
  transition: border-color 0.2s ease;
}

.connection-item:hover {
  border-color: ${tokens.primary}60;
}

.connection-avatar {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: ${tokens.primary}18;
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  font-weight: 600;
  border: 1px solid var(--border);
}

.connection-name {
  font-size: 0.825rem;
  color: var(--fg);
  font-weight: 500;
}

.connection-context {
  font-size: 0.7rem;
  color: var(--muted-fg);
}

/* Contact */
.contact-section {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}

.contact-info {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.contact-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.9rem;
}

.contact-icon {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  background: ${tokens.primary}14;
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  flex-shrink: 0;
}

.contact-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.contact-form input,
.contact-form textarea {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.65rem 0.85rem;
  color: var(--fg);
  font-size: 0.875rem;
  font-family: inherit;
  outline: none;
  transition: border-color 0.2s ease;
}

.contact-form input:focus,
.contact-form textarea:focus {
  border-color: var(--primary);
}

.contact-form textarea {
  min-height: 100px;
  resize: vertical;
}

/* Footer */
.site-footer {
  text-align: center;
  padding: 2.5rem 0;
  font-size: 0.75rem;
  color: var(--muted-fg);
  border-top: 1px solid var(--border);
  margin-top: 2.5rem;
}

.site-footer a {
  color: var(--accent);
}

/* Empty state */
.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--muted-fg);
  font-size: 0.9rem;
}

/* Responsive */
@media (max-width: 640px) {
  .nav-links {
    gap: 0;
  }
  .nav-links a {
    padding: 0.3rem 0.4rem;
    font-size: 0.7rem;
  }
  .site-wrapper {
    padding: 1.5rem 1rem 3rem;
  }
  .hero-name {
    font-size: 1.75rem;
  }
  .hero-section {
    padding: 2.5rem 0 2rem;
  }
  .page-title {
    font-size: 1.35rem;
  }
  .insights-grid {
    grid-template-columns: 1fr;
  }
  .offerings-grid {
    grid-template-columns: 1fr;
  }
  .connections-grid {
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  }
  .contact-section {
    grid-template-columns: 1fr;
  }
  .focus-grid {
    grid-template-columns: 1fr;
  }
}
`;
}

// ---------------------------------------------------------------------------
// Navigation generator
// ---------------------------------------------------------------------------

interface NavItem {
  label: string;
  href: string;
}

function generateNav(pages: NavItem[], currentPage: string, siteTitle: string): string {
  return `
  <nav class="site-nav">
    <div class="nav-inner">
      <a href="index.html" class="nav-brand">${escapeHtml(siteTitle)}</a>
      <div class="nav-links">
        ${pages.map((p) => `<a href="${escapeHtml(p.href)}"${p.href === currentPage ? ' class="active"' : ""}>${escapeHtml(p.label)}</a>`).join("\n        ")}
      </div>
    </div>
  </nav>`;
}

function generateFooter(name: string): string {
  return `
    <footer class="site-footer">
      <p>&copy; ${new Date().getFullYear()} ${escapeHtml(name)}. Built with <a href="https://rivr.social" target="_blank" rel="noopener">Rivr</a></p>
    </footer>`;
}

function wrapPage(title: string, nav: string, body: string, footer: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(title)}" />
  <link rel="stylesheet" href="style.css" />
</head>
<body>
  ${nav}
  <div class="site-wrapper">
    ${body}
  </div>
  ${footer}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// PERSON page generators
// ---------------------------------------------------------------------------

function generatePersonIndex(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const name = asString(extractFieldValue(bundle, "profile.agent.name"));
  const tagline = resolveOverride(overrides, "index.hero.tagline", asString(extractFieldValue(bundle, "profile.agent.metadata.tagline")));
  const subtitle = resolveOverride(overrides, "index.hero.subtitle", tagline);
  const bio = asString(extractFieldValue(bundle, "profile.agent.metadata.bio"));
  const avatarUrl = asString(extractFieldValue(bundle, "profile.agent.image"));
  const location = asString(extractFieldValue(bundle, "profile.agent.metadata.location"));
  const skills = asStringArray(extractFieldValue(bundle, "profile.agent.metadata.skills"));

  const missionBody = resolveOverride(overrides, "index.mission.body", bio);
  const mission = missionBody.length > 200 ? missionBody.substring(0, 200) + "..." : missionBody;

  const avatarHtml = avatarUrl
    ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)}" class="avatar" />`
    : `<div class="avatar avatar-placeholder">${escapeHtml(name.substring(0, 2).toUpperCase())}</div>`;

  // Selected focus: top groups + offerings
  const groups = asRecordArray(bundle.groups).slice(0, 3);
  const listings = asRecordArray(bundle.marketplaceListings).slice(0, 3);
  const focusItems = [
    ...groups.map((g) => ({
      title: asString(g.name || g.title || ""),
      desc: asString(g.description || "Organization"),
    })),
    ...listings.map((l) => ({
      title: asString(l.title || l.name || ""),
      desc: asString(l.description || "").substring(0, 80) || "Offering",
    })),
  ].filter((f) => f.title);

  return `
    <section class="hero-section">
      ${avatarHtml}
      <h1 class="hero-name">${escapeHtml(resolveOverrideWithAlias(overrides, "index.hero.heading", "index.hero.name", name || "Unnamed"))}</h1>
      ${subtitle ? `<p class="hero-tagline">${escapeHtml(subtitle)}</p>` : ""}
      ${location ? `<p class="hero-location">${escapeHtml(location)}</p>` : ""}
      ${mission ? `<p class="hero-mission">${escapeHtml(mission)}</p>` : ""}
      <div class="hero-cta">
        <a href="about.html" class="btn btn-primary">About Me</a>
        <a href="contact.html" class="btn btn-outline">Get in Touch</a>
      </div>
    </section>
    ${skills.length > 0 ? `
    <div class="card-section">
      <h2 class="section-title">Skills</h2>
      <div class="skills-row">
        ${skills.map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`).join("")}
      </div>
    </div>` : ""}
    ${focusItems.length > 0 ? `
    <div class="card-section">
      <h2 class="section-title">${escapeHtml(resolveOverrideWithAlias(overrides, "index.mission.heading", "index.focus.title", "Selected Focus"))}</h2>
      <div class="focus-grid">
        ${focusItems.map((f) => `
        <div class="focus-card">
          <div class="focus-card-title">${escapeHtml(f.title)}</div>
          <div class="focus-card-desc">${escapeHtml(f.desc)}</div>
        </div>`).join("")}
      </div>
    </div>` : ""}`;
}

function generatePersonAbout(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const bio = resolveOverride(overrides, "about.bio", asString(extractFieldValue(bundle, "profile.agent.metadata.bio")));
  const skills = asStringArray(extractFieldValue(bundle, "profile.agent.metadata.skills"));
  const location = asString(extractFieldValue(bundle, "profile.agent.metadata.location"));
  const socialLinks = extractFieldValue(bundle, "profile.agent.metadata.socialLinks");

  // Persona insights
  const insightFields = [
    { key: "profile.agent.metadata.geneKeys", label: "Gene Keys" },
    { key: "profile.agent.metadata.humanDesign", label: "Human Design" },
    { key: "profile.agent.metadata.westernAstrology", label: "Western Astrology" },
    { key: "profile.agent.metadata.vedicAstrology", label: "Vedic Astrology" },
    { key: "profile.agent.metadata.ocean", label: "OCEAN" },
    { key: "profile.agent.metadata.myersBriggs", label: "Myers-Briggs" },
    { key: "profile.agent.metadata.enneagram", label: "Enneagram" },
  ];

  const insights = insightFields
    .map(({ key, label }) => {
      const val = asString(extractFieldValue(bundle, key));
      return val ? { label, value: val } : null;
    })
    .filter(Boolean) as { label: string; value: string }[];

  // Parse social links
  const links = parseSocialLinks(socialLinks);

  return `
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(resolveOverrideWithAlias(overrides, "about.heading", "about.title", "About"))}</h1>
      <p class="page-subtitle">${escapeHtml(resolveOverride(overrides, "about.subtitle", "Background, philosophy, and interests"))}</p>
    </div>
    ${bio ? `
    <div class="card-section">
      <h2 class="section-title">Bio</h2>
      <p class="bio-text">${escapeHtml(bio)}</p>
    </div>` : ""}
    ${resolveOverride(overrides, "about.philosophy.heading", "") || resolveOverride(overrides, "about.philosophy.body", "") ? `
    <div class="card-section">
      <h2 class="section-title">${escapeHtml(resolveOverride(overrides, "about.philosophy.heading", "Philosophy"))}</h2>
      <p class="bio-text">${escapeHtml(resolveOverride(overrides, "about.philosophy.body", ""))}</p>
    </div>` : ""}
    ${location ? `
    <div class="card-section">
      <h2 class="section-title">Location</h2>
      <p class="bio-text">${escapeHtml(location)}</p>
    </div>` : ""}
    ${skills.length > 0 ? `
    <div class="card-section">
      <h2 class="section-title">Skills</h2>
      <div class="skills-row">
        ${skills.map((s) => `<span class="skill-tag">${escapeHtml(s)}</span>`).join("")}
      </div>
    </div>` : ""}
    ${insights.length > 0 ? `
    <div class="card-section">
      <h2 class="section-title">${escapeHtml(resolveOverrideWithAlias(overrides, "about.insights.heading", "about.insights.title", "Persona Insights"))}</h2>
      <div class="insights-grid">
        ${insights.map((e) => `<div class="insight-item"><span class="insight-label">${escapeHtml(e.label)}</span><span class="insight-value">${escapeHtml(e.value)}</span></div>`).join("")}
      </div>
    </div>` : ""}
    ${links.length > 0 ? `
    <div class="card-section">
      <h2 class="section-title">Social</h2>
      <div class="social-links">
        ${links.map((l) => `<a href="${escapeHtml(l.url)}" class="social-link" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`).join("")}
      </div>
    </div>` : ""}`;
}

function generatePersonRoles(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const groups = asRecordArray(bundle.groups);

  return `
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(resolveOverrideWithAlias(overrides, "roles.heading", "roles.title", "Roles & Affiliations"))}</h1>
      <p class="page-subtitle">${escapeHtml(resolveOverrideWithAlias(overrides, "roles.intro", "roles.subtitle", "Organizations and communities"))}</p>
    </div>
    ${groups.length > 0 ? `
    <div class="roles-list">
      ${groups.map((g) => {
        const gName = asString(g.name || g.title || "Unnamed Group");
        const gDesc = asString(g.description || "");
        const gRole = asString(g.role || g.memberRole || "Member");
        const initials = gName.substring(0, 2).toUpperCase();
        return `
      <div class="role-item">
        <div class="role-icon">${escapeHtml(initials)}</div>
        <div class="role-details">
          <div class="role-name">${escapeHtml(gName)}</div>
          <div class="role-position">${escapeHtml(gRole)}</div>
          ${gDesc ? `<div class="role-desc">${escapeHtml(gDesc.length > 200 ? gDesc.substring(0, 200) + "..." : gDesc)}</div>` : ""}
        </div>
      </div>`;
      }).join("")}
    </div>` : `<div class="empty-state">No group affiliations yet.</div>`}`;
}

function generatePersonOfferings(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const listings = asRecordArray(bundle.marketplaceListings);

  return `
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(resolveOverrideWithAlias(overrides, "offerings.heading", "offerings.title", "Offerings"))}</h1>
      <p class="page-subtitle">${escapeHtml(resolveOverrideWithAlias(overrides, "offerings.intro", "offerings.subtitle", "Services, products, and listings"))}</p>
    </div>
    ${listings.length > 0 ? `
    <div class="offerings-grid">
      ${listings.map((l) => {
        const title = asString(l.title || l.name || "Untitled");
        const desc = asString(l.description || "");
        const price = asString(l.price || "");
        const category = asString(l.category || "");
        return `
      <div class="offering-card">
        <div class="offering-title">${escapeHtml(title)}</div>
        ${desc ? `<div class="offering-desc">${escapeHtml(desc.length > 150 ? desc.substring(0, 150) + "..." : desc)}</div>` : ""}
        <div class="offering-meta">
          ${price ? `<span class="offering-price">${escapeHtml(price)}</span>` : `<span></span>`}
          ${category ? `<span class="offering-category">${escapeHtml(category)}</span>` : ""}
        </div>
      </div>`;
      }).join("")}
    </div>` : `<div class="empty-state">No offerings listed yet.</div>`}`;
}

function generatePersonWriting(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const postsData = resolvePath(bundle, "posts.posts");
  const posts = Array.isArray(postsData) ? postsData as Record<string, unknown>[] : [];

  return `
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(resolveOverrideWithAlias(overrides, "writing.heading", "writing.title", "Writing"))}</h1>
      <p class="page-subtitle">${escapeHtml(resolveOverrideWithAlias(overrides, "writing.intro", "writing.subtitle", "Posts, thoughts, and updates"))}</p>
    </div>
    ${posts.length > 0 ? `
    <div class="posts-list">
      ${posts.map((p) => {
        const title = asString(p.title || "");
        const content = asString(p.content || "");
        const date = asString(p.createdAt || "");
        const groupName = asString(p.groupName || "");
        const preview = content.length > 250 ? content.substring(0, 250) + "..." : content;
        return `
      <div class="post-item">
        ${title ? `<div class="post-title">${escapeHtml(title)}</div>` : ""}
        <p class="post-content">${escapeHtml(preview)}</p>
        <div class="post-meta">
          ${date ? `<time class="post-date">${escapeHtml(formatDate(date))}</time>` : ""}
          ${groupName ? `<span class="post-group">${escapeHtml(groupName)}</span>` : ""}
        </div>
      </div>`;
      }).join("")}
    </div>` : `<div class="empty-state">No posts yet.</div>`}`;
}

function generatePersonEvents(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const events = asRecordArray(bundle.events);
  const now = new Date();

  const upcoming = events.filter((e) => {
    const d = asString(e.startDate || e.date || "");
    return d && new Date(d) >= now;
  });
  const past = events.filter((e) => {
    const d = asString(e.startDate || e.date || "");
    return !d || new Date(d) < now;
  });

  function renderEventList(items: Record<string, unknown>[], isPast: boolean): string {
    return items.map((e) => {
      const title = asString(e.title || e.name || "Untitled Event");
      const dateStr = asString(e.startDate || e.date || e.createdAt || "");
      const location = asString(e.location || "");
      const groupName = asString(e.groupName || "");
      let month = "";
      let day = "";
      if (dateStr) {
        try {
          const d = new Date(dateStr);
          month = d.toLocaleDateString("en-US", { month: "short" });
          day = String(d.getDate());
        } catch { /* use empty */ }
      }
      return `
      <div class="event-item">
        <div class="event-date-block">
          ${month ? `<div class="event-date-month">${escapeHtml(month)}</div>` : ""}
          ${day ? `<div class="event-date-day">${escapeHtml(day)}</div>` : ""}
        </div>
        <div class="event-details">
          <div class="event-title">${escapeHtml(title)}</div>
          ${location ? `<div class="event-location">${escapeHtml(location)}</div>` : ""}
          ${groupName ? `<div class="event-group">${escapeHtml(groupName)}</div>` : ""}
        </div>
        <span class="event-badge ${isPast ? "event-badge-past" : "event-badge-upcoming"}">${isPast ? "Past" : "Upcoming"}</span>
      </div>`;
    }).join("");
  }

  return `
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(resolveOverrideWithAlias(overrides, "events.heading", "events.title", "Events"))}</h1>
      <p class="page-subtitle">${escapeHtml(resolveOverride(overrides, "events.subtitle", "Upcoming and past events"))}</p>
    </div>
    ${upcoming.length > 0 ? `
    <div class="card-section">
      <h2 class="section-title">Upcoming</h2>
      <div class="events-list">
        ${renderEventList(upcoming, false)}
      </div>
    </div>` : ""}
    ${past.length > 0 ? `
    <div class="card-section">
      <h2 class="section-title">Past</h2>
      <div class="events-list">
        ${renderEventList(past, true)}
      </div>
    </div>` : ""}
    ${events.length === 0 ? `<div class="empty-state">No events yet.</div>` : ""}`;
}

function generatePersonConnections(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const connections = asRecordArray(bundle.connections);

  return `
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(resolveOverrideWithAlias(overrides, "connections.heading", "connections.title", "Connections"))}</h1>
      <p class="page-subtitle">${escapeHtml(resolveOverride(overrides, "connections.subtitle", "Network and endorsements"))}</p>
    </div>
    ${connections.length > 0 ? `
    <div class="connections-grid">
      ${connections.map((c) => {
        const cName = asString(c.name || c.username || "");
        const initials = cName ? cName.substring(0, 2).toUpperCase() : "??";
        const context = asString(c.relationship || c.context || "");
        return `
      <div class="connection-item">
        <div class="connection-avatar">${escapeHtml(initials)}</div>
        <span class="connection-name">${escapeHtml(cName)}</span>
        ${context ? `<span class="connection-context">${escapeHtml(context)}</span>` : ""}
      </div>`;
      }).join("")}
    </div>` : `<div class="empty-state">No connections yet.</div>`}`;
}

function generatePersonContact(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const socialLinks = extractFieldValue(bundle, "profile.agent.metadata.socialLinks");
  const email = asString(extractFieldValue(bundle, "profile.agent.email") || extractFieldValue(bundle, "profile.agent.metadata.email") || "");
  const location = asString(extractFieldValue(bundle, "profile.agent.metadata.location"));
  const links = parseSocialLinks(socialLinks);

  return `
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(resolveOverrideWithAlias(overrides, "contact.heading", "contact.title", "Contact"))}</h1>
      <p class="page-subtitle">${escapeHtml(resolveOverride(overrides, "contact.subtitle", "Get in touch"))}</p>
    </div>
    ${resolveOverride(overrides, "contact.cta", "") ? `
    <div class="card-section">
      <p class="bio-text" style="text-align:center;font-size:1.05rem;margin-bottom:1.5rem;">${escapeHtml(resolveOverride(overrides, "contact.cta", ""))}</p>
    </div>` : ""}
    <div class="card-section">
      <div class="contact-section">
        <div class="contact-info">
          ${email ? `
          <div class="contact-row">
            <div class="contact-icon">@</div>
            <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>
          </div>` : ""}
          ${location ? `
          <div class="contact-row">
            <div class="contact-icon">&bull;</div>
            <span>${escapeHtml(location)}</span>
          </div>` : ""}
          ${links.length > 0 ? `
          <div style="margin-top:0.5rem">
            <div class="social-links">
              ${links.map((l) => `<a href="${escapeHtml(l.url)}" class="social-link" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`).join("")}
            </div>
          </div>` : ""}
          ${!email && !location && links.length === 0 ? `<p style="color:var(--muted-fg);font-size:0.9rem">No contact information available.</p>` : ""}
        </div>
        <div class="contact-form">
          <h3 style="font-size:0.8rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--primary);margin-bottom:0.25rem">Send a Message</h3>
          <input type="text" placeholder="Your name" disabled />
          <input type="email" placeholder="Your email" disabled />
          <textarea placeholder="Your message..." disabled></textarea>
          <button class="btn btn-primary" disabled style="opacity:0.5;cursor:not-allowed">Send (coming soon)</button>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// GROUP page generators
// ---------------------------------------------------------------------------

function generateGroupIndex(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const name = asString(extractFieldValue(bundle, "profile.agent.name"));
  const bio = asString(extractFieldValue(bundle, "profile.agent.metadata.bio"));
  const avatarUrl = asString(extractFieldValue(bundle, "profile.agent.image"));

  const avatarHtml = avatarUrl
    ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(name)}" class="avatar" />`
    : `<div class="avatar avatar-placeholder">${escapeHtml(name.substring(0, 2).toUpperCase())}</div>`;

  return `
    <section class="hero-section">
      ${avatarHtml}
      <h1 class="hero-name">${escapeHtml(resolveOverride(overrides, "index.hero.name", name || "Unnamed Group"))}</h1>
      ${bio ? `<p class="hero-mission">${escapeHtml(bio)}</p>` : ""}
    </section>`;
}

function generateGroupMembers(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const connections = asRecordArray(bundle.connections);

  return `
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(resolveOverride(overrides, "members.title", "Members"))}</h1>
      <p class="page-subtitle">Our community</p>
    </div>
    ${connections.length > 0 ? `
    <div class="connections-grid">
      ${connections.map((c) => {
        const cName = asString(c.name || c.username || "");
        const initials = cName ? cName.substring(0, 2).toUpperCase() : "??";
        const role = asString(c.role || "Member");
        return `
      <div class="connection-item">
        <div class="connection-avatar">${escapeHtml(initials)}</div>
        <span class="connection-name">${escapeHtml(cName)}</span>
        <span class="connection-context">${escapeHtml(role)}</span>
      </div>`;
      }).join("")}
    </div>` : `<div class="empty-state">No members listed.</div>`}`;
}

function generateGroupDocs(bundle: MyProfileModuleBundle, preferences: SitePreferences): string {
  const overrides = preferences.overrides;
  const postsData = resolvePath(bundle, "posts.posts");
  const posts = Array.isArray(postsData) ? (postsData as Record<string, unknown>[]).filter((p) => asString(p.type || "") === "document") : [];

  return `
    <div class="page-header">
      <h1 class="page-title">${escapeHtml(resolveOverride(overrides, "docs.title", "Documents"))}</h1>
      <p class="page-subtitle">Group resources and documents</p>
    </div>
    ${posts.length > 0 ? `
    <div class="posts-list">
      ${posts.map((p) => {
        const title = asString(p.title || "Untitled");
        const date = asString(p.createdAt || "");
        return `
      <div class="post-item">
        <div class="post-title">${escapeHtml(title)}</div>
        ${date ? `<time class="post-date">${escapeHtml(formatDate(date))}</time>` : ""}
      </div>`;
      }).join("")}
    </div>` : `<div class="empty-state">No documents yet.</div>`}`;
}

// ---------------------------------------------------------------------------
// Social links parser
// ---------------------------------------------------------------------------

interface SocialLinkParsed {
  label: string;
  url: string;
}

function parseSocialLinks(raw: unknown): SocialLinkParsed[] {
  if (!raw) return [];

  // Handle array of objects with label/url
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          const rec = item as Record<string, unknown>;
          const url = asString(rec.url || rec.href || rec.link || "");
          const label = asString(rec.label || rec.platform || rec.name || rec.title || url);
          return url ? { label, url } : null;
        }
        if (typeof item === "string" && item.startsWith("http")) {
          return { label: extractDomain(item), url: item };
        }
        return null;
      })
      .filter(Boolean) as SocialLinkParsed[];
  }

  // Handle object map { platform: url }
  if (typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    return Object.entries(rec)
      .map(([key, val]) => {
        const url = asString(val);
        return url ? { label: key, url } : null;
      })
      .filter(Boolean) as SocialLinkParsed[];
  }

  return [];
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace("www.", "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Page definitions
// ---------------------------------------------------------------------------

interface PageDefinition {
  slug: string;
  label: string;
  generator: (bundle: MyProfileModuleBundle, preferences: SitePreferences) => string;
}

const PERSON_PAGES: PageDefinition[] = [
  { slug: "index.html", label: "Home", generator: generatePersonIndex },
  { slug: "about.html", label: "About", generator: generatePersonAbout },
  { slug: "roles.html", label: "Roles", generator: generatePersonRoles },
  { slug: "offerings.html", label: "Offerings", generator: generatePersonOfferings },
  { slug: "writing.html", label: "Writing", generator: generatePersonWriting },
  { slug: "events.html", label: "Events", generator: generatePersonEvents },
  { slug: "connections.html", label: "Connections", generator: generatePersonConnections },
  { slug: "contact.html", label: "Contact", generator: generatePersonContact },
];

const GROUP_PAGES: PageDefinition[] = [
  { slug: "index.html", label: "Home", generator: generateGroupIndex },
  { slug: "members.html", label: "Members", generator: generateGroupMembers },
  { slug: "events.html", label: "Events", generator: generatePersonEvents },
  { slug: "docs.html", label: "Docs", generator: generateGroupDocs },
  { slug: "offerings.html", label: "Offerings", generator: generatePersonOfferings },
  { slug: "contact.html", label: "Contact", generator: generatePersonContact },
];

// ---------------------------------------------------------------------------
// Default visible sections
// ---------------------------------------------------------------------------

const DEFAULT_VISIBLE_SECTIONS = [
  "hero",
  "about",
  "persona-insights",
  "posts",
  "events",
  "groups",
  "offerings",
  "connections",
];

// ---------------------------------------------------------------------------
// Main multi-page generator
// ---------------------------------------------------------------------------

/**
 * Generate a complete multi-page static website from manifest, bundle, and preferences.
 *
 * Returns a GeneratedSite with a Map of filepath to content (HTML/CSS) and a
 * list of page paths for reference.
 */
export function generateMultiPageSite(
  manifest: BespokeModuleManifest,
  bundle: MyProfileModuleBundle,
  preferences: SitePreferences,
): GeneratedSite {
  const tokens = resolveTokens(preferences);
  const instanceType = preferences.instanceType || bundle.federation?.localInstanceType || INSTANCE_TYPE_PERSON;
  const pages = instanceType === INSTANCE_TYPE_GROUP ? GROUP_PAGES : PERSON_PAGES;

  const name = asString(extractFieldValue(bundle, "profile.agent.name"));
  const siteTitle = preferences.siteTitle || name || "My Site";

  const navItems: NavItem[] = pages.map((p) => ({
    label: p.label,
    href: p.slug,
  }));

  const files = new Map<string, string>();
  const pagePaths: string[] = [];

  // Generate CSS
  files.set("style.css", generateCSS(tokens));

  // Generate each page
  for (const page of pages) {
    const body = page.generator(bundle, preferences);
    const nav = generateNav(navItems, page.slug, siteTitle);
    const footer = generateFooter(name);
    const pageTitle = page.slug === "index.html" ? siteTitle : `${page.label} - ${siteTitle}`;
    const html = wrapPage(pageTitle, nav, body, footer);
    files.set(page.slug, html);
    pagePaths.push(page.slug);
  }

  return { files, pages: pagePaths };
}

// ---------------------------------------------------------------------------
// Single-page generator (backwards compatibility for preview iframe)
// ---------------------------------------------------------------------------

/**
 * Generate a single combined HTML page for preview purposes.
 * This is the backwards-compatible function used by the existing generate API.
 */
export function generateSiteHtml(
  manifest: BespokeModuleManifest,
  bundle: MyProfileModuleBundle,
  preferences: SitePreferences,
): string {
  const tokens = resolveTokens(preferences);
  const name = asString(extractFieldValue(bundle, "profile.agent.name"));
  const siteTitle = preferences.siteTitle || name || "My Site";

  // For single-page preview, embed CSS inline and combine visible sections
  const site = generateMultiPageSite(manifest, bundle, preferences);
  const css = site.files.get("style.css") || "";

  // Get the requested page or default to index
  const requestedPage = (preferences as SitePreferences & { previewPage?: string }).previewPage || "index.html";
  const pageHtml = site.files.get(requestedPage) || site.files.get("index.html") || "";

  // For the preview, inline the CSS and return a single complete document
  // We need to extract the body content from the generated page and re-wrap with inline styles
  const bodyMatch = pageHtml.match(/<body>([\s\S]*?)<\/body>/);
  const bodyContent = bodyMatch ? bodyMatch[1] : pageHtml;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(siteTitle)}</title>
  <style>${css}</style>
</head>
<body>
  ${bodyContent}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

/**
 * Returns the list of available theme preset names.
 */
export function getAvailablePresets(): string[] {
  return Object.keys(THEME_PRESETS);
}

/**
 * Returns the default visible sections list.
 */
export function getDefaultVisibleSections(): string[] {
  return [...DEFAULT_VISIBLE_SECTIONS];
}

/**
 * Returns the page definitions for a given instance type.
 */
export function getPageDefinitions(instanceType: string): { slug: string; label: string }[] {
  const pages = instanceType === INSTANCE_TYPE_GROUP ? GROUP_PAGES : PERSON_PAGES;
  return pages.map((p) => ({ slug: p.slug, label: p.label }));
}
