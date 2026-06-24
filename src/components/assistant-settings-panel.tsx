"use client";

/**
 * AssistantSettingsPanel — the self-owner-only configuration surface for the
 * ONE user-facing AI assistant (the direct agent that also acts as the
 * builder/execution agent).
 *
 * This re-homes the former Agent HQ hub's per-agent tabs into Settings, scoped
 * to the controller's own direct agent only — there is no persona roster here.
 * Personas are configured from their own editor (`/personas/[id]/edit`).
 *
 * Tabs: Identity (with an editable assistant NAME) · Roles · Knowledge ·
 * Voice · Access (MCP token + device approvals) · Connections · Activity.
 *
 * The assistant name is the direct agent's `agents.name` column, read/written
 * through `/api/autobot/identity` (which resolves the caller's own direct agent
 * via the canonical resolver — so it is inherently owner-only).
 */

import { useCallback, useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/use-toast";
import { Activity, Bot, Loader2, Network } from "lucide-react";
import { AutobotConnectionsPanel } from "@/components/autobot-connections-panel";
import { DeviceApprovals } from "@/components/device-approvals";
import { McpTokenCard } from "@/components/mcp-token-card";
import { AgentRolesTab } from "@/components/hub/agent-roles-tab";
import { AgentKnowledgeTab } from "@/components/hub/agent-knowledge-tab";
import { AgentVoiceTab } from "@/components/hub/agent-voice-tab";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDENTITY_ENDPOINT = "/api/autobot/identity";
const PROVENANCE_ENDPOINT = "/api/autobot/provenance";
const PROVENANCE_LIMIT = 50;
const MAX_NAME_LENGTH = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DirectAgentIdentity {
  directAgentId: string;
  controllerId: string;
  isPersona: boolean;
  name: string;
  image: string | null;
}

interface ProvenanceEntry {
  id: string;
  toolName: string;
  actorType: string;
  resultStatus: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AssistantSettingsPanel() {
  const { toast } = useToast();
  const [identity, setIdentity] = useState<DirectAgentIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [nameDraft, setNameDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const loadIdentity = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(IDENTITY_ENDPOINT, { cache: "no-store" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to load assistant identity (${res.status})`);
      }
      const data = (await res.json()) as DirectAgentIdentity;
      setIdentity(data);
      setNameDraft(data.name);
    } catch (error) {
      toast({
        title: "Could not load assistant",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadIdentity();
  }, [loadIdentity]);

  const onSaveName = useCallback(async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(IDENTITY_ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Failed to rename assistant (${res.status})`);
      }
      const data = (await res.json()) as DirectAgentIdentity;
      setIdentity(data);
      setNameDraft(data.name);
      toast({ title: "Assistant renamed", description: `Your assistant is now "${data.name}".` });
    } catch (error) {
      toast({
        title: "Could not rename assistant",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [nameDraft, toast]);

  if (loading || !identity) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const nameChanged = nameDraft.trim() !== identity.name && nameDraft.trim().length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="rounded-full bg-primary/10 p-1.5">
          <Bot className="h-4 w-4 text-primary" />
        </div>
        <div>
          <h2 className="text-sm font-semibold">Your Assistant</h2>
          <p className="text-[11px] text-muted-foreground">
            Configure the one AI assistant that talks with you and builds your sites.
          </p>
        </div>
      </div>

      <Tabs defaultValue="identity" className="w-full">
        <TabsList className="grid w-full grid-cols-3 sm:grid-cols-6">
          <TabsTrigger value="identity">Identity</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
          <TabsTrigger value="voice">Voice</TabsTrigger>
          <TabsTrigger value="access">Access</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
        </TabsList>

        <TabsContent value="identity" className="mt-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium">Identity</CardTitle>
              <CardDescription>
                Name your assistant. This is how it refers to itself in chat and
                on your generated sites.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <Avatar className="h-14 w-14">
                  <AvatarImage src={identity.image ?? undefined} alt={identity.name} />
                  <AvatarFallback>
                    {identity.name.substring(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                  <p className="font-medium">{identity.name}</p>
                  <Badge variant="secondary" className="mt-1 text-[10px]">
                    {identity.isPersona ? "Persona-backed" : "Your direct agent"}
                  </Badge>
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="assistant-name">Assistant name</Label>
                <div className="flex gap-2">
                  <Input
                    id="assistant-name"
                    value={nameDraft}
                    maxLength={MAX_NAME_LENGTH}
                    onChange={(event) => setNameDraft(event.target.value)}
                    placeholder="e.g. Camalot, Ada, Atlas…"
                  />
                  <Button onClick={onSaveName} disabled={!nameChanged || saving}>
                    {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="roles" className="mt-4">
          <AgentRolesTab agentId={identity.directAgentId} agentLabel={identity.name} />
        </TabsContent>

        <TabsContent value="knowledge" className="mt-4">
          <AgentKnowledgeTab
            agentId={identity.directAgentId}
            agentLabel={identity.name}
            ownerId={identity.controllerId}
          />
        </TabsContent>

        <TabsContent value="voice" className="mt-4">
          <AgentVoiceTab agentLabel={identity.name} editHref="/settings?tab=account" />
        </TabsContent>

        <TabsContent value="access" className="mt-4 space-y-4">
          <McpTokenCard />
          <DeviceApprovals />
          <ActivityFeed actorId={identity.directAgentId} />
        </TabsContent>

        <TabsContent value="connections" className="mt-4">
          <AutobotConnectionsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity feed (provenance log for the direct agent)
// ---------------------------------------------------------------------------

function ActivityFeed({ actorId }: { actorId: string }) {
  const [entries, setEntries] = useState<ProvenanceEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(
          `${PROVENANCE_ENDPOINT}?limit=${PROVENANCE_LIMIT}&actorId=${encodeURIComponent(actorId)}`,
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
