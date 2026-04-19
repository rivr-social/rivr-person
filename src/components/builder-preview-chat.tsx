"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronRight,
  Loader2,
  MessageSquareDashed,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Send,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAPTURE_REFRESH_INTERVAL_MS = 3000;
const CAPTURE_LINES = 60;
const STICK_TO_BOTTOM_THRESHOLD_PX = 16;

// ---------------------------------------------------------------------------
// Types (mirrored from builder-agents-panel to stay decoupled)
// ---------------------------------------------------------------------------

type AgentRole = "architect" | "orchestrator" | "worker" | "observer";

interface AgentSessionMetadata {
  role: AgentRole;
  parent: string | null;
  label: string;
  notes: string;
  objective: string;
  provider?: string;
  cwd?: string;
  workspaceId?: string;
  workspaceScope?: string;
  liveSubdomain?: string;
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
  error?: string;
}

interface AgentCaptureResponse {
  output?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function paneKeyForSession(session: Pick<AgentSession, "sessionName" | "windowIndex" | "paneIndex" | "paneId">) {
  if (typeof session.paneId === "string" && session.paneId.startsWith("%")) {
    return session.paneId;
  }
  return `${session.sessionName}:${session.windowIndex}.${session.paneIndex}`;
}

function stripControlCodes(value: string) {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "");
}

function normalizeCaptureOutput(output: string) {
  return stripControlCodes(output)
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .trim();
}

function architectRank(session: AgentSession) {
  if (session.metadata.role === "architect") return 0;
  if (session.metadata.role === "orchestrator") return 1;
  if (session.metadata.role === "worker") return 2;
  return 3;
}

function extractChoices(output: string) {
  const matches = [...output.matchAll(/(?:^|\n)\s*(\d+)\.\s+/g)];
  const unique: string[] = [];
  for (const match of matches) {
    const value = match[1];
    if (!unique.includes(value)) unique.push(value);
    if (unique.length >= 5) break;
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BuilderPreviewChat() {
  const [expanded, setExpanded] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [output, setOutput] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preRef = useRef<HTMLPreElement>(null);
  const scrollStateRef = useRef<{ top: number; left: number; stickToBottom: boolean }>({
    top: 0,
    left: 0,
    stickToBottom: true,
  });
  const interactionLockRef = useRef(false);

  // Find the primary architect session (highest rank)
  const primarySession = useMemo(() => {
    return [...sessions]
      .sort((a, b) => architectRank(a) - architectRank(b) || paneKeyForSession(a).localeCompare(paneKeyForSession(b)))
      [0] ?? null;
  }, [sessions]);

  const paneKey = primarySession ? paneKeyForSession(primarySession) : null;

  // Fetch sessions
  const fetchSessions = useCallback(async () => {
    try {
      const response = await fetch("/api/agent-hq/sessions", { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as AgentSessionsResponse;
      if (!response.ok || data.error) return;
      setSessions(data.sessions ?? []);
      setError(null);
    } catch {
      // Silently fail - agent HQ may not be running
    } finally {
      setLoading(false);
    }
  }, []);

  // Capture output for the primary session
  const captureOutput = useCallback(async (target: string) => {
    if (interactionLockRef.current) return;
    try {
      const response = await fetch(
        `/api/agent-hq/capture?target=${encodeURIComponent(target)}&lines=${CAPTURE_LINES}`,
        { cache: "no-store" },
      );
      const data = (await response.json().catch(() => ({}))) as AgentCaptureResponse;
      if (!response.ok || data.error) return;
      setOutput(normalizeCaptureOutput(data.output ?? ""));
    } catch {
      // Silently fail
    }
  }, []);

  // Restore scroll position after output changes
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    const prior = scrollStateRef.current;
    el.scrollLeft = prior.left;
    el.scrollTop = prior.stickToBottom ? el.scrollHeight : prior.top;
  }, [output]);

  // Initial fetch + polling
  useEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (!expanded || !paneKey) return;
    void captureOutput(paneKey);
    const timer = window.setInterval(() => {
      void captureOutput(paneKey);
    }, CAPTURE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [expanded, paneKey, captureOutput]);

  // Also refresh sessions periodically when expanded
  useEffect(() => {
    if (!expanded) return;
    const timer = window.setInterval(() => {
      void fetchSessions();
    }, CAPTURE_REFRESH_INTERVAL_MS * 2);
    return () => window.clearInterval(timer);
  }, [expanded, fetchSessions]);

  const handleSend = useCallback(async () => {
    if (!paneKey || !draft.trim()) return;
    setSending(true);
    try {
      const response = await fetch("/api/agent-hq/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: paneKey, text: draft.trim(), enter: true }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok || data.error) {
        throw new Error(data.error || "Failed to send");
      }
      setDraft("");
      await captureOutput(paneKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send input");
    } finally {
      setSending(false);
    }
  }, [paneKey, draft, captureOutput]);

  const handleSendChoice = useCallback(
    async (choice: string) => {
      if (!paneKey) return;
      setSending(true);
      try {
        const response = await fetch("/api/agent-hq/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: paneKey, text: choice, enter: true }),
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok || data.error) {
          throw new Error(data.error || "Failed to send choice");
        }
        await captureOutput(paneKey);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to send choice");
      } finally {
        setSending(false);
      }
    },
    [paneKey, captureOutput],
  );

  const choices = useMemo(() => extractChoices(output), [output]);

  // If no sessions found after loading, don't render anything
  if (!loading && sessions.length === 0) {
    return null;
  }

  // Collapsed state: thin vertical icon bar
  if (!expanded) {
    return (
      <div className="flex flex-col items-center w-10 border-l bg-muted/20 py-3 gap-2">
        <button
          onClick={() => setExpanded(true)}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Open architect chat"
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
        {primarySession && (
          <div className="flex flex-col items-center gap-1.5 mt-1">
            <Bot className="h-3.5 w-3.5 text-muted-foreground" />
            <div
              className={`h-2 w-2 rounded-full ${primarySession.active ? "bg-green-500" : "bg-muted-foreground/40"}`}
              title={primarySession.active ? "Architect active" : "Architect idle"}
            />
          </div>
        )}
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
    );
  }

  // Expanded state: sidebar chat panel
  return (
    <div className="flex flex-col w-72 xl:w-80 border-l bg-background min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b bg-muted/20">
        <div className="flex items-center gap-2 min-w-0">
          <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-xs font-medium truncate">
            {primarySession?.metadata.label || "Architect"}
          </span>
          {primarySession && (
            <Badge
              variant={primarySession.active ? "default" : "secondary"}
              className="text-[10px] shrink-0"
            >
              {primarySession.active ? "active" : "idle"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => paneKey && void captureOutput(paneKey)}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Refresh output"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
          <button
            onClick={() => setExpanded(false)}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Collapse architect chat"
          >
            <PanelRightClose className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-3 py-1.5 text-[10px] text-destructive bg-destructive/5 border-b">
          {error}
        </div>
      )}

      {/* Output area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : !primarySession ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-4">
            <MessageSquareDashed className="h-8 w-8 opacity-20" />
            <p className="text-xs text-center">No architect session found. Launch one from the Agents tab.</p>
          </div>
        ) : (
          <pre
            ref={preRef}
            onMouseEnter={() => { interactionLockRef.current = true; }}
            onMouseLeave={() => { interactionLockRef.current = false; }}
            onScroll={(event) => {
              const el = event.currentTarget;
              scrollStateRef.current = {
                top: el.scrollTop,
                left: el.scrollLeft,
                stickToBottom: Math.abs(el.scrollHeight - el.clientHeight - el.scrollTop) < STICK_TO_BOTTOM_THRESHOLD_PX,
              };
            }}
            className="h-full overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[10px] leading-4 text-slate-100 bg-slate-950/95 [tab-size:2]"
          >
            {output || "Waiting for architect output..."}
          </pre>
        )}
      </div>

      {/* Choice buttons */}
      {choices.length > 0 && primarySession && (
        <div className="flex flex-wrap gap-1.5 px-3 py-2 border-t bg-muted/10">
          {choices.map((choice) => (
            <Button
              key={choice}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => void handleSendChoice(choice)}
              disabled={sending}
            >
              {choice}
            </Button>
          ))}
        </div>
      )}

      {/* Input area */}
      {primarySession && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-t">
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            onFocus={() => { interactionLockRef.current = true; }}
            onBlur={() => { interactionLockRef.current = false; }}
            placeholder="Message architect..."
            className="h-8 text-xs"
            disabled={sending}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0 shrink-0"
            onClick={() => void handleSend()}
            disabled={sending || !draft.trim()}
            title="Send"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </Button>
        </div>
      )}
    </div>
  );
}
