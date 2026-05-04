/**
 * `/personas/new` — character-creator-style persona creation flow.
 *
 * Server Component:
 * - Gates access via `auth()` (redirects unauthenticated visitors to `/login`).
 * - Defers all interactive UX to the client `PersonaCreator` component, which
 *   walks the controller through identity, appearance, skills, operating mode,
 *   and a final review step before invoking the `createPersona` server action.
 *
 * Persisted fields land in `agents.image` and `agents.metadata` — no schema
 * migration is required.
 */

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { PersonaCreator } from "@/components/persona-creator";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "New Persona",
  description:
    "Create a new persona with identity, look, platform skills, and operating mode.",
};

export default async function NewPersonaPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  return <PersonaCreator />;
}
