/**
 * `/personas/[id]/edit` — character-creator-style persona EDIT flow.
 *
 * Server Component:
 * - Gates access via `auth()` (redirects unauthenticated visitors to `/login`).
 * - Loads the persona row and verifies ownership through `getMyPersonaById`,
 *   which returns null for both missing and not-owned personas.
 * - Hands the loaded `SerializedAgent` to the shared `PersonaCreator` client
 *   component in **edit mode**. The same component powers `/personas/new` and
 *   the persona-active variant of `/settings`, so all three flows render the
 *   same full identity / appearance / skills / operating-mode surface.
 *
 * Persisted fields land in `agents.image` and `agents.metadata` via
 * `updatePersona` — no schema migration is required.
 */

import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import { getMyPersonaById } from "@/app/actions/personas";
import { PersonaCreator } from "@/components/persona-creator";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit Persona",
  description:
    "Edit a persona: identity, look, platform skills, and operating mode.",
};

interface EditPersonaPageProps {
  params: Promise<{ id: string }>;
}

export default async function EditPersonaPage({ params }: EditPersonaPageProps) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const { id } = await params;
  const persona = await getMyPersonaById(id);
  if (!persona) {
    // Either the persona doesn't exist or it isn't owned by this user. The
    // ownership branch is intentionally indistinguishable from "not found"
    // so we don't leak the existence of other accounts' personas.
    notFound();
  }

  return (
    <PersonaCreator
      existingPersona={persona}
      onSavedRedirectTo="/profile"
    />
  );
}
