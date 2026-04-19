import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, desc } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { assertAgentHqAccess } from "@/lib/agent-hq";

export const dynamic = "force-dynamic";

/**
 * Folder display names keyed by resource_type enum value.
 * Media types (image, video, audio) are grouped into a single "Media" folder.
 */
const RESOURCE_TYPE_FOLDER_LABELS: Record<string, string> = {
  document: "Documents",
  project: "Projects",
  post: "Posts",
  listing: "Listings",
  event: "Events",
  job: "Jobs",
  task: "Tasks",
  note: "Notes",
  dataset: "Datasets",
  image: "Media",
  video: "Media",
  audio: "Media",
  file: "Files",
  link: "Links",
  skill: "Skills",
  shift: "Shifts",
  training: "Training",
  place: "Places",
  venue: "Venues",
  booking: "Bookings",
  asset: "Assets",
  voucher: "Vouchers",
  currency: "Currency",
  thanks_token: "Thanks Tokens",
  proposal: "Proposals",
  badge: "Badges",
  resource: "Resources",
  receipt: "Receipts",
  group: "Groups",
  permission_policy: "Permission Policies",
};

/** Canonical folder sort order — unlisted types sort to the end. */
const FOLDER_SORT_ORDER: string[] = [
  "Documents",
  "Notes",
  "Projects",
  "Posts",
  "Listings",
  "Events",
  "Jobs",
  "Tasks",
  "Media",
  "Files",
  "Links",
  "Datasets",
  "Skills",
  "Shifts",
  "Training",
  "Places",
  "Venues",
  "Bookings",
  "Assets",
  "Vouchers",
  "Currency",
  "Thanks Tokens",
  "Proposals",
  "Badges",
  "Resources",
  "Receipts",
  "Groups",
  "Permission Policies",
];

type Scope = "self" | "persona" | "group";

const VALID_SCOPES = new Set<Scope>(["self", "persona", "group"]);

interface TreeFile {
  id: string;
  name: string;
  type: "file";
  resourceType: string;
  description: string | null;
  createdAt: string;
}

interface TreeFolder {
  id: string;
  name: string;
  type: "folder";
  resourceType: string;
  children: TreeFile[];
}

/**
 * GET /api/agent-hq/resources
 *
 * Returns user-owned resources organized as a file-explorer tree
 * grouped by resource type.
 *
 * Query params:
 *   agentId  — UUID of the agent whose resources to fetch (required for persona/group scope)
 *   scope    — "self" | "persona" | "group" (default: "self")
 */
export async function GET(request: NextRequest) {
  try {
    await assertAgentHqAccess();
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const scopeParam = (searchParams.get("scope") ?? "self") as Scope;
    const agentIdParam = searchParams.get("agentId");

    if (!VALID_SCOPES.has(scopeParam)) {
      return NextResponse.json(
        { error: `Invalid scope: ${scopeParam}. Must be one of: ${[...VALID_SCOPES].join(", ")}` },
        { status: 400 },
      );
    }

    // Resolve the target owner agent id
    let ownerId: string;
    if (scopeParam === "self") {
      // Use PRIMARY_AGENT_ID env var, falling back to authenticated user id
      ownerId = process.env.PRIMARY_AGENT_ID ?? userId;
    } else {
      // persona or group scope requires an explicit agentId
      if (!agentIdParam) {
        return NextResponse.json(
          { error: "agentId query parameter is required for persona and group scopes" },
          { status: 400 },
        );
      }
      ownerId = agentIdParam;
    }

    // Fetch resources owned by the target agent, excluding soft-deleted rows
    const rows = await db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
        description: resources.description,
        createdAt: resources.createdAt,
      })
      .from(resources)
      .where(and(eq(resources.ownerId, ownerId), isNull(resources.deletedAt)))
      .orderBy(desc(resources.createdAt));

    // Group rows into folders by display label
    const folderMap = new Map<string, { resourceType: string; children: TreeFile[] }>();

    for (const row of rows) {
      const label = RESOURCE_TYPE_FOLDER_LABELS[row.type] ?? capitalize(row.type);
      // For merged folders (e.g. Media), use the label-derived key; for single-type
      // folders use the raw resource type so the folder carries a meaningful resourceType.
      const folderResourceType = label === "Media" ? "media" : row.type;

      if (!folderMap.has(label)) {
        folderMap.set(label, { resourceType: folderResourceType, children: [] });
      }

      folderMap.get(label)!.children.push({
        id: row.id,
        name: row.name,
        type: "file",
        resourceType: row.type,
        description: row.description,
        createdAt: row.createdAt.toISOString(),
      });
    }

    // Build sorted tree — only include non-empty folders
    const tree: TreeFolder[] = [];

    for (const label of FOLDER_SORT_ORDER) {
      const entry = folderMap.get(label);
      if (entry && entry.children.length > 0) {
        tree.push({
          id: `folder-${entry.resourceType}`,
          name: label,
          type: "folder",
          resourceType: entry.resourceType,
          children: entry.children,
        });
        folderMap.delete(label);
      }
    }

    // Append any remaining folders not in the canonical sort order
    for (const [label, entry] of folderMap) {
      if (entry.children.length > 0) {
        tree.push({
          id: `folder-${entry.resourceType}`,
          name: label,
          type: "folder",
          resourceType: entry.resourceType,
          children: entry.children,
        });
      }
    }

    return NextResponse.json({ tree });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list resources";
    const status = message === "Authentication required" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
