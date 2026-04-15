import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agentTypeEnum, agents, builderDataSources, ledger, resourceTypeEnum, resources, verbTypeEnum } from "@/db/schema";
import { discoverAgentProjects } from "@/lib/agent-hq";
import {
  agentFolderExists,
  agentSoulExists,
  ensureAgentDocsFolder,
  listAgentFolder,
  listAgentFolderIds,
  readAgentFile,
  writeAgentFile,
} from "@/lib/agent-docs";

export interface AgentHqDbEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
}

interface AgentHqDbViewerContext {
  userId: string;
  personaIds: string[];
  allOwnerIds: string[];
}

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid JSON payload.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

async function getViewerContext(): Promise<AgentHqDbViewerContext> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    throw new Error("Authentication required");
  }

  const personaRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.parentAgentId, userId),
        isNull(agents.deletedAt),
      ),
    );
  const personaIds = personaRows.map((row) => row.id);
  return { userId, personaIds, allOwnerIds: [userId, ...personaIds] };
}

function splitPath(relativePath: string) {
  const safeRelative = relativePath.replace(/^\/+/, "").trim();
  const segments = safeRelative.length > 0 ? safeRelative.split("/") : [];
  return { safeRelative, segments };
}

export async function listDbEntries(relativePath = ""): Promise<{
  relativePath: string;
  entries: AgentHqDbEntry[];
}> {
  const ctx = await getViewerContext();
  const { safeRelative, segments } = splitPath(relativePath);

  if (segments.length === 0) {
    return {
      relativePath: safeRelative,
      entries: [
        { name: "agent-docs", path: "agent-docs", type: "directory", size: 0 },
        { name: "agents", path: "agents", type: "directory", size: 0 },
        { name: "resources", path: "resources", type: "directory", size: 0 },
        { name: "ledger", path: "ledger", type: "directory", size: 0 },
        { name: "apps", path: "apps", type: "directory", size: 0 },
        { name: "builder-data-sources", path: "builder-data-sources", type: "directory", size: 0 },
      ],
    };
  }

  const [root, type, id] = segments;

  if (root === "agent-docs") {
    // Virtual filesystem root mapping to /workspace/agents/ on disk.
    // Structure: agent-docs/ → list agent folders (enriched with DB names)
    //            agent-docs/{id}/ → soul.md + docs/
    //            agent-docs/{id}/docs/ → files inside docs subfolder
    if (!type) {
      // List all agent folders — combine DB agents with on-disk folders
      const dbRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(inArray(agents.id, ctx.allOwnerIds), isNull(agents.deletedAt)));
      const dbMap = new Map(dbRows.map((row) => [row.id, row.name || row.id]));

      // Also include any on-disk folders that might not be in DB (edge case)
      const diskIds = await listAgentFolderIds();
      const allIds = new Set([...dbMap.keys(), ...diskIds]);

      const entries: AgentHqDbEntry[] = [];
      for (const agentId of allIds) {
        // Only show agents the user owns
        if (!ctx.allOwnerIds.includes(agentId)) continue;
        const label = dbMap.get(agentId) ?? agentId;
        const hasFolder = agentFolderExists(agentId);
        entries.push({
          name: hasFolder ? `${label} (${agentId})` : `${label} (${agentId}) [no folder]`,
          path: `agent-docs/${agentId}`,
          type: "directory",
          size: 0,
        });
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return { relativePath: safeRelative, entries };
    }

    // type = agentId at this level
    const agentId = type;
    if (!ctx.allOwnerIds.includes(agentId)) throw new Error("Agent not found.");
    await ensureAgentDocsFolder(agentId);

    if (!id) {
      // List contents of agent's root folder: soul.md + docs/
      const hasSoul = agentSoulExists(agentId);
      const entries: AgentHqDbEntry[] = [];
      if (hasSoul) {
        entries.push({ name: "soul.md", path: `agent-docs/${agentId}/soul.md`, type: "file", size: 0 });
      }
      entries.push({ name: "docs", path: `agent-docs/${agentId}/docs`, type: "directory", size: 0 });
      return { relativePath: safeRelative, entries };
    }

    if (id === "docs") {
      // List files inside the agent's docs/ subfolder
      const subPath = segments.slice(3).join("/");
      const docsSubPath = subPath ? `docs/${subPath}` : "docs";
      const diskEntries = await listAgentFolder(agentId, docsSubPath);
      const basePath = `agent-docs/${agentId}/${docsSubPath}`;
      return {
        relativePath: safeRelative,
        entries: diskEntries.map((entry) => ({
          name: entry.name,
          path: `${basePath}/${entry.name}`,
          type: entry.type,
          size: entry.size,
        })),
      };
    }

    // Unrecognized sub-path under agent-docs/{id}/
    throw new Error("Unsupported agent-docs path.");
  }

  if (root === "agents") {
    if (!type) {
      const rows = await db
        .select({ type: agents.type })
        .from(agents)
        .where(and(inArray(agents.id, ctx.allOwnerIds), isNull(agents.deletedAt)));
      const presentTypes = new Set(rows.map((row) => row.type));
      return {
        relativePath: safeRelative,
        entries: agentTypeEnum.enumValues
          .filter((agentType) => presentTypes.has(agentType))
          .sort((a, b) => a.localeCompare(b))
          .map((agentType) => ({
            name: agentType,
            path: `agents/${agentType}`,
            type: "directory" as const,
            size: 0,
          })),
      };
    }
    if (!id) {
      const rows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(inArray(agents.id, ctx.allOwnerIds), eq(agents.type, type as typeof agentTypeEnum.enumValues[number]), isNull(agents.deletedAt)));
      return {
        relativePath: safeRelative,
        entries: rows
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
          .map((row) => ({
            name: row.name || row.id,
            path: `agents/${type}/${row.id}`,
            type: "directory" as const,
            size: 0,
          })),
      };
    }
    return {
      relativePath: safeRelative,
      entries: [
        { name: "record.json", path: `agents/${type}/${id}/record.json`, type: "file", size: 0 },
        { name: "metadata.json", path: `agents/${type}/${id}/metadata.json`, type: "file", size: 0 },
      ],
    };
  }

  if (root === "resources") {
    if (!type) {
      const rows = await db
        .select({ type: resources.type })
        .from(resources)
        .where(and(inArray(resources.ownerId, ctx.allOwnerIds), isNull(resources.deletedAt)));
      const presentTypes = new Set(rows.map((row) => row.type));
      return {
        relativePath: safeRelative,
        entries: resourceTypeEnum.enumValues
          .filter((resourceType) => presentTypes.has(resourceType))
          .sort((a, b) => a.localeCompare(b))
          .map((resourceType) => ({
            name: resourceType,
            path: `resources/${resourceType}`,
            type: "directory" as const,
            size: 0,
          })),
      };
    }
    if (!id) {
      const rows = await db
        .select({ id: resources.id, name: resources.name })
        .from(resources)
        .where(and(eq(resources.type, type as typeof resourceTypeEnum.enumValues[number]), inArray(resources.ownerId, ctx.allOwnerIds), isNull(resources.deletedAt)));
      return {
        relativePath: safeRelative,
        entries: rows
          .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
          .map((row) => ({
            name: row.name || row.id,
            path: `resources/${type}/${row.id}`,
            type: "directory" as const,
            size: 0,
          })),
      };
    }
    return {
      relativePath: safeRelative,
      entries: [
        { name: "record.json", path: `resources/${type}/${id}/record.json`, type: "file", size: 0 },
        { name: "metadata.json", path: `resources/${type}/${id}/metadata.json`, type: "file", size: 0 },
        { name: "content.md", path: `resources/${type}/${id}/content.md`, type: "file", size: 0 },
      ],
    };
  }

  if (root === "ledger") {
    if (!type) {
      const rows = await db
        .select({ verb: ledger.verb })
        .from(ledger)
        .where(inArray(ledger.subjectId, ctx.allOwnerIds));
      const presentVerbs = new Set(rows.map((row) => row.verb));
      return {
        relativePath: safeRelative,
        entries: verbTypeEnum.enumValues
          .filter((verb) => presentVerbs.has(verb))
          .sort((a, b) => a.localeCompare(b))
          .map((verb) => ({
            name: verb,
            path: `ledger/${verb}`,
            type: "directory" as const,
            size: 0,
          })),
      };
    }
    const rows = await db
      .select({ id: ledger.id, timestamp: ledger.timestamp })
      .from(ledger)
      .where(and(eq(ledger.verb, type as typeof verbTypeEnum.enumValues[number]), inArray(ledger.subjectId, ctx.allOwnerIds)))
      .orderBy(desc(ledger.timestamp))
      .limit(250);
    return {
      relativePath: safeRelative,
      entries: rows.map((row) => ({
        name: `${row.id}.json`,
        path: `ledger/${type}/${row.id}.json`,
        type: "file" as const,
        size: 0,
      })),
    };
  }

  if (root === "apps") {
    const projects = await discoverAgentProjects();
    return {
      relativePath: safeRelative,
      entries: projects
        .filter((workspace) => workspace.scope === "app")
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((workspace) => ({
          name: `${workspace.label}.json`,
          path: `apps/${workspace.id}.json`,
          type: "file" as const,
          size: 0,
        })),
    };
  }

  if (root === "builder-data-sources") {
    if (!id) {
      const rows = await db
        .select({ id: builderDataSources.id, label: builderDataSources.label })
        .from(builderDataSources)
        .where(inArray(builderDataSources.agentId, ctx.allOwnerIds));
      return {
        relativePath: safeRelative,
        entries: rows
          .sort((a, b) => (a.label || "").localeCompare(b.label || ""))
          .map((row) => ({
            name: row.label || row.id,
            path: `builder-data-sources/${row.id}`,
            type: "directory" as const,
            size: 0,
          })),
      };
    }
    return {
      relativePath: safeRelative,
      entries: [
        { name: "record.json", path: `builder-data-sources/${id}/record.json`, type: "file", size: 0 },
        { name: "config.json", path: `builder-data-sources/${id}/config.json`, type: "file", size: 0 },
      ],
    };
  }

  throw new Error("Unsupported virtual path.");
}

export async function readDbFile(relativePath: string): Promise<{
  relativePath: string;
  content: string;
}> {
  const ctx = await getViewerContext();
  const { safeRelative, segments } = splitPath(relativePath);
  if (segments.length < 2) {
    throw new Error("File path is required.");
  }

  const [root, segment1, segment2, segment3] = segments;

  if (root === "agent-docs") {
    // agent-docs/{agentId}/soul.md or agent-docs/{agentId}/docs/...
    const agentId = segment1;
    if (!agentId) throw new Error("Agent ID is required.");
    if (!ctx.allOwnerIds.includes(agentId)) throw new Error("Agent not found.");

    // Build the relative file path within the agent's folder
    const fileParts = segments.slice(2);
    if (fileParts.length === 0) throw new Error("File path is required.");
    const relativeFilePath = fileParts.join("/");

    const content = await readAgentFile(agentId, relativeFilePath);
    return { relativePath: safeRelative, content };
  }

  if (root === "agents") {
    const type = segment1;
    const id = segment2;
    const fileName = segment3;
    if (!type || !id || !fileName) throw new Error("Agent file path is required.");
    const row = await db.query.agents.findFirst({
      where: and(
        eq(agents.id, id),
        inArray(agents.id, ctx.allOwnerIds),
        eq(agents.type, type as typeof agentTypeEnum.enumValues[number]),
        isNull(agents.deletedAt),
      ),
      columns: {
        id: true,
        name: true,
        type: true,
        description: true,
        email: true,
        visibility: true,
        image: true,
        metadata: true,
        parentAgentId: true,
      },
    });
    if (!row) throw new Error("Agent not found.");
    if (fileName === "record.json") {
      return { relativePath: safeRelative, content: `${JSON.stringify(row, null, 2)}\n` };
    }
    if (fileName === "metadata.json") {
      return { relativePath: safeRelative, content: `${JSON.stringify(row.metadata ?? {}, null, 2)}\n` };
    }
    throw new Error("Unsupported agent file.");
  }

  if (root === "resources") {
    const type = segment1;
    const id = segment2;
    const fileName = segment3;
    if (!type || !id || !fileName) throw new Error("Resource file path is required.");
    const row = await db.query.resources.findFirst({
      where: and(
        eq(resources.id, id),
        eq(resources.type, type as typeof resourceTypeEnum.enumValues[number]),
        inArray(resources.ownerId, ctx.allOwnerIds),
        isNull(resources.deletedAt),
      ),
      columns: {
        id: true,
        name: true,
        type: true,
        description: true,
        content: true,
        contentType: true,
        ownerId: true,
        visibility: true,
        tags: true,
        metadata: true,
        updatedAt: true,
      },
    });
    if (!row) throw new Error("Resource not found.");
    if (fileName === "content.md") {
      return { relativePath: safeRelative, content: row.content ?? "" };
    }
    if (fileName === "record.json") {
      return { relativePath: safeRelative, content: `${JSON.stringify(row, null, 2)}\n` };
    }
    if (fileName === "metadata.json") {
      return { relativePath: safeRelative, content: `${JSON.stringify(row.metadata ?? {}, null, 2)}\n` };
    }
    throw new Error("Unsupported resource file.");
  }

  if (root === "ledger") {
    const type = segment1;
    const id = segment2;
    if (!type || !id || !id.endsWith(".json")) throw new Error("Ledger file path is required.");
    const ledgerId = id.replace(/\.json$/, "");
    const row = await db.query.ledger.findFirst({
      where: and(
        eq(ledger.id, ledgerId),
        eq(ledger.verb, type as typeof verbTypeEnum.enumValues[number]),
        inArray(ledger.subjectId, ctx.allOwnerIds),
      ),
    });
    if (!row) throw new Error("Ledger entry not found.");
    return {
      relativePath: safeRelative,
      content: `${JSON.stringify(row, null, 2)}\n`,
    };
  }

  if (root === "apps") {
    const fileName = segment1;
    if (!fileName || !fileName.endsWith(".json")) throw new Error("App file path is required.");
    const workspaceId = fileName.replace(/\.json$/, "");
    const projects = await discoverAgentProjects();
    const workspace = projects.find((item) => item.id === workspaceId && item.scope === "app");
    if (!workspace) throw new Error("App workspace not found.");
    return {
      relativePath: safeRelative,
      content: `${JSON.stringify(workspace, null, 2)}\n`,
    };
  }

  if (root === "builder-data-sources") {
    const id = segment1;
    const fileName = segment2;
    if (!id || !fileName) throw new Error("Data source file path is required.");
    const row = await db.query.builderDataSources.findFirst({
      where: and(eq(builderDataSources.id, id), inArray(builderDataSources.agentId, ctx.allOwnerIds)),
      columns: {
        id: true,
        agentId: true,
        kind: true,
        label: true,
        enabled: true,
        config: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!row) throw new Error("Data source not found.");
    if (fileName === "record.json") {
      return { relativePath: safeRelative, content: `${JSON.stringify(row, null, 2)}\n` };
    }
    if (fileName === "config.json") {
      return { relativePath: safeRelative, content: `${JSON.stringify(row.config ?? {}, null, 2)}\n` };
    }
    throw new Error("Unsupported data source file.");
  }

  throw new Error("Unsupported virtual file path.");
}

export async function writeDbFile(relativePath: string, content: string): Promise<{
  relativePath: string;
  size: number;
}> {
  const ctx = await getViewerContext();
  const { safeRelative, segments } = splitPath(relativePath);
  if (segments.length < 2) {
    throw new Error("File path is required.");
  }
  const [root, segment1, segment2, segment3] = segments;
  const size = Buffer.byteLength(content, "utf8");
  if (size > 1024 * 1024) {
    throw new Error("File is too large to save.");
  }

  if (root === "agent-docs") {
    // agent-docs/{agentId}/soul.md or agent-docs/{agentId}/docs/...
    const agentId = segment1;
    if (!agentId) throw new Error("Agent ID is required.");
    if (!ctx.allOwnerIds.includes(agentId)) throw new Error("Agent not found.");

    const fileParts = segments.slice(2);
    if (fileParts.length === 0) throw new Error("File path is required.");
    const relativeFilePath = fileParts.join("/");

    const written = await writeAgentFile(agentId, relativeFilePath, content);
    return { relativePath: safeRelative, size: written };
  }

  if (root === "agents") {
    const type = segment1;
    const id = segment2;
    const fileName = segment3;
    if (!type || !id || !fileName) throw new Error("Agent file path is required.");
    if (!ctx.allOwnerIds.includes(id)) throw new Error("Agent not found.");
    if (fileName === "metadata.json") {
      const metadata = parseJsonObject(content);
      await db.update(agents).set({ metadata, updatedAt: new Date() }).where(eq(agents.id, id));
      return { relativePath: safeRelative, size };
    }
    if (fileName === "record.json") {
      const payload = parseJsonObject(content);
      await db
        .update(agents)
        .set({
          name: typeof payload.name === "string" ? payload.name : undefined,
          description: typeof payload.description === "string" ? payload.description : undefined,
          image: typeof payload.image === "string" ? payload.image : undefined,
          visibility: typeof payload.visibility === "string" ? (payload.visibility as "public" | "locale" | "members" | "private") : undefined,
          metadata: payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
            ? (payload.metadata as Record<string, unknown>)
            : undefined,
          updatedAt: new Date(),
        })
        .where(eq(agents.id, id));
      return { relativePath: safeRelative, size };
    }
    throw new Error("Agent file is read-only.");
  }

  if (root === "resources") {
    const type = segment1;
    const id = segment2;
    const fileName = segment3;
    if (!type || !id || !fileName) throw new Error("Resource file path is required.");
    const allowedResource = await db.query.resources.findFirst({
      where: and(
        eq(resources.id, id),
        eq(resources.type, type as typeof resourceTypeEnum.enumValues[number]),
        inArray(resources.ownerId, ctx.allOwnerIds),
        isNull(resources.deletedAt),
      ),
      columns: { id: true },
    });
    if (!allowedResource) throw new Error("Resource not found.");
    if (fileName === "content.md") {
      await db.update(resources).set({ content, updatedAt: new Date() }).where(eq(resources.id, id));
      return { relativePath: safeRelative, size };
    }
    if (fileName === "metadata.json") {
      const metadata = parseJsonObject(content);
      await db.update(resources).set({ metadata, updatedAt: new Date() }).where(eq(resources.id, id));
      return { relativePath: safeRelative, size };
    }
    if (fileName === "record.json") {
      const payload = parseJsonObject(content);
      await db
        .update(resources)
        .set({
          name: typeof payload.name === "string" ? payload.name : undefined,
          description: typeof payload.description === "string" ? payload.description : undefined,
          content: typeof payload.content === "string" ? payload.content : undefined,
          tags: Array.isArray(payload.tags) ? payload.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
          visibility: typeof payload.visibility === "string" ? (payload.visibility as "public" | "locale" | "members" | "private") : undefined,
          metadata: payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
            ? (payload.metadata as Record<string, unknown>)
            : undefined,
          updatedAt: new Date(),
        })
        .where(eq(resources.id, id));
      return { relativePath: safeRelative, size };
    }
    throw new Error("Resource file is read-only.");
  }

  if (root === "builder-data-sources") {
    const id = segment1;
    const fileName = segment2;
    if (!id || !fileName) throw new Error("Data source file path is required.");
    const row = await db.query.builderDataSources.findFirst({
      where: and(eq(builderDataSources.id, id), inArray(builderDataSources.agentId, ctx.allOwnerIds)),
      columns: { id: true },
    });
    if (!row) throw new Error("Data source not found.");
    if (fileName === "config.json") {
      const config = parseJsonObject(content);
      await db.update(builderDataSources).set({ config, updatedAt: new Date() }).where(eq(builderDataSources.id, id));
      return { relativePath: safeRelative, size };
    }
    if (fileName === "record.json") {
      const payload = parseJsonObject(content);
      await db
        .update(builderDataSources)
        .set({
          label: typeof payload.label === "string" ? payload.label : undefined,
          enabled: typeof payload.enabled === "boolean" ? payload.enabled : undefined,
          config: payload.config && typeof payload.config === "object" && !Array.isArray(payload.config)
            ? (payload.config as Record<string, unknown>)
            : undefined,
          updatedAt: new Date(),
        })
        .where(eq(builderDataSources.id, id));
      return { relativePath: safeRelative, size };
    }
    throw new Error("Data source file is read-only.");
  }

  throw new Error("Virtual path is read-only.");
}
