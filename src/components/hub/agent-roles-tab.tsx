"use client";

/**
 * AgentRolesTab — configure the role flags + public-chat visibility scope for
 * the selected agent (controller or persona) in the Agent HQ hub.
 *
 * Reuses the global scope-picker UX (`VisibilityScopeSelector`) and the same
 * level taxonomy the group tab-visibility model uses, so the mental model is
 * consistent across the app. Works for both the controller (agentId = the
 * signed-in user's id) and owned personas, because the underlying server
 * actions accept self or owned-persona ids.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Lock, Globe } from "lucide-react";
import {
  VisibilityScopeSelector,
  type VisibilityScopeState,
} from "@/components/visibility-scope-selector";
import {
  getAgentRoleConfig,
  setAgentRole,
  setAgentChatVisibility,
} from "@/app/actions/personas";
import {
  AGENT_CHAT_VISIBILITY_LEVELS,
  DEFAULT_AGENT_CHAT_VISIBILITY,
  DEFAULT_AGENT_ROLE,
  type AgentChatVisibility,
  type AgentChatVisibilityLevel,
  type AgentRoleFlags,
} from "@/lib/agent-roles";

const LEVEL_LABELS: Record<AgentChatVisibilityLevel, string> = {
  public: "Public — anyone can chat",
  members: "Members — scoped groups or listed users",
  admin: "Admins only",
  hidden: "Hidden — public chat disabled",
};

interface AgentRolesTabProps {
  agentId: string;
  agentLabel: string;
}

export function AgentRolesTab({ agentId, agentLabel }: AgentRolesTabProps) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [role, setRole] = useState<AgentRoleFlags>(DEFAULT_AGENT_ROLE);
  const [visibility, setVisibility] = useState<AgentChatVisibility>(
    DEFAULT_AGENT_CHAT_VISIBILITY,
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getAgentRoleConfig(agentId);
      if (result.success) {
        setRole(result.role ?? DEFAULT_AGENT_ROLE);
        setVisibility(result.visibility ?? DEFAULT_AGENT_CHAT_VISIBILITY);
      } else {
        toast({ title: result.error ?? "Failed to load role config", variant: "destructive" });
      }
    } finally {
      setLoading(false);
    }
  }, [agentId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const scopeValue: VisibilityScopeState = {
    localeIds: visibility.localeIds,
    groupIds: visibility.groupIds,
    userIds: visibility.userIds,
  };

  const handleScopeChange = useCallback((next: VisibilityScopeState) => {
    setVisibility((prev) => ({
      ...prev,
      localeIds: next.localeIds,
      groupIds: next.groupIds,
      userIds: next.userIds,
    }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const roleResult = await setAgentRole({ agentId, role });
      if (!roleResult.success) {
        toast({ title: roleResult.error ?? "Failed to save role", variant: "destructive" });
        return;
      }
      const visResult = await setAgentChatVisibility({ agentId, visibility });
      if (!visResult.success) {
        toast({ title: visResult.error ?? "Failed to save visibility", variant: "destructive" });
        return;
      }
      toast({ title: `Roles updated for ${agentLabel}` });
    } finally {
      setSaving(false);
    }
  }, [agentId, agentLabel, role, visibility, toast]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium">Agent Roles</CardTitle>
          <CardDescription>
            Choose how <strong>{agentLabel}</strong> may be used. An agent can be
            private, public, both, or neither.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 p-3">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-2 text-sm font-medium">
                <Lock className="h-3.5 w-3.5" /> Private agent
              </Label>
              <p className="text-xs text-muted-foreground">
                Personal assistant — only you can chat with it.
              </p>
            </div>
            <Switch
              checked={role.privateAgent}
              onCheckedChange={(checked) =>
                setRole((prev) => ({ ...prev, privateAgent: checked }))
              }
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-md border border-border/60 p-3">
            <div className="space-y-0.5">
              <Label className="flex items-center gap-2 text-sm font-medium">
                <Globe className="h-3.5 w-3.5" /> Public agent
              </Label>
              <p className="text-xs text-muted-foreground">
                Others can chat with it from your public profile, gated by the
                visibility scope below.
              </p>
            </div>
            <Switch
              checked={role.publicAgent}
              onCheckedChange={(checked) =>
                setRole((prev) => ({ ...prev, publicAgent: checked }))
              }
            />
          </div>
        </CardContent>
      </Card>

      {role.publicAgent && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Public-chat access</CardTitle>
            <CardDescription>
              Who may chat with this agent when it acts publicly.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Access level</Label>
              <Select
                value={visibility.level}
                onValueChange={(value) =>
                  setVisibility((prev) => ({
                    ...prev,
                    level: value as AgentChatVisibilityLevel,
                  }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_CHAT_VISIBILITY_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {LEVEL_LABELS[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {visibility.level === "members" && (
              <VisibilityScopeSelector
                value={scopeValue}
                onChange={handleScopeChange}
                locales={[]}
              />
            )}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving} className="gap-2">
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save Roles
        </Button>
      </div>
    </div>
  );
}
