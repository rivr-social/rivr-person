/**
 * `/personas` — index redirect.
 *
 * This sovereign instance has no standalone personas list page. Personas are
 * managed from the profile "Personas" tab, where the `PersonaManager` component
 * is mounted (`/profile?tab=personas`) — the same canonical surface the
 * CommandBar "personas" command routes to. The persona creator's Back action
 * (`persona-creator.tsx`) pushes to `/personas`, so this route forwards to that
 * surface instead of 404ing.
 *
 * Server Component: gates on `auth()` (unauthenticated visitors go to `/login`),
 * otherwise redirects to the profile Personas tab.
 */

import { redirect } from "next/navigation";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Personas",
  description: "Manage your personas from the profile Personas tab.",
};

export default async function PersonasIndexPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  redirect("/profile?tab=personas");
}
