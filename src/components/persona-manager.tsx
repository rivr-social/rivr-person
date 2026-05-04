"use client";

/**
 * PersonaManager component.
 *
 * Renders the persona management panel for the profile page: lists existing
 * personas, shows which is active, and provides create/edit/delete/switch controls.
 *
 * Editing is delegated to `/personas/[id]/edit`, which mounts the same
 * `PersonaCreator` UI used by `/personas/new` and the persona-active variant
 * of `/settings`. The flat in-list edit dialog has been removed in favour of
 * that single shared surface so identity, appearance (3D avatar viewer),
 * skills, and operating-mode are all editable in one place.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Bot, ChevronDown, Drama, Edit2, Plus, Trash2, UserCheck, UserX } from "lucide-react";
import {
  deletePersona,
  listMyPersonas,
  switchActivePersona,
} from "@/app/actions/personas";
import { AutobotControlPane } from "@/components/autobot-control-pane";
import type { SerializedAgent } from "@/lib/graph-serializers";

export function PersonaManager() {
  const router = useRouter();
  const { toast } = useToast();
  const [personas, setPersonas] = useState<SerializedAgent[]>([]);
  const [activePersonaId, setActivePersonaId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);

  // Dialog state — only the delete-confirm dialog remains; edit navigates
  // to the dedicated edit route so the rich PersonaCreator UI is reused.
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  // Autobot control pane expanded state (persona id -> boolean)
  const [expandedPanes, setExpandedPanes] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const result = await listMyPersonas();
      if (result.success && result.personas) {
        setPersonas(result.personas);
        setActivePersonaId(result.activePersonaId ?? null);
      }
    } catch {
      // Silently fail on load
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDelete = async () => {
    if (!deleteConfirmId) return;
    setActionLoading(true);
    try {
      const result = await deletePersona(deleteConfirmId);
      if (result.success) {
        toast({ title: "Persona deleted" });
        setDeleteConfirmId(null);
        await refresh();
      } else {
        toast({ title: result.error ?? "Failed to delete persona", variant: "destructive" });
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleSwitch = async (personaId: string | null) => {
    setActionLoading(true);
    try {
      const result = await switchActivePersona(personaId);
      if (result.success) {
        setActivePersonaId(personaId);
        toast({
          title: personaId ? "Switched persona" : "Switched back to main account",
        });
        router.refresh();
      } else {
        toast({ title: result.error ?? "Failed to switch persona", variant: "destructive" });
      }
    } finally {
      setActionLoading(false);
    }
  };

  /**
   * Navigates to the dedicated edit page for a persona, which mounts the
   * shared `PersonaCreator` component in edit mode (full identity, appearance
   * with 3D viewer, skills, and operating-mode steps).
   */
  const openEdit = (persona: SerializedAgent) => {
    router.push(`/personas/${persona.id}/edit`);
  };

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Drama className="h-5 w-5" />
            Personas
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Drama className="h-5 w-5" />
              Personas
            </CardTitle>
            <Button
              size="sm"
              onClick={() => router.push("/personas/new")}
            >
              <Plus className="h-4 w-4 mr-1" />
              Create Persona
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Active persona banner */}
          {activePersonaId && (
            <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Drama className="h-4 w-4 text-primary" />
                <span>
                  Operating as{" "}
                  <strong>
                    {personas.find((p) => p.id === activePersonaId)?.name ?? "persona"}
                  </strong>
                </span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSwitch(null)}
                disabled={actionLoading}
              >
                <UserX className="h-4 w-4 mr-1" />
                Switch Back
              </Button>
            </div>
          )}

          {personas.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No personas yet. Create one to operate under an alternate identity.
            </p>
          ) : (
            <div className="space-y-2">
              {personas.map((persona) => {
                const metadata = persona.metadata ?? {};
                const username =
                  typeof metadata.username === "string" ? metadata.username : null;
                const bio = typeof metadata.bio === "string" ? metadata.bio : null;
                const isActive = persona.id === activePersonaId;
                const isAutobotEnabled = metadata.autobotEnabled === true;
                const isPaneOpen = expandedPanes[persona.id] === true;

                return (
                  <Collapsible
                    key={persona.id}
                    open={isPaneOpen}
                    onOpenChange={(open) =>
                      setExpandedPanes((prev) => ({ ...prev, [persona.id]: open }))
                    }
                  >
                    <div
                      className={`rounded-md border transition-colors ${
                        isActive ? "border-primary bg-primary/5" : "border-border"
                      }`}
                    >
                      {/* ── Persona identity row ── */}
                      <div className="flex items-center gap-3 p-3">
                        <Link
                          href={`/profile/${username ?? persona.id}`}
                          className="flex flex-1 items-center gap-3 min-w-0 hover:opacity-80 transition-opacity"
                          title={`View ${persona.name}'s public profile`}
                        >
                          <div className="relative shrink-0">
                            <Avatar className="h-10 w-10">
                              <AvatarImage src={persona.image ?? undefined} alt={persona.name} />
                              <AvatarFallback>
                                {persona.name.substring(0, 2).toUpperCase()}
                              </AvatarFallback>
                            </Avatar>
                            {isActive && (
                              <div className="absolute -bottom-1 -right-1 rounded-full bg-primary p-0.5">
                                <Drama className="h-3 w-3 text-primary-foreground" />
                              </div>
                            )}
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm truncate">{persona.name}</span>
                              {username && (
                                <span className="text-xs text-muted-foreground">@{username}</span>
                              )}
                              {isActive && (
                                <Badge variant="default" className="text-xs">
                                  Active
                                </Badge>
                              )}
                              {isAutobotEnabled && (
                                <Badge variant="secondary" className="text-xs gap-1">
                                  <Bot className="h-3 w-3" />
                                  Autobot
                                </Badge>
                              )}
                            </div>
                            {bio && (
                              <p className="text-xs text-muted-foreground truncate">{bio}</p>
                            )}
                          </div>
                        </Link>

                        <div className="flex items-center gap-1">
                          <CollapsibleTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              title={isPaneOpen ? "Collapse autobot controls" : "Expand autobot controls"}
                            >
                              <ChevronDown
                                className={`h-4 w-4 transition-transform ${
                                  isPaneOpen ? "rotate-180" : ""
                                }`}
                              />
                            </Button>
                          </CollapsibleTrigger>
                          {!isActive && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleSwitch(persona.id)}
                              disabled={actionLoading}
                              title="Switch to this persona"
                            >
                              <UserCheck className="h-4 w-4" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEdit(persona)}
                            title="Edit persona"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setDeleteConfirmId(persona.id)}
                            title="Delete persona"
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      {/* ── Autobot control pane (expandable) ── */}
                      <CollapsibleContent>
                        <div className="px-3 pb-3">
                          <AutobotControlPane
                            persona={persona}
                            onSettingsChanged={refresh}
                          />
                        </div>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteConfirmId} onOpenChange={(open) => !open && setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Persona</DialogTitle>
            <DialogDescription>
              This will permanently remove this persona and all its content. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-4">
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={actionLoading}>
              {actionLoading ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
