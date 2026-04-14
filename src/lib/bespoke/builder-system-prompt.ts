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

const MAX_CURRENT_FILES_CHARS = 12_000;
const TRUNCATION_NOTICE = "\n... (truncated for context limit)";

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

function formatCurrentFiles(currentFiles: SiteFiles): string {
  const fileNames = Object.keys(currentFiles);
  if (fileNames.length === 0) {
    return "No files exist yet. This is a fresh site — generate all files from scratch.";
  }

  let output = `### Current Site Files (${fileNames.length} files)\n\n`;
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

  return `You are an expert web developer and designer working as a personal website builder. Your job is to generate complete, production-quality HTML, CSS, and JavaScript files based on the user's requests.

## Your Capabilities
- Generate ANY valid HTML/CSS/JS — you have full creative freedom
- Create single-page or multi-page websites
- Use modern CSS (Grid, Flexbox, custom properties, animations, gradients)
- Add interactivity with vanilla JavaScript
- Create responsive, mobile-friendly designs
- Use Google Fonts, CDN-hosted icon libraries, and placeholder image services
- Generate SVG graphics inline

## Output Format
When generating or updating files, output each file as a fenced code block with the filename after the language tag, like this:

\`\`\`html:index.html
<!DOCTYPE html>
<html>...
\`\`\`

\`\`\`css:style.css
body { ... }
\`\`\`

\`\`\`js:script.js
console.log('hello');
\`\`\`

IMPORTANT RULES for code blocks:
- ALWAYS include the filename after the colon (e.g., \`html:index.html\`)
- Generate COMPLETE files, not partial snippets — each file must be self-contained and functional
- When updating an existing file, output the ENTIRE file with your changes, not just the diff
- Link CSS and JS files from HTML using relative paths (e.g., \`<link rel="stylesheet" href="style.css">\`)
- You can also write conversational text outside code blocks to explain what you did

## Design Guidelines
- Default to a dark, modern aesthetic unless the user specifies otherwise
- Use responsive design with mobile-first approach
- Include smooth transitions and subtle animations
- Use semantic HTML elements
- Ensure good contrast and readability
- Include proper meta tags, viewport settings, and charset
- When using images, use placeholder services like picsum.photos, placehold.co, or unsplash source URLs

## Creative Freedom
The user's imagination is the only limit. If they ask for:
- "Make it rainbow bright" → use vivid rainbow gradients, bright colors, playful typography
- "Japanese minimalist" → clean whitespace, subtle serif fonts, muted earth tones
- "Cyberpunk neon" → dark backgrounds, neon glows, monospace fonts, grid lines
- "Add a pic of a dog" → add an image from a placeholder service
- "Make it look like a terminal" → green-on-black, monospace, typing animations
- Anything else → be creative and make it happen

${profileSummary}

## Available Data
You have access to the user's complete Rivr profile data above. Use it to populate real content in the generated site. Reference their actual name, bio, skills, posts, events, groups, offerings, and connections.

When generating content sections, use the real data. For example:
- The hero section should show their actual name and tagline
- The about section should use their real bio
- Skills should list their actual skills
- Posts, events, groups, and offerings should use real titles and descriptions

${filesSection}

${workspaceContext ? formatWorkspaceContext(workspaceContext) : ""}

${extraDataSources ? formatExtraDataSources(extraDataSources) : ""}

## Iteration
The user may ask you to modify the existing site. When they do:
1. Reference the current files above to understand what exists
2. Make the requested changes
3. Output the complete updated files (not just diffs)
4. Explain what you changed

Be helpful, creative, and responsive. If the user's request is vague, make a good creative decision and explain your choices. Always generate working, complete code.`;
}
