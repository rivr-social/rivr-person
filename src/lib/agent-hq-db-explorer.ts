import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import nodePath from "node:path";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { agentTypeEnum, agents, builderDataSources, ledger, resourceTypeEnum, resources, verbTypeEnum } from "@/db/schema";
import { discoverAgentProjects, listAgentSessions } from "@/lib/agent-hq";
import {
  AGENTS_ROOT,
  agentFolderExists,
  agentSoulExists,
  ensureAgentDocsFolder,
  listAgentFolder,
  listAgentFolderIds,
  readAgentFile,
  readHeartbeat,
  writeAgentFile,
  writeHeartbeatNotes,
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

// ---------------------------------------------------------------------------
// agents.md virtual file — dynamic descriptions per directory level
// ---------------------------------------------------------------------------

const AGENTS_MD_DESCRIPTIONS: Record<string, string> = {
  root: "Each folder represents an agent or persona. The primary agent is marked (self).",
  resources: "Resources are owned content items: documents, listings, posts, events.",
  ledger: "Ledger entries track actions (create, join, update, etc.) performed by this agent.",
  agents: "Sub-agents and personas owned by this agent.",
  sessions: "LLM session context folders. Each session folder contains files appended via the Agent HQ explorer.",
};

function agentsMdForAgentRoot(agentName: string): string {
  return `This is ${agentName}'s scope. soul.md defines identity. heartbeat.md shows live status and notes. resources/ contains owned content. ledger/ tracks actions. agents/ lists sub-agents. sessions/ shows active LLM session contexts.`;
}

function agentsMdForResourceType(typeName: string): string {
  return `${typeName} resources. Each subfolder contains record.json (full data), metadata.json, and content.md.`;
}

function getAgentsMdContent(dirKey: string, extra?: string): string {
  if (extra) return extra;
  return AGENTS_MD_DESCRIPTIONS[dirKey] ?? "Agent HQ directory.";
}

function prependAgentsMd(entries: AgentHqDbEntry[], dirPath: string, dirKey: string, extra?: string): AgentHqDbEntry[] {
  return [
    { name: "agents.md", path: `${dirPath}/agents.md`, type: "file" as const, size: 0 },
    ...entries,
  ];
}

// ---------------------------------------------------------------------------
// Session folder discovery helpers
// ---------------------------------------------------------------------------

async function discoverSessionFolders(): Promise<Array<{ sessionId: string; hasContext: boolean; fileCount: number }>> {
  if (!existsSync(AGENTS_ROOT)) return [];
  const entries = await readdir(AGENTS_ROOT, { withFileTypes: true });
  const results: Array<{ sessionId: string; hasContext: boolean; fileCount: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contextDir = nodePath.join(AGENTS_ROOT, entry.name, "context");
    if (!existsSync(contextDir)) continue;
    try {
      const contextEntries = await readdir(contextDir, { withFileTypes: true });
      const files = contextEntries.filter((e) => e.isFile() && e.name !== "CLAUDE.md" && e.name !== "claude.md");
      results.push({ sessionId: entry.name, hasContext: true, fileCount: files.length });
    } catch {
      // skip unreadable
    }
  }
  return results;
}

async function listSessionContextFiles(sessionId: string): Promise<Array<{ name: string; size: number }>> {
  const contextDir = nodePath.join(AGENTS_ROOT, sessionId, "context");
  if (!existsSync(contextDir)) return [];
  const entries = await readdir(contextDir, { withFileTypes: true });
  const results: Array<{ name: string; size: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === "CLAUDE.md" || entry.name === "claude.md") continue;
    try {
      const fileStat = await stat(nodePath.join(contextDir, entry.name));
      results.push({ name: entry.name, size: fileStat.size });
    } catch {
      results.push({ name: entry.name, size: 0 });
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

async function readSessionContextFile(sessionId: string, fileName: string): Promise<string> {
  const safeName = nodePath.basename(fileName);
  const filePath = nodePath.join(AGENTS_ROOT, sessionId, "context", safeName);
  return readFile(filePath, "utf-8");
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

  // ---- Root: list agents/personas as top-level folders ----
  if (segments.length === 0) {
    const dbRows = await db
      .select({ id: agents.id, name: agents.name, type: agents.type, parentAgentId: agents.parentAgentId })
      .from(agents)
      .where(and(inArray(agents.id, ctx.allOwnerIds), isNull(agents.deletedAt)));

    // Primary agent first, then personas sorted by name
    const primary = dbRows.find((r) => r.id === ctx.userId);
    const personas = dbRows.filter((r) => r.id !== ctx.userId).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const ordered = primary ? [primary, ...personas] : personas;

    const agentEntries = ordered.map((row) => ({
      name: row.id === ctx.userId ? `${row.name || "Primary"} (self)` : row.name || row.id,
      path: `@${row.id}`,
      type: "directory" as const,
      size: 0,
    }));
    return {
      relativePath: safeRelative,
      entries: prependAgentsMd(agentEntries, "", "root"),
    };
  }

  const [root, ...rest] = segments;

  // ---- Per-agent scoped view: @{agentId}/... ----
  if (root.startsWith("@")) {
    const agentId = root.slice(1);
    if (!ctx.allOwnerIds.includes(agentId)) throw new Error("Agent not found.");

    if (rest.length === 0) {
      // List scoped sub-folders for this agent
      await ensureAgentDocsFolder(agentId);
      const hasSoul = agentSoulExists(agentId);
      const agentRow = await db.query.agents.findFirst({
        where: eq(agents.id, agentId),
        columns: { name: true },
      });
      const agentName = agentRow?.name || agentId;
      const entries: AgentHqDbEntry[] = [];
      if (hasSoul) {
        entries.push({ name: "soul.md", path: `${root}/soul.md`, type: "file", size: 0 });
      } else {
        entries.push({ name: "soul.md (create)", path: `${root}/soul.md`, type: "file", size: 0 });
      }
      entries.push({ name: "heartbeat.md", path: `${root}/heartbeat.md`, type: "file", size: 0 });
      entries.push({ name: "resources", path: `${root}/resources`, type: "directory", size: 0 });
      entries.push({ name: "ledger", path: `${root}/ledger`, type: "directory", size: 0 });
      entries.push({ name: "agents", path: `${root}/agents`, type: "directory", size: 0 });
      entries.push({ name: "sessions", path: `${root}/sessions`, type: "directory", size: 0 });
      return { relativePath: safeRelative, entries: prependAgentsMd(entries, root, "agent-root", agentsMdForAgentRoot(agentName)) };
    }

    const [subRoot, ...subRest] = rest;

    // soul.md read is handled by readDbFile

    if (subRoot === "docs") {
      const subPath = subRest.join("/");
      const docsSubPath = subPath ? `docs/${subPath}` : "docs";
      const diskEntries = await listAgentFolder(agentId, docsSubPath);
      const basePath = `${root}/${docsSubPath}`;
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

    if (subRoot === "resources") {
      // Scoped resources for this agent
      const type = subRest[0];
      const id = subRest[1];
      if (!type) {
        const rows = await db
          .select({ type: resources.type })
          .from(resources)
          .where(and(eq(resources.ownerId, agentId), isNull(resources.deletedAt)));
        const presentTypes = new Set(rows.map((row) => row.type));
        const resourceEntries = resourceTypeEnum.enumValues
          .filter((rt) => presentTypes.has(rt))
          .sort((a, b) => a.localeCompare(b))
          .map((rt) => ({ name: rt, path: `${root}/resources/${rt}`, type: "directory" as const, size: 0 }));
        return {
          relativePath: safeRelative,
          entries: prependAgentsMd(resourceEntries, `${root}/resources`, "resources"),
        };
      }
      // Virtual "transcripts" subfolder under document type
      if (type === "document" && id === "transcripts") {
        const transcriptId = subRest[2];
        if (!transcriptId) {
          const rows = await db
            .select({ id: resources.id, name: resources.name })
            .from(resources)
            .where(and(
              eq(resources.type, "document"),
              eq(resources.ownerId, agentId),
              isNull(resources.deletedAt),
            ));
          // Filter to transcript-tagged documents (tags is a text[] column)
          const transcriptRows = [];
          for (const row of rows) {
            const full = await db.query.resources.findFirst({
              where: eq(resources.id, row.id),
              columns: { id: true, name: true, tags: true },
            });
            if (full?.tags && (full.tags.includes("transcript") || full.tags.includes("session-record"))) {
              transcriptRows.push(full);
            }
          }
          return {
            relativePath: safeRelative,
            entries: transcriptRows.sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((row) => ({
              name: row.name || row.id,
              path: `${root}/resources/document/transcripts/${row.id}`,
              type: "directory" as const,
              size: 0,
            })),
          };
        }
        // Individual transcript record
        return {
          relativePath: safeRelative,
          entries: [
            { name: "record.json", path: `${root}/resources/document/transcripts/${transcriptId}/record.json`, type: "file" as const, size: 0 },
            { name: "metadata.json", path: `${root}/resources/document/transcripts/${transcriptId}/metadata.json`, type: "file" as const, size: 0 },
            { name: "content.md", path: `${root}/resources/document/transcripts/${transcriptId}/content.md`, type: "file" as const, size: 0 },
          ],
        };
      }

      if (!id) {
        const rows = await db
          .select({ id: resources.id, name: resources.name })
          .from(resources)
          .where(and(eq(resources.type, type as typeof resourceTypeEnum.enumValues[number]), eq(resources.ownerId, agentId), isNull(resources.deletedAt)));
        const entries: AgentHqDbEntry[] = [];
        // Add transcripts virtual folder for document type
        if (type === "document") {
          entries.push({ name: "transcripts", path: `${root}/resources/document/transcripts`, type: "directory" as const, size: 0 });
        }
        entries.push(...rows.sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((row) => ({
          name: row.name || row.id,
          path: `${root}/resources/${type}/${row.id}`,
          type: "directory" as const,
          size: 0,
        })));
        return { relativePath: safeRelative, entries: prependAgentsMd(entries, `${root}/resources/${type}`, "resource-type", agentsMdForResourceType(type)) };
      }
      return {
        relativePath: safeRelative,
        entries: [
          { name: "record.json", path: `${root}/resources/${type}/${id}/record.json`, type: "file" as const, size: 0 },
          { name: "metadata.json", path: `${root}/resources/${type}/${id}/metadata.json`, type: "file" as const, size: 0 },
          { name: "content.md", path: `${root}/resources/${type}/${id}/content.md`, type: "file" as const, size: 0 },
        ],
      };
    }

    if (subRoot === "ledger") {
      const verb = subRest[0];
      if (!verb) {
        const rows = await db
          .select({ verb: ledger.verb })
          .from(ledger)
          .where(eq(ledger.subjectId, agentId));
        const presentVerbs = new Set(rows.map((row) => row.verb));
        const ledgerEntries = verbTypeEnum.enumValues
          .filter((v) => presentVerbs.has(v))
          .sort((a, b) => a.localeCompare(b))
          .map((v) => ({ name: v, path: `${root}/ledger/${v}`, type: "directory" as const, size: 0 }));
        return {
          relativePath: safeRelative,
          entries: prependAgentsMd(ledgerEntries, `${root}/ledger`, "ledger"),
        };
      }
      const rows = await db
        .select({ id: ledger.id, timestamp: ledger.timestamp })
        .from(ledger)
        .where(and(eq(ledger.verb, verb as typeof verbTypeEnum.enumValues[number]), eq(ledger.subjectId, agentId)))
        .orderBy(desc(ledger.timestamp))
        .limit(250);
      return {
        relativePath: safeRelative,
        entries: rows.map((row) => ({
          name: `${row.id}.json`,
          path: `${root}/ledger/${verb}/${row.id}.json`,
          type: "file" as const,
          size: 0,
        })),
      };
    }

    if (subRoot === "agents") {
      // Sub-agents: other agents owned by this agent (personas for primary, nothing for personas typically)
      const type = subRest[0];
      const id = subRest[1];
      if (!type) {
        const rows = await db
          .select({ type: agents.type })
          .from(agents)
          .where(and(eq(agents.parentAgentId, agentId), isNull(agents.deletedAt)));
        const presentTypes = new Set(rows.map((row) => row.type));
        if (presentTypes.size === 0) {
          return { relativePath: safeRelative, entries: [] };
        }
        return {
          relativePath: safeRelative,
          entries: agentTypeEnum.enumValues
            .filter((at) => presentTypes.has(at))
            .sort((a, b) => a.localeCompare(b))
            .map((at) => ({ name: at, path: `${root}/agents/${at}`, type: "directory" as const, size: 0 })),
        };
      }
      if (!id) {
        const rows = await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.parentAgentId, agentId), eq(agents.type, type as typeof agentTypeEnum.enumValues[number]), isNull(agents.deletedAt)));
        return {
          relativePath: safeRelative,
          entries: rows.sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((row) => ({
            name: row.name || row.id,
            path: `${root}/agents/${type}/${row.id}`,
            type: "directory" as const,
            size: 0,
          })),
        };
      }
      return {
        relativePath: safeRelative,
        entries: [
          { name: "record.json", path: `${root}/agents/${type}/${id}/record.json`, type: "file" as const, size: 0 },
          { name: "metadata.json", path: `${root}/agents/${type}/${id}/metadata.json`, type: "file" as const, size: 0 },
        ],
      };
    }

    if (subRoot === "sessions") {
      const sessionId = subRest[0];
      const sessionFile = subRest[1];

      if (!sessionId) {
        // List all session folders that have context directories
        const sessionFolders = await discoverSessionFolders();
        let liveSessions: Awaited<ReturnType<typeof listAgentSessions>> = [];
        try {
          liveSessions = await listAgentSessions();
        } catch {
          // tmux may not be available
        }
        const liveSessionNames = new Set(liveSessions.map((s) => s.sessionName));

        const sessionEntries: AgentHqDbEntry[] = sessionFolders
          .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
          .map((sf) => ({
            name: liveSessionNames.has(sf.sessionId)
              ? `${sf.sessionId} (active, ${sf.fileCount} files)`
              : `${sf.sessionId} (${sf.fileCount} files)`,
            path: `${root}/sessions/${sf.sessionId}`,
            type: "directory" as const,
            size: 0,
          }));
        return {
          relativePath: safeRelative,
          entries: prependAgentsMd(sessionEntries, `${root}/sessions`, "sessions"),
        };
      }

      if (!sessionFile) {
        // List files inside a specific session's context folder
        const files = await listSessionContextFiles(sessionId);
        const fileEntries: AgentHqDbEntry[] = files.map((f) => ({
          name: f.name,
          path: `${root}/sessions/${sessionId}/${f.name}`,
          type: "file" as const,
          size: f.size,
        }));
        return { relativePath: safeRelative, entries: fileEntries };
      }

      // Should not get here for listing — file reads are handled by readDbFile
      throw new Error("Use readDbFile for session context files.");
    }

    throw new Error(`Unsupported sub-path: ${subRoot}`);
  }

  // ---- Legacy flat roots (kept for backward compat with readDbFile/writeDbFile) ----
  const [type, id] = rest;

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
  if (segments.length < 1) {
    throw new Error("File path is required.");
  }

  // Root-level agents.md virtual file
  if (segments.length === 1 && segments[0] === "agents.md") {
    return { relativePath: safeRelative, content: getAgentsMdContent("root") };
  }

  if (segments.length < 2) {
    throw new Error("File path is required.");
  }

  const [root, segment1, segment2, segment3] = segments;

  // ---- Per-agent scoped reads: @{agentId}/... ----
  if (root.startsWith("@")) {
    const agentId = root.slice(1);
    if (!ctx.allOwnerIds.includes(agentId)) throw new Error("Agent not found.");
    const subParts = segments.slice(1);
    if (subParts.length === 0) throw new Error("File path is required.");

    // agents.md virtual file — generate content dynamically based on path
    if (subParts[subParts.length - 1] === "agents.md") {
      const dirParts = subParts.slice(0, -1);
      let mdContent: string;
      if (dirParts.length === 0) {
        // @{agentId}/agents.md — agent root
        const agentRow = await db.query.agents.findFirst({
          where: eq(agents.id, agentId),
          columns: { name: true },
        });
        mdContent = agentsMdForAgentRoot(agentRow?.name || agentId);
      } else if (dirParts[0] === "resources" && dirParts.length === 1) {
        mdContent = getAgentsMdContent("resources");
      } else if (dirParts[0] === "resources" && dirParts.length === 2) {
        mdContent = agentsMdForResourceType(dirParts[1]);
      } else if (dirParts[0] === "ledger") {
        mdContent = getAgentsMdContent("ledger");
      } else if (dirParts[0] === "agents") {
        mdContent = getAgentsMdContent("agents");
      } else if (dirParts[0] === "sessions") {
        mdContent = getAgentsMdContent("sessions");
      } else {
        mdContent = "Agent HQ directory.";
      }
      return { relativePath: safeRelative, content: mdContent };
    }

    // heartbeat.md — auto-generated on read
    if (subParts[0] === "heartbeat.md") {
      const content = await readHeartbeat(agentId);
      return { relativePath: safeRelative, content };
    }

    // soul.md and docs/ are on disk
    if (subParts[0] === "soul.md" || subParts[0] === "docs") {
      const relativeFilePath = subParts.join("/");
      const content = await readAgentFile(agentId, relativeFilePath);
      return { relativePath: safeRelative, content };
    }

    // Session context file reads: @{agentId}/sessions/{sessionId}/{file}
    if (subParts[0] === "sessions" && subParts.length === 3) {
      const [, sessionId, fileName] = subParts;
      if (!sessionId || !fileName) throw new Error("Session file path is required.");
      const content = await readSessionContextFile(sessionId, fileName);
      return { relativePath: safeRelative, content };
    }

    // Rewrite scoped paths to legacy flat paths for DB reads
    // @{agentId}/resources/{type}/{id}/file → resources/{type}/{id}/file (scoped)
    // @{agentId}/ledger/{verb}/{id}.json → ledger/{verb}/{id}.json (scoped)
    // @{agentId}/agents/{type}/{id}/file → agents/{type}/{id}/file
    if (subParts[0] === "resources" && subParts.length >= 3) {
      // Handle virtual transcripts path: resources/document/transcripts/{id}/{file}
      let [, rType, rId, rFile] = subParts;
      if (rType === "document" && rId === "transcripts" && subParts.length >= 5) {
        rId = subParts[3];
        rFile = subParts[4];
      }
      if (!rType || !rId || !rFile) throw new Error("Resource file path is required.");
      const row = await db.query.resources.findFirst({
        where: and(eq(resources.id, rId), eq(resources.ownerId, agentId), isNull(resources.deletedAt)),
        columns: { id: true, name: true, type: true, description: true, content: true, contentType: true, ownerId: true, visibility: true, tags: true, metadata: true, updatedAt: true },
      });
      if (!row) throw new Error("Resource not found.");
      if (rFile === "content.md") return { relativePath: safeRelative, content: row.content ?? "" };
      if (rFile === "record.json") return { relativePath: safeRelative, content: `${JSON.stringify(row, null, 2)}\n` };
      if (rFile === "metadata.json") return { relativePath: safeRelative, content: `${JSON.stringify(row.metadata ?? {}, null, 2)}\n` };
      throw new Error("Unsupported resource file.");
    }
    if (subParts[0] === "ledger" && subParts.length >= 2) {
      const [, lVerb, lId] = subParts;
      if (!lVerb || !lId?.endsWith(".json")) throw new Error("Ledger file path is required.");
      const ledgerId = lId.replace(/\.json$/, "");
      const row = await db.query.ledger.findFirst({
        where: and(eq(ledger.id, ledgerId), eq(ledger.subjectId, agentId)),
      });
      if (!row) throw new Error("Ledger entry not found.");
      return { relativePath: safeRelative, content: `${JSON.stringify(row, null, 2)}\n` };
    }
    if (subParts[0] === "agents" && subParts.length >= 3) {
      const [, aType, aId, aFile] = subParts;
      if (!aType || !aId || !aFile) throw new Error("Agent file path is required.");
      const row = await db.query.agents.findFirst({
        where: and(eq(agents.id, aId), eq(agents.parentAgentId, agentId), isNull(agents.deletedAt)),
        columns: { id: true, name: true, type: true, description: true, email: true, visibility: true, image: true, metadata: true, parentAgentId: true },
      });
      if (!row) throw new Error("Agent not found.");
      if (aFile === "record.json") return { relativePath: safeRelative, content: `${JSON.stringify(row, null, 2)}\n` };
      if (aFile === "metadata.json") return { relativePath: safeRelative, content: `${JSON.stringify(row.metadata ?? {}, null, 2)}\n` };
      throw new Error("Unsupported agent file.");
    }
    throw new Error("Unsupported scoped file path.");
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

  // ---- Per-agent scoped writes: @{agentId}/... ----
  if (root.startsWith("@")) {
    const agentId = root.slice(1);
    if (!ctx.allOwnerIds.includes(agentId)) throw new Error("Agent not found.");
    const subParts = segments.slice(1);
    if (subParts.length === 0) throw new Error("File path is required.");

    // heartbeat.md — only the Notes section is user-writable
    if (subParts[0] === "heartbeat.md") {
      await writeHeartbeatNotes(agentId, content);
      return { relativePath: safeRelative, size };
    }

    // soul.md and docs/ are on disk
    if (subParts[0] === "soul.md" || subParts[0] === "docs") {
      const relativeFilePath = subParts.join("/");
      const written = await writeAgentFile(agentId, relativeFilePath, content);
      return { relativePath: safeRelative, size: written };
    }

    // For DB-backed scoped writes, delegate to the flat path handlers below
    // by rewriting the path (e.g. @{id}/resources/... → resources/...)
    // This keeps the write logic DRY.
    throw new Error("Write not supported for this scoped path.");
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
