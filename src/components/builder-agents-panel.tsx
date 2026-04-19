"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bot, ChevronDown, ChevronRight, Circle, Dot, FileText, FolderOpen, GripHorizontal, Loader2, Plus, RefreshCw, Send, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import XTermPane from "@/components/xterm-pane";
import type { XTermPaneHandle } from "@/components/xterm-pane";

const TERMINAL_FONT_STACK = "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', monospace";
const PRIMARY_REFRESH_INTERVAL_MS = 2000;
const TEAM_REFRESH_INTERVAL_MS = 4000;


type PaneSizePreset = "compact" | "normal" | "expanded";
const PANE_SIZE_HEIGHTS: Record<PaneSizePreset, string> = {
  compact: "200px",
  normal: "360px",
  expanded: "600px",
};

type AgentRole = "executive" | "architect" | "orchestrator" | "worker" | "observer";
type AgentWorkspaceScope = "foundation" | "app" | "shared";
type AgentLauncherProvider = "claude" | "codex" | "opencode" | "custom";

interface AgentSessionMetadata {
  role: AgentRole;
  parent: string | null;
  label: string;
  notes: string;
  objective: string;
  provider?: AgentLauncherProvider;
  cwd?: string;
  workspaceId?: string;
  workspaceScope?: AgentWorkspaceScope;
  liveSubdomain?: string;
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
  mountedPaths?: string[];
}

interface AgentSession {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId?: string;
  active: boolean;
  metadata: AgentSessionMetadata;
}

interface AgentSessionsResponse {
  sessions: AgentSession[];
  templates?: AgentSessionTemplate[];
  lastUpdatedAt?: string;
  warning?: string;
  error?: string;
}

interface AgentCaptureResponse {
  output?: string;
  warning?: string;
  error?: string;
}

interface AgentWorkspace {
  id: string;
  label: string;
  cwd: string;
  scope: AgentWorkspaceScope;
  description: string;
  liveSubdomain?: string | null;
}

interface AgentWorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
}

interface ExplorerNode extends AgentWorkspaceEntry {
  id: string;
  expanded?: boolean;
  loaded?: boolean;
  loading?: boolean;
  children?: ExplorerNode[];
}

interface AgentLauncher {
  provider: AgentLauncherProvider;
  installed: boolean;
}

interface AgentLaunchersResponse {
  workspaces: AgentWorkspace[];
  launchers: AgentLauncher[];
  activePersonaId?: string | null;
  personas?: Array<{ id: string; name: string }>;
  error?: string;
}

interface AgentPersona {
  id: string;
  name: string;
}

type LaunchPreset = "default" | "guide_builder";

interface AgentSessionTemplate {
  id: string;
  name: string;
  mode: "architect" | "team";
  preset: LaunchPreset;
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
}

interface BuilderAgentsPanelProps {
  workspaceId?: string;
}

function parseKgScopeSet(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function getArchitectObjective(workspaceLabel: string, preset: LaunchPreset) {
  if (preset === "guide_builder") {
    return `Act as the top-tier Guide architect for ${workspaceLabel}. Compile user intent into deployable surfaces with policy-safe bindings, then coordinate orchestrators and workers.`;
  }
  return `Act as the top-tier architect for ${workspaceLabel}. Coordinate tmux-backed orchestrators and workers, keep the user-facing plan simple, and maintain app-scoped boundaries unless explicitly elevated.`;
}

function getArchitectNotes(scope: AgentWorkspaceScope, liveSubdomain?: string | null, preset: LaunchPreset = "default") {
  const base = `Workspace scope: ${scope}. Live subdomain: ${liveSubdomain ?? "n/a"}`;
  if (preset === "guide_builder") {
    return `${base}. Guide mode: prioritize adaptive UI manifests, permission-safe actions, and deploy readiness.`;
  }
  return base;
}

function paneKeyForSession(session: Pick<AgentSession, "sessionName" | "windowIndex" | "paneIndex" | "paneId">) {
  if (typeof session.paneId === "string" && session.paneId.startsWith("%")) {
    return session.paneId;
  }
  return `${session.sessionName}:${session.windowIndex}.${session.paneIndex}`;
}

function stripAnsi(value: string) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "");
}

function architectRank(session: AgentSession) {
  if (session.metadata.role === "executive") return 0;
  if (session.metadata.role === "observer") return 1;
  if (session.metadata.role === "architect") return 2;
  if (session.metadata.role === "orchestrator") return 3;
  if (session.metadata.role === "worker") return 4;
  return 4;
}

function buildChildrenMap(sessions: AgentSession[]) {
  const children = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    const parent = session.metadata.parent?.trim();
    if (!parent) continue;
    const current = children.get(parent) ?? [];
    current.push(session);
    children.set(parent, current);
  }
  for (const list of children.values()) {
    list.sort((a, b) => architectRank(a) - architectRank(b) || paneKeyForSession(a).localeCompare(paneKeyForSession(b)));
  }
  return children;
}

function extractChoices(rawOutput: string) {
  const output = stripAnsi(rawOutput);
  const matches = [...output.matchAll(/(?:^|\n)\s*(\d+)\.\s+/g)];
  const unique: string[] = [];
  for (const match of matches) {
    const value = match[1];
    if (!unique.includes(value)) unique.push(value);
    if (unique.length >= 5) break;
  }
  return unique;
}

function formatKgScopes(scopes?: string[]) {
  if (!Array.isArray(scopes) || scopes.length === 0) return "person:self";
  return scopes.join(", ");
}

interface AgentFilesystemTreeProps {
  nodes: ExplorerNode[];
  selectedFile: string;
  mountedPaths: string[];
  onToggleDirectory: (node: ExplorerNode) => void;
  onSelectFile: (node: ExplorerNode) => void;
  onToggleMount: (node: ExplorerNode) => void;
  depth?: number;
}

function AgentFilesystemTree({
  nodes,
  selectedFile,
  mountedPaths,
  onToggleDirectory,
  onSelectFile,
  onToggleMount,
  depth = 0,
}: AgentFilesystemTreeProps) {
  if (nodes.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        const isDirectory = node.type === "directory";
        const isSelected = !isDirectory && selectedFile === node.path;
        const isMounted = mountedPaths.includes(node.path);
        return (
          <div key={node.id}>
            <div
              className={`flex items-center gap-1 rounded px-1 py-0.5 text-xs ${isSelected ? "bg-primary/10 text-primary" : ""}`}
              style={{ paddingLeft: `${4 + depth * 12}px` }}
            >
              <button
                type="button"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted"
                onClick={() => onToggleMount(node)}
                title={isMounted ? "Remove from this agent context" : "Append to this agent context"}
              >
                {isMounted ? <Dot className="h-5 w-5" /> : <Circle className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-muted"
                onClick={() => {
                  if (isDirectory) {
                    onToggleDirectory(node);
                    return;
                  }
                  onSelectFile(node);
                }}
              >
                {isDirectory ? (
                  node.expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />
                ) : (
                  <span className="inline-block w-3 shrink-0" />
                )}
                {isDirectory ? <FolderOpen className="h-3 w-3 shrink-0" /> : <FileText className="h-3 w-3 shrink-0" />}
                <span className="truncate">{node.name}</span>
                {node.loading ? <span className="ml-auto text-[10px] text-muted-foreground">…</span> : null}
              </button>
            </div>
            {isDirectory && node.expanded && node.children && node.children.length > 0 ? (
              <AgentFilesystemTree
                nodes={node.children}
                selectedFile={selectedFile}
                mountedPaths={mountedPaths}
                onToggleDirectory={onToggleDirectory}
                onSelectFile={onSelectFile}
                onToggleMount={onToggleMount}
                depth={depth + 1}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function pickProvider(
  installed: Set<AgentLauncherProvider>,
  preferredOrder: AgentLauncherProvider[],
): AgentLauncherProvider | null {
  for (const provider of preferredOrder) {
    if (installed.has(provider)) return provider;
  }
  return null;
}

export function BuilderAgentsPanel({ workspaceId }: BuilderAgentsPanelProps) {
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[]>([]);
  const [launchers, setLaunchers] = useState<AgentLauncher[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [sendingKey, setSendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [personas, setPersonas] = useState<AgentPersona[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>("");
  const [kgScopeDraft, setKgScopeDraft] = useState<string>("person:self");
  const [kgScopeInput, setKgScopeInput] = useState<string>("");
  const [launchPreset, setLaunchPreset] = useState<LaunchPreset>("default");
  const [templates, setTemplates] = useState<AgentSessionTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [reloadingPaneKey, setReloadingPaneKey] = useState<string | null>(null);
  const [panePersonaDrafts, setPanePersonaDrafts] = useState<Record<string, string>>({});
  const [paneScopesDrafts, setPaneScopesDrafts] = useState<Record<string, string[]>>({});
  const [paneMountedPathsDrafts, setPaneMountedPathsDrafts] = useState<Record<string, string[]>>({});
  const [paneScopeInput, setPaneScopeInput] = useState<Record<string, string>>({});
  const [savingPaneKey, setSavingPaneKey] = useState<string | null>(null);
  const [selectedContextPaneKey, setSelectedContextPaneKey] = useState<string>("");
  const [fsRootPath, setFsRootPath] = useState("");
  const [fsTree, setFsTree] = useState<ExplorerNode[]>([]);
  const [fsLoading, setFsLoading] = useState(false);
  const [fsSelectedFile, setFsSelectedFile] = useState("");
  const [fsFileContent, setFsFileContent] = useState("");
  const [fsFileLoading, setFsFileLoading] = useState(false);
  const [fsFileMessage, setFsFileMessage] = useState<string | null>(null);

  const [primaryPaneSize, setPrimaryPaneSize] = useState<PaneSizePreset>("normal");
  const [primaryDragHeight, setPrimaryDragHeight] = useState<number | null>(null);
  const dragStartRef = useRef<{ y: number; height: number } | null>(null);

  const paneRefs = useRef<Record<string, XTermPaneHandle | null>>({});
  const interactionLocksRef = useRef<Set<string>>(new Set());
  const commandHistoryRef = useRef<Record<string, string[]>>({});
  const commandHistoryIndexRef = useRef<Record<string, number>>({});
  const inputRefsMap = useRef<Record<string, HTMLInputElement | null>>({});

  const captureSession = useCallback(async (paneKey: string) => {
    if (interactionLocksRef.current.has(paneKey)) {
      return;
    }
    const response = await fetch(`/api/agent-hq/capture?target=${encodeURIComponent(paneKey)}&lines=90&raw=1`, {
      cache: "no-store",
    });
    const data = (await response.json().catch(() => ({}))) as AgentCaptureResponse;
    if (!response.ok || data.error) {
      throw new Error(data.error || `Failed to capture ${paneKey}`);
    }
    if (data.warning) {
      setError(data.warning);
    }
    const rawOutput = data.output ?? "";
    setOutputs((prev) => ({ ...prev, [paneKey]: rawOutput }));
    // Write raw ANSI output directly to the xterm instance
    paneRefs.current[paneKey]?.writeRaw(rawOutput);
  }, []);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [sessionsResponse, launchersResponse] = await Promise.all([
        fetch("/api/agent-hq/sessions", { cache: "no-store" }),
        fetch("/api/agent-hq/launchers", { cache: "no-store" }),
      ]);

      const sessionsData = (await sessionsResponse.json().catch(() => ({}))) as AgentSessionsResponse;
      const launchersData = (await launchersResponse.json().catch(() => ({}))) as AgentLaunchersResponse;
      if (!sessionsResponse.ok || sessionsData.error) {
        throw new Error(sessionsData.error || `Failed to load sessions (${sessionsResponse.status})`);
      }
      if (!launchersResponse.ok || launchersData.error) {
        throw new Error(launchersData.error || `Failed to load workspaces (${launchersResponse.status})`);
      }

      setSessions(sessionsData.sessions ?? []);
      setTemplates(sessionsData.templates ?? []);
      setWorkspaces(launchersData.workspaces ?? []);
      setLaunchers(launchersData.launchers ?? []);
      const personaOptions = launchersData.personas ?? [];
      setPersonas(personaOptions);
      setLastUpdatedAt(sessionsData.lastUpdatedAt ?? new Date().toISOString());
      setError(sessionsData.warning ?? null);

      const nextWorkspaces = launchersData.workspaces ?? [];
      const nextSelectedWorkspaceId =
        (workspaceId && nextWorkspaces.some((workspace) => workspace.id === workspaceId)
          ? workspaceId
          : undefined) ??
        (selectedWorkspaceId && nextWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
          ? selectedWorkspaceId
          : undefined) ??
        nextWorkspaces.find((workspace) => workspace.scope === "app")?.id ??
        nextWorkspaces[0]?.id ??
        "";
      setSelectedWorkspaceId(nextSelectedWorkspaceId);

      setSelectedPersonaId((current) => {
        if (current && personaOptions.some((persona) => persona.id === current)) return current;
        return launchersData.activePersonaId && personaOptions.some((persona) => persona.id === launchersData.activePersonaId)
          ? launchersData.activePersonaId
          : "";
      });
      setSelectedTemplateId((current) => {
        if (current && (sessionsData.templates ?? []).some((template) => template.id === current)) {
          return current;
        }
        return "";
      });

      await Promise.all(
        (sessionsData.sessions ?? [])
          .filter((session) => !nextSelectedWorkspaceId || session.metadata.workspaceId === nextSelectedWorkspaceId)
          .map(async (session) => {
          const paneKey = paneKeyForSession(session);
          setDrafts((prev) => (paneKey in prev ? prev : { ...prev, [paneKey]: "" }));
          setPanePersonaDrafts((prev) =>
            paneKey in prev
              ? prev
              : { ...prev, [paneKey]: session.metadata.personaId ?? "" },
          );
          setPaneScopesDrafts((prev) =>
            paneKey in prev
              ? prev
              : { ...prev, [paneKey]: session.metadata.kgScopeSet?.length ? session.metadata.kgScopeSet : ["person:self"] },
          );
          setPaneMountedPathsDrafts((prev) =>
            paneKey in prev
              ? prev
              : { ...prev, [paneKey]: session.metadata.mountedPaths?.length ? session.metadata.mountedPaths : [] },
          );
          setPaneScopeInput((prev) => (paneKey in prev ? prev : { ...prev, [paneKey]: "" }));
          try {
            await captureSession(paneKey);
          } catch {
            return;
          }
          }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Agent HQ");
    } finally {
      setLoading(false);
      if (!silent) setRefreshing(false);
    }
  }, [captureSession, selectedWorkspaceId, workspaceId]);

  const manualRefreshPane = useCallback(
    async (paneKey: string) => {
      try {
        await captureSession(paneKey);
      } catch {
        /* silently ignore single-pane refresh failure */
      }
    },
    [captureSession],
  );

  const applyTemplate = useCallback(
    (templateId: string) => {
      setSelectedTemplateId(templateId);
      const template = templates.find((entry) => entry.id === templateId);
      if (!template) return;
      setLaunchPreset(template.preset);
      setSelectedPersonaId(template.personaId ?? "");
      if (template.kgScopeSet && template.kgScopeSet.length > 0) {
        setKgScopeDraft(template.kgScopeSet.join(","));
      }
    },
    [templates],
  );

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const selectedPersona = useMemo(
    () => personas.find((persona) => persona.id === selectedPersonaId) ?? null,
    [personas, selectedPersonaId],
  );
  const kgScopeOptions = useMemo(() => {
    const values = new Set<string>(["person:self", "workspace:app", "workspace:foundation"]);
    for (const persona of personas) {
      values.add(`persona:${persona.id}`);
    }
    for (const session of sessions) {
      for (const scope of session.metadata.kgScopeSet ?? []) {
        if (scope.trim()) values.add(scope.trim());
      }
    }
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [personas, sessions]);

  const saveCurrentTemplate = useCallback(
    async (mode: AgentSessionTemplate["mode"]) => {
      const templateName = window.prompt("Template name");
      const trimmed = templateName?.trim();
      if (!trimmed) return;

      setSavingTemplate(true);
      try {
        const response = await fetch("/api/agent-hq/session-templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmed,
            mode,
            preset: launchPreset,
            personaId: selectedPersona?.id ?? null,
            personaName: selectedPersona?.name,
            kgScopeSet: parseKgScopeSet(kgScopeDraft),
          }),
        });
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
          templates?: AgentSessionTemplate[];
        };
        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to save template (${response.status})`);
        }
        setTemplates(data.templates ?? []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save template");
      } finally {
        setSavingTemplate(false);
      }
    },
    [kgScopeDraft, launchPreset, selectedPersona],
  );

  const sortWorkspaceEntries = useCallback((entries: AgentWorkspaceEntry[]) => {
    return [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, []);

  const toExplorerNodes = useCallback(
    (entries: AgentWorkspaceEntry[]): ExplorerNode[] =>
      sortWorkspaceEntries(entries).map((entry) => ({ ...entry, id: entry.path || "__root__" })),
    [sortWorkspaceEntries],
  );

  const updateExplorerNode = useCallback(
    (nodes: ExplorerNode[], targetId: string, updater: (node: ExplorerNode) => ExplorerNode): ExplorerNode[] =>
      nodes.map((node) => {
        if (node.id === targetId) {
          return updater(node);
        }
        if (node.children?.length) {
          return { ...node, children: updateExplorerNode(node.children, targetId, updater) };
        }
        return node;
      }),
    [],
  );

  const fetchWorkspaceEntries = useCallback(async (workspaceId: string, nextPath: string) => {
    const params = new URLSearchParams();
    if (nextPath) params.set("path", nextPath);
    const response = await fetch(
      `/api/agent-hq/workspaces/${encodeURIComponent(workspaceId)}/entries?${params.toString()}`,
      { cache: "no-store" },
    );
    const data = (await response.json().catch(() => ({}))) as {
      entries?: AgentWorkspaceEntry[];
      relativePath?: string;
      error?: string;
    };
    if (!response.ok || data.error) {
      throw new Error(data.error || `Failed to load workspace entries (${response.status})`);
    }
    return {
      entries: data.entries ?? [],
      relativePath: data.relativePath ?? nextPath,
    };
  }, []);

  const loadWorkspaceTreeRoot = useCallback(async (workspaceId: string, rootPath: string) => {
    if (!workspaceId) return;
    setFsLoading(true);
    setFsFileMessage(null);
    try {
      const result = await fetchWorkspaceEntries(workspaceId, rootPath);
      setFsRootPath(result.relativePath);
      setFsTree(toExplorerNodes(result.entries));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspace tree");
    } finally {
      setFsLoading(false);
    }
  }, [fetchWorkspaceEntries, toExplorerNodes]);

  const toggleWorkspaceDirectory = useCallback(async (node: ExplorerNode) => {
    if (!selectedWorkspace || node.type !== "directory") return;
    if (node.expanded) {
      setFsTree((current) => updateExplorerNode(current, node.id, (entry) => ({ ...entry, expanded: false })));
      return;
    }
    if (node.loaded) {
      setFsTree((current) => updateExplorerNode(current, node.id, (entry) => ({ ...entry, expanded: true })));
      return;
    }
    setFsTree((current) =>
      updateExplorerNode(current, node.id, (entry) => ({ ...entry, expanded: true, loading: true })),
    );
    try {
      const result = await fetchWorkspaceEntries(selectedWorkspace.id, node.path);
      const children = toExplorerNodes(result.entries);
      setFsTree((current) =>
        updateExplorerNode(current, node.id, (entry) => ({
          ...entry,
          expanded: true,
          loading: false,
          loaded: true,
          children,
        })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load directory");
      setFsTree((current) =>
        updateExplorerNode(current, node.id, (entry) => ({ ...entry, loading: false })),
      );
    }
  }, [fetchWorkspaceEntries, selectedWorkspace, toExplorerNodes, updateExplorerNode]);

  const loadWorkspaceFile = useCallback(async (targetPath: string) => {
    if (!selectedWorkspace || !targetPath) return;
    setFsFileLoading(true);
    setFsFileMessage(null);
    try {
      const params = new URLSearchParams({ path: targetPath });
      const response = await fetch(
        `/api/agent-hq/workspaces/${encodeURIComponent(selectedWorkspace.id)}/file?${params.toString()}`,
        { cache: "no-store" },
      );
      const data = (await response.json().catch(() => ({}))) as { content?: string; error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to load file (${response.status})`);
      }
      setFsSelectedFile(targetPath);
      setFsFileContent(data.content ?? "");
      setFsFileMessage(`Loaded ${targetPath}`);
    } catch (err) {
      setFsFileMessage(err instanceof Error ? err.message : "Failed to load file");
    } finally {
      setFsFileLoading(false);
    }
  }, [selectedWorkspace]);

  const addGlobalScope = useCallback(() => {
    const next = kgScopeInput.trim();
    if (!next) return;
    const merged = Array.from(new Set([...parseKgScopeSet(kgScopeDraft), next]));
    setKgScopeDraft(merged.join(","));
    setKgScopeInput("");
  }, [kgScopeDraft, kgScopeInput]);

  const removeGlobalScope = useCallback((scope: string) => {
    const next = parseKgScopeSet(kgScopeDraft).filter((entry) => entry !== scope);
    setKgScopeDraft(next.join(","));
  }, [kgScopeDraft]);

  const addPaneScope = useCallback((paneKey: string) => {
    const value = (paneScopeInput[paneKey] ?? "").trim();
    if (!value) return;
    setPaneScopesDrafts((prev) => {
      const current = prev[paneKey] ?? [];
      return { ...prev, [paneKey]: Array.from(new Set([...current, value])) };
    });
    setPaneScopeInput((prev) => ({ ...prev, [paneKey]: "" }));
  }, [paneScopeInput]);

  const removePaneScope = useCallback((paneKey: string, scope: string) => {
    setPaneScopesDrafts((prev) => ({
      ...prev,
      [paneKey]: (prev[paneKey] ?? []).filter((entry) => entry !== scope),
    }));
  }, []);

  const toggleMountedPath = useCallback((paneKey: string, targetPath: string) => {
    setPaneMountedPathsDrafts((prev) => {
      const current = prev[paneKey] ?? [];
      const next = current.includes(targetPath)
        ? current.filter((entry) => entry !== targetPath)
        : [...current, targetPath];
      return { ...prev, [paneKey]: next };
    });
  }, []);

  const savePaneContext = useCallback(
    async (session: AgentSession) => {
      const paneKey = paneKeyForSession(session);
      const personaId = (panePersonaDrafts[paneKey] ?? "").trim();
      const persona = personas.find((entry) => entry.id === personaId);
      setSavingPaneKey(paneKey);
      try {
        const response = await fetch("/api/agent-hq/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paneKey,
            personaId: personaId || null,
            personaName: persona?.name,
            kgScopeSet: paneScopesDrafts[paneKey]?.length
              ? paneScopesDrafts[paneKey]
              : ["person:self"],
            mountedPaths: paneMountedPathsDrafts[paneKey] ?? session.metadata.mountedPaths ?? [],
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to save pane context for ${paneKey}`);
        }
        await fetch("/api/agent-hq/reload-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paneKey }),
        });
        await captureSession(paneKey);
        await refresh(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save pane context");
      } finally {
        setSavingPaneKey((current) => (current === paneKey ? null : current));
      }
    },
    [captureSession, paneMountedPathsDrafts, panePersonaDrafts, paneScopesDrafts, personas, refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!workspaceId) return;
    if (workspaces.some((workspace) => workspace.id === workspaceId)) {
      setSelectedWorkspaceId(workspaceId);
    }
  }, [workspaceId, workspaces]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setFsTree([]);
      setFsSelectedFile("");
      setFsFileContent("");
      setFsFileMessage(null);
      return;
    }
    setFsRootPath("");
    void loadWorkspaceTreeRoot(selectedWorkspace.id, "");
  }, [loadWorkspaceTreeRoot, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace?.id) return;
    void loadWorkspaceTreeRoot(selectedWorkspace.id, fsRootPath);
  }, [fsRootPath, loadWorkspaceTreeRoot, selectedWorkspace]);

  useEffect(() => {
    if (!selectedWorkspace || !fsSelectedFile) return;
    void loadWorkspaceFile(fsSelectedFile);
  }, [fsSelectedFile, loadWorkspaceFile, selectedWorkspace]);

  const workspaceSessions = useMemo(() => {
    if (!selectedWorkspace) return sessions;
    const exact = sessions.filter((session) => session.metadata.workspaceId === selectedWorkspace.id);
    if (exact.length > 0) return exact;
    // Backward-compat fallback: older/legacy panes may not carry workspaceId metadata.
    const unlabeled = sessions.filter((session) => !session.metadata.workspaceId);
    return unlabeled.length > 0 ? unlabeled : exact;
  }, [selectedWorkspace, sessions]);
  

  const primarySession = useMemo(() => {
    return [...workspaceSessions].sort((a, b) => {
      return architectRank(a) - architectRank(b) || paneKeyForSession(a).localeCompare(paneKeyForSession(b));
    })[0] ?? null;
  }, [workspaceSessions]);

  const teamSessions = useMemo(() => {
    if (!primarySession) return workspaceSessions;
    const primaryKey = paneKeyForSession(primarySession);
    return workspaceSessions.filter((session) => paneKeyForSession(session) !== primaryKey);
  }, [primarySession, workspaceSessions]);
  const primaryPaneKey = useMemo(
    () => (primarySession ? paneKeyForSession(primarySession) : ""),
    [primarySession],
  );
  const selectedContextSession = useMemo(
    () => workspaceSessions.find((session) => paneKeyForSession(session) === selectedContextPaneKey) ?? primarySession,
    [primarySession, selectedContextPaneKey, workspaceSessions],
  );
  const teamChildrenMap = useMemo(() => buildChildrenMap(workspaceSessions), [workspaceSessions]);
  const topLevelTeamSessions = useMemo(() => {
    if (!primarySession) return teamSessions;
    const primaryKey = paneKeyForSession(primarySession);
    const direct = teamChildrenMap.get(primaryKey);
    if (direct && direct.length > 0) return direct;
    return teamSessions.filter((session) => !session.metadata.parent);
  }, [primarySession, teamChildrenMap, teamSessions]);

  useEffect(() => {
    const availablePaneKeys = workspaceSessions.map((session) => paneKeyForSession(session));
    if (availablePaneKeys.length === 0) {
      setSelectedContextPaneKey("");
      return;
    }
    setSelectedContextPaneKey((current) => {
      if (current && availablePaneKeys.includes(current)) return current;
      return primaryPaneKey || availablePaneKeys[0] || "";
    });
  }, [primaryPaneKey, workspaceSessions]);

  /* Differential refresh: primary pane at 2s, team panes at 4s */
  useEffect(() => {
    const primaryTimer = window.setInterval(() => {
      if (primarySession) {
        const pk = paneKeyForSession(primarySession);
        void captureSession(pk);
      }
    }, PRIMARY_REFRESH_INTERVAL_MS);

    const teamTimer = window.setInterval(() => {
      for (const session of teamSessions) {
        const pk = paneKeyForSession(session);
        void captureSession(pk);
      }
    }, TEAM_REFRESH_INTERVAL_MS);

    const sessionsTimer = window.setInterval(() => {
      void refresh(true);
    }, TEAM_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(primaryTimer);
      window.clearInterval(teamTimer);
      window.clearInterval(sessionsTimer);
    };
  }, [captureSession, primarySession, refresh, teamSessions]);

  // Sync buffered output to xterm panes after they mount or re-mount
  useEffect(() => {
    for (const [paneKey, output] of Object.entries(outputs)) {
      if (output) {
        paneRefs.current[paneKey]?.writeRaw(output);
      }
    }
  }, [outputs]);

  const installedProviders = useMemo(
    () =>
      new Set<AgentLauncherProvider>(
        launchers.filter((launcher) => launcher.installed).map((launcher) => launcher.provider),
      ),
    [launchers],
  );
  const executiveDefaultProvider = useMemo(
    () => pickProvider(installedProviders, ["codex", "opencode", "claude"]),
    [installedProviders],
  );
  const visionaryDefaultProvider = useMemo(
    () => pickProvider(installedProviders, ["codex", "opencode", "claude"]),
    [installedProviders],
  );
  const architectDefaultProvider = useMemo(
    () => pickProvider(installedProviders, ["claude", "opencode", "codex"]),
    [installedProviders],
  );
  const teamDefaultProvider = useMemo(
    () => pickProvider(installedProviders, ["claude", "opencode", "codex"]),
    [installedProviders],
  );

  const sendToSession = useCallback(
    async (session: AgentSession) => {
      const paneKey = paneKeyForSession(session);
      const text = drafts[paneKey]?.trim();
      if (!text) return;
      setSendingKey(paneKey);
      try {
        const attemptSend = async (target: string) => {
          const response = await fetch("/api/agent-hq/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target, text, enter: true }),
          });
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          return { response, data };
        };

        let target = paneKey;
        let { response, data } = await attemptSend(target);

        if (!response.ok && response.status === 409) {
          await refresh(true);
          const remapped = sessions.find((candidate) => candidate.sessionName === session.sessionName);
          if (remapped) {
            target = paneKeyForSession(remapped);
            ({ response, data } = await attemptSend(target));
          }
        }

        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to send to ${target} (${response.status})`);
        }
        const history = commandHistoryRef.current[paneKey] ?? [];
        history.push(text);
        commandHistoryRef.current[paneKey] = history;
        commandHistoryIndexRef.current[paneKey] = history.length;
        setDrafts((prev) => ({ ...prev, [paneKey]: "" }));
        await captureSession(target);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send input");
      } finally {
        setSendingKey((current) => (current === paneKey ? null : current));
      }
    },
    [captureSession, drafts, refresh, sessions],
  );

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>, session: AgentSession) => {
      const paneKey = paneKeyForSession(session);
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void sendToSession(session);
        return;
      }
      const history = commandHistoryRef.current[paneKey] ?? [];
      if (history.length === 0) return;
      if (event.key === "ArrowUp") {
        event.preventDefault();
        const currentIndex = commandHistoryIndexRef.current[paneKey] ?? history.length;
        const nextIndex = Math.max(0, currentIndex - 1);
        commandHistoryIndexRef.current[paneKey] = nextIndex;
        setDrafts((prev) => ({ ...prev, [paneKey]: history[nextIndex] ?? "" }));
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        const currentIndex = commandHistoryIndexRef.current[paneKey] ?? history.length;
        const nextIndex = Math.min(history.length, currentIndex + 1);
        commandHistoryIndexRef.current[paneKey] = nextIndex;
        setDrafts((prev) => ({ ...prev, [paneKey]: nextIndex >= history.length ? "" : (history[nextIndex] ?? "") }));
      }
    },
    [sendToSession],
  );

  const handlePaneDragStart = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startHeight = primaryDragHeight ?? (parseInt(PANE_SIZE_HEIGHTS[primaryPaneSize]) || 360);
      dragStartRef.current = { y: event.clientY, height: startHeight };
      const onMove = (moveEvent: MouseEvent) => {
        if (!dragStartRef.current) return;
        const delta = moveEvent.clientY - dragStartRef.current.y;
        const newHeight = Math.max(120, Math.min(900, dragStartRef.current.height + delta));
        setPrimaryDragHeight(newHeight);
      };
      const onUp = () => {
        dragStartRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [primaryDragHeight, primaryPaneSize],
  );

  const sendChoiceToSession = useCallback(
    async (session: AgentSession, choice: string) => {
      const paneKey = paneKeyForSession(session);
      setSendingKey(paneKey);
      try {
        const response = await fetch("/api/agent-hq/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: paneKey, text: choice, enter: true }),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok || data.error) {
          if (response.status === 409) {
            await refresh(true);
          }
          throw new Error(data.error || `Failed to send choice to ${paneKey} (${response.status})`);
        }
        await captureSession(paneKey);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send choice");
      } finally {
        setSendingKey((current) => (current === paneKey ? null : current));
      }
    },
    [captureSession, refresh],
  );

  const reloadPaneContext = useCallback(
    async (session: AgentSession) => {
      const paneKey = paneKeyForSession(session);
      setReloadingPaneKey(paneKey);
      try {
        const response = await fetch("/api/agent-hq/reload-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paneKey }),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to reload context for ${paneKey}`);
        }
        await captureSession(paneKey);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to reload context");
      } finally {
        setReloadingPaneKey((current) => (current === paneKey ? null : current));
      }
    },
    [captureSession],
  );

  const launchExecutive = useCallback(async () => {
    if (!selectedWorkspace) {
      setError("Select a workspace first.");
      return;
    }
    if (!executiveDefaultProvider) {
      setError("No agent runtime is installed in this app context. Install Codex, Claude, or OpenCode.");
      return;
    }
    setLaunching(true);
    try {
      const response = await fetch("/api/agent-hq/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: executiveDefaultProvider,
          workspaceId: selectedWorkspace.id,
          cwd: selectedWorkspace.cwd,
          displayLabel: `${selectedWorkspace.label} Executive`,
          role: "executive",
          parent: null,
          objective: `Act as the user-facing executive for ${selectedWorkspace.label}. Keep responses concise, delegate implementation, and report progress clearly.`,
          notes: `Primary interactive pane. ${getArchitectNotes(selectedWorkspace.scope, selectedWorkspace.liveSubdomain, launchPreset)}`,
          capabilityIds:
            selectedWorkspace.scope === "foundation"
              ? ["foundation_read", "foundation_deploy", "deploy", "dns", "git"]
              : ["edit", "git", "deploy", "kg_read"],
          personaId: selectedPersona?.id ?? null,
          personaName: selectedPersona?.name,
          kgScopeSet: parseKgScopeSet(kgScopeDraft),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || "Failed to launch executive");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch executive");
    } finally {
      setLaunching(false);
    }
  }, [executiveDefaultProvider, kgScopeDraft, launchPreset, refresh, selectedPersona, selectedWorkspace]);

  const launchExecutiveTeam = useCallback(async () => {
    if (!selectedWorkspace) {
      setError("Select a workspace first.");
      return;
    }
    if (!executiveDefaultProvider || !visionaryDefaultProvider || !architectDefaultProvider || !teamDefaultProvider) {
      setError("Missing required runtimes for defaults. Need Codex/Claude (or fallback runtime) installed.");
      return;
    }
    const kgScopeSet = parseKgScopeSet(kgScopeDraft);
    const basePayload = {
      workspaceId: selectedWorkspace.id,
      cwd: selectedWorkspace.cwd,
      personaId: selectedPersona?.id ?? null,
      personaName: selectedPersona?.name,
      kgScopeSet,
      capabilityIds:
        selectedWorkspace.scope === "foundation"
          ? ["foundation_read", "foundation_deploy", "deploy", "dns", "git"]
          : ["edit", "git", "deploy", "kg_read"],
    };

    async function launchNode(payload: Record<string, unknown>) {
      const response = await fetch("/api/agent-hq/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => ({}))) as {
        paneKey?: string;
        error?: string;
      };
      if (!response.ok || data.error || !data.paneKey) {
        throw new Error(data.error || "Failed to launch team node");
      }
      return data.paneKey;
    }

    setLaunching(true);
    try {
      const executivePane = await launchNode({
        ...basePayload,
        provider: executiveDefaultProvider,
        displayLabel: `${selectedWorkspace.label} Executive`,
        role: "executive",
        parent: null,
        objective: `Act as the user-facing executive for ${selectedWorkspace.label}. Keep interaction concise and clear, then delegate implementation to the architect team.`,
        notes: `Primary interactive pane. Persona: ${selectedPersona?.name ?? "main profile"}.`,
      });

      await launchNode({
        ...basePayload,
        provider: visionaryDefaultProvider,
        displayLabel: `${selectedWorkspace.label} Visionary`,
        role: "observer",
        parent: executivePane,
        objective:
          "Operate as the visionary lane. Synthesize long-arc direction and advise executive/architect decisions.",
        notes: "Visionary defaults to Codex when available.",
      });

      const architectPane = await launchNode({
        ...basePayload,
        provider: architectDefaultProvider,
        displayLabel: `${selectedWorkspace.label} Architect`,
        role: "architect",
        parent: executivePane,
        objective:
          launchPreset === "guide_builder"
            ? `Lead Guide delivery for ${selectedWorkspace.label}. Compile user asks into adaptive manifest-driven surfaces and orchestrate safe implementation.`
            : `Lead delivery for ${selectedWorkspace.label}. Decompose user goals into orchestrated worker tasks and keep progress visible.`,
        notes: getArchitectNotes(selectedWorkspace.scope, selectedWorkspace.liveSubdomain, launchPreset),
      });

      const orchestratorPane = await launchNode({
        ...basePayload,
        provider: teamDefaultProvider,
        displayLabel: `${selectedWorkspace.label} Orchestrator`,
        role: "orchestrator",
        parent: architectPane,
        objective:
          launchPreset === "guide_builder"
            ? "Coordinate Guide worker execution: surface assembly, data bindings, gate checks, and deploy readiness."
            : "Coordinate worker execution, track blockers, and report concise status to the architect.",
        notes: "Do not bypass architect decisions. Keep work scoped to this workspace.",
      });

      await Promise.all([
        launchNode({
          ...basePayload,
          provider: teamDefaultProvider,
          displayLabel: `${selectedWorkspace.label} Worker A`,
          role: "worker",
          parent: orchestratorPane,
          objective:
            launchPreset === "guide_builder"
              ? "Implement adaptive UI blocks and front-end integration for Guide manifests."
              : "Implement UI and client-side changes assigned by the orchestrator.",
          notes: "Focus on user-facing surfaces and preserve existing patterns.",
        }),
        launchNode({
          ...basePayload,
          provider: teamDefaultProvider,
          displayLabel: `${selectedWorkspace.label} Worker B`,
          role: "worker",
          parent: orchestratorPane,
          objective:
            launchPreset === "guide_builder"
              ? "Implement Guide API/data/model work, including policy checks and binding integrity."
              : "Implement API/data/model changes assigned by the orchestrator.",
          notes: "Focus on server logic, contracts, and verification.",
        }),
      ]);

      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch executive team");
    } finally {
      setLaunching(false);
    }
  }, [
    architectDefaultProvider,
    executiveDefaultProvider,
    kgScopeDraft,
    launchPreset,
    refresh,
    selectedPersona,
    selectedWorkspace,
    teamDefaultProvider,
    visionaryDefaultProvider,
  ]);

  const renderTerminalPane = useCallback(
    (paneKey: string, session: AgentSession, opts: { maxHeight: string; isPrimary?: boolean }) => {
      const output = outputs[paneKey] || "";
      const choices = extractChoices(output);
      return (
        <>
          <div
            className="relative rounded-lg border border-slate-700/60 bg-[#0d1117] shadow-inner"
            onMouseEnter={() => interactionLocksRef.current.add(paneKey)}
            onMouseLeave={() => interactionLocksRef.current.delete(paneKey)}
          >
            <div className="flex items-center justify-between border-b border-slate-700/40 px-3 py-1">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: session.active ? "#3fb950" : "#484f58" }} />
                <span className="text-[10px] text-slate-500" style={{ fontFamily: TERMINAL_FONT_STACK }}>{paneKey}</span>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-slate-500 hover:text-slate-300"
                  onClick={() => void reloadPaneContext(session)}
                  title="Reload session context"
                  disabled={reloadingPaneKey === paneKey}
                >
                  {reloadingPaneKey === paneKey ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Bot className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-slate-500 hover:text-slate-300"
                  onClick={() => void manualRefreshPane(paneKey)}
                  title="Refresh this pane now"
                >
                  <RefreshCw className="h-3 w-3" />
                </Button>
              </div>
            </div>
            <XTermPane
              ref={(handle) => { paneRefs.current[paneKey] = handle; }}
              maxHeight={opts.maxHeight}
              active={session.active}
            />
          </div>
          {choices.length > 0 && (
            <div className="flex flex-wrap gap-2 pt-1">
              {choices.map((choice) => (
                <Button key={choice} type="button" variant="outline" size="sm" onClick={() => void sendChoiceToSession(session, choice)}>
                  Send {choice}
                </Button>
              ))}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2">
            <div className="relative flex-1">
              <span
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-500"
                style={{ fontFamily: TERMINAL_FONT_STACK }}
              >
                $
              </span>
              <Input
                ref={(el) => { inputRefsMap.current[paneKey] = el; }}
                value={drafts[paneKey] ?? ""}
                onChange={(event) => setDrafts((prev) => ({ ...prev, [paneKey]: event.target.value }))}
                onKeyDown={(event) => handleInputKeyDown(event, session)}
                onFocus={() => interactionLocksRef.current.add(paneKey)}
                onBlur={() => interactionLocksRef.current.delete(paneKey)}
                placeholder={opts.isPrimary ? "Tell the architect what to do next" : "Send to this pane"}
                className="h-9 bg-[#0d1117] pl-7 text-[#c9d1d9] placeholder:text-slate-600 border-slate-700/60"
                style={{ fontFamily: TERMINAL_FONT_STACK, fontSize: "12px" }}
              />
            </div>
            <Button
              variant="outline"
              className="h-9 gap-1.5 border-slate-700/60"
              onClick={() => void sendToSession(session)}
              disabled={sendingKey === paneKey}
            >
              {sendingKey === paneKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send
            </Button>
          </div>
        </>
      );
    },
    [
      drafts,
      handleInputKeyDown,
      manualRefreshPane,
      outputs,
      reloadPaneContext,
      reloadingPaneKey,
      sendChoiceToSession,
      sendToSession,
      sendingKey,
    ],
  );

  const renderTeamNode = useCallback(
    (session: AgentSession, depth = 0) => {
      const paneKey = paneKeyForSession(session);
      const children = teamChildrenMap.get(paneKey) ?? [];
      const panePersonaId = panePersonaDrafts[paneKey] ?? session.metadata.personaId ?? "";
      const paneScopes = paneScopesDrafts[paneKey] ?? session.metadata.kgScopeSet ?? ["person:self"];
      return (
        <div key={paneKey} className="space-y-3">
          <div className="rounded-xl border bg-card p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{session.metadata.label || paneKey}</p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {session.metadata.role} · {session.metadata.cwd || paneKey}
                </p>
              </div>
              <Badge variant={session.active ? "default" : "secondary"}>
                {session.active ? "active" : "idle"}
              </Badge>
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {session.metadata.personaName || session.metadata.personaId ? (
                <Badge variant="outline" className="text-[10px]">
                  persona: {session.metadata.personaName ?? session.metadata.personaId}
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[10px]">
                  persona: main
                </Badge>
              )}
              <Badge variant="outline" className="max-w-full truncate text-[10px]">
                kg: {formatKgScopes(session.metadata.kgScopeSet)}
              </Badge>
            </div>
            <div className="mb-2 grid gap-2 md:grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)_auto]">
              <select
                value={panePersonaId}
                onChange={(event) =>
                  setPanePersonaDrafts((prev) => ({ ...prev, [paneKey]: event.target.value }))
                }
                className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none"
              >
                <option value="">Main profile context</option>
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    Persona: {persona.name}
                  </option>
                ))}
              </select>
              <div className="flex items-center gap-1.5">
                <Input
                  value={paneScopeInput[paneKey] ?? ""}
                  onChange={(event) =>
                    setPaneScopeInput((prev) => ({ ...prev, [paneKey]: event.target.value }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addPaneScope(paneKey);
                    }
                  }}
                  list={`kg-scope-options-${paneKey}`}
                  placeholder="Add KG scope"
                  className="h-8 text-xs"
                />
                <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => addPaneScope(paneKey)}>
                  Add
                </Button>
                <datalist id={`kg-scope-options-${paneKey}`}>
                  {kgScopeOptions.map((scope) => (
                    <option key={scope} value={scope} />
                  ))}
                </datalist>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={() => void savePaneContext(session)}
                disabled={savingPaneKey === paneKey}
              >
                {savingPaneKey === paneKey ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                Save Context
              </Button>
            </div>
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {paneScopes.map((scope) => (
                <Badge key={`${paneKey}-${scope}`} variant="secondary" className="max-w-[220px] gap-1 truncate pr-1 text-[10px]">
                  <span className="truncate">{scope}</span>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-black/10"
                    onClick={() => removePaneScope(paneKey, scope)}
                    aria-label={`Remove ${scope}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              ))}
            </div>
            {renderTerminalPane(paneKey, session, { maxHeight: "160px" })}
          </div>
          {children.length > 0 ? (
            <div className={`grid gap-3 pl-4 border-l ${depth === 0 ? "lg:grid-cols-2" : ""}`}>
              {children.map((child) => renderTeamNode(child, depth + 1))}
            </div>
          ) : null}
        </div>
      );
    },
    [
      addPaneScope,
      kgScopeOptions,
      panePersonaDrafts,
      paneScopeInput,
      paneScopesDrafts,
      personas,
      removePaneScope,
      renderTerminalPane,
      savePaneContext,
      savingPaneKey,
      teamChildrenMap,
    ],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b bg-muted/20 px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Agent HQ</h3>
            <p className="text-xs text-muted-foreground">
              Executive-first terminal view. All panes are real tmux/OpenCode sessions you can type into directly.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void launchExecutive()}
              disabled={launching || !selectedWorkspace}
            >
              {launching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bot className="h-3.5 w-3.5" />}
              Launch Executive
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void launchExecutiveTeam()}
              disabled={launching || !selectedWorkspace}
            >
              {launching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Users className="h-3.5 w-3.5" />}
              Launch Exec Team
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={selectedWorkspaceId}
            onChange={(event) => setSelectedWorkspaceId(event.target.value)}
            disabled={Boolean(workspaceId)}
            className="h-9 min-w-[220px] rounded-md border border-input bg-background px-3 text-sm outline-none"
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.label} · {workspace.scope}
              </option>
            ))}
          </select>
          {selectedWorkspace && (
            <>
              <Badge variant="outline">{selectedWorkspace.scope}</Badge>
              {selectedWorkspace.liveSubdomain ? <Badge variant="outline">{selectedWorkspace.liveSubdomain}</Badge> : null}
              {executiveDefaultProvider ? <Badge variant="outline">exec: {executiveDefaultProvider}</Badge> : null}
              {architectDefaultProvider ? <Badge variant="outline">architect/team: {architectDefaultProvider}</Badge> : null}
              {workspaceId ? <Badge variant="outline">locked to app context</Badge> : null}
            </>
          )}
          {lastUpdatedAt ? (
            <span className="text-xs text-muted-foreground">
              Updated {new Date(lastUpdatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">
            panes: {workspaceSessions.length}/{sessions.length}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={selectedPersonaId}
            onChange={(event) => {
              const nextId = event.target.value;
              setSelectedPersonaId(nextId);
              const currentScopes = parseKgScopeSet(kgScopeDraft).filter((scope) => !scope.startsWith("persona:"));
              const merged = nextId ? Array.from(new Set([...currentScopes, `persona:${nextId}`])) : currentScopes;
              setKgScopeDraft((merged.length > 0 ? merged : ["person:self"]).join(","));
            }}
            className="h-9 min-w-[220px] rounded-md border border-input bg-background px-3 text-sm outline-none"
          >
            <option value="">Main profile context</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                Persona: {persona.name}
              </option>
            ))}
          </select>
          <div className="flex min-w-[260px] flex-1 flex-wrap items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1.5">
            {parseKgScopeSet(kgScopeDraft).map((scope) => (
              <Badge key={scope} variant="secondary" className="max-w-[220px] gap-1 truncate pr-1 text-[10px]">
                <span className="truncate">{scope}</span>
                <button
                  type="button"
                  className="rounded p-0.5 hover:bg-black/10"
                  onClick={() => removeGlobalScope(scope)}
                  aria-label={`Remove ${scope}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            ))}
            <Input
              value={kgScopeInput}
              onChange={(event) => setKgScopeInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addGlobalScope();
                }
              }}
              list="kg-scope-options-global"
              placeholder="Add KG scope"
              className="h-7 min-w-[180px] flex-1 border-0 bg-transparent px-1 text-xs shadow-none focus-visible:ring-0"
            />
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={addGlobalScope}>
              Add
            </Button>
            <datalist id="kg-scope-options-global">
              {kgScopeOptions.map((scope) => (
                <option key={scope} value={scope} />
              ))}
            </datalist>
          </div>
          <span className="text-xs text-muted-foreground">KG scopes</span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={launchPreset}
            onChange={(event) => setLaunchPreset(event.target.value as LaunchPreset)}
            className="h-9 min-w-[200px] rounded-md border border-input bg-background px-3 text-sm outline-none"
          >
            <option value="default">Preset: Default</option>
            <option value="guide_builder">Preset: Guide Builder Team</option>
          </select>
          <select
            value={selectedTemplateId}
            onChange={(event) => applyTemplate(event.target.value)}
            className="h-9 min-w-[240px] rounded-md border border-input bg-background px-3 text-sm outline-none"
          >
            <option value="">Apply saved template…</option>
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.name} · {template.mode}
              </option>
            ))}
          </select>
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs"
            onClick={() => void saveCurrentTemplate("architect")}
            disabled={savingTemplate}
          >
            {savingTemplate ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Save Architect Template
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs"
            onClick={() => void saveCurrentTemplate("team")}
            disabled={savingTemplate}
          >
            {savingTemplate ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Save Team Template
          </Button>
        </div>

        {error ? (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {primarySession ? (
          <Card className="border-border/80 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-base">Executive Terminal</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {primarySession.metadata.objective || "Primary tmux-backed executive session for this workspace."}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 rounded-md border border-input p-0.5">
                    {(["compact", "normal", "expanded"] as const).map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={() => { setPrimaryPaneSize(size); setPrimaryDragHeight(null); }}
                        className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
                          primaryPaneSize === size && primaryDragHeight === null
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        {size.charAt(0).toUpperCase() + size.slice(1)}
                      </button>
                    ))}
                  </div>
                  <Badge variant="outline">{primarySession.metadata.role}</Badge>
                  <Badge variant="outline">
                    persona: {primarySession.metadata.personaName ?? primarySession.metadata.personaId ?? "main"}
                  </Badge>
                  <Badge variant="outline" className="max-w-[280px] truncate">
                    kg: {formatKgScopes(primarySession.metadata.kgScopeSet)}
                  </Badge>
                  <Badge variant={primarySession.active ? "default" : "secondary"}>
                    {primarySession.active ? "active" : "idle"}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-2 md:grid-cols-[minmax(180px,1fr)_minmax(220px,1fr)_auto]">
                <select
                  value={panePersonaDrafts[primaryPaneKey] ?? primarySession.metadata.personaId ?? ""}
                  onChange={(event) =>
                    setPanePersonaDrafts((prev) => ({ ...prev, [primaryPaneKey]: event.target.value }))
                  }
                  className="h-8 rounded-md border border-input bg-background px-2 text-xs outline-none"
                >
                  <option value="">Main profile context</option>
                  {personas.map((persona) => (
                    <option key={persona.id} value={persona.id}>
                      Persona: {persona.name}
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1.5">
                  <Input
                    value={paneScopeInput[primaryPaneKey] ?? ""}
                    onChange={(event) =>
                      setPaneScopeInput((prev) => ({ ...prev, [primaryPaneKey]: event.target.value }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addPaneScope(primaryPaneKey);
                      }
                    }}
                    list="kg-scope-options-primary"
                    placeholder="Add KG scope"
                    className="h-8 text-xs"
                  />
                  <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => addPaneScope(primaryPaneKey)}>
                    Add
                  </Button>
                  <datalist id="kg-scope-options-primary">
                    {kgScopeOptions.map((scope) => (
                      <option key={scope} value={scope} />
                    ))}
                  </datalist>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => void savePaneContext(primarySession)}
                  disabled={savingPaneKey === primaryPaneKey}
                >
                  {savingPaneKey === primaryPaneKey ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}
                  Save Context
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {(paneScopesDrafts[primaryPaneKey] ?? primarySession.metadata.kgScopeSet ?? ["person:self"]).map((scope) => (
                  <Badge key={`${primaryPaneKey}-${scope}`} variant="secondary" className="max-w-[220px] gap-1 truncate pr-1 text-[10px]">
                    <span className="truncate">{scope}</span>
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-black/10"
                      onClick={() => removePaneScope(primaryPaneKey, scope)}
                      aria-label={`Remove ${scope}`}
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </Badge>
                ))}
              </div>
              {renderTerminalPane(primaryPaneKey, primarySession, {
                maxHeight: primaryDragHeight !== null ? `${primaryDragHeight}px` : PANE_SIZE_HEIGHTS[primaryPaneSize],
                isPrimary: true,
              })}
              <div
                onMouseDown={handlePaneDragStart}
                className="mx-auto flex h-4 w-16 cursor-row-resize items-center justify-center rounded-b-md text-slate-500 hover:text-slate-300 transition-colors"
                title="Drag to resize pane"
              >
                <GripHorizontal className="h-3.5 w-3.5" />
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed border-border/70 shadow-sm">
            <CardContent className="flex flex-col gap-3 p-6">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Bot className="h-4 w-4" />
                No executive session yet for this workspace
              </div>
              <p className="text-sm text-muted-foreground">
                Launch a primary executive to use as your main interactive terminal, then add the background team panes.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void launchExecutive()} disabled={launching || !selectedWorkspace}>
                  {launching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Launch Executive
                </Button>
                <Button variant="outline" onClick={() => void launchExecutiveTeam()} disabled={launching || !selectedWorkspace}>
                  {launching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  Launch Executive Team
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="border-border/80 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4" />
              <CardTitle className="text-sm">Org Chart Terminals</CardTitle>
            </div>
            <p className="text-xs text-muted-foreground">
              Child panes mirror your team structure under the executive. Each pane includes role, persona, and KG scope.
            </p>
          </CardHeader>
          <CardContent>
            {teamSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No additional panes attached to this workspace yet.</p>
            ) : (
              <div className="space-y-4">
                {topLevelTeamSessions.map((session) => renderTeamNode(session))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/80 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Context Mounts</CardTitle>
            <p className="text-xs text-muted-foreground">
              Select an agent pane, then append or remove folders and files from that live session using the filesystem browser on the left.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedContextPaneKey}
                onChange={(event) => setSelectedContextPaneKey(event.target.value)}
                className="h-9 min-w-[260px] rounded-md border border-input bg-background px-3 text-sm outline-none"
              >
                {workspaceSessions.map((session) => {
                  const paneKey = paneKeyForSession(session);
                  return (
                    <option key={paneKey} value={paneKey}>
                      {session.metadata.label || paneKey} · {session.metadata.role}
                    </option>
                  );
                })}
              </select>
              <Input
                value={fsRootPath || "/"}
                onChange={(event) => setFsRootPath(event.target.value === "/" ? "" : event.target.value)}
                className="h-9 min-w-[180px] flex-1 text-xs"
              />
              <Button
                variant="outline"
                className="h-9"
                onClick={() => selectedWorkspace && void loadWorkspaceTreeRoot(selectedWorkspace.id, fsRootPath)}
                disabled={!selectedWorkspace || fsLoading}
              >
                {fsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Refresh"}
              </Button>
              {selectedContextSession ? (
                <Button
                  className="h-9"
                  onClick={() => void savePaneContext(selectedContextSession)}
                  disabled={savingPaneKey === selectedContextPaneKey}
                >
                  {savingPaneKey === selectedContextPaneKey ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                  Apply Mounts
                </Button>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {(paneMountedPathsDrafts[selectedContextPaneKey] ?? selectedContextSession?.metadata.mountedPaths ?? []).map((mountedPath) => (
                <Badge key={`${selectedContextPaneKey}-${mountedPath}`} variant="secondary" className="max-w-[320px] gap-1 truncate pr-1 text-[10px]">
                  <span className="truncate">{mountedPath}</span>
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-black/10"
                    onClick={() => toggleMountedPath(selectedContextPaneKey, mountedPath)}
                    aria-label={`Remove ${mountedPath}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-xs font-medium text-muted-foreground">Filesystem</p>
                <div className="max-h-[520px] overflow-y-auto rounded-md border bg-muted/20 p-2">
                  <AgentFilesystemTree
                    nodes={fsTree}
                    selectedFile={fsSelectedFile}
                    mountedPaths={paneMountedPathsDrafts[selectedContextPaneKey] ?? selectedContextSession?.metadata.mountedPaths ?? []}
                    onToggleDirectory={(node) => void toggleWorkspaceDirectory(node)}
                    onSelectFile={(node) => void loadWorkspaceFile(node.path)}
                    onToggleMount={(node) => {
                      if (!selectedContextPaneKey) return;
                      toggleMountedPath(selectedContextPaneKey, node.path);
                    }}
                  />
                  {!fsLoading && fsTree.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-muted-foreground">No files in this tree.</p>
                  ) : null}
                </div>
              </div>
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-medium">{fsSelectedFile || "Select a file"}</p>
                </div>
                <textarea
                  value={fsFileContent}
                  readOnly
                  className="min-h-[520px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
                  placeholder={fsFileLoading ? "Loading..." : "Select a file from the left pane."}
                  spellCheck={false}
                />
                {fsFileMessage ? (
                  <p className="text-xs text-muted-foreground">{fsFileMessage}</p>
                ) : null}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
