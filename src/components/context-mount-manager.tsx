"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Database,
  Globe,
  Layers,
  Plus,
  User,
  Users,
  X,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export interface ContextMount {
  kind: "person" | "persona" | "group" | "kg-scope" | "workspace";
  id: string;
  label: string;
  ref?: string;
}

interface Workspace {
  id: string;
  label: string;
  cwd: string;
  scope: string;
}

const MOUNT_KIND_LABELS: Record<ContextMount["kind"], string> = {
  person: "Person",
  persona: "Persona",
  group: "Group",
  "kg-scope": "KG Scope",
  workspace: "Workspace",
};

const MOUNT_KIND_ICONS: Record<ContextMount["kind"], typeof User> = {
  person: User,
  persona: User,
  group: Users,
  "kg-scope": Database,
  workspace: Layers,
};

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

interface ContextMountManagerProps {
  mounts: ContextMount[];
  onMountsChange: (mounts: ContextMount[]) => void;
}

export function ContextMountManager({ mounts, onMountsChange }: ContextMountManagerProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [addingKind, setAddingKind] = useState<ContextMount["kind"] | "">("");
  const [addingLabel, setAddingLabel] = useState("");
  const [addingRef, setAddingRef] = useState("");

  // Fetch workspaces for workspace mount suggestions
  useEffect(() => {
    fetch("/api/agent-hq/launchers", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.workspaces) {
          setWorkspaces(data.workspaces);
        }
      })
      .catch(() => {});
  }, []);

  const handleAdd = useCallback(() => {
    if (!addingKind || !addingLabel.trim()) return;
    const newMount: ContextMount = {
      kind: addingKind,
      id: `${addingKind}-${Date.now().toString(36)}`,
      label: addingLabel.trim(),
      ref: addingRef.trim() || undefined,
    };
    onMountsChange([...mounts, newMount]);
    setAddingKind("");
    setAddingLabel("");
    setAddingRef("");
  }, [addingKind, addingLabel, addingRef, mounts, onMountsChange]);

  const handleRemove = useCallback(
    (id: string) => {
      onMountsChange(mounts.filter((m) => m.id !== id));
    },
    [mounts, onMountsChange],
  );

  const handleAddWorkspace = useCallback(
    (workspace: Workspace) => {
      if (mounts.some((m) => m.kind === "workspace" && m.ref === workspace.id)) return;
      const newMount: ContextMount = {
        kind: "workspace",
        id: `workspace-${workspace.id}`,
        label: workspace.label,
        ref: workspace.id,
      };
      onMountsChange([...mounts, newMount]);
    },
    [mounts, onMountsChange],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          Context Mounts
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Current mounts */}
        {mounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No context mounts attached. Add person, persona, group, KG scope, or workspace contexts.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {mounts.map((mount) => {
              const Icon = MOUNT_KIND_ICONS[mount.kind] ?? Globe;
              return (
                <Badge
                  key={mount.id}
                  variant="secondary"
                  className="gap-1 pr-1"
                >
                  <Icon className="h-3 w-3" />
                  <span className="text-[10px]">{MOUNT_KIND_LABELS[mount.kind]}:</span>
                  <span className="text-[10px] font-medium">{mount.label}</span>
                  <button
                    onClick={() => handleRemove(mount.id)}
                    className="ml-0.5 rounded-sm p-0.5 hover:bg-destructive/20 hover:text-destructive transition-colors"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}

        {/* Quick-add workspace */}
        {workspaces.length > 0 && (
          <div className="flex items-center gap-2">
            <Select
              onValueChange={(wsId) => {
                const ws = workspaces.find((w) => w.id === wsId);
                if (ws) handleAddWorkspace(ws);
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Attach workspace..." />
              </SelectTrigger>
              <SelectContent>
                {workspaces
                  .filter((ws) => !mounts.some((m) => m.kind === "workspace" && m.ref === ws.id))
                  .map((ws) => (
                    <SelectItem key={ws.id} value={ws.id}>
                      {ws.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Custom mount add */}
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Select
              value={addingKind}
              onValueChange={(v) => setAddingKind(v as ContextMount["kind"])}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Kind" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(MOUNT_KIND_LABELS) as ContextMount["kind"][]).map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {MOUNT_KIND_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Input
            className="h-8 text-xs flex-1"
            placeholder="Label"
            value={addingLabel}
            onChange={(e) => setAddingLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
          <Input
            className="h-8 text-xs flex-1"
            placeholder="Ref (optional)"
            value={addingRef}
            onChange={(e) => setAddingRef(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
          />
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={handleAdd}
            disabled={!addingKind || !addingLabel.trim()}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
