"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Play,
  RefreshCw,
  Send,
  Square,
  Terminal,
} from "lucide-react";
import dynamic from "next/dynamic";
import type { XTermPaneHandle } from "@/components/xterm-pane";
import { ContextMountManager } from "@/components/context-mount-manager";
import type { ContextMount } from "@/components/context-mount-manager";

const XTermPane = dynamic(() => import("@/components/xterm-pane"), { ssr: false });

/* ------------------------------------------------------------------ */
/*  Types (matching API response shapes)                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 3000;
const CAPTURE_LINES = 100;

const ROLE_ORDER = ["executive", "architect", "orchestrator", "worker", "observer"];
const ROLE_COLORS: Record<string, string> = {
  executive: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  architect: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  orchestrator: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  worker: "bg-green-500/20 text-green-300 border-green-500/30",
  observer: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
};

function paneKeyForSession(session: Pick<AgentSession, "sessionName" | "windowIndex" | "paneIndex" | "paneId">) {
  if (typeof session.paneId === "string" && session.paneId.startsWith("%")) {
    return session.paneId;
  }
  return `${session.sessionName}:${session.windowIndex}.${session.paneIndex}`;
}

/* ------------------------------------------------------------------ */
/*  Child session row                                                 */
/* ------------------------------------------------------------------ */

function SessionRow({
  session,
  isSelected,
  onSelect,
}: {
  session: AgentSession;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const paneKey = paneKeyForSession(session);
  const role = session.metadata.role;
  const roleClass = ROLE_COLORS[role] ?? ROLE_COLORS.worker;

  return (
    <button
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
        isSelected
          ? "border-primary/40 bg-primary/5"
          : "border-border/30 bg-muted/20 hover:bg-muted/40"
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${session.dead ? "bg-red-500" : session.active ? "bg-green-500" : "bg-yellow-500"}`}
      />
      <span className="flex-1 truncate font-medium">
        {session.metadata.label || session.title}
      </span>
      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${roleClass}`}>
        {role}
      </Badge>
      {session.metadata.personaName && (
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
          {session.metadata.personaName}
        </Badge>
      )}
      {isSelected && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Main supervisor console                                           */
/* ------------------------------------------------------------------ */

export function SupervisorConsole() {
  const [groups, setGroups] = useState<RoleGroup[]>([]);
  const [selectedPaneKey, setSelectedPaneKey] = useState<string | null>(null);
  const [capture, setCapture] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set(ROLE_ORDER));
  const [contextMounts, setContextMounts] = useState<ContextMount[]>([]);

  const termRef = useRef<XTermPaneHandle>(null);

  /* ---- Load executive session context mounts ---- */
  useEffect(() => {
    fetch("/api/agent-hq/executive", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.session?.contextMounts) {
          setContextMounts(data.session.contextMounts);
        }
      })
      .catch(() => {});
  }, []);

  const handleContextMountsChange = useCallback((mounts: ContextMount[]) => {
    setContextMounts(mounts);
    // Persist to executive session
    fetch("/api/agent-hq/executive", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "updateMounts", contextMounts: mounts }),
    }).catch(() => {});
  }, []);

  /* ---- Fetch sessions ---- */
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/agent-hq/sessions", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const grouped = Array.isArray(data.grouped) ? data.grouped as RoleGroup[] : [];
      setGroups(grouped);

      // Auto-select executive if nothing selected
      if (!selectedPaneKey) {
        const executive = grouped
          .find((g) => g.role === "executive")
          ?.sessions?.[0];
        if (executive) {
          setSelectedPaneKey(paneKeyForSession(executive));
        }
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [selectedPaneKey]);

  /* ---- Capture selected pane ---- */
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
    } catch {}
  }, [selectedPaneKey]);

  /* ---- Polling ---- */
  useEffect(() => {
    void fetchSessions();
    const id = setInterval(() => {
      void fetchSessions();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchSessions]);

  useEffect(() => {
    if (!selectedPaneKey) return;
    void capturePane();
    const id = setInterval(() => {
      void capturePane();
    }, 2000);
    return () => clearInterval(id);
  }, [selectedPaneKey, capturePane]);

  /* ---- Send input ---- */
  const handleSend = useCallback(async () => {
    if (!selectedPaneKey || !inputValue.trim()) return;
    setSending(true);
    try {
      await fetch("/api/agent-hq/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: selectedPaneKey, text: inputValue.trim(), enter: true }),
      });
      setInputValue("");
      setTimeout(() => capturePane(), 500);
    } catch {
      setError("Failed to send input");
    } finally {
      setSending(false);
    }
  }, [selectedPaneKey, inputValue, capturePane]);

  const toggleRole = (role: string) => {
    setExpandedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  };

  const allSessions = groups.flatMap((g) => g.sessions);
  const selectedSession = allSessions.find(
    (s) => paneKeyForSession(s) === selectedPaneKey,
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const hasAnySessions = allSessions.length > 0;

  return (
    <div className="space-y-4">
      {/* ---- Terminal viewer ---- */}
      <Card className="overflow-hidden">
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-sm font-medium">
              {selectedSession
                ? `${selectedSession.metadata.label || selectedSession.title}`
                : "No session selected"}
            </CardTitle>
            {selectedSession && (
              <>
                <Badge
                  variant="outline"
                  className={`text-[10px] px-1.5 py-0 ${ROLE_COLORS[selectedSession.metadata.role] ?? ""}`}
                >
                  {selectedSession.metadata.role}
                </Badge>
                <span
                  className={`h-2 w-2 rounded-full ${selectedSession.dead ? "bg-red-500" : selectedSession.active ? "bg-green-500" : "bg-yellow-500"}`}
                />
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => {
              void fetchSessions();
              void capturePane();
            }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {selectedPaneKey ? (
            <div className="border-t border-border/30">
              <XTermPane ref={termRef} maxHeight="320px" active={!!selectedSession && !selectedSession.dead} />
              {/* Input */}
              <div className="flex items-center gap-2 border-t border-border/30 px-3 py-2">
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder="Send to selected session..."
                  disabled={!selectedSession || selectedSession.dead || sending}
                  className="flex-1 h-8 rounded-md border border-border/40 bg-muted/30 px-2.5 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => void handleSend()}
                  disabled={!selectedSession || selectedSession.dead || sending || !inputValue.trim()}
                >
                  {sending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex h-48 items-center justify-center border-t border-border/30 text-sm text-muted-foreground">
              {hasAnySessions
                ? "Select a session from the list below to view its terminal output."
                : "No agent sessions are running. Launch an executive from the bubble in the bottom-right corner."}
            </div>
          )}

          {/* Objective display */}
          {selectedSession?.metadata.objective && (
            <div className="border-t border-border/30 px-3 py-2">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium">Objective:</span>{" "}
                {selectedSession.metadata.objective}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---- Context Mounts ---- */}
      <ContextMountManager
        mounts={contextMounts}
        onMountsChange={handleContextMountsChange}
      />

      {/* ---- Session list by role ---- */}
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {ROLE_ORDER.map((role) => {
          const group = groups.find((g) => g.role === role);
          const sessions = group?.sessions ?? [];
          if (sessions.length === 0) return null;
          const isExpanded = expandedRoles.has(role);

          return (
            <div key={role}>
              <button
                onClick={() => toggleRole(role)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {isExpanded ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                <span className="font-medium capitalize">{role}</span>
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {sessions.length}
                </Badge>
              </button>
              {isExpanded && (
                <div className="ml-5 space-y-1 mt-1">
                  {sessions.map((session) => {
                    const pk = paneKeyForSession(session);
                    return (
                      <SessionRow
                        key={pk}
                        session={session}
                        isSelected={pk === selectedPaneKey}
                        onSelect={() => setSelectedPaneKey(pk)}
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
  );
}
