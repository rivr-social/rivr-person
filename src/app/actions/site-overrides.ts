"use server";

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getCurrentUserId } from "@/app/actions/interactions/helpers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SiteOverridesResult {
  success: boolean;
  message?: string;
  overrides?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// saveSiteOverrides
//
// Merges the provided overrides into the user's agent metadata under the
// `siteOverrides` key. Existing keys not present in the input are preserved.
// ---------------------------------------------------------------------------

export async function saveSiteOverrides(
  overrides: Record<string, string>,
): Promise<SiteOverridesResult> {
  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to save site overrides." };
  }

  const [existing] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);

  const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>;
  const existingOverrides = (existingMeta.siteOverrides ?? {}) as Record<string, string>;

  const mergedOverrides = { ...existingOverrides, ...overrides };
  const updatedMetadata = { ...existingMeta, siteOverrides: mergedOverrides };

  await db.execute(sql`
    UPDATE agents
    SET metadata = ${JSON.stringify(updatedMetadata)}::jsonb
    WHERE id = ${userId}
  `);

  return { success: true, overrides: mergedOverrides };
}

// ---------------------------------------------------------------------------
// getSiteOverrides
//
// Returns the user's saved site overrides from agent metadata, or an empty
// object if none exist.
// ---------------------------------------------------------------------------

export async function getSiteOverrides(): Promise<SiteOverridesResult> {
  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to read site overrides." };
  }

  const [existing] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);

  const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>;
  const overrides = (existingMeta.siteOverrides ?? {}) as Record<string, string>;

  return { success: true, overrides };
}

// ---------------------------------------------------------------------------
// removeSiteOverride
//
// Removes a single override key from the user's saved siteOverrides in
// agent metadata.
// ---------------------------------------------------------------------------

export async function removeSiteOverride(key: string): Promise<SiteOverridesResult> {
  const userId = await getCurrentUserId();
  if (!userId) {
    return { success: false, message: "You must be logged in to remove site overrides." };
  }

  const [existing] = await db
    .select({ metadata: agents.metadata })
    .from(agents)
    .where(eq(agents.id, userId))
    .limit(1);

  const existingMeta = (existing?.metadata ?? {}) as Record<string, unknown>;
  const existingOverrides = { ...((existingMeta.siteOverrides ?? {}) as Record<string, string>) };

  delete existingOverrides[key];
  const updatedMetadata = { ...existingMeta, siteOverrides: existingOverrides };

  await db.execute(sql`
    UPDATE agents
    SET metadata = ${JSON.stringify(updatedMetadata)}::jsonb
    WHERE id = ${userId}
  `);

  return { success: true, overrides: existingOverrides };
}
