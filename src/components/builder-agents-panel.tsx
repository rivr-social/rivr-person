"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bot, ChevronDown, ChevronRight, GripHorizontal, Loader2, RefreshCw, Send, Users } from "lucide-react";
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
}

interface AgentSession {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  active: boolean;
  metadata: AgentSessionMetadata;
}

interface AgentSessionsResponse {
  sessions: AgentSession[];
  templates?: AgentSessionTemplate[];
  lastUpdatedAt?: string;
  error?: string;
}

interface AgentCaptureResponse {
  output?: string;
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

function paneKeyForSession(session: Pick<AgentSession, "sessionName" | "windowIndex" | "paneIndex">) {
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
  if (session.metadata.role === "architect") return 1;
  if (session.metadata.role === "orchestrator") return 2;
  if (session.metadata.role === "worker") return 3;
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

export function BuilderAgentsPanel() {
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
  const [showTeam, setShowTeam] = useState(false);
  const [personas, setPersonas] = useState<AgentPersona[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>("");
  const [kgScopeDraft, setKgScopeDraft] = useState<string>("person:self");
  const [launchPreset, setLaunchPreset] = useState<LaunchPreset>("default");
  const [templates, setTemplates] = useState<AgentSessionTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [reloadingPaneKey, setReloadingPaneKey] = useState<string | null>(null);
  const [fileEditorPath, setFileEditorPath] = useState("persona/soul.md");
  const [fileEditorValue, setFileEditorValue] = useState("");
  const [fileEditorLoading, setFileEditorLoading] = useState(false);
  const [fileEditorSaving, setFileEditorSaving] = useState(false);
  const [fileEditorMessage, setFileEditorMessage] = useState<string | null>(null);

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
      setError(null);

      setSelectedWorkspaceId((current) => {
        if (current && (launchersData.workspaces ?? []).some((workspace) => workspace.id === current)) {
          return current;
        }
        return (
          launchersData.workspaces?.find((workspace) => workspace.scope === "app")?.id ??
          launchersData.workspaces?.[0]?.id ??
          ""
        );
      });

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
        (sessionsData.sessions ?? []).map(async (session) => {
          const paneKey = paneKeyForSession(session);
          setDrafts((prev) => (paneKey in prev ? prev : { ...prev, [paneKey]: "" }));
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
  }, [captureSession]);

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

  const loadWorkspaceFile = useCallback(async () => {
    if (!selectedWorkspace || !fileEditorPath.trim()) return;
    setFileEditorLoading(true);
    setFileEditorMessage(null);
    try {
      const params = new URLSearchParams({ path: fileEditorPath.trim() });
      const response = await fetch(
        `/api/agent-hq/workspaces/${encodeURIComponent(selectedWorkspace.id)}/file?${params.toString()}`,
        { cache: "no-store" },
      );
      const data = (await response.json().catch(() => ({}))) as { content?: string; error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to load file (${response.status})`);
      }
      setFileEditorValue(data.content ?? "");
      setFileEditorMessage(`Loaded ${fileEditorPath.trim()}`);
    } catch (err) {
      setFileEditorMessage(err instanceof Error ? err.message : "Failed to load file");
    } finally {
      setFileEditorLoading(false);
    }
  }, [fileEditorPath, selectedWorkspace]);

  const saveWorkspaceFile = useCallback(async () => {
    if (!selectedWorkspace || !fileEditorPath.trim()) return;
    setFileEditorSaving(true);
    setFileEditorMessage(null);
    try {
      const response = await fetch(
        `/api/agent-hq/workspaces/${encodeURIComponent(selectedWorkspace.id)}/file`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: fileEditorPath.trim(),
            content: fileEditorValue,
          }),
        },
      );
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to save file (${response.status})`);
      }
      setFileEditorMessage(`Saved ${fileEditorPath.trim()}`);
    } catch (err) {
      setFileEditorMessage(err instanceof Error ? err.message : "Failed to save file");
    } finally {
      setFileEditorSaving(false);
    }
  }, [fileEditorPath, fileEditorValue, selectedWorkspace]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedWorkspace) {
      setFileEditorValue("");
      setFileEditorMessage(null);
      return;
    }
    void loadWorkspaceFile();
    // Intentionally only auto-load on workspace switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspace?.id]);

  const workspaceSessions = useMemo(() => {
    if (!selectedWorkspace) return sessions;
    return sessions.filter((session) => session.metadata.workspaceId === selectedWorkspace.id);
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
  const teamChildrenMap = useMemo(() => buildChildrenMap(workspaceSessions), [workspaceSessions]);
  const topLevelTeamSessions = useMemo(() => {
    if (!primarySession) return teamSessions;
    const primaryKey = paneKeyForSession(primarySession);
    const direct = teamChildrenMap.get(primaryKey);
    if (direct && direct.length > 0) return direct;
    return teamSessions.filter((session) => !session.metadata.parent);
  }, [primarySession, teamChildrenMap, teamSessions]);

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

  const claudeInstalled = useMemo(
    () => launchers.some((launcher) => launcher.provider === "claude" && launcher.installed),
    [launchers],
  );
  const codexInstalled = useMemo(
    () => launchers.some((launcher) => launcher.provider === "codex" && launcher.installed),
    [launchers],
  );
  const opencodeInstalled = useMemo(
    () => launchers.some((launcher) => launcher.provider === "opencode" && launcher.installed),
    [launchers],
  );
  const preferredArchitectProvider = useMemo<AgentLauncherProvider | null>(() => {
    if (opencodeInstalled) return "opencode";
    if (claudeInstalled) return "claude";
    if (codexInstalled) return "codex";
    return null;
  }, [claudeInstalled, codexInstalled, opencodeInstalled]);

  const sendToSession = useCallback(
    async (session: AgentSession) => {
      const paneKey = paneKeyForSession(session);
      const text = drafts[paneKey]?.trim();
      if (!text) return;
      setSendingKey(paneKey);
      try {
        const response = await fetch("/api/agent-hq/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: paneKey, text, enter: true }),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to send to ${paneKey}`);
        }
        const history = commandHistoryRef.current[paneKey] ?? [];
        history.push(text);
        commandHistoryRef.current[paneKey] = history;
        commandHistoryIndexRef.current[paneKey] = history.length;
        setDrafts((prev) => ({ ...prev, [paneKey]: "" }));
        await captureSession(paneKey);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send input");
      } finally {
        setSendingKey((current) => (current === paneKey ? null : current));
      }
    },
    [captureSession, drafts],
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
          throw new Error(data.error || `Failed to send choice to ${paneKey}`);
        }
        await captureSession(paneKey);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send choice");
      } finally {
        setSendingKey((current) => (current === paneKey ? null : current));
      }
    },
    [captureSession],
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
    if (!preferredArchitectProvider) {
      setError("No supported agent runtime is installed. Install OpenCode, Claude, or Codex in the app environment.");
      return;
    }
    setLaunching(true);
    try {
      const response = await fetch("/api/agent-hq/launch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: preferredArchitectProvider,
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
  }, [kgScopeDraft, launchPreset, preferredArchitectProvider, refresh, selectedPersona, selectedWorkspace]);

  const launchExecutiveTeam = useCallback(async () => {
    if (!selectedWorkspace) {
      setError("Select a workspace first.");
      return;
    }
    if (!preferredArchitectProvider) {
      setError("No supported agent runtime is installed. Install OpenCode, Claude, or Codex in the app environment.");
      return;
    }

    const teamProvider =
      claudeInstalled ? "claude" : codexInstalled ? "codex" : preferredArchitectProvider;
    const workerProvider =
      codexInstalled ? "codex" : claudeInstalled ? "claude" : preferredArchitectProvider;
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
        provider: preferredArchitectProvider,
        displayLabel: `${selectedWorkspace.label} Executive`,
        role: "executive",
        parent: null,
        objective: `Act as the user-facing executive for ${selectedWorkspace.label}. Keep interaction concise and clear, then delegate implementation to the architect team.`,
        notes: `Primary interactive pane. Persona: ${selectedPersona?.name ?? "main profile"}.`,
      });

      const architectPane = await launchNode({
        ...basePayload,
        provider: preferredArchitectProvider,
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
        provider: teamProvider,
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
          provider: workerProvider,
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
          provider: workerProvider,
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
    claudeInstalled,
    codexInstalled,
    kgScopeDraft,
    launchPreset,
    preferredArchitectProvider,
    refresh,
    selectedPersona,
    selectedWorkspace,
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
    [renderTerminalPane, teamChildrenMap],
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
            <h3 className="text-sm font-semibold">Architect Console</h3>
            <p className="text-xs text-muted-foreground">
              Pick an app workspace, then talk to its primary executive. The team stays in the background unless you open it.
            </p>
          </div>
          <div className="flex items-center gap-2">
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
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={() => setShowTeam((current) => !current)}
            >
              {showTeam ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              {showTeam ? "Hide team" : "Show team"}
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
              {preferredArchitectProvider ? <Badge variant="outline">launch: {preferredArchitectProvider}</Badge> : null}
            </>
          )}
          {lastUpdatedAt ? (
            <span className="text-xs text-muted-foreground">
              Updated {new Date(lastUpdatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
            </span>
          ) : null}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={selectedPersonaId}
            onChange={(event) => {
              const nextId = event.target.value;
              setSelectedPersonaId(nextId);
              setKgScopeDraft(nextId ? `person:self,persona:${nextId}` : "person:self");
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
          <Input
            value={kgScopeDraft}
            onChange={(event) => setKgScopeDraft(event.target.value)}
            placeholder="person:self,persona:<id>"
            className="h-9 min-w-[260px] flex-1"
          />
          <span className="text-xs text-muted-foreground">KG scopes (comma-separated)</span>
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
        <Card className="border-border/80 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Workspace Files</CardTitle>
            <p className="text-xs text-muted-foreground">
              Edit filesystem-backed context files directly (for example: <code>persona/soul.md</code>) so executive sessions and Claude runs use current instructions.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={fileEditorPath}
                onChange={(event) => setFileEditorPath(event.target.value)}
                placeholder="persona/soul.md"
                className="h-9 min-w-[260px] flex-1"
              />
              <Button
                variant="outline"
                className="h-9"
                onClick={() => void loadWorkspaceFile()}
                disabled={!selectedWorkspace || fileEditorLoading}
              >
                {fileEditorLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Load"}
              </Button>
              <Button
                className="h-9"
                onClick={() => void saveWorkspaceFile()}
                disabled={!selectedWorkspace || fileEditorSaving}
              >
                {fileEditorSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
              </Button>
            </div>
            <textarea
              value={fileEditorValue}
              onChange={(event) => setFileEditorValue(event.target.value)}
              className="min-h-[220px] w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
              placeholder="Load a workspace file to edit."
              spellCheck={false}
            />
            {fileEditorMessage ? (
              <p className="text-xs text-muted-foreground">{fileEditorMessage}</p>
            ) : null}
          </CardContent>
        </Card>

        {primarySession ? (
          <Card className="border-border/80 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-base">{primarySession.metadata.label || "Primary executive"}</CardTitle>
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
                  {primarySession.metadata.personaName || primarySession.metadata.personaId ? (
                    <Badge variant="outline">
                      persona: {primarySession.metadata.personaName ?? primarySession.metadata.personaId}
                    </Badge>
                  ) : null}
                  <Badge variant={primarySession.active ? "default" : "secondary"}>
                    {primarySession.active ? "active" : "idle"}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {renderTerminalPane(paneKeyForSession(primarySession), primarySession, {
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
                Launch a primary executive and use it as the single user-facing entry point for this app. It can drive architect/orchestrator/worker panes behind the scenes.
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

        {showTeam ? (
          <Card className="border-border/80 shadow-sm">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4" />
                <CardTitle className="text-sm">Background Team</CardTitle>
              </div>
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
        ) : null}
      </div>
    </div>
  );
}
