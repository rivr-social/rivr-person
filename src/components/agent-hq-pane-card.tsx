"use client";

import { Badge } from "@/components/ui/badge";
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Eye,
  Layers,
  Monitor,
  Sparkles,
  Terminal,
  Workflow,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentRole = "executive" | "architect" | "orchestrator" | "worker" | "observer";
export type AgentLauncherProvider = "claude" | "codex" | "opencode" | "custom";

export interface PaneCardSession {
  sessionName: string;
  windowIndex: number;
  paneIndex: number;
  paneId?: string;
  active: boolean;
  dead?: boolean;
  metadata: {
    role: AgentRole | string;
    parent: string | null;
    label: string;
    notes: string;
    objective: string;
    provider?: AgentLauncherProvider | string;
    cwd?: string;
    workspaceId?: string;
    personaId?: string | null;
    personaName?: string;
    kgScopeSet?: string[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROLE_COLORS: Record<string, string> = {
  executive: "border-violet-500/40 bg-violet-500/5",
  architect: "border-blue-500/40 bg-blue-500/5",
  orchestrator: "border-cyan-500/40 bg-cyan-500/5",
  worker: "border-green-500/40 bg-green-500/5",
  observer: "border-zinc-500/40 bg-zinc-500/5",
};

const ROLE_BADGE_COLORS: Record<string, string> = {
  executive: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  architect: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  orchestrator: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  worker: "bg-green-500/20 text-green-300 border-green-500/30",
  observer: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
};

const ROLE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  executive: Terminal,
  architect: Brain,
  orchestrator: Workflow,
  worker: Bot,
  observer: Eye,
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  custom: "Custom",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function paneKeyForSession(
  session: Pick<PaneCardSession, "sessionName" | "windowIndex" | "paneIndex" | "paneId">,
) {
  if (typeof session.paneId === "string" && session.paneId.startsWith("%")) {
    return session.paneId;
  }
  return `${session.sessionName}:${session.windowIndex}.${session.paneIndex}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface AgentHqPaneCardProps {
  session: PaneCardSession;
  isSelected: boolean;
  isExpanded: boolean;
  childCount: number;
  onSelect: () => void;
  onToggleExpand: () => void;
}

export function AgentHqPaneCard({
  session,
  isSelected,
  isExpanded,
  childCount,
  onSelect,
  onToggleExpand,
}: AgentHqPaneCardProps) {
  const role = session.metadata.role;
  const cardColor = ROLE_COLORS[role] ?? ROLE_COLORS.worker;
  const badgeColor = ROLE_BADGE_COLORS[role] ?? ROLE_BADGE_COLORS.worker;
  const RoleIcon = ROLE_ICONS[role] ?? Bot;
  const provider = session.metadata.provider;
  const providerLabel = provider ? PROVIDER_LABELS[provider] ?? provider : null;

  const statusDot = session.dead
    ? "bg-red-500"
    : session.active
      ? "bg-green-500"
      : "bg-yellow-500";

  const statusLabel = session.dead
    ? "disconnected"
    : session.active
      ? "active"
      : "idle";

  return (
    <div
      className={`
        group relative rounded-lg border transition-all cursor-pointer
        ${cardColor}
        ${isSelected ? "ring-2 ring-primary/50 shadow-md" : "hover:shadow-sm"}
      `}
      onClick={onSelect}
    >
      {/* Main card content */}
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        {/* Status indicator */}
        <div className="flex flex-col items-center gap-1 pt-1">
          <span className={`h-2.5 w-2.5 rounded-full ${statusDot}`} title={statusLabel} />
          <RoleIcon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>

        {/* Info block */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-medium text-sm truncate">
              {session.metadata.label || session.sessionName}
            </span>
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 shrink-0 ${badgeColor}`}>
              {role}
            </Badge>
            {providerLabel && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0 bg-muted/30">
                {providerLabel}
              </Badge>
            )}
            {session.metadata.personaName && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0 bg-purple-500/10 text-purple-300 border-purple-500/30">
                <Sparkles className="h-2.5 w-2.5 mr-0.5" />
                {session.metadata.personaName}
              </Badge>
            )}
          </div>

          {session.metadata.objective && (
            <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
              {session.metadata.objective}
            </p>
          )}
        </div>

        {/* Expand toggle for parents with children */}
        {childCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted/50 shrink-0"
          >
            <Layers className="h-3 w-3" />
            <span>{childCount}</span>
            {isExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
