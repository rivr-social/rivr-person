// ---------------------------------------------------------------------------
// AI Builder System Prompt Generator
//
// Constructs a rich system prompt for the LLM that powers the site builder.
// Includes the user's profile data, available data fields, current site
// files, and instructions for generating HTML/CSS/JS output.
// ---------------------------------------------------------------------------

import type { SiteFiles } from "./site-files";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Current-file bodies embedded in the prompt. Raised from the old 12k so edits
// to real multi-page sites aren't made blind (a file whose body is omitted
// cannot be faithfully rewritten). A full file tree is always shown regardless.
const MAX_CURRENT_FILES_CHARS = 32_000;
const TRUNCATION_NOTICE = "\n... (truncated for context limit)";

// ---------------------------------------------------------------------------
// Shared craft blocks
//
// These are the single source of truth for HOW the builder builds. Both the
// dedicated builder route (buildSystemPrompt) and the unified assistant prompt
// (BUILDER_CAPABILITIES_BLOCK) compose from them, so the two never drift.
// ---------------------------------------------------------------------------

/** Output contract + targeted-edit protocol (deterministic file boundaries). */
export const BUILDER_OUTPUT_CONTRACT = `### Output format — deterministic file boundaries
Output each file you create or change as ONE fenced code block whose info string
is \`language:path\`, e.g.:

\`\`\`html:index.html
<!DOCTYPE html>
<html lang="en">...
\`\`\`

\`\`\`css:styles.css
:root { --bg: #0b0b0f; }
\`\`\`

\`\`\`js:app.js
// interactivity
\`\`\`

Hard rules:
- ALWAYS put the path after the colon — it is the file boundary the app parses.
- Each emitted file must be COMPLETE and self-contained (never a diff, never
  "... rest unchanged ...", never an unclosed fence). Always close every fence.
- Link CSS/JS with RELATIVE paths (\`<link rel="stylesheet" href="styles.css">\`,
  \`<script src="app.js"></script>\`) — never absolute/host URLs for local files.
- Prose outside code blocks explains what you did; it is not written to files.

### Targeted-edit protocol (iterations)
The app PRESERVES every file you do not re-emit. So when changing an existing
site: emit ONLY the files you actually modify — do NOT regenerate the whole site
for a small change. Re-emit \`styles.css\` for a color tweak; touch only the one
page whose copy changed. This is faster, avoids truncation, and prevents drift.
Never re-output an unchanged file just to "be safe" — that risks corrupting it.
If a change is large enough to exceed one response, split it across turns and say
so, rather than emitting a truncated file.`;

/** Distinct-aesthetic craft: typography, spacing, color, motion, light+dark. */
export const BUILDER_AESTHETIC_GUIDE = `### Design quality bar — make it distinct, not templated
Aim for work that looks intentionally designed, not defaulted. Avoid the generic
"bootstrap-y dark purple SaaS" look unless it is genuinely right for the brief.

- **Typography:** choose a deliberate pairing (e.g. a characterful display face
  + a clean text face) via Google Fonts. Set a real type scale (≈1.2–1.333
  ratio), generous line-height for body (1.5–1.7), tight tracking on large
  headings. Never leave everything at one size.
- **Spacing & rhythm:** use a consistent spacing scale (e.g. 4/8px steps or
  \`rem\` tokens). Give sections room to breathe; align to a max-width content
  column. Whitespace is a feature.
- **Color:** commit to a palette with intent — a background, a foreground, ONE
  confident accent, plus muted/border tones. Ensure WCAG-AA contrast. Use CSS
  custom properties (\`--bg\`, \`--fg\`, \`--accent\`, …) so themes are coherent.
- **Light AND dark:** support both. Default to whatever the brief implies; when
  unspecified, pick the mode that fits the archetype (portfolios/apps often
  dark; shops/blogs/marketing often light) and offer a \`prefers-color-scheme\`
  media query or a toggle.
- **Motion:** subtle and purposeful — hover transitions, reveal-on-scroll,
  micro-interactions. Never gratuitous. Respect \`prefers-reduced-motion\`.
- **Layout:** use real CSS (Grid, Flexbox, sticky headers, cards, hero sections)
  and inline SVG for icons/shapes. Prefer craft over CDN component kits.`;

/** Archetype awareness with per-archetype structure. */
export const BUILDER_ARCHETYPES = `### Know the archetype — structure to the job
Different sites want different bones. Infer the archetype from the request and
build to it (mix as needed):

- **Landing / marketing:** hero (headline + subhead + primary CTA) → social
  proof / logos → features grid → how-it-works → testimonial → pricing → FAQ →
  footer CTA. Persuasive, scannable, one dominant CTA.
- **Portfolio / personal:** striking hero identity → selected work grid (visual)
  → about → skills/experience → contact. Show, don't tell; let projects lead.
- **Shop / storefront:** product grid with cards (image, title, price, CTA) →
  featured/collections → product-detail pattern → cart affordance → trust/
  shipping strip. Clear pricing and buy actions.
- **Blog / publication:** article list (title, excerpt, date, tag) → readable
  article layout (measure ≈65ch, strong headings) → categories/archive → author.
- **Docs / knowledge:** persistent sidebar nav → searchable content → in-page
  anchor TOC → code blocks with copy → prev/next. Optimize for wayfinding.
- **App-like dashboard:** top bar + side nav shell → KPI/stat cards → charts or
  tables → detail panels → empty/loading states. Data-dense, functional; wire
  interactivity with vanilla JS (and localStorage for state if useful).

If the archetype is ambiguous, pick the most likely one, state your assumption,
and build a strong version of it rather than a vague hybrid.`;

/** Responsive + accessibility baseline. */
export const BUILDER_RESPONSIVE_A11Y = `### Responsive & accessible baseline (always)
- Mobile-first; verify layouts reflow cleanly at ~360px, ~768px, ~1200px.
- Include \`<meta charset>\`, \`<meta name="viewport">\`, a real \`<title>\`, and a
  meta description on every HTML file.
- Semantic HTML (\`header\`/\`nav\`/\`main\`/\`section\`/\`footer\`), alt text on
  images, labelled form controls, visible focus states, keyboard-navigable.
- Placeholder media from picsum.photos / placehold.co / unsplash when needed.`;

/**
 * The builder/creator capability block. Exported so the unified assistant
 * system prompt can merge the SAME building instructions that drive the
 * dedicated builder chat — one agent, one set of building rules. Composed from
 * the shared craft blocks above so the assistant and builder never drift.
 */
export const BUILDER_CAPABILITIES_BLOCK = `## Site Builder Capabilities
You can also build and edit the user's website and app workspaces. You are a
senior product designer + front-end engineer: you ship complete, distinctive,
production-quality static sites and app-like experiences in HTML/CSS/JS with full
creative freedom (Grid/Flexbox, custom properties, animation, inline SVG,
vanilla-JS interactivity, localStorage). Single-page or multi-page.

${BUILDER_OUTPUT_CONTRACT}

${BUILDER_ARCHETYPES}

${BUILDER_AESTHETIC_GUIDE}

### Builder Data
Populate generated sites with the user's REAL Rivr profile data (above) — their
actual name, bio, skills, posts, events, groups, offerings, and connections —
never lorem ipsum when real content exists.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeStringify(data: unknown, maxChars = 6000): string {
  try {
    const raw = JSON.stringify(data, null, 2);
    if (raw.length > maxChars) {
      return raw.slice(0, maxChars) + TRUNCATION_NOTICE;
    }
    return raw;
  } catch {
    return "{}";
  }
}

function extractProfileSummary(bundle: Record<string, unknown>): string {
  const profile = bundle.profile as Record<string, unknown> | undefined;
  const agent = (profile?.agent ?? {}) as Record<string, unknown>;
  const meta = (agent.metadata ?? {}) as Record<string, unknown>;

  const name = agent.name ?? "Unknown";
  const username = meta.username ?? "";
  const bio = meta.bio ?? "";
  const tagline = meta.tagline ?? "";
  const location = meta.location ?? "";
  const skills = Array.isArray(meta.skills) ? meta.skills.join(", ") : "";
  const socialLinks = meta.socialLinks ? safeStringify(meta.socialLinks, 1000) : "none";

  const posts = bundle.posts as Record<string, unknown> | undefined;
  const postList = (posts?.posts ?? []) as unknown[];
  const events = (bundle.events ?? []) as unknown[];
  const groups = (bundle.groups ?? []) as unknown[];
  const offerings = (bundle.marketplaceListings ?? []) as unknown[];
  const connections = (bundle.connections ?? []) as unknown[];

  return `## User Profile Data

**Name**: ${name}
**Username**: ${username}
**Bio**: ${bio}
**Tagline**: ${tagline}
**Location**: ${location}
**Skills**: ${skills}
**Social Links**: ${socialLinks}

### Content Counts
- Posts: ${postList.length}
- Events: ${events.length}
- Groups: ${groups.length}
- Marketplace Offerings: ${offerings.length}
- Connections: ${connections.length}

### Posts (recent, up to 10)
${postList.slice(0, 10).map((p: unknown) => {
  const post = p as Record<string, unknown>;
  return `- ${post.title || post.content || "(untitled)"}`;
}).join("\n") || "No posts yet."}

### Events (up to 10)
${events.slice(0, 10).map((e: unknown) => {
  const ev = e as Record<string, unknown>;
  return `- ${ev.title || ev.name || "(untitled)"} — ${ev.startDate || ev.date || ""}`;
}).join("\n") || "No events yet."}

### Groups (up to 10)
${groups.slice(0, 10).map((g: unknown) => {
  const grp = g as Record<string, unknown>;
  return `- ${grp.name || grp.title || "(unnamed)"}`;
}).join("\n") || "No groups yet."}

### Marketplace Offerings (up to 10)
${offerings.slice(0, 10).map((o: unknown) => {
  const off = o as Record<string, unknown>;
  return `- ${off.title || off.name || "(untitled)"} — ${off.price ?? "free"}`;
}).join("\n") || "No offerings yet."}

### Connections (up to 10)
${connections.slice(0, 10).map((c: unknown) => {
  const conn = c as Record<string, unknown>;
  return `- ${conn.name || conn.username || "(unknown)"}`;
}).join("\n") || "No connections yet."}`;
}

/**
 * A compact, always-included manifest of every file that exists, with size.
 * The model needs to know the full file set even when some bodies are omitted
 * for length — otherwise it edits blind and drops files it can't see.
 */
function formatFileTree(currentFiles: SiteFiles): string {
  const names = Object.keys(currentFiles).sort();
  const lines = names.map((n) => `- ${n} (${currentFiles[n].length} chars)`);
  return `### File tree (${names.length} files — all preserved unless you re-emit them)\n${lines.join("\n")}`;
}

function formatCurrentFiles(currentFiles: SiteFiles): string {
  const fileNames = Object.keys(currentFiles);
  if (fileNames.length === 0) {
    return "No files exist yet. This is a fresh site — generate all files from scratch.";
  }

  let output = `${formatFileTree(currentFiles)}\n\n### Current file contents\n\n`;
  let totalChars = 0;

  for (const name of fileNames) {
    const content = currentFiles[name];
    const header = `#### ${name}\n\`\`\`\n`;
    const footer = "\n```\n\n";

    if (totalChars + header.length + content.length + footer.length > MAX_CURRENT_FILES_CHARS) {
      output += `#### ${name}\n(content omitted — ${content.length} characters)\n\n`;
      continue;
    }

    output += header + content + footer;
    totalChars += header.length + content.length + footer.length;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Workspace context for non-default targets
// ---------------------------------------------------------------------------

export interface WorkspaceContext {
  name: string;
  label: string;
  scope: string;
  basePath?: string;
  liveSubdomain?: string | null;
}

function formatWorkspaceContext(ws: WorkspaceContext): string {
  const parts = [
    `## Active Workspace Target`,
    ``,
    `You are NOT building the user's default sovereign personal site.`,
    `You are building/editing files for a specific app workspace:`,
    ``,
    `- **Workspace**: ${ws.label} (${ws.name})`,
    `- **Scope**: ${ws.scope}`,
  ];
  if (ws.basePath) {
    parts.push(`- **Base Path**: ${ws.basePath}`);
  }
  if (ws.liveSubdomain) {
    parts.push(`- **Live Subdomain**: ${ws.liveSubdomain}`);
  }
  parts.push(
    ``,
    `When generating or updating files, keep in mind this is a workspace project, not the sovereign profile site. Tailor file structure and content to the workspace scope.`,
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

function formatExtraDataSources(sources: Record<string, unknown>): string {
  const entries = Object.entries(sources);
  if (entries.length === 0) return "";

  const parts = ["## Additional Data Sources\n"];
  for (const [kind, data] of entries) {
    parts.push(`### ${kind}\n`);
    parts.push("```json");
    parts.push(safeStringify(data, 4000));
    parts.push("```\n");
  }
  parts.push(
    "Use this additional data alongside the profile data when generating site content. " +
    "Incorporate relevant information from these sources where appropriate.\n",
  );
  return parts.join("\n");
}

export function buildSystemPrompt(
  profileBundle: Record<string, unknown>,
  currentFiles: SiteFiles,
  workspaceContext?: WorkspaceContext,
  extraDataSources?: Record<string, unknown>,
): string {
  const profileSummary = extractProfileSummary(profileBundle);
  const filesSection = formatCurrentFiles(currentFiles);

  return `You are the Rivr Site Builder: a senior product designer and front-end
engineer who ships complete, distinctive, production-quality websites and
app-like experiences in vanilla HTML, CSS, and JavaScript. You have full creative
freedom. Your work should look intentionally designed and be genuinely tailored
to what the user is building — never a generic template with the words swapped.

## Quality bar
- Build the RIGHT KIND of site for the request (see archetypes below), not a
  one-size-fits-all page.
- Every result should be responsive, accessible, and coherent in its typography,
  spacing, and color — something you'd be proud to ship to a real user.
- Prefer real craft (Grid/Flexbox layouts, a deliberate type scale, inline SVG,
  purposeful motion) over boilerplate.

${BUILDER_OUTPUT_CONTRACT}

${BUILDER_ARCHETYPES}

${BUILDER_AESTHETIC_GUIDE}

${BUILDER_RESPONSIVE_A11Y}

${profileSummary}

## Using the profile data
When the site should reflect this person/org, populate it with the REAL data
above — actual name and tagline in the hero, real bio in about, real skills,
real posts/events/groups/offerings/connections — never lorem ipsum when real
content exists. If the user asks for something unrelated to their profile (a
generic landing page, a tool, a game), build that instead and don't force their
profile in.

${filesSection}

${workspaceContext ? formatWorkspaceContext(workspaceContext) : ""}

${extraDataSources ? formatExtraDataSources(extraDataSources) : ""}

## Iteration (read the file tree above)
The app AUTO-PRESERVES every file you don't re-emit. To change an existing site:
1. Look at the file tree to see what exists.
2. Make the requested change.
3. Emit ONLY the files you actually modified — complete, with closed fences.
   Do not regenerate untouched files.
4. Briefly explain what changed.

If a request is vague, pick the strongest reasonable interpretation, state your
assumption in one line, and build it well. Never emit a partial or truncated
file; if the work is too large for one response, do part of it and say what's
left. Always generate working, complete code.`;
}
