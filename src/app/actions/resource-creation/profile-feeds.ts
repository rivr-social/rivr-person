"use server";

import { db } from "@/db";
import { agents, ledger, resources } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { getOperatingAgentId } from "@/lib/persona";
import { serializeResource } from "@/lib/graph-serializers";
import type { Resource } from "@/db/schema";

/** Shape returned for each comment the user has made on other posts. */
export interface MyCommentEntry {
  id: string;
  content: string;
  timestamp: string;
  /** The resource (post) the comment was placed on. */
  post: {
    id: string;
    name: string;
    excerpt: string;
  };
  /** Author of the original post. */
  postAuthor: {
    id: string;
    name: string;
    image: string | null;
  };
}

/** Shape returned for each post that mentions/tags the current user. */
export interface MentionPostSerialized {
  id: string;
  name: string;
  type: string;
  description: string | null;
  content: string | null;
  ownerId: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  ownerName: string | null;
  ownerImage: string | null;
}

const MAX_RESULTS = 50;

/**
 * Fetch all comments the current user has posted on other people's posts.
 * Joins ledger (verb=comment, subjectId=me) with the resource being commented on.
 */
export async function fetchMyCommentsAction(): Promise<
  { success: true; comments: MyCommentEntry[] } | { success: false; error: string }
> {
  const userId = await getOperatingAgentId();
  if (!userId) {
    return { success: false, error: "You must be logged in." };
  }

  try {
    const rows = await db
      .select({
        id: ledger.id,
        metadata: ledger.metadata,
        timestamp: ledger.timestamp,
        resourceId: ledger.resourceId,
        resourceName: resources.name,
        resourceContent: resources.content,
        resourceDescription: resources.description,
        postOwnerId: resources.ownerId,
        postOwnerName: agents.name,
        postOwnerImage: agents.image,
      })
      .from(ledger)
      .innerJoin(resources, eq(resources.id, ledger.resourceId))
      .innerJoin(agents, eq(agents.id, resources.ownerId))
      .where(
        and(
          eq(ledger.verb, "comment"),
          eq(ledger.subjectId, userId),
          eq(ledger.isActive, true),
        ),
      )
      .orderBy(desc(ledger.timestamp))
      .limit(MAX_RESULTS);

    const comments: MyCommentEntry[] = rows.map((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const rawContent = row.resourceContent ?? row.resourceDescription ?? "";
      const excerpt = rawContent.length > 120 ? `${rawContent.slice(0, 120)}...` : rawContent;

      return {
        id: row.id,
        content: (meta.content as string) ?? "",
        timestamp: row.timestamp.toISOString(),
        post: {
          id: row.resourceId ?? "",
          name: row.resourceName ?? "Untitled Post",
          excerpt,
        },
        postAuthor: {
          id: row.postOwnerId,
          name: row.postOwnerName ?? "Unknown",
          image: row.postOwnerImage,
        },
      };
    });

    return { success: true, comments };
  } catch (error) {
    console.error("[fetchMyCommentsAction] failed:", error);
    return { success: false, error: "Unable to load comments." };
  }
}

/**
 * Fetch posts where the current user is mentioned/tagged.
 * Searches the `resources.tags` array for the user's username or ID.
 */
export async function fetchMyMentionsAction(): Promise<
  { success: true; mentions: MentionPostSerialized[] } | { success: false; error: string }
> {
  const userId = await getOperatingAgentId();
  if (!userId) {
    return { success: false, error: "You must be logged in." };
  }

  try {
    // Look up the user's username for tag matching
    const [userAgent] = await db
      .select({ name: agents.name, metadata: agents.metadata })
      .from(agents)
      .where(eq(agents.id, userId))
      .limit(1);

    const agentMeta = (userAgent?.metadata ?? {}) as Record<string, unknown>;
    const username = (agentMeta.username as string) ?? "";

    // Build tag match candidates: userId and username (if set)
    const tagCandidates = [userId];
    if (username && username.length > 0) {
      tagCandidates.push(username);
    }

    // Query resources whose tags array overlaps with the user's identifiers
    // Uses PostgreSQL array overlap operator (&&)
    const rows = await db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
        description: resources.description,
        content: resources.content,
        ownerId: resources.ownerId,
        tags: resources.tags,
        metadata: resources.metadata,
        createdAt: resources.createdAt,
        updatedAt: resources.updatedAt,
        ownerName: agents.name,
        ownerImage: agents.image,
      })
      .from(resources)
      .innerJoin(agents, eq(agents.id, resources.ownerId))
      .where(
        and(
          sql`${resources.tags} && ${tagCandidates}::text[]`,
          eq(resources.type, "post"),
          sql`${resources.deletedAt} IS NULL`,
        ),
      )
      .orderBy(desc(resources.createdAt))
      .limit(MAX_RESULTS);

    const mentions: MentionPostSerialized[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.description,
      content: row.content,
      ownerId: row.ownerId,
      tags: row.tags ?? [],
      metadata: (row.metadata ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ownerName: row.ownerName,
      ownerImage: row.ownerImage,
    }));

    return { success: true, mentions };
  } catch (error) {
    console.error("[fetchMyMentionsAction] failed:", error);
    return { success: false, error: "Unable to load mentions." };
  }
}
