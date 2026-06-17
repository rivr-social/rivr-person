"use client";

/**
 * AgentKnowledgeTab — configure the selected agent's native knowledge graph.
 *
 * Two complementary mechanisms, per the locked overhaul decision:
 *   1. Hand-picked Rivr objects — the owner checks individual objects (posts,
 *      events, documents, listings, …), grouped by type AND visibility.
 *      Persisted as `metadata.kgObjects` via `setAgentKgObjects`; retrieval
 *      always re-checks each object's live visibility relative to the asker.
 *   2. Pasted documents — free text ingested into the native pgvector KG
 *      (rule-based triple extraction) via `ingestAgentKgDoc`.
 *
 * Works for both the controller (agentId = signed-in user id) and owned
 * personas; the server actions resolve person- vs persona-scope automatically.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { Database, FileText, Loader2, Network } from "lucide-react";
import {
  getAgentKgSummary,
  getAgentRoleConfig,
  ingestAgentKgDoc,
  setAgentKgObjects,
} from "@/app/actions/personas";
import { fetchResourcesByOwner } from "@/app/actions/graph";
import {
  KG_OBJECT_TYPES,
  type KgObjectRef,
  type KgObjectType,
} from "@/lib/agent-roles";
import type { SerializedResource } from "@/lib/graph-serializers";
import type { KgDoc } from "@/lib/kg/native-kg";

const KG_TYPE_SET = new Set<string>(KG_OBJECT_TYPES);

interface AgentKnowledgeTabProps {
  agentId: string;
  agentLabel: string;
  /** The controller (signed-in user) id — owns the rivr objects to pick from. */
  ownerId: string;
}

/** Maps a raw resource type onto a KG object type, defaulting to "resource". */
function toKgObjectType(rawType: string): KgObjectType {
  return KG_TYPE_SET.has(rawType) ? (rawType as KgObjectType) : "resource";
}

/** Resolves a display visibility for grouping/sorting. */
function resourceVisibility(resource: SerializedResource): string {
  if (resource.visibility) return resource.visibility;
  return resource.isPublic ? "public" : "private";
}

function refKey(type: string, id: string): string {
  return `${type}:${id}`;
}

export function AgentKnowledgeTab({ agentId, agentLabel, ownerId }: AgentKnowledgeTabProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [savingObjects, setSavingObjects] = useState(false);
  const [ingesting, setIngesting] = useState(false);

  const [resources, setResources] = useState<SerializedResource[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [stats, setStats] = useState<{ docCount: number; entityCount: number; tripleCount: number }>(
    { docCount: 0, entityCount: 0, tripleCount: 0 },
  );
  const [docs, setDocs] = useState<KgDoc[]>([]);

  const [docTitle, setDocTitle] = useState("");
  const [docContent, setDocContent] = useState("");

  const refreshSummary = useCallback(async () => {
    const summary = await getAgentKgSummary(agentId);
    if (summary.success) {
      setStats({
        docCount: summary.docCount ?? 0,
        entityCount: summary.entityCount ?? 0,
        tripleCount: summary.tripleCount ?? 0,
      });
      setDocs(summary.docs ?? []);
    }
  }, [agentId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [config, ownerResources] = await Promise.all([
        getAgentRoleConfig(agentId),
        fetchResourcesByOwner(ownerId).catch(() => [] as SerializedResource[]),
      ]);
      if (config.success && config.kgObjects) {
        setSelectedKeys(
          new Set(config.kgObjects.map((o) => refKey(o.type, o.id))),
        );
      }
      setResources(ownerResources);
      await refreshSummary();
    } finally {
      setLoading(false);
    }
  }, [agentId, ownerId, refreshSummary]);

  useEffect(() => {
    load();
  }, [load]);

  // Group resources by type, then by visibility — matches the locked picker UX.
  const grouped = useMemo(() => {
    const byType = new Map<string, Map<string, SerializedResource[]>>();
    for (const resource of resources) {
      const type = toKgObjectType(resource.type);
      const vis = resourceVisibility(resource);
      if (!byType.has(type)) byType.set(type, new Map());
      const byVis = byType.get(type)!;
      if (!byVis.has(vis)) byVis.set(vis, []);
      byVis.get(vis)!.push(resource);
    }
    return byType;
  }, [resources]);

  const toggleResource = useCallback((resource: SerializedResource) => {
    const key = refKey(toKgObjectType(resource.type), resource.id);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSaveObjects = useCallback(async () => {
    setSavingObjects(true);
    try {
      const objects: KgObjectRef[] = resources
        .filter((r) => selectedKeys.has(refKey(toKgObjectType(r.type), r.id)))
        .map((r) => ({
          type: toKgObjectType(r.type),
          id: r.id,
          visibility: resourceVisibility(r),
        }));
      const result = await setAgentKgObjects({ agentId, objects });
      if (result.success) {
        toast({ title: `Saved ${result.count ?? objects.length} objects for ${agentLabel}` });
      } else {
        toast({ title: result.error ?? "Failed to save objects", variant: "destructive" });
      }
    } finally {
      setSavingObjects(false);
    }
  }, [agentId, agentLabel, resources, selectedKeys, toast]);

  const handleIngest = useCallback(async () => {
    setIngesting(true);
    try {
      const result = await ingestAgentKgDoc({
        agentId,
        title: docTitle,
        content: docContent,
      });
      if (result.success) {
        toast({
          title: "Document ingested",
          description: `${result.triplesExtracted ?? 0} facts extracted.`,
        });
        setDocTitle("");
        setDocContent("");
        await refreshSummary();
      } else {
        toast({ title: result.error ?? "Failed to ingest document", variant: "destructive" });
      }
    } finally {
      setIngesting(false);
    }
  }, [agentId, docTitle, docContent, refreshSummary, toast]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Network className="h-4 w-4" /> Knowledge Graph
          </CardTitle>
          <CardDescription>
            Native facts available to <strong>{agentLabel}</strong>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            <KgStat label="Documents" value={stats.docCount} />
            <KgStat label="Entities" value={stats.entityCount} />
            <KgStat label="Facts" value={stats.tripleCount} />
          </div>
        </CardContent>
      </Card>

      {/* Hand-picked rivr objects */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Database className="h-4 w-4" /> Linked Rivr Objects
              </CardTitle>
              <CardDescription>
                Hand-pick objects this agent may draw on. Retrieval re-checks each
                object&apos;s live visibility for whoever is asking.
              </CardDescription>
            </div>
            <Button onClick={handleSaveObjects} disabled={savingObjects} size="sm" className="gap-2">
              {savingObjects ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save ({selectedKeys.size})
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {resources.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No objects to link yet. Create posts, events, or documents first.
            </p>
          ) : (
            <ScrollArea className="max-h-[360px] pr-3">
              <div className="space-y-4">
                {[...grouped.entries()].map(([type, byVis]) => (
                  <div key={type}>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      {type}
                    </p>
                    <div className="space-y-3">
                      {[...byVis.entries()].map(([vis, items]) => (
                        <div key={`${type}:${vis}`} className="space-y-1">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-[10px]">{vis}</Badge>
                          </div>
                          <div className="space-y-0.5">
                            {items.map((resource) => {
                              const key = refKey(toKgObjectType(resource.type), resource.id);
                              return (
                                <label
                                  key={resource.id}
                                  className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50 cursor-pointer"
                                >
                                  <Checkbox
                                    checked={selectedKeys.has(key)}
                                    onCheckedChange={() => toggleResource(resource)}
                                  />
                                  <span className="truncate flex-1">{resource.name}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Paste a document */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FileText className="h-4 w-4" /> Add a Document
          </CardTitle>
          <CardDescription>
            Paste notes or text. Rivr extracts facts into the native knowledge graph.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={docTitle}
              onChange={(e) => setDocTitle(e.target.value)}
              placeholder="e.g. Bio, project notes, FAQ"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Content</Label>
            <Textarea
              value={docContent}
              onChange={(e) => setDocContent(e.target.value)}
              className="min-h-[140px]"
              placeholder="Paste the text to ingest..."
            />
          </div>
          <div className="flex justify-end">
            <Button
              onClick={handleIngest}
              disabled={ingesting || !docTitle.trim() || !docContent.trim()}
              className="gap-2"
            >
              {ingesting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Ingest Document
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Existing documents */}
      {docs.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Documents ({docs.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {docs.map((doc) => (
                <div
                  key={doc.id}
                  className="flex items-center gap-2 rounded border border-border/30 px-3 py-2 text-xs"
                >
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 truncate">{doc.title}</span>
                  <Badge variant="outline" className="text-[10px]">{doc.doc_type}</Badge>
                  <span className="text-muted-foreground">{doc.triple_count} facts</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function KgStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 p-3 text-center">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
