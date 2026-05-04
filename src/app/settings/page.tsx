/**
 * Settings page for `/settings`.
 *
 * Purpose:
 * - Loads the active actor's profile data (name, username, email, bio, phone,
 *   image) and renders a client-side `SettingsForm` for editing.
 * - When a persona is active (selected via the persona switcher), the page
 *   pre-fills the form with the persona's `agents` row instead of the
 *   controller's. Subscription tier, wallet, and email auth still belong to
 *   the controller — see `resolveActiveActorAgentId` in `@/lib/persona`.
 *
 * Rendering: Server Component (no `"use client"` directive).
 * Data requirements:
 * - Authenticated session via `auth()`.
 * - Active actor agent row from the database (`agents` table) queried by the
 *   resolved actor id (controller or persona).
 *
 * Auth: Redirects to `/auth/login` if no session or no matching agent exists.
 * Metadata: No `metadata` export; metadata is inherited from the layout.
 *
 * @module settings/page
 */
import { redirect } from "next/navigation";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { SettingsForm, type SettingsInitialData } from "./settings-form";
import { buildFederationIdentityStatus, type FederationIdentityStatus } from "@/lib/federation-identities";
import { buildPersonInstanceSetupState, type PersonInstanceSetupState } from "@/lib/person-instance-setup";
import { buildAppReleaseStatus, type AppReleaseStatus } from "@/lib/app-release";
import { resolveActiveActorAgentId } from "@/lib/persona";
import { PersonaCreator } from "@/components/persona-creator";
import { serializeAgent } from "@/lib/graph-serializers";

/**
 * Generates a URL-safe fallback username from the user's display name.
 * @param name - The user's display name.
 * @returns A lowercased, hyphenated string, or "user" if the name is empty.
 */
function fallbackUsername(name: string): string {
  const base = name.trim().toLowerCase().replace(/\s+/g, "-");
  return base || "user";
}

/**
 * Server-rendered settings page that fetches user data and delegates to the
 * appropriate editor.
 *
 * Branching:
 * - **Controller active** → renders the existing controller `SettingsForm`
 *   unchanged.
 * - **Persona active** → renders the shared `PersonaCreator` in edit mode,
 *   so `/settings` looks like the full persona surface (identity →
 *   appearance with 3D viewer → skills → operating mode → review). This is
 *   intentional: when a persona is the active actor, the whole app behaves
 *   as if that persona is the user, including the settings surface.
 *
 * @returns The matching editor component hydrated with the actor's data.
 */
export default async function SettingsPage() {
  // Auth check: redirect unauthenticated visitors to login.
  // Persona switcher cookies upgrade the active actor to a persona row when
  // the cookie value is owned by the authenticated controller.
  const activeActor = await resolveActiveActorAgentId();

  if (!activeActor) {
    redirect("/auth/login");
  }

  const { actorId, controllerId, isPersona } = activeActor;

  // When a persona is active, settings becomes the persona-edit surface.
  // We fetch the full agent row and hand it to `PersonaCreator` (edit mode),
  // which mirrors `/personas/[id]/edit`.
  if (isPersona) {
    const [personaRow] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, actorId), isNull(agents.deletedAt)))
      .limit(1);

    if (!personaRow) {
      // Stale persona cookie that survived the resolver — fall through to
      // login to force a clean reauth/cookie state.
      redirect("/auth/login");
    }

    const serialized = serializeAgent(personaRow);
    return (
      <PersonaCreator
        existingPersona={serialized}
        onSavedRedirectTo="/settings"
      />
    );
  }

  // Fetch the active actor's agent row from the database. When a persona is
  // active this is the persona row; otherwise it is the controller row.
  const [currentUser] = await db
    .select({
      id: agents.id,
      name: agents.name,
      email: agents.email,
      image: agents.image,
      description: agents.description,
      metadata: agents.metadata,
    })
    .from(agents)
    .where(eq(agents.id, actorId))
    .limit(1);

  // If the agent row is missing (orphaned session or stale persona cookie),
  // redirect to login. Stale persona cookies are cleared inside the resolver,
  // but a missing controller row is the only remaining failure mode.
  if (!currentUser) {
    redirect("/auth/login");
  }

  // Personas share the controller's email (auth identity); fetch it separately
  // so we can show it as a read-only field instead of the persona's empty
  // email column.
  let controllerEmail: string | null = null;
  if (isPersona) {
    const [controllerRow] = await db
      .select({ email: agents.email })
      .from(agents)
      .where(eq(agents.id, controllerId))
      .limit(1);
    controllerEmail = controllerRow?.email ?? null;
  }

  // Safely extract metadata as a record for field lookups.
  const metadata =
    currentUser.metadata && typeof currentUser.metadata === "object"
      ? (currentUser.metadata as Record<string, unknown>)
      : {};

  // Assemble initial form data with fallbacks for missing fields.
  // Email is the controller's auth identity. When operating as a persona we
  // surface the controller's email read-only so users can see which account
  // they're authenticated as, but the persona row's own email column is left
  // alone (personas cannot change auth identity).
  const initialData: SettingsInitialData = {
    name: currentUser.name,
    username:
      typeof metadata.username === "string" && metadata.username
        ? metadata.username
        : fallbackUsername(currentUser.name),
    email: isPersona ? controllerEmail ?? "" : currentUser.email ?? "",
    bio:
      currentUser.description ??
      (typeof metadata.bio === "string" ? metadata.bio : ""),
    tagline: typeof metadata.tagline === "string" ? metadata.tagline : "",
    phone: typeof metadata.phone === "string" ? metadata.phone : "",
    image: currentUser.image ?? "",
    skills: Array.isArray(metadata.skills) ? (metadata.skills as string[]) : [],
    geneKeys: typeof metadata.geneKeys === "string" ? metadata.geneKeys : "",
    humanDesign: typeof metadata.humanDesign === "string" ? metadata.humanDesign : "",
    westernAstrology: typeof metadata.westernAstrology === "string" ? metadata.westernAstrology : "",
    vedicAstrology: typeof metadata.vedicAstrology === "string" ? metadata.vedicAstrology : "",
    ocean: typeof metadata.ocean === "string" ? metadata.ocean : "",
    myersBriggs: typeof metadata.myersBriggs === "string" ? metadata.myersBriggs : "",
    enneagram: typeof metadata.enneagram === "string" ? metadata.enneagram : "",
    homeLocale: typeof metadata.homeLocale === "string" ? metadata.homeLocale : "",
    murmurationsPublishing: metadata.murmurationsPublishing === true,
    socialLinks: typeof metadata.socialLinks === 'object' && metadata.socialLinks !== null && !Array.isArray(metadata.socialLinks)
      ? metadata.socialLinks as Record<string, string>
      : Array.isArray(metadata.socialLinks)
        ? Object.fromEntries((metadata.socialLinks as {platform: string; url: string}[]).map(l => [l.platform, l.url]))
        : {},
    profilePhotos: Array.isArray(metadata.profilePhotos)
      ? metadata.profilePhotos.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [],
    privacySettings: metadata.privacySettings && typeof metadata.privacySettings === "object" && !Array.isArray(metadata.privacySettings)
      ? metadata.privacySettings as SettingsInitialData["privacySettings"]
      : {},
    notificationSettings: metadata.notificationSettings && typeof metadata.notificationSettings === "object" && !Array.isArray(metadata.notificationSettings)
      ? metadata.notificationSettings as SettingsInitialData["notificationSettings"]
      : { pushNotifications: false, emailNotifications: true, eventReminders: true, newMessages: true },
  };

  let initialFederationStatus: FederationIdentityStatus | null = null;
  try {
    initialFederationStatus = await buildFederationIdentityStatus(currentUser.id);
  } catch {
    initialFederationStatus = null;
  }

  let initialAppReleaseStatus: AppReleaseStatus | null = null;
  try {
    initialAppReleaseStatus = await buildAppReleaseStatus({
      appName: "rivr-person",
      defaultVersion: "0.1.0",
      defaultUpstreamRepo: "rivr-social/rivr-monorepo",
    });
  } catch {
    initialAppReleaseStatus = null;
  }

  const initialPersonInstanceSetup: PersonInstanceSetupState = buildPersonInstanceSetupState({
    metadata,
    fallbackName: currentUser.name,
    fallbackUsername: initialData.username,
    agentId: currentUser.id,
  });

  return (
    <SettingsForm
      initialData={initialData}
      initialFederationStatus={initialFederationStatus}
      initialPersonInstanceSetup={initialPersonInstanceSetup}
      initialAppReleaseStatus={initialAppReleaseStatus}
      activePersona={{
        isPersona,
        actorId,
        controllerId,
        personaName: isPersona ? currentUser.name : undefined,
      }}
    />
  );
}
