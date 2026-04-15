"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Drama,
  FileText,
  FolderOpen,
  Loader2,
  Network,
  RefreshCw,
  Send,
  Settings,
  Terminal,
} from "lucide-react";
import dynamic from "next/dynamic";
import type { XTermPaneHandle } from "@/components/xterm-pane";
import { AgentHqPaneCard, paneKeyForSession } from "@/components/agent-hq-pane-card";
import type { PaneCardSession } from "@/components/agent-hq-pane-card";
import { PersonaManager } from "@/components/persona-manager";
import { AutobotConnectionsPanel } from "@/components/autobot-connections-panel";

const XTermPane = dynamic(() => import("@/components/xterm-pane"), { ssr: false });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_POLL_MS = 3000;
const CAPTURE_POLL_MS = 2000;
const CAPTURE_LINES = 100;
const DB_ENTRY_POLL_MS = 0; // no polling, load on demand

const ROLE_ORDER = ["executive", "architect", "orchestrator", "worker", "observer"];

const ROLE_BADGE_COLORS: Record<string, string> = {
  executive: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  architect: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  orchestrator: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  worker: "bg-green-500/20 text-green-300 border-green-500/30",
  observer: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutobotStatus {
  instance: {
    instanceId: string;
    instanceType: string;
    instanceSlug: string;
    baseUrl: string;
    isGlobal: boolean;
  };
  autobot: {
    primaryAgentId: string | null;
    primaryAgent: {
      id: string;
      name: string;
      image: string | null;
      metadata: Record<string, unknown> | null;
    } | null;
    mcpTokenConfigured: boolean;
    mcpEndpoint: string;
    discoveryEndpoint: string;
  };
}

interface AgentSessionMetadata {
  role: string;
  parent: string | null;
  label: string;
  notes: string;
  objective: string;
  provider?: string;
  cwd?: string;
  workspaceId?: string;
  workspaceScope?: string;
  personaId?: string | null;
  personaName?: string;
  kgScopeSet?: string[];
}

interface AgentSession {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId: string;
  command: string;
  pid: number;
  title: string;
  active: boolean;
  dead: boolean;
  metadata: AgentSessionMetadata;
}

interface RoleGroup {
  role: string;
  sessions: AgentSession[];
}

interface DbEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
}

interface ExplorerNode extends DbEntry {
  id: string;
  expanded?: boolean;
  loaded?: boolean;
  loading?: boolean;
  children?: ExplorerNode[];
}

interface ProvenanceEntry {
  id: string;
  toolName: string;
  actorId: string;
  actorType: string;
  authMode: string;
  controllerId: string | null;
  argsSummary: Record<string, unknown>;
  resultStatus: string;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Sidebar - DB Explorer Tree
// ---------------------------------------------------------------------------

interface DbExplorerTreeProps {
  nodes: ExplorerNode[];
  selectedPaths: Set<string>;
  onToggleDirectory: (node: ExplorerNode) => void;
  onSelectFile: (node: ExplorerNode) => void;
  depth?: number;
}

function DbExplorerTree({
  nodes,
  selectedPaths,
  onToggleDirectory,
  onSelectFile,
  depth = 0,
}: DbExplorerTreeProps) {
  if (nodes.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {nodes.map((node) => {
        const isDirectory = node.type === "directory";
        const isSelected = selectedPaths.has(node.path);
        return (
          <div key={node.id}>
            <button
              type="button"
              className={`
                flex w-full items-center gap-1.5 rounded px-1 py-1 text-xs text-left
                transition-colors hover:bg-muted/60
                ${isSelected ? "bg-primary/10 text-primary" : "text-foreground/80"}
              `}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={() => {
                if (isDirectory) {
                  onToggleDirectory(node);
                } else {
                  onSelectFile(node);
                }
              }}
            >
              {isDirectory ? (
                node.expanded ? (
                  <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                )
              ) : (
                <span
                  className={`
                    inline-flex items-center justify-center h-3.5 w-3.5 shrink-0 rounded-full border
                    ${isSelected
                      ? "border-primary bg-primary"
                      : "border-muted-foreground/40 bg-transparent"
                    }
                  `}
                >
                  {isSelected && <Check className="h-2 w-2 text-primary-foreground" />}
                </span>
              )}
              {isDirectory ? (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate flex-1">{node.name}</span>
              {node.loading && <Loader2 className="h-3 w-3 animate-spin shrink-0 text-muted-foreground" />}
            </button>
            {isDirectory && node.expanded && node.children && node.children.length > 0 && (
              <DbExplorerTree
                nodes={node.children}
                selectedPaths={selectedPaths}
                onToggleDirectory={onToggleDirectory}
                onSelectFile={onSelectFile}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar Footer - Tool Buttons for legacy tabs
// ---------------------------------------------------------------------------

interface SidebarToolButtonsProps {
  status: AutobotStatus | null;
}

function SidebarToolButtons({ status }: SidebarToolButtonsProps) {
  return (
    <div className="flex items-center gap-1 px-2 py-2 border-t border-border/50">
      <TooltipProvider delayDuration={200}>
        {/* Status */}
        <Sheet>
          <Tooltip>
            <TooltipTrigger asChild>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <CircleDot className="h-3.5 w-3.5" />
                </Button>
              </SheetTrigger>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Status</p></TooltipContent>
          </Tooltip>
          <SheetContent side="left" className="w-[400px] sm:w-[480px]">
            <SheetHeader>
              <SheetTitle>Instance Status</SheetTitle>
            </SheetHeader>
            <div className="mt-4 space-y-4 overflow-y-auto max-h-[calc(100vh-6rem)]">
              <StatusPanel status={status} />
            </div>
          </SheetContent>
        </Sheet>

        {/* Personas */}
        <Sheet>
          <Tooltip>
            <TooltipTrigger asChild>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <Drama className="h-3.5 w-3.5" />
                </Button>
              </SheetTrigger>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Personas</p></TooltipContent>
          </Tooltip>
          <SheetContent side="left" className="w-[500px] sm:w-[600px]">
            <SheetHeader>
              <SheetTitle>Personas</SheetTitle>
            </SheetHeader>
            <div className="mt-4 overflow-y-auto max-h-[calc(100vh-6rem)]">
              <PersonaManager />
            </div>
          </SheetContent>
        </Sheet>

        {/* Activity */}
        <Sheet>
          <Tooltip>
            <TooltipTrigger asChild>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <Activity className="h-3.5 w-3.5" />
                </Button>
              </SheetTrigger>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Activity</p></TooltipContent>
          </Tooltip>
          <SheetContent side="right" className="w-[600px] sm:w-[720px]">
            <SheetHeader>
              <SheetTitle>MCP Activity</SheetTitle>
            </SheetHeader>
            <div className="mt-4 overflow-y-auto max-h-[calc(100vh-6rem)]">
              <ActivityPanel />
            </div>
          </SheetContent>
        </Sheet>

        {/* Connections */}
        <Sheet>
          <Tooltip>
            <TooltipTrigger asChild>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7">
                  <Network className="h-3.5 w-3.5" />
                </Button>
              </SheetTrigger>
            </TooltipTrigger>
            <TooltipContent side="top"><p>Connections</p></TooltipContent>
          </Tooltip>
          <SheetContent side="right" className="w-[500px] sm:w-[600px]">
            <SheetHeader>
              <SheetTitle>Connections</SheetTitle>
            </SheetHeader>
            <div className="mt-4 overflow-y-auto max-h-[calc(100vh-6rem)]">
              <AutobotConnectionsPanel />
            </div>
          </SheetContent>
        </Sheet>
      </TooltipProvider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status Panel (moved from old StatusTab)
// ---------------------------------------------------------------------------

function StatusPanel({ status }: { status: AutobotStatus | null }) {
  if (!status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const { instance, autobot } = status;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CircleDot className="h-4 w-4" /> Instance Identity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Type</dt>
            <dd><Badge variant="outline" className="font-mono">{instance.instanceType}</Badge></dd>
            <dt className="text-muted-foreground">Slug</dt>
            <dd className="font-mono text-xs">{instance.instanceSlug}</dd>
            <dt className="text-muted-foreground">ID</dt>
            <dd className="font-mono text-xs truncate" title={instance.instanceId}>{instance.instanceId.slice(0, 8)}...</dd>
            <dt className="text-muted-foreground">Base URL</dt>
            <dd className="font-mono text-xs truncate">
              <a href={instance.baseUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                {instance.baseUrl}
              </a>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Bot className="h-4 w-4" /> Primary Agent
          </CardTitle>
        </CardHeader>
        <CardContent>
          {autobot.primaryAgent ? (
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold">
                {autobot.primaryAgent.name.substring(0, 2).toUpperCase()}
              </div>
              <div>
                <p className="font-medium text-sm">{autobot.primaryAgent.name}</p>
                <p className="font-mono text-xs text-muted-foreground">{autobot.primaryAgentId?.slice(0, 8)}...</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {autobot.primaryAgentId
                ? `Agent ${autobot.primaryAgentId.slice(0, 8)}... (not found)`
                : "No PRIMARY_AGENT_ID configured"}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Terminal className="h-4 w-4" /> MCP Endpoints
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Discovery</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">{autobot.discoveryEndpoint}</code>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">RPC Transport</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">{autobot.mcpEndpoint}</code>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Token Auth</span>
            <Badge variant={autobot.mcpTokenConfigured ? "default" : "destructive"}>
              {autobot.mcpTokenConfigured ? "Configured" : "Not Set"}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Panel (minimal for sheet)
// ---------------------------------------------------------------------------

function ActivityPanel() {
  const [entries, setEntries] = useState<ProvenanceEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/autobot/provenance?limit=50");
        if (res.ok) {
          const data = await res.json();
          setEntries(data.entries ?? []);
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground text-center py-8">No MCP activity recorded yet.</p>;
  }

  return (
    <div className="space-y-1">
      {entries.map((entry) => (
        <div key={entry.id} className="flex items-center gap-2 rounded border border-border/30 px-3 py-2 text-xs">
          <span className={`h-2 w-2 rounded-full shrink-0 ${entry.resultStatus === "success" ? "bg-green-500" : "bg-red-500"}`} />
          <span className="font-mono flex-1 truncate">{entry.toolName}</span>
          <Badge variant="outline" className="text-[10px]">{entry.actorType}</Badge>
          <span className="text-muted-foreground">
            {new Date(entry.createdAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hierarchical Pane Graph
// ---------------------------------------------------------------------------

function buildChildrenMap(sessions: PaneCardSession[]) {
  const children = new Map<string, PaneCardSession[]>();
  for (const session of sessions) {
    const parent = session.metadata.parent?.trim();
    if (!parent) continue;
    const current = children.get(parent) ?? [];
    current.push(session);
    children.set(parent, current);
  }
  return children;
}

function roleRank(role: string): number {
  const idx = ROLE_ORDER.indexOf(role);
  return idx >= 0 ? idx : ROLE_ORDER.length;
}

interface TierConfig {
  label: string;
  roles: string[];
}

const TIER_CONFIG: TierConfig[] = [
  { label: "Visionary / Architect", roles: ["architect"] },
  { label: "Executive", roles: ["executive"] },
  { label: "Orchestrators", roles: ["orchestrator"] },
  { label: "Workers / Subagents", roles: ["worker"] },
  { label: "Observers", roles: ["observer"] },
];

interface PaneGraphProps {
  sessions: PaneCardSession[];
  selectedPaneKey: string | null;
  onSelectPane: (paneKey: string) => void;
}

function PaneGraph({ sessions, selectedPaneKey, onSelectPane }: PaneGraphProps) {
  const [expandedPanes, setExpandedPanes] = useState<Set<string>>(new Set());
  const childrenMap = useMemo(() => buildChildrenMap(sessions), [sessions]);

  const toggleExpand = useCallback((paneKey: string) => {
    setExpandedPanes((prev) => {
      const next = new Set(prev);
      if (next.has(paneKey)) next.delete(paneKey);
      else next.add(paneKey);
      return next;
    });
  }, []);

  // Group sessions into tiers by role
  const tiers = useMemo(() => {
    return TIER_CONFIG.map((tier) => ({
      ...tier,
      sessions: sessions
        .filter((s) => tier.roles.includes(s.metadata.role))
        .sort((a, b) => {
          const ra = roleRank(a.metadata.role);
          const rb = roleRank(b.metadata.role);
          if (ra !== rb) return ra - rb;
          return (a.metadata.label || a.sessionName).localeCompare(b.metadata.label || b.sessionName);
        }),
    })).filter((tier) => tier.sessions.length > 0);
  }, [sessions]);

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="rounded-full bg-muted/30 p-4 mb-4">
          <Terminal className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-medium text-muted-foreground mb-1">No active agent sessions</h3>
        <p className="text-xs text-muted-foreground/70 max-w-[280px]">
          Agent sessions will appear here when launched from the builder or terminal.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {tiers.map((tier) => (
        <div key={tier.label}>
          {/* Tier label */}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {tier.label}
            </span>
            <Separator className="flex-1" />
          </div>

          {/* Tier session cards */}
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {tier.sessions.map((session) => {
              const pk = paneKeyForSession(session);
              const children = childrenMap.get(pk) ?? [];
              const isExpanded = expandedPanes.has(pk);

              return (
                <div key={pk}>
                  <AgentHqPaneCard
                    session={session}
                    isSelected={selectedPaneKey === pk}
                    isExpanded={isExpanded}
                    childCount={children.length}
                    onSelect={() => onSelectPane(pk)}
                    onToggleExpand={() => toggleExpand(pk)}
                  />

                  {/* Nested children */}
                  {isExpanded && children.length > 0 && (
                    <div className="ml-4 mt-1 space-y-1 border-l-2 border-border/30 pl-3">
                      {children.map((child) => {
                        const cpk = paneKeyForSession(child);
                        const grandchildren = childrenMap.get(cpk) ?? [];
                        return (
                          <AgentHqPaneCard
                            key={cpk}
                            session={child}
                            isSelected={selectedPaneKey === cpk}
                            isExpanded={false}
                            childCount={grandchildren.length}
                            onSelect={() => onSelectPane(cpk)}
                            onToggleExpand={() => toggleExpand(cpk)}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Terminal Viewer (expands when a pane is selected)
// ---------------------------------------------------------------------------

interface TerminalViewerProps {
  session: PaneCardSession | null;
  capture: string;
  paneKey: string | null;
  termRef: React.RefObject<XTermPaneHandle | null>;
}

function TerminalViewer({ session, capture, paneKey, termRef }: TerminalViewerProps) {
  if (!session) return null;

  const role = session.metadata.role;
  const badgeColor = ROLE_BADGE_COLORS[role] ?? ROLE_BADGE_COLORS.worker;

  const handleTermInput = useCallback(
    async (data: string) => {
      if (!paneKey) return;
      try {
        await fetch("/api/agent-hq/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: paneKey, text: data, enter: false }),
        });
      } catch {
        // silent
      }
    },
    [paneKey],
  );

  return (
    <Card className="overflow-hidden border-border/50">
      <CardHeader className="py-2 px-3 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium truncate">
            {session.metadata.label || session.sessionName}
          </span>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${badgeColor}`}>
            {role}
          </Badge>
          <span
            className={`h-2 w-2 rounded-full ${session.dead ? "bg-red-500" : session.active ? "bg-green-500" : "bg-yellow-500"}`}
          />
        </div>
      </CardHeader>
      <div className="border-t border-border/30">
        <XTermPane
          ref={termRef}
          maxHeight="320px"
          active={true}
          onInput={handleTermInput}
        />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Executive Chat Bar
// ---------------------------------------------------------------------------

interface ExecutiveChatBarProps {
  executivePaneKey: string | null;
  onPaneSelected: (paneKey: string) => void;
}

function ExecutiveChatBar({ executivePaneKey, onPaneSelected }: ExecutiveChatBarProps) {
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [lastReply, setLastReply] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(async () => {
    if (!executivePaneKey || !inputValue.trim()) return;
    setSending(true);
    const sent = inputValue.trim();
    try {
      await fetch("/api/agent-hq/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: executivePaneKey,
          text: sent,
          enter: true,
        }),
      });
      setInputValue("");
      setLastReply(`You: ${sent}`);
      // Focus the executive pane so the user can see the response in the terminal
      onPaneSelected(executivePaneKey);

      // Poll for a response after a short delay
      setTimeout(async () => {
        try {
          const captureRes = await fetch(
            `/api/agent-hq/capture?target=${encodeURIComponent(executivePaneKey)}&lines=20&raw=1`,
            { cache: "no-store" },
          );
          if (captureRes.ok) {
            const data = await captureRes.json();
            const lines = (data.output ?? "").split("\n").filter((l: string) => l.trim());
            if (lines.length > 0) {
              setLastReply(lines.slice(-3).join(" ").slice(0, 200));
            }
          }
        } catch {
          // silent
        }
      }, 3000);
    } catch {
      // silent
    } finally {
      setSending(false);
    }
  }, [executivePaneKey, inputValue, onPaneSelected]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  if (!executivePaneKey) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Terminal className="h-3.5 w-3.5" />
        <span>No executive session active. Launch one from the builder to use the chat bar.</span>
      </div>
    );
  }

  return (
    <div className="space-y-0">
      {/* Last reply preview */}
      {lastReply && (
        <div className="px-4 py-1.5 text-xs text-muted-foreground bg-muted/20 border-b border-border/30 line-clamp-2">
          <span className="font-medium text-violet-400">Executive: </span>
          {lastReply}
        </div>
      )}

      {/* Input bar */}
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="h-2 w-2 rounded-full bg-violet-500" />
          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Exec</span>
        </div>
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send to executive..."
          disabled={sending}
          className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground/50 focus:outline-none"
        />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          disabled={sending || !inputValue.trim()}
          onClick={handleSend}
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function AutobotPage() {
  // ---- Global state ----
  const [status, setStatus] = useState<AutobotStatus | null>(null);
  const [groups, setGroups] = useState<RoleGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // ---- Pane selection ----
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null);
  const [capture, setCapture] = useState("");
  const termRef = useRef<XTermPaneHandle>(null);

  // ---- DB Explorer ----
  const [dbTree, setDbTree] = useState<ExplorerNode[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [selectedDbPaths, setSelectedDbPaths] = useState<Set<string>>(new Set());

  // ---- Sidebar collapse ----
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // ---- Derived sessions ----
  const allSessions = useMemo<PaneCardSession[]>(() => {
    return groups.flatMap((g) => g.sessions) as PaneCardSession[];
  }, [groups]);

  const selectedSession = useMemo(() => {
    return allSessions.find((s) => paneKeyForSession(s) === selectedPaneKey) ?? null;
  }, [allSessions, selectedPaneKey]);

  const executivePaneKey = useMemo(() => {
    const executive = groups.find((g) => g.role === "executive")?.sessions?.[0];
    return executive ? paneKeyForSession(executive as PaneCardSession) : null;
  }, [groups]);

  // ---- Fetch status ----
  useEffect(() => {
    fetch("/api/autobot/status")
      .then((r) => (r.ok ? r.json() : null))
      .then(setStatus)
      .catch(() => {});
  }, []);

  // ---- Fetch sessions with polling ----
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-hq/sessions", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const grouped = Array.isArray(data.grouped) ? (data.grouped as RoleGroup[]) : [];
      setGroups(grouped);

      // Auto-select executive if nothing selected
      if (!selectedPaneKey) {
        const executive = grouped.find((g) => g.role === "executive")?.sessions?.[0];
        if (executive) {
          setSelectedPaneKey(paneKeyForSession(executive as PaneCardSession));
        }
      }
      setError(data.warning ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [selectedPaneKey]);

  useEffect(() => {
    void fetchSessions();
    const id = setInterval(() => void fetchSessions(), SESSIONS_POLL_MS);
    return () => clearInterval(id);
  }, [fetchSessions]);

  // ---- Capture selected pane with polling ----
  const capturePane = useCallback(async () => {
    if (!selectedPaneKey) return;
    try {
      const res = await fetch(
        `/api/agent-hq/capture?target=${encodeURIComponent(selectedPaneKey)}&lines=${CAPTURE_LINES}&raw=1`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const data = await res.json();
      const output = data.output ?? "";
      setCapture(output);
      termRef.current?.writeRaw(output);
    } catch {
      // silent
    }
  }, [selectedPaneKey]);

  useEffect(() => {
    if (!selectedPaneKey) return;
    void capturePane();
    const id = setInterval(() => void capturePane(), CAPTURE_POLL_MS);
    return () => clearInterval(id);
  }, [selectedPaneKey, capturePane]);

  // ---- DB Explorer ----
  const toExplorerNodes = useCallback((entries: DbEntry[]): ExplorerNode[] => {
    return [...entries]
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => ({ ...entry, id: entry.path || "__root__" }));
  }, []);

  const updateExplorerNode = useCallback(
    (nodes: ExplorerNode[], targetId: string, updater: (node: ExplorerNode) => ExplorerNode): ExplorerNode[] =>
      nodes.map((node) => {
        if (node.id === targetId) return updater(node);
        if (node.children?.length) {
          return { ...node, children: updateExplorerNode(node.children, targetId, updater) };
        }
        return node;
      }),
    [],
  );

  const loadDbRoot = useCallback(async () => {
    setDbLoading(true);
    try {
      const res = await fetch("/api/agent-hq/db/entries", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setDbTree(toExplorerNodes(data.entries ?? []));
    } catch {
      // silent
    } finally {
      setDbLoading(false);
    }
  }, [toExplorerNodes]);

  useEffect(() => {
    loadDbRoot();
  }, [loadDbRoot]);

  const toggleDbDirectory = useCallback(
    async (node: ExplorerNode) => {
      if (node.type !== "directory") return;
      if (node.expanded) {
        setDbTree((current) => updateExplorerNode(current, node.id, (n) => ({ ...n, expanded: false })));
        return;
      }
      if (node.loaded) {
        setDbTree((current) => updateExplorerNode(current, node.id, (n) => ({ ...n, expanded: true })));
        return;
      }
      setDbTree((current) =>
        updateExplorerNode(current, node.id, (n) => ({ ...n, expanded: true, loading: true })),
      );
      try {
        const params = new URLSearchParams({ path: node.path });
        const res = await fetch(`/api/agent-hq/db/entries?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const children = toExplorerNodes(data.entries ?? []);
        setDbTree((current) =>
          updateExplorerNode(current, node.id, (n) => ({
            ...n,
            expanded: true,
            loading: false,
            loaded: true,
            children,
          })),
        );
      } catch {
        setDbTree((current) =>
          updateExplorerNode(current, node.id, (n) => ({ ...n, loading: false })),
        );
      }
    },
    [toExplorerNodes, updateExplorerNode],
  );

  const selectDbFile = useCallback(
    async (node: ExplorerNode) => {
      if (node.type === "directory") return;
      const isRemoving = selectedDbPaths.has(node.path);

      // Toggle selection
      setSelectedDbPaths((prev) => {
        const next = new Set(prev);
        if (next.has(node.path)) {
          next.delete(node.path);
        } else {
          next.add(node.path);
        }
        return next;
      });

      // If adding and there's an active pane, fetch file content and send to pane
      if (!isRemoving && selectedPaneKey) {
        try {
          const params = new URLSearchParams({ path: node.path });
          const res = await fetch(`/api/agent-hq/db/file?${params.toString()}`, { cache: "no-store" });
          if (!res.ok) return;
          const data = await res.json();
          const content = typeof data.content === "string"
            ? data.content
            : JSON.stringify(data.content, null, 2);
          const contextBlock = `\n--- Context: ${node.name} (${node.path}) ---\n${content.slice(0, 4000)}\n--- End Context ---\n`;
          await fetch("/api/agent-hq/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              target: selectedPaneKey,
              text: contextBlock,
              enter: false,
            }),
          });
        } catch {
          // silent
        }
      }
    },
    [selectedDbPaths, selectedPaneKey],
  );

  // ---- Handle pane selection ----
  const handleSelectPane = useCallback((paneKey: string) => {
    setSelectedPaneKey(paneKey);
  }, []);

  // ---- Render ----
  return (
    <div
      className="h-[100dvh] overflow-hidden"
      style={{
        display: "grid",
        gridTemplateColumns: sidebarCollapsed ? "0px 1fr" : "280px 1fr",
        gridTemplateRows: "1fr auto",
      }}
    >
      {/* ================================================================ */}
      {/* LEFT SIDEBAR - DB Explorer                                       */}
      {/* ================================================================ */}
      <div
        className="border-r border-border/50 flex flex-col overflow-hidden bg-background/50"
        style={{ gridRow: "1 / -1" }}
      >
        {!sidebarCollapsed && (
          <>
            {/* Sidebar header */}
            <div className="flex items-center justify-between px-3 py-2.5 border-b border-border/50">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Explorer
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={loadDbRoot}
                disabled={dbLoading}
              >
                <RefreshCw className={`h-3 w-3 ${dbLoading ? "animate-spin" : ""}`} />
              </Button>
            </div>

            {/* Tree content */}
            <ScrollArea className="flex-1">
              <div className="py-1">
                {dbLoading && dbTree.length === 0 ? (
                  <div className="space-y-1 px-2 py-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                      <Skeleton key={i} className="h-6 w-full" />
                    ))}
                  </div>
                ) : dbTree.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-4">No entries found</p>
                ) : (
                  <DbExplorerTree
                    nodes={dbTree}
                    selectedPaths={selectedDbPaths}
                    onToggleDirectory={toggleDbDirectory}
                    onSelectFile={selectDbFile}
                  />
                )}
              </div>
            </ScrollArea>

            {/* Selected context summary */}
            {selectedDbPaths.size > 0 && (
              <div className="border-t border-border/50 px-3 py-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    Appended to {selectedSession?.metadata?.label || selectedSession?.sessionName || "pane"} ({selectedDbPaths.size})
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 text-[10px] px-1"
                    onClick={() => setSelectedDbPaths(new Set())}
                  >
                    Clear
                  </Button>
                </div>
                <div className="space-y-0.5 max-h-[80px] overflow-y-auto">
                  {Array.from(selectedDbPaths).map((p) => (
                    <div key={p} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Check className="h-2.5 w-2.5 text-primary shrink-0" />
                      <span className="truncate">{p.split("/").pop()}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Sidebar footer with tool buttons */}
            <SidebarToolButtons status={status} />
          </>
        )}
      </div>

      {/* ================================================================ */}
      {/* MAIN AREA - Pane Graph + Terminal Viewer                          */}
      {/* ================================================================ */}
      <div className="overflow-y-auto" style={{ gridColumn: 2 }}>
        <ScrollArea className="h-full">
          <div className="p-4 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setSidebarCollapsed((prev) => !prev)}
                >
                  {sidebarCollapsed ? (
                    <ChevronRight className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </Button>
                <div className="flex items-center gap-2">
                  <div className="rounded-full bg-primary/10 p-1.5">
                    <Terminal className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <h1 className="text-sm font-semibold">Agent HQ</h1>
                    <p className="text-[11px] text-muted-foreground">
                      {allSessions.length} session{allSessions.length !== 1 ? "s" : ""} active
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1">
                {error && (
                  <Badge variant="outline" className="text-[10px] text-yellow-400 border-yellow-500/30 mr-2">
                    {error}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => fetchSessions()}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </div>

            {/* Loading state */}
            {loading && allSessions.length === 0 ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : (
              <>
                {/* Pane Graph */}
                <PaneGraph
                  sessions={allSessions}
                  selectedPaneKey={selectedPaneKey}
                  onSelectPane={handleSelectPane}
                />

                {/* Terminal Viewer for selected pane */}
                {selectedSession && (
                  <div className="mt-4">
                    <TerminalViewer
                      session={selectedSession}
                      capture={capture}
                      paneKey={selectedPaneKey}
                      termRef={termRef}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* ================================================================ */}
      {/* BOTTOM - Executive Chat Bar                                       */}
      {/* ================================================================ */}
      <div
        className="border-t border-border/50 bg-background/80 backdrop-blur-sm"
        style={{ gridColumn: 2 }}
      >
        <ExecutiveChatBar
          executivePaneKey={executivePaneKey}
          onPaneSelected={handleSelectPane}
        />
      </div>
    </div>
  );
}
