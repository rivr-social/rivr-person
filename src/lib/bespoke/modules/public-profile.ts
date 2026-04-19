import { fetchAgentByUsername, fetchPublicAgentById } from "@/app/actions/graph";
import type { BespokeModuleManifest } from "@/lib/bespoke/types";

export const PUBLIC_PROFILE_MODULE_ID = "rivr.public-profile";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function resolvePublicProfileAgent(usernameOrId: string) {
  const trimmed = usernameOrId.trim();
  if (!trimmed) return null;

  if (UUID_RE.test(trimmed)) {
    const agent = await fetchPublicAgentById(trimmed);
    return agent?.type === "person" ? agent : null;
  }

  return fetchAgentByUsername(trimmed);
}

export function getPublicProfileModuleManifest(username: string): BespokeModuleManifest {
  const encodedUsername = encodeURIComponent(username);

  return {
    moduleId: PUBLIC_PROFILE_MODULE_ID,
    version: "0.1.0",
    title: "Public Profile",
    auth: "public",
    dataEndpoint: `/api/profile/${encodedUsername}`,
    manifestEndpoint: `/api/profile/${encodedUsername}/manifest`,
    description:
      "Read-only profile harness for bespoke public profile interfaces. Exposes the target person's visible profile data, activity, and reusable public profile components.",
    fields: [
      { id: "name", label: "Name", type: "string", dataPath: "agent.name", editable: false },
      { id: "username", label: "Username", type: "string", dataPath: "subjectUsername", editable: false },
      { id: "bio", label: "Bio", type: "string", dataPath: "agent.metadata.bio", editable: false },
      { id: "location", label: "Location", type: "string", dataPath: "agent.metadata.location", editable: false },
      { id: "skills", label: "Skills", type: "string[]", dataPath: "agent.metadata.skills", editable: false },
      { id: "socialLinks", label: "Social Links", type: "json", dataPath: "agent.metadata.socialLinks", editable: false },
      { id: "profilePhotos", label: "Profile Photos", type: "image[]", dataPath: "agent.metadata.profilePhotos", editable: false },
      { id: "geneKeys", label: "Gene Keys", type: "string", dataPath: "agent.metadata.geneKeys", editable: false, hideable: true },
      { id: "humanDesign", label: "Human Design", type: "string", dataPath: "agent.metadata.humanDesign", editable: false, hideable: true },
      { id: "westernAstrology", label: "Western Astrology", type: "string", dataPath: "agent.metadata.westernAstrology", editable: false, hideable: true },
      { id: "vedicAstrology", label: "Vedic Astrology", type: "string", dataPath: "agent.metadata.vedicAstrology", editable: false, hideable: true },
      { id: "ocean", label: "OCEAN", type: "string", dataPath: "agent.metadata.ocean", editable: false, hideable: true },
      { id: "myersBriggs", label: "Myers-Briggs", type: "string", dataPath: "agent.metadata.myersBriggs", editable: false, hideable: true },
      { id: "enneagram", label: "Enneagram", type: "string", dataPath: "agent.metadata.enneagram", editable: false, hideable: true },
    ],
    mutations: [],
    components: [
      { id: "profile-header-card", label: "Profile Header Card", importPath: "@/components/ui/card", exportName: "Card" },
      { id: "post-feed", label: "Post Feed", importPath: "@/components/post-feed", exportName: "PostFeed" },
      { id: "event-feed", label: "Event Feed", importPath: "@/components/event-feed", exportName: "EventFeed" },
      { id: "profile-group-feed", label: "Profile Group Feed", importPath: "@/components/profile-group-feed", exportName: "ProfileGroupFeed" },
      { id: "agent-graph", label: "Agent Graph", importPath: "@/components/agent-graph", exportName: "AgentGraph" },
      { id: "thank-module", label: "Thank Module", importPath: "@/components/thank-module", exportName: "ThankModule" },
    ],
    sections: [
      { id: "hero", label: "Hero", dataPath: "agent", defaultComponentId: "profile-header-card", themeable: true },
      { id: "about", label: "About", dataPath: "agent", defaultComponentId: "profile-header-card", hideable: true, themeable: true },
      { id: "persona-insights", label: "Persona Insights", dataPath: "agent.metadata", defaultComponentId: "profile-header-card", hideable: true, themeable: true },
      { id: "posts", label: "Posts", dataPath: "posts.posts", defaultComponentId: "post-feed", hideable: true, themeable: true },
      { id: "docs", label: "Documents", dataPath: "documents", defaultComponentId: "profile-header-card", hideable: true, themeable: true },
      { id: "media", label: "Media", dataPath: "profile.resources", defaultComponentId: "profile-header-card", hideable: true, themeable: true },
      { id: "events", label: "Events", dataPath: "events", defaultComponentId: "event-feed", hideable: true, themeable: true },
      { id: "groups", label: "Groups", dataPath: "groups", defaultComponentId: "profile-group-feed", hideable: true, themeable: true },
      { id: "photos", label: "Photos", dataPath: "profile.resources", defaultComponentId: "profile-header-card", hideable: true, themeable: true },
      { id: "offerings", label: "Offerings", dataPath: "profile.resources", defaultComponentId: "profile-header-card", hideable: true, themeable: true },
      { id: "activity", label: "Activity", dataPath: "profile.recentActivity", defaultComponentId: "profile-header-card", hideable: true, themeable: true },
      { id: "connections", label: "Connections", dataPath: "subjectId", defaultComponentId: "agent-graph", hideable: true, themeable: true },
    ],
    theme: {
      mode: "tokens",
      editableTokens: [
        "color.background",
        "color.foreground",
        "color.primary",
        "color.accent",
        "color.border",
        "radius.card",
        "shadow.card",
      ],
      presets: ["default", "red-gold", "forest-brass", "earth-clay"],
    },
  };
}
