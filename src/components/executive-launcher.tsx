"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ExternalLink,
  KeyRound,
  Loader2,
  Mic,
  MicOff,
  Play,
  Send,
  Sparkles,
  Terminal,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/use-toast";

type AgentRole = "executive" | "architect" | "orchestrator" | "worker" | "observer";
type AgentWorkspaceScope = "foundation" | "app" | "shared";
type AgentLauncherProvider = "claude" | "codex" | "opencode" | "custom";

type AgentSessionMetadata = {
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
};

type AgentSession = {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId?: string;
  active: boolean;
  metadata: AgentSessionMetadata;
};

type AgentWorkspace = {
  id: string;
  label: string;
  cwd: string;
  scope: AgentWorkspaceScope;
  description: string;
  liveSubdomain?: string | null;
};

type AgentLauncher = {
  provider: AgentLauncherProvider;
  installed: boolean;
};

type LaunchersResponse = {
  workspaces: AgentWorkspace[];
  launchers: AgentLauncher[];
  activePersonaId?: string | null;
  personas?: Array<{ id: string; name: string }>;
  error?: string;
};

type SessionsResponse = {
  sessions: AgentSession[];
  warning?: string;
  error?: string;
};

type ExecutiveContextMount = {
  kind: "person" | "persona" | "group" | "kg-scope" | "workspace";
  id: string;
  label: string;
  ref?: string;
};

type ExecutiveStateResponse = {
  session: {
    id: string;
    paneKey: string;
    provider: AgentLauncherProvider;
    cwd: string;
    label: string;
    state: "active" | "suspended" | "terminated";
    contextMounts: ExecutiveContextMount[];
    personaId: string | null;
    personaName?: string;
    voiceMode?: "browser" | "clone";
    childPaneKeys: string[];
    createdAt: string;
    updatedAt: string;
  } | null;
  alive?: boolean;
  capture?: string | null;
  messages?: ChatBubbleMessage[];
  error?: string;
};

type CaptureResponse = {
  output?: string;
  warning?: string;
  error?: string;
};

type ClaudeAuthStatus = {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
};

type VoiceMode = "browser" | "clone";

type SpeechRecognitionResult = ArrayLike<{ transcript: string }> & { isFinal: boolean };
type SpeechRecognitionResultList = ArrayLike<SpeechRecognitionResult> & { length: number };
type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: SpeechRecognitionResultList; resultIndex: number }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

type SaveTargetOption = {
  id: string;
  label: string;
};

type ChatBubbleMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
};

interface ExecutiveLauncherProps {
  personas?: SaveTargetOption[];
  groups?: SaveTargetOption[];
}

const CAPTURE_LINES = 140;
const REFRESH_INTERVAL_MS = 2000;
const PREFERRED_WORKSPACE_HINTS = ["rivr-person", "/rivr-person", "person"];
const PROVIDER_PREFERENCE: AgentLauncherProvider[] = ["claude", "codex", "opencode", "custom"];
const TTS_API_ENDPOINT = "/api/autobot/tts";

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

function extractFirstUrl(value: string) {
  const cleaned = stripAnsi(value).replace(/\n/g, "");
  const match = cleaned.match(/https:\/\/[^\s]+/);
  return match?.[0] ?? null;
}

function stripMarkdownForSpeech(text: string) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/#{1,6}\s*/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract speakable Claude response text from raw terminal output.
 * Strips ANSI codes, tool calls, command indicators, file paths, and prompts,
 * returning only the natural-language response portion.
 */
function extractClaudeResponse(raw: string): string | null {
  const text = stripAnsi(raw).trim();
  if (!text) return null;

  const lines = text.split("\n");
  const responseLines: string[] = [];
  let inResponse = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines at start
    if (!inResponse && !trimmed) continue;
    // Skip tool/command indicators
    if (/^[⏺►▶>$#❯→✻]/.test(trimmed)) { inResponse = false; continue; }
    // Skip tool call lines (Bash, Read, Edit, Write, Grep, Glob)
    if (/^(Bash|Read|Edit|Write|Grep|Glob)\(/.test(trimmed)) { inResponse = false; continue; }
    // Skip file paths
    if (/^[\w/.]+\.(ts|tsx|js|json|md|py|sh)/.test(trimmed)) continue;
    // Skip progress spinners and status lines
    if (/^(Running|Searching|Reading|Writing|Editing)\.{0,3}$/.test(trimmed)) continue;
    // This looks like response text
    inResponse = true;
    responseLines.push(trimmed);
  }

  const result = responseLines.join(" ").trim();
  // Don't speak very short or very long outputs
  if (result.length < 20 || result.length > 3000) return null;
  return stripMarkdownForSpeech(result);
}

function extractLatestClaudeReply(raw: string): string | null {
  const text = stripAnsi(raw);
  if (!text.trim()) return null;

  const pattern = /(?:^|\n)●\s([\s\S]*?)(?=\n(?:\s*[❯>$]|\s*─{5,}|\s*⏵⏵|\s*$))/g;
  let match: RegExpExecArray | null = null;
  let latest: string | null = null;

  while ((match = pattern.exec(text)) !== null) {
    latest = match[1] ?? null;
  }

  const cleaned = latest
    ?.replace(/\n\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || cleaned.length < 2) return null;
  return cleaned;
}

function isToolProgressReply(reply: string | null) {
  if (!reply) return true;
  const normalized = reply.trim();
  if (!normalized) return true;
  return (
    /^Reading \d+ file/i.test(normalized) ||
    /^Read \d+ file/i.test(normalized) ||
    /^Searched for /i.test(normalized) ||
    /^Listed \d+/i.test(normalized) ||
    /^Using \d+ /i.test(normalized) ||
    /^Planning /i.test(normalized) ||
    /^Thinking /i.test(normalized) ||
    normalized.includes("(ctrl+o to expand)") ||
    normalized.includes("⎿ /")
  );
}

function chunkTextForSpeech(text: string, maxChars = 220): string[] {
  const normalized = stripMarkdownForSpeech(text);
  if (!normalized) return [];
  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
  const chunks: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (!current) {
      current = sentence;
      continue;
    }
    if ((current + " " + sentence).length <= maxChars) {
      current += " " + sentence;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function getSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  return (
    (window as unknown as { SpeechRecognition?: BrowserSpeechRecognitionCtor }).SpeechRecognition ||
    (window as unknown as { webkitSpeechRecognition?: BrowserSpeechRecognitionCtor }).webkitSpeechRecognition ||
    null
  );
}

function pickProvider(launchers: AgentLauncher[]) {
  const installed = new Set(
    launchers.filter((launcher) => launcher.installed).map((launcher) => launcher.provider),
  );
  return PROVIDER_PREFERENCE.find((provider) => installed.has(provider)) ?? null;
}

function pickWorkspace(workspaces: AgentWorkspace[]) {
  for (const hint of PREFERRED_WORKSPACE_HINTS) {
    const match = workspaces.find((workspace) =>
      workspace.cwd.toLowerCase().includes(hint.toLowerCase()) ||
      workspace.label.toLowerCase().includes(hint.toLowerCase()),
    );
    if (match) return match;
  }
  return workspaces.find((workspace) => workspace.scope === "app") ?? workspaces[0] ?? null;
}

export function ExecutiveLauncher({ personas: externalPersonas, groups: externalGroups }: ExecutiveLauncherProps = {}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isListeningRef = useRef(false);
  const audioUrlRef = useRef<string | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const [open, setOpen] = useState(false);
  const [launchers, setLaunchers] = useState<AgentLauncher[]>([]);
  const [fetchedPersonas, setFetchedPersonas] = useState<SaveTargetOption[]>([]);
  const [fetchedGroups, setFetchedGroups] = useState<SaveTargetOption[]>([]);
  const personas = externalPersonas ?? fetchedPersonas;
  const groups = externalGroups ?? fetchedGroups;
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [activePersonaId, setActivePersonaId] = useState<string>("");
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [output, setOutput] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<ClaudeAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authSessionPaneKey, setAuthSessionPaneKey] = useState<string | null>(null);
  const [authSessionOutput, setAuthSessionOutput] = useState("");
  const [authCodeDraft, setAuthCodeDraft] = useState("");
  const [authSending, setAuthSending] = useState(false);
  const [executiveAlive, setExecutiveAlive] = useState(false);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("browser");
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatBubbleMessage[]>([]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const executiveSession = useMemo(() => {
    const candidates = sessions.filter((session) => session.metadata.role === "executive");
    if (selectedWorkspaceId) {
      const exact = candidates.find((session) => session.metadata.workspaceId === selectedWorkspaceId);
      if (exact) return exact;
    }
    return candidates[0] ?? null;
  }, [selectedWorkspaceId, sessions]);

  const executivePaneKey = executiveSession ? paneKeyForSession(executiveSession) : null;
  const authLoginUrl = useMemo(() => extractFirstUrl(authSessionOutput), [authSessionOutput]);

  const showingAuthTerminal = !executiveSession && Boolean(authSessionPaneKey);
  const previousOutputRef = useRef("");
  const speakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalText = showingAuthTerminal ? authSessionOutput : output;
  const lastAssistantMessageRef = useRef("");
  const buildContextMounts = useCallback((): ExecutiveContextMount[] => {
    const mounts: ExecutiveContextMount[] = [
      { kind: "person", id: "self", label: "Self" },
    ];
    if (selectedWorkspace) {
      mounts.push({
        kind: "workspace",
        id: selectedWorkspace.id,
        label: selectedWorkspace.label,
        ref: selectedWorkspace.cwd,
      });
    }
    if (activePersonaId) {
      mounts.push({
        kind: "persona",
        id: activePersonaId,
        label: personas.find((persona) => persona.id === activePersonaId)?.label ?? activePersonaId,
      });
      mounts.push({
        kind: "kg-scope",
        id: `persona:${activePersonaId}`,
        label: `persona:${activePersonaId}`,
        ref: `persona:${activePersonaId}`,
      });
    }
    mounts.push({
      kind: "kg-scope",
      id: "person:self",
      label: "person:self",
      ref: "person:self",
    });
    if (activeGroupId) {
      mounts.push({
        kind: "group",
        id: activeGroupId,
        label: groups.find((group) => group.id === activeGroupId)?.label ?? activeGroupId,
      });
      mounts.push({
        kind: "kg-scope",
        id: `group:${activeGroupId}`,
        label: `group:${activeGroupId}`,
        ref: `group:${activeGroupId}`,
      });
    }
    return mounts;
  }, [activeGroupId, activePersonaId, groups, personas, selectedWorkspace]);

  const saveVoiceSettings = useCallback(async (next: Partial<{ voiceMode: VoiceMode; ttsEnabled: boolean }>) => {
    const response = await fetch("/api/autobot/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    const data = (await response.json().catch(() => ({}))) as {
      settings?: { voiceMode?: VoiceMode; ttsEnabled?: boolean };
      error?: string;
    };
    if (!response.ok || data.error) {
      throw new Error(data.error || `Failed to save voice settings (${response.status})`);
    }
    if (data.settings?.voiceMode === "browser" || data.settings?.voiceMode === "clone") {
      setVoiceMode(data.settings.voiceMode);
    }
    if (typeof data.settings?.ttsEnabled === "boolean") {
      setTtsEnabled(data.settings.ttsEnabled);
    }
  }, []);

  const refreshSessions = useCallback(
    async (preferredWorkspaceId?: string) => {
      const response = await fetch("/api/agent-hq/sessions", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as SessionsResponse;
      if (!response.ok || data.error) {
        throw new Error(data.error || `Failed to load executive sessions (${response.status})`);
      }
      setSessions(data.sessions ?? []);
      const chosenWorkspaceId = preferredWorkspaceId ?? selectedWorkspaceId;
      const nextExecutive = (data.sessions ?? []).find((session) =>
        session.metadata.role === "executive" &&
        (!chosenWorkspaceId || session.metadata.workspaceId === chosenWorkspaceId),
      );
      if (nextExecutive) {
        setActivePersonaId(nextExecutive.metadata.personaId ?? "");
      }
      if (data.warning) {
        setError(data.warning);
      }
      return data.sessions ?? [];
    },
    [selectedWorkspaceId],
  );

  const captureExecutive = useCallback(async (paneKey: string) => {
    const response = await fetch(
      `/api/agent-hq/capture?target=${encodeURIComponent(paneKey)}&lines=${CAPTURE_LINES}&raw=1`,
      { cache: "no-store" },
    );
    const data = (await response.json().catch(() => ({}))) as CaptureResponse;
    if (!response.ok || data.error) {
      throw new Error(data.error || `Failed to capture executive pane (${response.status})`);
    }
    const nextOutput = data.output ?? "";
    setOutput(nextOutput);
    if (data.warning) {
      setError(data.warning);
    }
  }, []);

  const refreshExecutiveState = useCallback(async (capture = true) => {
    const params = new URLSearchParams();
    if (capture) {
      params.set("capture", "1");
      params.set("lines", String(CAPTURE_LINES));
    }
    const response = await fetch(`/api/agent-hq/executive?${params.toString()}`, { cache: "no-store" });
    const data = (await response.json().catch(() => ({}))) as ExecutiveStateResponse;
    if (!response.ok || data.error) {
      throw new Error(data.error || `Failed to load executive state (${response.status})`);
    }
    setExecutiveAlive(Boolean(data.alive));
    if (data.session?.personaId) {
      setActivePersonaId(data.session.personaId);
    }
    const mountedGroup = data.session?.contextMounts?.find((mount) => mount.kind === "group");
    if (mountedGroup?.id) {
      setActiveGroupId(mountedGroup.id);
    }
    if (typeof data.capture === "string") {
      setOutput(data.capture);
    }
    if (Array.isArray(data.messages)) {
      setChatMessages(data.messages);
    }
    return data;
  }, []);

  const refreshAuthStatus = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setAuthLoading(true);
    }
    try {
      const response = await fetch("/api/agent-hq/claude-auth", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: ClaudeAuthStatus;
        error?: string;
      };
      if (!response.ok || data.ok === false || !data.status) {
        throw new Error(data.error || `Failed to load Claude auth status (${response.status})`);
      }
      setAuthStatus(data.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Claude auth status");
    } finally {
      if (!options?.silent) {
        setAuthLoading(false);
      }
    }
  }, []);

  const captureAuthSession = useCallback(async (paneKey: string) => {
    const response = await fetch(
      `/api/agent-hq/capture?target=${encodeURIComponent(paneKey)}&lines=80&raw=1`,
      { cache: "no-store" },
    );
    const data = (await response.json().catch(() => ({}))) as CaptureResponse & { warning?: string };
    if (!response.ok || data.error) {
      throw new Error(data.error || `Failed to capture Claude login session (${response.status})`);
    }
    if (data.warning && /can't find session|can't find pane|no server running/i.test(data.warning)) {
      setAuthSessionPaneKey(null);
      setAuthSessionOutput("");
      setError("Claude login session expired. Click Connect Claude to start a fresh one.");
      return;
    }
    setAuthSessionOutput(data.output ?? "");
  }, []);

  const refreshBootstrap = useCallback(async () => {
    setLoading(true);
    try {
      setAuthSessionPaneKey(null);
      setAuthSessionOutput("");
      const launchersResponse = await fetch("/api/agent-hq/launchers", { cache: "no-store" });
      const launchersData = (await launchersResponse.json().catch(() => ({}))) as LaunchersResponse;
      if (!launchersResponse.ok || launchersData.error) {
        throw new Error(launchersData.error || `Failed to load Agent HQ launchers (${launchersResponse.status})`);
      }
      setLaunchers(launchersData.launchers ?? []);
      setWorkspaces(launchersData.workspaces ?? []);
      const workspace = pickWorkspace(launchersData.workspaces ?? []);
      const workspaceId = workspace?.id ?? "";
      setSelectedWorkspaceId((current) => current || workspaceId);
      setActivePersonaId(launchersData.activePersonaId ?? "");
      // Populate personas from launchers API when not externally provided
      if (!externalPersonas && launchersData.personas) {
        setFetchedPersonas(
          launchersData.personas.map((p: { id: string; name: string }) => ({
            id: p.id,
            label: p.name,
          })),
        );
      }
      try {
        const settingsResponse = await fetch("/api/autobot/settings", { cache: "no-store" });
        const settingsData = (await settingsResponse.json().catch(() => ({}))) as {
          settings?: { voiceMode?: VoiceMode; ttsEnabled?: boolean };
        };
        if (settingsData.settings?.voiceMode === "browser" || settingsData.settings?.voiceMode === "clone") {
          setVoiceMode(settingsData.settings.voiceMode);
        }
        if (typeof settingsData.settings?.ttsEnabled === "boolean") {
          setTtsEnabled(settingsData.settings.ttsEnabled);
        }
      } catch {
        // Voice settings are optional at launcher bootstrap.
      }
      await refreshAuthStatus();
      const nextSessions = await refreshSessions(workspaceId);
      const nextExecutive = nextSessions.find((session) =>
        session.metadata.role === "executive" && (!workspaceId || session.metadata.workspaceId === workspaceId),
      );
      if (nextExecutive) {
        await captureExecutive(paneKeyForSession(nextExecutive));
      }
      await refreshExecutiveState(true).catch(() => null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load executive session");
    } finally {
      setLoading(false);
    }
  }, [captureExecutive, externalPersonas, refreshAuthStatus, refreshExecutiveState, refreshSessions]);

  useEffect(() => {
    if (!open) return;
    void refreshBootstrap();
  }, [open, refreshBootstrap]);

  useEffect(() => {
    if (!open || !executivePaneKey) return;
    const timer = window.setInterval(() => {
      void refreshExecutiveState(true).catch(() => {
        void captureExecutive(executivePaneKey);
      });
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [captureExecutive, executivePaneKey, open, refreshExecutiveState]);

  useEffect(() => {
    const node = chatScrollRef.current;
    if (!open || !node) return;
    node.scrollTop = node.scrollHeight;
  }, [chatMessages, open]);

  useEffect(() => {
    if (!open || !authSessionPaneKey) return;
    const timer = window.setInterval(() => {
      void captureAuthSession(authSessionPaneKey);
      void refreshAuthStatus({ silent: true });
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [authSessionPaneKey, captureAuthSession, open, refreshAuthStatus]);

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        // noop
      }
      recognitionRef.current = null;
      window.speechSynthesis?.cancel();
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
      if (speakTimerRef.current) {
        clearTimeout(speakTimerRef.current);
        speakTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!open || !selectedWorkspaceId) return;
    const nextExecutive = sessions.find((session) =>
      session.metadata.role === "executive" && session.metadata.workspaceId === selectedWorkspaceId,
    );
    if (nextExecutive) {
      void refreshExecutiveState(true).catch(() => {
        void captureExecutive(paneKeyForSession(nextExecutive));
      });
      return;
    }
    setOutput("");
    setChatMessages([]);
  }, [captureExecutive, open, refreshExecutiveState, selectedWorkspaceId, sessions]);

  const launchExecutive = useCallback(async () => {
    if (!selectedWorkspace) {
      setError("No workspace is available for the executive.");
      return;
    }
    if (authStatus && !authStatus.loggedIn) {
      setError("Claude Code is not signed into your personal account in this workspace runtime yet. Connect Claude first.");
      return;
    }
    setLaunching(true);
    try {
      const existingExecutive = sessions.find((session) =>
        session.metadata.role === "executive" && session.metadata.workspaceId === selectedWorkspace.id,
      );

      if (existingExecutive) {
        const paneKey = paneKeyForSession(existingExecutive);
        const mountResponse = await fetch("/api/agent-hq/executive", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "updateMounts",
            contextMounts: buildContextMounts(),
          }),
        });
        const mountData = (await mountResponse.json().catch(() => ({}))) as { error?: string };
        if (!mountResponse.ok || mountData.error) {
          throw new Error(mountData.error || `Failed to update executive mounts (${mountResponse.status})`);
        }
        const metadataResponse = await fetch("/api/agent-hq/metadata", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paneKey,
            personaId: activePersonaId || null,
            personaName: personas.find((persona) => persona.id === activePersonaId)?.label,
            kgScopeSet: activePersonaId ? ["person:self", `persona:${activePersonaId}`] : ["person:self"],
          }),
        });
        const metadataData = (await metadataResponse.json().catch(() => ({}))) as { error?: string };
        if (!metadataResponse.ok || metadataData.error) {
          throw new Error(metadataData.error || `Failed to update executive context (${metadataResponse.status})`);
        }
        const reloadResponse = await fetch("/api/agent-hq/reload-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paneKey }),
        });
        const reloadData = (await reloadResponse.json().catch(() => ({}))) as { error?: string };
        if (!reloadResponse.ok || reloadData.error) {
          throw new Error(reloadData.error || `Failed to reload executive context (${reloadResponse.status})`);
        }
        await refreshSessions(selectedWorkspace.id);
        await refreshExecutiveState(true).catch(() => captureExecutive(paneKey));
        setAuthSessionPaneKey(null);
        setAuthSessionOutput("");
      } else {
        const provider = pickProvider(launchers);
        if (!provider) {
          throw new Error("No runtime is installed for the executive. Install Claude Code or Codex.");
        }
        const response = await fetch("/api/agent-hq/executive", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider,
            cwd: selectedWorkspace.cwd,
            personaId: activePersonaId || null,
            personaName: personas.find((persona) => persona.id === activePersonaId)?.label,
            contextMounts: buildContextMounts(),
          }),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok || data.error) {
          throw new Error(data.error || `Failed to launch executive (${response.status})`);
        }
        const nextSessions = await refreshSessions(selectedWorkspace.id);
        const nextExecutive = nextSessions.find((session) =>
          session.metadata.role === "executive" && session.metadata.workspaceId === selectedWorkspace.id,
        );
        if (nextExecutive) {
          await refreshExecutiveState(true).catch(() => captureExecutive(paneKeyForSession(nextExecutive)));
        }
        setAuthSessionPaneKey(null);
        setAuthSessionOutput("");
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch executive");
    } finally {
      setLaunching(false);
    }
  }, [activePersonaId, authStatus, buildContextMounts, captureExecutive, launchers, personas, refreshExecutiveState, refreshSessions, selectedWorkspace, sessions]);

  const startClaudeLogin = useCallback(async () => {
    setAuthLoading(true);
    try {
      const response = await fetch("/api/agent-hq/claude-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "login",
          mode: "claudeai",
          email: authStatus?.email ?? undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        loginSession?: { paneKey: string };
      };
      if (!response.ok || data.ok === false || !data.loginSession?.paneKey) {
        throw new Error(data.error || `Failed to start Claude login (${response.status})`);
      }
      setAuthSessionPaneKey(data.loginSession.paneKey);
      setAuthSessionOutput("");
      setAuthCodeDraft("");
      await captureAuthSession(data.loginSession.paneKey);
      await refreshAuthStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start Claude login");
    } finally {
      setAuthLoading(false);
    }
  }, [authStatus?.email, captureAuthSession, refreshAuthStatus]);

  const sendAuthCode = useCallback(async () => {
    const code = authCodeDraft.trim();
    if (!authSessionPaneKey || !code) {
      setError("Paste the Claude login code first.");
      return;
    }
    setAuthSending(true);
    setError(null);
    try {
      const response = await fetch("/api/agent-hq/claude-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "submitCode", paneKey: authSessionPaneKey, code }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        status?: ClaudeAuthStatus;
        output?: string;
      };
      if (!response.ok || data.ok === false || data.error) {
        throw new Error(data.error || `Failed to submit Claude login code (${response.status})`);
      }
      setAuthCodeDraft("");
      if (typeof data.output === "string") {
        setAuthSessionOutput(data.output);
      }
      if (data.status) {
        setAuthStatus(data.status);
      }
      toast({
        title: data.status?.loggedIn ? "Claude connected" : "Code submitted",
        description: data.status?.loggedIn
          ? "Claude Code is now signed into this app runtime."
          : "Claude processed the submitted code. Latest terminal output is shown above.",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit Claude login code");
    } finally {
      setAuthSending(false);
    }
  }, [authCodeDraft, authSessionPaneKey, toast]);

  const logoutClaude = useCallback(async () => {
    setAuthLoading(true);
    try {
      const response = await fetch("/api/agent-hq/claude-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout" }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        status?: ClaudeAuthStatus;
      };
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `Failed to logout Claude (${response.status})`);
      }
      setAuthStatus(data.status ?? { loggedIn: false });
      setAuthSessionPaneKey(null);
      setAuthSessionOutput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to logout Claude");
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const speakBrowserFallback = useCallback((text: string) => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(stripMarkdownForSpeech(text));
    const voices = synth.getVoices();
    const preferred =
      voices.find((voice) => voice.name.includes("Daniel") || voice.name.includes("Alex")) ||
      voices.find((voice) => voice.lang.startsWith("en-US"));
    if (preferred) utterance.voice = preferred;
    utterance.onend = () => {
      setIsSpeaking(false);
      setVoiceStatus(null);
    };
    utterance.onerror = () => {
      setIsSpeaking(false);
      setVoiceStatus(null);
    };
    synth.speak(utterance);
  }, []);

  const playRemoteAudio = useCallback(async (blob: Blob) => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    const audioUrl = URL.createObjectURL(blob);
    audioUrlRef.current = audioUrl;
    await new Promise<void>((resolve, reject) => {
      const audio = new Audio(audioUrl);
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("audio playback failed"));
      audio.play().catch(reject);
    });
  }, []);

  const speakText = useCallback(async (text: string) => {
    const cleaned = stripAnsi(text).trim();
    if (!cleaned) return;
    setIsSpeaking(true);
    try {
      if (voiceMode === "browser") {
        setVoiceStatus("Speaking (browser voice)");
        speakBrowserFallback(cleaned);
        return;
      }
      setVoiceStatus("Speaking (personal voice)");
      const chunks = chunkTextForSpeech(cleaned);
      let succeeded = false;
      for (const chunk of chunks) {
        const response = await fetch(TTS_API_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: chunk }),
        });
        if (!response.ok) {
          break;
        }
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.startsWith("audio/")) {
          break;
        }
        const blob = await response.blob();
        await playRemoteAudio(blob);
        succeeded = true;
      }
      if (!succeeded) {
        setVoiceStatus("Personal voice unavailable, using browser voice.");
        speakBrowserFallback(cleaned);
      } else {
        setIsSpeaking(false);
        setVoiceStatus(null);
      }
    } catch {
      setVoiceStatus("Personal voice unavailable, using browser voice.");
      speakBrowserFallback(cleaned);
    }
  }, [playRemoteAudio, speakBrowserFallback, voiceMode]);

  useEffect(() => {
    const latestAssistant = [...chatMessages].reverse().find((message) => message.role === "assistant")?.content ?? "";
    if (!latestAssistant || latestAssistant === lastAssistantMessageRef.current) return;
    lastAssistantMessageRef.current = latestAssistant;
    if (!ttsEnabled) return;
    if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
    speakTimerRef.current = setTimeout(() => {
      void speakText(latestAssistant);
    }, 1200);
  }, [chatMessages, speakText, ttsEnabled]);

  const sendDirectText = useCallback(async (text: string) => {
    if (!executivePaneKey) {
      setError("Launch the executive first.");
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const previousAssistant = lastAssistantMessageRef.current;
      const response = await fetch("/api/agent-hq/executive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const ensureData = (await response.json().catch(() => ({}))) as { session?: { paneKey?: string }; messages?: ChatBubbleMessage[]; error?: string };
      if (!response.ok || ensureData.error) {
        throw new Error(ensureData.error || `Failed to load executive session (${response.status})`);
      }

      const sendResponse = await fetch("/api/agent-hq/executive", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", text: trimmed, enter: true }),
      });
      const data = (await sendResponse.json().catch(() => ({}))) as { error?: string; capture?: string; reply?: string; messages?: ChatBubbleMessage[] };
      if (!sendResponse.ok || data.error) {
        throw new Error(data.error || `Failed to send to executive (${sendResponse.status})`);
      }
      setDraft("");
      if (typeof data.capture === "string") {
        setOutput(data.capture);
      }
      if (Array.isArray(data.messages)) {
        setChatMessages(data.messages);
      } else {
        await refreshExecutiveState(true).catch(() => captureExecutive(executivePaneKey));
      }
      setError(null);
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send to executive");
    } finally {
      setSending(false);
    }
  }, [captureExecutive, executivePaneKey, refreshExecutiveState]);

  const stopListening = useCallback(() => {
    setIsListening(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      // noop
    }
  }, []);

  const startListening = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setVoiceStatus("Browser speech recognition is not available here.");
      return;
    }
    try {
      recognitionRef.current?.stop();
    } catch {
      // noop
    }
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal) {
          const transcript = result[0]?.transcript?.trim();
          if (transcript) {
            setDraft(transcript);
            void sendDirectText(transcript);
          }
        }
      }
    };
    recognition.onerror = () => {
      setIsListening(false);
    };
    recognition.onend = () => {
      if (isListeningRef.current) {
        try {
          recognition.start();
        } catch {
          setIsListening(false);
        }
      } else {
        setIsListening(false);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setIsListening(true);
      setVoiceStatus("Listening…");
    } catch {
      setIsListening(false);
      setVoiceStatus("Could not start microphone input.");
    }
  }, [sendDirectText]);

  const toggleListening = useCallback(() => {
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, startListening, stopListening]);
  const sendToExecutive = useCallback(async () => {
    await sendDirectText(draft);
  }, [draft, sendDirectText]);

  return (
    <>
      <div className="fixed bottom-20 right-4 z-50 sm:bottom-6 sm:right-6">
        <Button
          type="button"
          onClick={() => setOpen(true)}
          className="h-14 w-14 rounded-full shadow-xl"
          size="icon"
          title="Open executive"
        >
          <Bot className="h-6 w-6" />
        </Button>
      </div>

      {open ? (
        <div className="fixed inset-0 z-50 sm:inset-x-auto sm:bottom-24 sm:right-6 sm:top-auto sm:w-[28rem] sm:max-h-[calc(100dvh-8rem)] overflow-y-auto overscroll-contain bg-background/80 backdrop-blur-sm sm:bg-transparent sm:backdrop-blur-0">
          <Card className="min-h-dvh rounded-none border-0 shadow-none sm:min-h-0 sm:overflow-hidden sm:border sm:shadow-2xl sm:rounded-xl">
            <CardHeader className="sticky top-0 z-10 flex flex-row items-start justify-between gap-4 border-b bg-muted/95 backdrop-blur px-5 py-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Bot className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Executive</p>
                    <p className="text-xs text-muted-foreground">
                      {executiveSession
                        ? executiveAlive
                          ? "Live executive chat"
                          : "Executive chat paused"
                        : "Launch the executive to start chatting"}
                    </p>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" asChild>
                  <Link href="/session-record" onClick={() => setOpen(false)}>
                    Session Record
                  </Link>
                </Button>
                <Button type="button" variant="outline" size="sm" asChild>
                  <Link href="/settings?tab=agent-hq" onClick={() => setOpen(false)}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Agent HQ
                  </Link>
                </Button>
                <Button type="button" variant="ghost" size="icon" onClick={() => setOpen(false)} title="Close">
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>

            <CardContent className="space-y-4 px-5 py-4">
              {!executiveSession ? (
                <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/20 px-3 py-3">
                  <Button
                    type="button"
                    size="sm"
                    variant={authStatus?.loggedIn ? "outline" : "default"}
                    onClick={() => void startClaudeLogin()}
                    disabled={authLoading}
                  >
                    {authLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                    {authStatus?.loggedIn ? "Claude Ready" : "Connect Claude"}
                  </Button>
                  <Button type="button" onClick={() => void launchExecutive()} disabled={launching || !selectedWorkspace || authLoading}>
                    {launching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
                    Launch Executive
                  </Button>
                </div>
              ) : null}

              {error ? (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              ) : null}

              {authSessionPaneKey ? (
                <div className="space-y-2 rounded-xl border border-border/70 bg-muted/10 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium">Claude subscription session</p>
                      <p className="text-xs text-muted-foreground">
                        This is a standard Claude Code terminal for this app runtime. The defaults are preselected so it should land directly on the Claude subscription sign-in step.
                      </p>
                    </div>
                    <Badge variant="outline">{authSessionPaneKey}</Badge>
                  </div>
                  {authLoginUrl ? (
                    <div className="flex items-center justify-between gap-2 rounded-lg border bg-background/60 px-3 py-2">
                      <p className="min-w-0 truncate text-xs text-muted-foreground">{authLoginUrl}</p>
                      <Button type="button" size="sm" variant="outline" asChild>
                        <a href={authLoginUrl} target="_blank" rel="noreferrer">
                          Open Login
                        </a>
                      </Button>
                    </div>
                  ) : (
                    <div className="rounded-lg border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                      Claude Code is starting in the terminal below.
                    </div>
                  )}
                  <div className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
                    If Claude shows “Paste code here if prompted &gt;”, paste the returned code into the field below and send it. If the flow gets stuck, click Connect Claude again for a fresh terminal.
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      value={authCodeDraft}
                      onChange={(event) => setAuthCodeDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void sendAuthCode();
                        }
                      }}
                      placeholder="Paste Claude login code here…"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      className="font-mono text-sm"
                    />
                    <Button type="button" size="sm" onClick={() => void sendAuthCode()} disabled={!authCodeDraft.trim() || authSending}>
                      {authSending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Send className="mr-1.5 h-3.5 w-3.5" />}
                      Send
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="overflow-hidden rounded-xl border bg-[#0d1117]">
                {loading ? (
                  <div className="flex h-[min(48dvh,420px)] sm:h-[320px] items-center justify-center text-sm text-slate-300">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Connecting to executive runtime…
                  </div>
                ) : executiveSession ? (
                  <div
                    ref={chatScrollRef}
                    className="h-[min(48dvh,420px)] sm:h-[320px] overflow-auto px-3 py-3"
                  >
                    {chatMessages.length ? (
                      <div className="space-y-3">
                        {chatMessages.map((message) => (
                          <div
                            key={message.id}
                            className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                          >
                            <div
                              className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-6 ${
                                message.role === "user"
                                  ? "bg-[#9fe3d7] text-slate-950"
                                  : "bg-slate-800 text-slate-100"
                              }`}
                            >
                              {message.content}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-slate-300">
                        <Bot className="h-8 w-8" />
                        <div className="space-y-1">
                          <p className="text-sm font-medium text-white">Executive is ready.</p>
                          <p className="text-xs text-slate-400">
                            Start chatting below. Use Session Record to capture real-world audio into Docs, or open Agent HQ to manage agent containers and mounts.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : authSessionPaneKey ? (
                  <pre className="h-[min(48dvh,420px)] sm:h-[320px] overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-6 text-slate-100">
                    {terminalText || "Waiting for Claude login output…"}
                  </pre>
                ) : (
                  <div className="flex h-[min(48dvh,420px)] sm:h-[320px] flex-col items-center justify-center gap-3 px-8 text-center text-slate-300">
                    <Terminal className="h-8 w-8" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-white">No executive session is running yet.</p>
                      <p className="text-xs text-slate-400">
                        Connect Claude, launch the executive, then reopen this bubble to chat. Use Agent HQ for terminals, child agents, and context mounts.
                      </p>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Input
                  ref={inputRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendToExecutive();
                    }
                  }}
                  placeholder="Send a command to the executive…"
                  disabled={!executiveSession || sending}
                />
                <Button type="button" onClick={() => void sendToExecutive()} disabled={!executiveSession || sending || !draft.trim()}>
                  {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
                  Send
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={toggleListening}
                  disabled={!executiveSession}
                  title={isListening ? "Stop listening" : "Start voice input"}
                >
                  {isListening ? <MicOff className="h-4 w-4 text-destructive" /> : <Mic className="h-4 w-4" />}
                </Button>
                <Button
                  type="button"
                  variant={ttsEnabled ? "secondary" : "ghost"}
                  size="icon"
                  onClick={() => {
                    const next = !ttsEnabled;
                    setTtsEnabled(next);
                    void saveVoiceSettings({ ttsEnabled: next });
                  }}
                  title={ttsEnabled ? "Disable auto-speak" : "Enable auto-speak"}
                >
                  {ttsEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
                </Button>
                {executiveSession ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      const transcript = stripAnsi(output).trim();
                      if (transcript) void speakText(transcript);
                    }}
                    disabled={!output || isSpeaking}
                    title="Speak last output"
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                ) : null}
                {isSpeaking ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      window.speechSynthesis?.cancel();
                      setIsSpeaking(false);
                      setVoiceStatus(null);
                    }}
                    title="Stop speaking"
                  >
                    <X className="h-4 w-4 text-destructive" />
                  </Button>
                ) : null}
                {voiceStatus ? (
                  <span className="text-xs text-muted-foreground">{voiceStatus}</span>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
      ) : null}
    </>
  );
}
