"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Mic,
  MicOff,
  PanelTopClose,
  PanelTopOpen,
  Send,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import XTermPane from "@/components/xterm-pane";
import type { XTermPaneHandle } from "@/components/xterm-pane";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

/* ─── Types ────────────────────────────────────────────────────────────── */

type AgentLauncherProvider = "claude" | "codex" | "opencode" | "custom";

type AgentWorkspace = {
  id: string;
  label: string;
  cwd: string;
  scope: "foundation" | "app" | "shared";
  description: string;
  liveSubdomain?: string | null;
};

type AgentLauncher = {
  provider: AgentLauncherProvider;
  installed: boolean;
};

type PersonaOption = { id: string; name: string };

type LaunchersResponse = {
  workspaces: AgentWorkspace[];
  launchers: AgentLauncher[];
  activePersonaId?: string | null;
  personas?: PersonaOption[];
  error?: string;
};

type ExecutiveContextMount = {
  kind: "person" | "persona" | "group" | "kg-scope" | "workspace";
  id: string;
  label: string;
  ref?: string;
};

type ExecutiveSession = {
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
};

type ExecutiveStateResponse = {
  session: ExecutiveSession | null;
  alive?: boolean;
  capture?: string | null;
  error?: string;
};

type VoiceMode = "browser" | "clone";

type ResourceNode = {
  id: string;
  name: string;
  type: "folder" | "file";
  resourceType?: string;
  children?: ResourceNode[];
  description?: string;
  createdAt?: string;
};

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

/* ─── Constants ────────────────────────────────────────────────────────── */

const TTS_API_ENDPOINT = "/api/autobot/tts";
const RESOURCES_API_ENDPOINT = "/api/agent-hq/resources";
const LAUNCHERS_API_ENDPOINT = "/api/agent-hq/launchers";
const EXECUTIVE_API_ENDPOINT = "/api/agent-hq/executive";
const PROVIDER_PREFERENCE: AgentLauncherProvider[] = ["claude", "codex", "opencode", "custom"];
const PREFERRED_WORKSPACE_HINTS = ["rivr-person", "/rivr-person", "person"];

/* ─── TTS Helpers (ported from executive-launcher) ─────────────────────── */

function stripAnsi(value: string) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "");
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

function extractClaudeResponse(raw: string): string | null {
  const text = stripAnsi(raw).trim();
  if (!text) return null;

  const lines = text.split("\n");
  const responseLines: string[] = [];
  let inResponse = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inResponse && !trimmed) continue;
    if (/^[⏺►▶>$#❯→✻]/.test(trimmed)) { inResponse = false; continue; }
    if (/^(Bash|Read|Edit|Write|Grep|Glob)\(/.test(trimmed)) { inResponse = false; continue; }
    if (/^[\w/.]+\.(ts|tsx|js|json|md|py|sh)/.test(trimmed)) continue;
    if (/^(Running|Searching|Reading|Writing|Editing)\.{0,3}$/.test(trimmed)) continue;
    inResponse = true;
    responseLines.push(trimmed);
  }

  const result = responseLines.join(" ").trim();
  if (result.length < 20 || result.length > 3000) return null;
  return stripMarkdownForSpeech(result);
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
    launchers.filter((l) => l.installed).map((l) => l.provider),
  );
  return PROVIDER_PREFERENCE.find((p) => installed.has(p)) ?? null;
}

function pickWorkspace(workspaces: AgentWorkspace[]) {
  for (const hint of PREFERRED_WORKSPACE_HINTS) {
    const match = workspaces.find(
      (w) =>
        w.cwd.toLowerCase().includes(hint.toLowerCase()) ||
        w.label.toLowerCase().includes(hint.toLowerCase()),
    );
    if (match) return match;
  }
  return workspaces.find((w) => w.scope === "app") ?? workspaces[0] ?? null;
}

/* ─── Resource Tree Sub-component ──────────────────────────────────────── */

function ResourceTreeNode({
  node,
  selected,
  onToggle,
  depth = 0,
}: {
  node: ResourceNode;
  selected: Set<string>;
  onToggle: (id: string) => void;
  depth?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const isFolder = node.type === "folder";
  const hasChildren = isFolder && node.children && node.children.length > 0;
  const childCount = node.children?.length ?? 0;

  if (isFolder) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-sm hover:bg-white/5 transition-colors"
          style={{ paddingLeft: `${depth * 16 + 4}px` }}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          )}
          <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
          <span className="truncate text-zinc-300">{node.name}</span>
          {childCount > 0 && (
            <span className="ml-auto text-xs text-zinc-600">({childCount})</span>
          )}
        </button>
        {expanded && hasChildren && (
          <div>
            {node.children!.map((child) => (
              <ResourceTreeNode
                key={child.id}
                node={child}
                selected={selected}
                onToggle={onToggle}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // File / leaf node
  const isChecked = selected.has(node.id);
  return (
    <button
      type="button"
      onClick={() => onToggle(node.id)}
      className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-sm hover:bg-white/5 transition-colors"
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
    >
      <Checkbox
        checked={isChecked}
        onCheckedChange={() => onToggle(node.id)}
        className="h-3.5 w-3.5 shrink-0 border-zinc-600 data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
      />
      <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <span className="truncate text-zinc-300">{node.name}</span>
      {node.description && (
        <span className="ml-auto max-w-[40%] truncate text-xs text-zinc-600">
          {node.description}
        </span>
      )}
    </button>
  );
}

function ResourceTree({
  items,
  selected,
  onToggle,
}: {
  items: ResourceNode[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="px-3 py-2 text-xs text-zinc-600">No resources available</div>
    );
  }
  return (
    <div className="max-h-40 overflow-y-auto px-1 py-1 scrollbar-thin scrollbar-thumb-zinc-700">
      {items.map((node) => (
        <ResourceTreeNode
          key={node.id}
          node={node}
          selected={selected}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

/* ─── Main Component ───────────────────────────────────────────────────── */

export function AgentChat() {
  const { toast } = useToast();

  /* Refs */
  const terminalRef = useRef<XTermPaneHandle | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const isListeningRef = useRef(false);
  const audioUrlRef = useRef<string | null>(null);
  const terminalBufferRef = useRef<string>("");
  const speakTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Panel state */
  const [open, setOpen] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(true);

  /* Data from launchers API */
  const [workspaces, setWorkspaces] = useState<AgentWorkspace[]>([]);
  const [launchers, setLaunchers] = useState<AgentLauncher[]>([]);
  const [personas, setPersonas] = useState<PersonaOption[]>([]);

  /* Selections */
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [agentScope, setAgentScope] = useState("self");
  const [kgScope, setKgScope] = useState("self");

  /* Resource tree */
  const [resourceTree, setResourceTree] = useState<ResourceNode[]>([]);
  const [selectedResources, setSelectedResources] = useState<Set<string>>(new Set());
  const [resourcesLoading, setResourcesLoading] = useState(false);

  /* Session */
  const [session, setSession] = useState<ExecutiveSession | null>(null);
  const [sessionAlive, setSessionAlive] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [launching, setLaunching] = useState(false);

  /* Input */
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  /* Voice / TTS */
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("browser");
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);

  /* Error */
  const [error, setError] = useState<string | null>(null);

  /* Computed */
  const selectedWorkspace = useMemo(
    () => workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const wsUrl = useMemo(() => {
    if (!session?.paneKey) return undefined;
    const envUrl =
      typeof window !== "undefined"
        ? (process.env.NEXT_PUBLIC_PTY_BRIDGE_URL ?? "").trim()
        : "";
    if (envUrl) {
      const separator = envUrl.includes("?") ? "&" : "?";
      return `${envUrl}${separator}pane=${encodeURIComponent(session.paneKey)}`;
    }
    if (typeof window === "undefined") return undefined;
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = window.location.host;
    return `${wsProtocol}//${wsHost}/ws/terminal?pane=${encodeURIComponent(session.paneKey)}`;
  }, [session?.paneKey]);

  /* ─── Data Fetching ────────────────────────────────────────────────── */

  const fetchLaunchers = useCallback(async () => {
    try {
      const res = await fetch(LAUNCHERS_API_ENDPOINT, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as LaunchersResponse;
      if (!res.ok || data.error) return;
      setWorkspaces(data.workspaces ?? []);
      setLaunchers(data.launchers ?? []);
      setPersonas(data.personas ?? []);
      // Auto-select best workspace
      if (!selectedWorkspaceId && data.workspaces?.length) {
        const best = pickWorkspace(data.workspaces);
        if (best) setSelectedWorkspaceId(best.id);
      }
    } catch {
      /* silent */
    }
  }, [selectedWorkspaceId]);

  const fetchSession = useCallback(async () => {
    setSessionLoading(true);
    try {
      const res = await fetch(EXECUTIVE_API_ENDPOINT, { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as ExecutiveStateResponse;
      if (data.session && data.session.state !== "terminated") {
        setSession(data.session);
        setSessionAlive(data.alive ?? false);
        // Sync voice mode from session
        if (data.session.voiceMode) {
          setVoiceMode(data.session.voiceMode);
        }
      } else {
        setSession(null);
        setSessionAlive(false);
      }
    } catch {
      setSession(null);
      setSessionAlive(false);
    } finally {
      setSessionLoading(false);
    }
  }, []);

  const fetchResources = useCallback(async (scope: string) => {
    setResourcesLoading(true);
    try {
      const params = new URLSearchParams();
      if (scope !== "self") {
        params.set("agentId", scope);
        params.set("scope", scope.startsWith("persona:") ? "persona" : "group");
      }
      const res = await fetch(`${RESOURCES_API_ENDPOINT}?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        setResourceTree([]);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { tree?: ResourceNode[] };
      setResourceTree(data.tree ?? []);
    } catch {
      setResourceTree([]);
    } finally {
      setResourcesLoading(false);
    }
  }, []);

  /* Load data when panel opens */
  useEffect(() => {
    if (!open) return;
    void fetchLaunchers();
    void fetchSession();
  }, [open, fetchLaunchers, fetchSession]);

  /* Fetch resources when KG scope changes */
  useEffect(() => {
    if (!open) return;
    void fetchResources(kgScope);
  }, [open, kgScope, fetchResources]);

  /* ─── TTS Functions (ported from executive-launcher) ───────────────── */

  const speakBrowserFallback = useCallback((text: string) => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(stripMarkdownForSpeech(text));
    const voices = synth.getVoices();
    const preferred =
      voices.find((v) => v.name.includes("Daniel") || v.name.includes("Alex")) ||
      voices.find((v) => v.lang.startsWith("en-US"));
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

  const speakText = useCallback(
    async (text: string) => {
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
          const res = await fetch(TTS_API_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: chunk }),
          });
          if (!res.ok) break;
          const contentType = res.headers.get("content-type") || "";
          if (!contentType.startsWith("audio/")) break;
          const blob = await res.blob();
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
    },
    [playRemoteAudio, speakBrowserFallback, voiceMode],
  );

  const stopSpeaking = useCallback(() => {
    if (typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setIsSpeaking(false);
    setVoiceStatus(null);
  }, []);

  const handleTerminalData = useCallback(
    (data: string) => {
      terminalBufferRef.current += data;
      if (!ttsEnabled) return;
      if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
      speakTimerRef.current = setTimeout(() => {
        const raw = terminalBufferRef.current;
        terminalBufferRef.current = "";
        const cleaned = extractClaudeResponse(raw);
        if (cleaned && cleaned.length > 20) {
          void speakText(cleaned);
        }
      }, 2000);
    },
    [ttsEnabled, speakText],
  );

  /* ─── Speech Recognition ───────────────────────────────────────────── */

  const toggleListening = useCallback(() => {
    if (isListeningRef.current) {
      recognitionRef.current?.stop();
      isListeningRef.current = false;
      setIsListening(false);
      return;
    }
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      toast({ title: "Speech recognition unavailable", variant: "destructive" });
      return;
    }
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const results = event.results;
      for (let i = event.resultIndex; i < results.length; i++) {
        const result = results[i];
        if (result.isFinal) {
          const transcript = result[0]?.transcript?.trim() ?? "";
          if (transcript) {
            setDraft((prev) => (prev ? prev + " " + transcript : transcript));
          }
        }
      }
    };
    recognition.onerror = () => {
      isListeningRef.current = false;
      setIsListening(false);
    };
    recognition.onend = () => {
      isListeningRef.current = false;
      setIsListening(false);
    };
    recognition.start();
    recognitionRef.current = recognition;
    isListeningRef.current = true;
    setIsListening(true);
  }, [toast]);

  /* ─── Session Lifecycle ────────────────────────────────────────────── */

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
    if (agentScope !== "self") {
      // Could be a persona or group
      const persona = personas.find((p) => p.id === agentScope);
      if (persona) {
        mounts.push({ kind: "persona", id: persona.id, label: persona.name });
        mounts.push({
          kind: "kg-scope",
          id: `persona:${persona.id}`,
          label: `persona:${persona.id}`,
          ref: `persona:${persona.id}`,
        });
      } else {
        mounts.push({ kind: "group", id: agentScope, label: agentScope });
        mounts.push({
          kind: "kg-scope",
          id: `group:${agentScope}`,
          label: `group:${agentScope}`,
          ref: `group:${agentScope}`,
        });
      }
    }
    if (kgScope !== "self" && kgScope !== agentScope) {
      mounts.push({
        kind: "kg-scope",
        id: kgScope,
        label: kgScope,
        ref: kgScope,
      });
    }
    mounts.push({
      kind: "kg-scope",
      id: "person:self",
      label: "person:self",
      ref: "person:self",
    });
    return mounts;
  }, [agentScope, kgScope, personas, selectedWorkspace]);

  const launchSession = useCallback(async () => {
    const provider = pickProvider(launchers);
    if (!provider) {
      setError("No agent provider installed. Install Claude Code or another provider.");
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        provider,
        contextMounts: buildContextMounts(),
        voiceMode,
      };
      if (selectedWorkspace) {
        body.cwd = selectedWorkspace.cwd;
      }
      if (agentScope !== "self") {
        const persona = personas.find((p) => p.id === agentScope);
        if (persona) {
          body.personaId = persona.id;
          body.personaName = persona.name;
        }
      }
      const res = await fetch(EXECUTIVE_API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        session?: ExecutiveSession;
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || data.error) {
        setError(data.error || `Failed to launch session (${res.status})`);
        return;
      }
      if (data.session) {
        setSession(data.session);
        setSessionAlive(true);
        toast({ title: "Agent session started" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch session");
    } finally {
      setLaunching(false);
    }
  }, [launchers, buildContextMounts, voiceMode, selectedWorkspace, agentScope, personas, toast]);

  const terminateSession = useCallback(async () => {
    try {
      await fetch(EXECUTIVE_API_ENDPOINT, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "terminate" }),
      });
      setSession(null);
      setSessionAlive(false);
      toast({ title: "Agent session terminated" });
    } catch {
      setError("Failed to terminate session");
    }
  }, [toast]);

  /* ─── Input Handling ───────────────────────────────────────────────── */

  const sendMessage = useCallback(
    async (text?: string) => {
      const message = (text ?? draft).trim();
      if (!message) return;

      // If no session, launch one first then send
      if (!session) {
        await launchSession();
        // The WebSocket will connect and we send via it
        // For now, queue the message to be sent after WS connects
        // We'll rely on the terminal's WS for input instead
        setDraft("");
        return;
      }

      setSending(true);
      setError(null);
      try {
        // Send via the executive API (which routes to tmux pane)
        const res = await fetch(EXECUTIVE_API_ENDPOINT, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "send", text: message, enter: true }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error || `Send failed (${res.status})`);
          return;
        }
        setDraft("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send message");
      } finally {
        setSending(false);
      }
    },
    [draft, session, launchSession],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  const handleResourceToggle = useCallback((id: string) => {
    setSelectedResources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  /* WebSocket callbacks */
  const handleWsOpen = useCallback(() => {
    setSessionAlive(true);
  }, []);

  const handleWsClose = useCallback(() => {
    setSessionAlive(false);
  }, []);

  /* Cleanup on unmount */
  useEffect(() => {
    return () => {
      if (speakTimerRef.current) clearTimeout(speakTimerRef.current);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  /* ─── Scope options ────────────────────────────────────────────────── */

  const scopeOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      { value: "self", label: "Self" },
    ];
    for (const p of personas) {
      options.push({ value: p.id, label: p.name });
    }
    return options;
  }, [personas]);

  /* ─── Render ───────────────────────────────────────────────────────── */

  // FAB button
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed z-50 flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg shadow-blue-600/25 transition-all hover:bg-blue-500 hover:shadow-xl hover:shadow-blue-500/30 active:scale-95 bottom-20 right-4 md:bottom-6 md:right-6"
        aria-label="Open Agent Chat"
      >
        <Bot className="h-6 w-6" />
      </button>
    );
  }

  const hasSession = session !== null;
  const showTerminal = hasSession;

  return (
    <>
      {/* Backdrop on mobile */}
      <div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
        onClick={() => setOpen(false)}
        aria-hidden
      />

      {/* Panel */}
      <div
        className={[
          "fixed z-50 flex flex-col overflow-hidden",
          "bg-zinc-950 border border-zinc-800 shadow-2xl shadow-black/50",
          // Mobile: full screen
          "inset-0 rounded-none",
          // Desktop: right-side panel
          "md:inset-auto md:bottom-24 md:right-6 md:w-[32rem] md:max-h-[calc(100dvh-8rem)] md:rounded-xl",
        ].join(" ")}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/80 px-4 py-3 shrink-0">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-blue-400" />
            <h2 className="text-sm font-semibold text-zinc-100">Agent Chat</h2>
            {hasSession && (
              <Badge
                variant="outline"
                className={
                  sessionAlive
                    ? "border-emerald-700 bg-emerald-950/50 text-emerald-400 text-[10px] px-1.5 py-0"
                    : "border-zinc-700 bg-zinc-900 text-zinc-500 text-[10px] px-1.5 py-0"
                }
              >
                {sessionAlive ? "Live" : "Disconnected"}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* Context toggle */}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-zinc-400 hover:text-zinc-200"
              onClick={() => setContextExpanded((prev) => !prev)}
              title={contextExpanded ? "Collapse context" : "Expand context"}
            >
              {contextExpanded ? (
                <PanelTopClose className="h-4 w-4" />
              ) : (
                <PanelTopOpen className="h-4 w-4" />
              )}
            </Button>
            {/* Terminate session */}
            {hasSession && (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-red-500 hover:text-red-400 hover:bg-red-950/30"
                onClick={() => void terminateSession()}
                title="Terminate session"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            )}
            {/* Close panel */}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-zinc-400 hover:text-zinc-200"
              onClick={() => setOpen(false)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Context Bar (collapsible) */}
        {contextExpanded && (
          <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-3 py-2 space-y-2">
            {/* Dropdowns row */}
            <div className="flex flex-wrap gap-2">
              {/* Agent scope */}
              <div className="min-w-0 flex-1">
                <label className="block text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-0.5">
                  Agent
                </label>
                <Select value={agentScope} onValueChange={setAgentScope}>
                  <SelectTrigger className="h-7 text-xs bg-zinc-900 border-zinc-700 text-zinc-300">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* KG scope */}
              <div className="min-w-0 flex-1">
                <label className="block text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-0.5">
                  KG
                </label>
                <Select value={kgScope} onValueChange={setKgScope}>
                  <SelectTrigger className="h-7 text-xs bg-zinc-900 border-zinc-700 text-zinc-300">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeOptions.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Workspace selector */}
            {workspaces.length > 0 && (
              <div>
                <label className="block text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-0.5">
                  Workspace
                </label>
                <Select value={selectedWorkspaceId} onValueChange={setSelectedWorkspaceId}>
                  <SelectTrigger className="h-7 text-xs bg-zinc-900 border-zinc-700 text-zinc-300">
                    <SelectValue placeholder="Select workspace" />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((ws) => (
                      <SelectItem key={ws.id} value={ws.id}>
                        {ws.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Resource tree */}
            <div>
              <div className="flex items-center justify-between mb-0.5">
                <label className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider">
                  Resources
                </label>
                {selectedResources.size > 0 && (
                  <Badge
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 bg-blue-950/50 text-blue-400 border-blue-800"
                  >
                    {selectedResources.size} selected
                  </Badge>
                )}
              </div>
              <div className="rounded-md border border-zinc-800 bg-zinc-950/80">
                {resourcesLoading ? (
                  <div className="flex items-center justify-center py-3">
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-600" />
                  </div>
                ) : (
                  <ResourceTree
                    items={resourceTree}
                    selected={selectedResources}
                    onToggle={handleResourceToggle}
                  />
                )}
              </div>
            </div>
          </div>
        )}

        {/* Terminal area */}
        <div className="flex-1 min-h-0 relative">
          {showTerminal ? (
            <XTermPane
              ref={terminalRef}
              maxHeight="100%"
              active
              wsUrl={wsUrl}
              onWsOpen={handleWsOpen}
              onWsClose={handleWsClose}
              onWsData={handleTerminalData}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              {sessionLoading ? (
                <>
                  <Loader2 className="h-8 w-8 animate-spin text-zinc-600" />
                  <p className="text-sm text-zinc-500">Checking for active session...</p>
                </>
              ) : (
                <>
                  <div className="rounded-full bg-zinc-900 p-4">
                    <Bot className="h-8 w-8 text-zinc-600" />
                  </div>
                  <p className="text-sm text-zinc-400">
                    Select context and start chatting.
                  </p>
                  <p className="text-xs text-zinc-600">
                    Choose an agent scope, KG scope, and workspace above, then type a message to begin.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                    onClick={() => void launchSession()}
                    disabled={launching}
                  >
                    {launching ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Bot className="mr-2 h-3.5 w-3.5" />
                    )}
                    Start Session
                  </Button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Error banner */}
        {error && (
          <div className="shrink-0 border-t border-red-900/50 bg-red-950/30 px-3 py-1.5">
            <p className="text-xs text-red-400 truncate">{error}</p>
          </div>
        )}

        {/* Voice status */}
        {voiceStatus && (
          <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/60 px-3 py-1">
            <p className="text-[10px] text-zinc-500 truncate">{voiceStatus}</p>
          </div>
        )}

        {/* Input bar */}
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/80 px-3 py-2">
          <div className="flex items-center gap-2">
            {/* Voice controls */}
            <div className="flex items-center gap-0.5 shrink-0">
              {/* Mic toggle */}
              <Button
                variant="ghost"
                size="icon"
                className={[
                  "h-8 w-8",
                  isListening
                    ? "text-red-400 bg-red-950/30 hover:bg-red-950/50"
                    : "text-zinc-500 hover:text-zinc-300",
                ].join(" ")}
                onClick={toggleListening}
                title={isListening ? "Stop listening" : "Start listening"}
              >
                {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </Button>

              {/* TTS toggle */}
              <Button
                variant="ghost"
                size="icon"
                className={[
                  "h-8 w-8",
                  ttsEnabled
                    ? "text-blue-400 bg-blue-950/30 hover:bg-blue-950/50"
                    : "text-zinc-500 hover:text-zinc-300",
                ].join(" ")}
                onClick={() => setTtsEnabled((prev) => !prev)}
                title={ttsEnabled ? "Disable auto-speak" : "Enable auto-speak"}
              >
                {ttsEnabled ? (
                  <Volume2 className="h-4 w-4" />
                ) : (
                  <VolumeX className="h-4 w-4" />
                )}
              </Button>

              {/* Stop speaking */}
              {isSpeaking && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-amber-400 hover:text-amber-300"
                  onClick={stopSpeaking}
                  title="Stop speaking"
                >
                  <Square className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>

            {/* Text input */}
            <Input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={hasSession ? "Type a message..." : "Type a message to start..."}
              className="flex-1 h-8 text-sm bg-zinc-900 border-zinc-700 text-zinc-200 placeholder:text-zinc-600 focus-visible:ring-blue-600/50"
              disabled={sending}
            />

            {/* Send button */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-blue-400 hover:text-blue-300 hover:bg-blue-950/30 shrink-0"
              onClick={() => void sendMessage()}
              disabled={sending || (!draft.trim() && !hasSession)}
              title="Send message"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

export default AgentChat;
