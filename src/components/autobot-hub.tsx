"use client";

/**
 * AutobotHub — the single tabbed configuration surface for Agent HQ.
 *
 * Layout (locked overhaul decision):
 *   - A persistent persona ROSTER sits ABOVE the tabs: the controller (the
 *     signed-in account) + each persona + an "Add persona" action. Selecting
 *     an entry chooses which agent the tabs configure.
 *   - A "Configuring: <name>" banner shows the active selection.
 *   - Tabs configure the selected agent: Identity · Roles · Knowledge ·
 *     Voice & Avatar · Connections · Activity.
 *
 * The live tmux/terminal Agent HQ console is preserved at /autobot/console and
 * linked from the header. All styling reuses the existing design system.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Activity,
  Bot,
  Drama,
  Network,
  Plus,
  Terminal,
  UserCog,
} from "lucide-react";
import { listMyPersonas } from "@/app/actions/personas";
import { AutobotConnectionsPanel } from "@/components/autobot-connections-panel";
import { DeviceApprovals } from "@/components/device-approvals";
import { AgentIdentityTab } from "@/components/hub/agent-identity-tab";
import { AgentRolesTab } from "@/components/hub/agent-roles-tab";
import { AgentKnowledgeTab } from "@/components/hub/agent-knowledge-tab";
import { AgentVoiceTab } from "@/components/hub/agent-voice-tab";
import type { SerializedAgent } from "@/lib/graph-serializers";

interface ProvenanceEntry {
  id: string;
  toolName: string;
  actorType: string;
  resultStatus: string;
  createdAt: string;
}

/** Normalized identity used by the Identity/Voice tabs. */
interface AgentIdentity {
  id: string;
  name: string;
  image: string | null;
  bio: string;
  username: string | null;
  skills: string[];
  editHref: string;
  isController: boolean;
}

function personaIdentity(persona: SerializedAgent): AgentIdentity {
  const metadata = persona.metadata ?? {};
  const bio = typeof metadata.bio === "string" ? metadata.bio : persona.description ?? "";
  const username = typeof metadata.username === "string" ? metadata.username : null;
  const skills = Array.isArray(metadata.skills)
    ? (metadata.skills as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  return {
    id: persona.id,
    name: persona.name,
    image: persona.image ?? null,
    bio,
    username,
    skills,
    editHref: `/personas/${persona.id}/edit`,
    isController: false,
  };
}

export function AutobotHub() {
  const router = useRouter();
  const { data: session } = useSession();
  const [personas, setPersonas] = useState<SerializedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [configuringId, setConfiguringId] = useState<string | null>(null);

  const controllerId = session?.user?.id ?? null;

  const refresh = useCallback(async () => {
    const result = await listMyPersonas();
    if (result.success && result.personas) {
      setPersonas(result.personas);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Default the selection to the controller once the session resolves.
  useEffect(() => {
    if (!configuringId && controllerId) setConfiguringId(controllerId);
  }, [configuringId, controllerId]);

  const controllerIdentity: AgentIdentity | null = useMemo(() => {
    if (!controllerId) return null;
    return {
      id: controllerId,
      name: session?.user?.name ?? "You",
      image: session?.user?.image ?? null,
      bio: "",
      username: null,
      skills: [],
      editHref: "/settings",
      isController: true,
    };
  }, [controllerId, session?.user?.name, session?.user?.image]);

  const selected: AgentIdentity | null = useMemo(() => {
    if (!configuringId) return null;
    if (controllerIdentity && configuringId === controllerIdentity.id) {
      return controllerIdentity;
    }
    const persona = personas.find((p) => p.id === configuringId);
    return persona ? personaIdentity(persona) : controllerIdentity;
  }, [configuringId, controllerIdentity, personas]);

  if (loading || !controllerIdentity || !selected || !controllerId) {
    return (
      <div className="p-4 space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="rounded-full bg-primary/10 p-1.5">
            <Bot className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-sm font-semibold">Agent HQ</h1>
            <p className="text-[11px] text-muted-foreground">
              Configure your agents and personas
            </p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="gap-2">
          <Link href="/autobot/console">
            <Terminal className="h-3.5 w-3.5" />
            Live Console
          </Link>
        </Button>
      </div>

      {/* Roster */}
      <div className="rounded-lg border border-border/60 bg-background/50 p-2">
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <RosterEntry
            identity={controllerIdentity}
            selected={configuringId === controllerIdentity.id}
            onSelect={() => setConfiguringId(controllerIdentity.id)}
          />
          {personas.map((persona) => {
            const identity = personaIdentity(persona);
            return (
              <RosterEntry
                key={persona.id}
                identity={identity}
                selected={configuringId === persona.id}
                onSelect={() => setConfiguringId(persona.id)}
              />
            );
          })}
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 gap-1.5 h-auto py-2"
            onClick={() => router.push("/personas/new")}
          >
            <Plus className="h-4 w-4" />
            Add
          </Button>
        </div>
      </div>

      {/* Configuring banner */}
      <div className="flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
        {selected.isController ? (
          <UserCog className="h-4 w-4 text-primary" />
        ) : (
          <Drama className="h-4 w-4 text-primary" />
        )}
        <span>
          Configuring:{" "}
          <strong>{selected.name}</strong>
          {selected.isController && (
            <span className="text-muted-foreground"> (controller)</span>
          )}
        </span>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="identity" key={selected.id} className="w-full">
        <TabsList className="grid w-full grid-cols-3 sm:grid-cols-6">
          <TabsTrigger value="identity">Identity</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
          <TabsTrigger value="voice">Voice</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="identity" className="mt-4">
          <AgentIdentityTab
            name={selected.name}
            image={selected.image}
            bio={selected.bio}
            username={selected.username}
            skills={selected.skills}
            editHref={selected.editHref}
          />
        </TabsContent>

        <TabsContent value="roles" className="mt-4">
          <AgentRolesTab agentId={selected.id} agentLabel={selected.name} />
        </TabsContent>

        <TabsContent value="knowledge" className="mt-4">
          <AgentKnowledgeTab
            agentId={selected.id}
            agentLabel={selected.name}
            ownerId={controllerId}
          />
        </TabsContent>

        <TabsContent value="voice" className="mt-4">
          <AgentVoiceTab agentLabel={selected.name} editHref={selected.editHref} />
        </TabsContent>

        <TabsContent value="connections" className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            Connections follow your active operating identity. Switch personas
            from your profile to manage a persona&apos;s own connections.
          </p>
          <AutobotConnectionsPanel />
        </TabsContent>

        <TabsContent value="activity" className="mt-4 space-y-4">
          <DeviceApprovals />
          <ActivityTab actorId={selected.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RosterEntry({
  identity,
  selected,
  onSelect,
}: {
  identity: AgentIdentity;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
        selected
          ? "border-primary bg-primary/10"
          : "border-border hover:bg-muted/50"
      }`}
    >
      <Avatar className="h-7 w-7">
        <AvatarImage src={identity.image ?? undefined} alt={identity.name} />
        <AvatarFallback className="text-[10px]">
          {identity.name.substring(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="max-w-[120px] truncate font-medium">{identity.name}</span>
      {identity.isController && (
        <Badge variant="secondary" className="text-[10px]">
          You
        </Badge>
      )}
    </button>
  );
}

function ActivityTab({ actorId }: { actorId: string }) {
  const [entries, setEntries] = useState<ProvenanceEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `/api/autobot/provenance?limit=50&actorId=${encodeURIComponent(actorId)}`,
          { cache: "no-store" },
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          setEntries(Array.isArray(data.entries) ? data.entries : []);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [actorId]);

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
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Activity className="h-6 w-6 text-muted-foreground mb-2" />
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="flex items-center gap-2 rounded border border-border/30 px-3 py-2 text-xs"
        >
          <span
            className={`h-2 w-2 rounded-full shrink-0 ${
              entry.resultStatus === "success" ? "bg-green-500" : "bg-red-500"
            }`}
          />
          <Network className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
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
