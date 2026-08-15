"use client";

/**
 * Builder Apps panel — registry-backed multi-app lifecycle.
 *
 * Lists every app workspace with its manifest + broker status, scaffolds new
 * apps from platform templates, and drives the typed lifecycle
 * (deploy / stop / start / rollback / archive / delete) plus verified custom
 * domains. Everything goes through the owner-gated `/api/builder/apps` routes;
 * the panel never sees or sends Docker/Compose material.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Archive,
  Boxes,
  CheckCircle2,
  ExternalLink,
  Globe,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

const STATUS_POLL_INTERVAL_MS = 5000;

type AppPhase =
  | "queued"
  | "validating"
  | "building"
  | "deploying"
  | "running"
  | "stopped"
  | "archived"
  | "deleted"
  | "failed";

interface AppStatus {
  phase: AppPhase;
  release?: string;
  url?: string;
  error?: string;
  updatedAt?: string;
  customDomains?: string[];
}

interface RegisteredApp {
  appId: string;
  managed: boolean;
  manifest: {
    name: string;
    runtime: "static" | "node-22";
    resourceClass: string;
    database: string;
  } | null;
  manifestErrors: string[] | null;
  status: AppStatus | null;
  pendingRequest: boolean;
  expectedUrl: string | null;
}

const ACTIVE_PHASES: ReadonlySet<string> = new Set([
  "queued",
  "validating",
  "building",
  "deploying",
]);

function phaseBadgeClass(phase: string | undefined): string {
  switch (phase) {
    case "running":
      return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "bg-destructive/10 text-destructive";
    case "stopped":
    case "archived":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-primary/10 text-primary";
  }
}

export function BuilderAppsPanel() {
  const [apps, setApps] = useState<RegisteredApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAppId, setBusyAppId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newAppId, setNewAppId] = useState("");
  const [newRuntime, setNewRuntime] = useState<"static" | "node-22">("static");
  const [domainDrafts, setDomainDrafts] = useState<Record<string, string>>({});
  const [dnsProviders, setDnsProviders] = useState<string[]>([]);

  const fetchApps = useCallback(async () => {
    try {
      const response = await fetch("/api/builder/apps");
      const data = (await response.json()) as {
        success?: boolean;
        apps?: RegisteredApp[];
        dnsProviders?: string[];
        error?: string;
      };
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to load apps");
      }
      setApps(data.apps ?? []);
      setDnsProviders(data.dnsProviders ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load apps");
    } finally {
      setLoading(false);
    }
  }, []);

  const hasActiveWork = useMemo(
    () =>
      apps.some(
        (app) => app.pendingRequest || ACTIVE_PHASES.has(app.status?.phase ?? ""),
      ),
    [apps],
  );

  useEffect(() => {
    void fetchApps();
  }, [fetchApps]);

  useEffect(() => {
    if (!hasActiveWork) return;
    const timer = setInterval(() => void fetchApps(), STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveWork, fetchApps]);

  const queueAction = useCallback(
    async (appId: string, action: string, confirmToken?: string) => {
      setBusyAppId(appId);
      setError(null);
      try {
        const response = await fetch(`/api/builder/apps/${appId}/lifecycle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, ...(confirmToken ? { confirmToken } : {}) }),
        });
        const data = (await response.json()) as { success?: boolean; error?: string };
        if (!response.ok || !data.success) {
          throw new Error(data.error || `Failed to queue ${action}`);
        }
        setConfirmDeleteId(null);
        await fetchApps();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to queue ${action}`);
      } finally {
        setBusyAppId(null);
      }
    },
    [fetchApps],
  );

  const createApp = useCallback(async () => {
    if (!newAppId.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch("/api/builder/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: newAppId.trim(), runtime: newRuntime }),
      });
      const data = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !data.success) {
        throw new Error(data.error || "Failed to create app");
      }
      setNewAppId("");
      setShowCreate(false);
      await fetchApps();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create app");
    } finally {
      setCreating(false);
    }
  }, [newAppId, newRuntime, fetchApps]);

  const bindDomain = useCallback(
    async (appId: string) => {
      const domain = (domainDrafts[appId] ?? "").trim();
      if (!domain) return;
      setBusyAppId(appId);
      setError(null);
      try {
        const response = await fetch(`/api/builder/apps/${appId}/domains`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "bind", domain }),
        });
        const data = (await response.json()) as { success?: boolean; error?: string };
        if (!response.ok || !data.success) {
          throw new Error(data.error || "Domain bind failed");
        }
        setDomainDrafts((drafts) => ({ ...drafts, [appId]: "" }));
        await fetchApps();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Domain bind failed");
      } finally {
        setBusyAppId(null);
      }
    },
    [domainDrafts, fetchApps],
  );

  const setDomainDns = useCallback(
    async (appId: string, provider: string) => {
      const domain = (domainDrafts[appId] ?? "").trim();
      if (!domain) return;
      setBusyAppId(appId);
      setError(null);
      try {
        const response = await fetch(`/api/builder/apps/${appId}/domains`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set-dns", domain, provider }),
        });
        const data = (await response.json()) as { success?: boolean; error?: string };
        if (!response.ok || !data.success) {
          throw new Error(data.error || "DNS setup failed");
        }
        await fetchApps();
      } catch (err) {
        setError(err instanceof Error ? err.message : "DNS setup failed");
      } finally {
        setBusyAppId(null);
      }
    },
    [domainDrafts, fetchApps],
  );

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium flex items-center gap-2">
          <Boxes className="h-4 w-4" />
          Apps
        </h3>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => void fetchApps()}
          >
            <RefreshCw className="h-3 w-3" />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={() => setShowCreate((open) => !open)}
          >
            <Plus className="h-3 w-3" />
            New App
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="break-words">{error}</span>
        </div>
      )}

      {showCreate && (
        <div className="rounded-lg border p-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            The app id becomes its subdomain. Lowercase letters, digits, and
            hyphens only.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newAppId}
              onChange={(event) => setNewAppId(event.target.value)}
              placeholder="my-app"
              className="h-8 text-xs w-40"
            />
            <select
              value={newRuntime}
              onChange={(event) => setNewRuntime(event.target.value as "static" | "node-22")}
              className="h-8 rounded-md border bg-background px-2 text-xs"
            >
              <option value="static">Static site</option>
              <option value="node-22">Node 22 service</option>
            </select>
            <Button
              size="sm"
              className="h-8 text-xs gap-1"
              onClick={() => void createApp()}
              disabled={creating || !newAppId.trim()}
            >
              {creating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Plus className="h-3 w-3" />
              )}
              Create
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-3">
          <Boxes className="h-12 w-12 opacity-20" />
          <div className="text-center">
            <p className="text-sm font-medium">No apps yet</p>
            <p className="text-xs">Create one and deploy it to its own subdomain.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {apps.map((app) => {
            const phase = app.status?.phase;
            const busy = busyAppId === app.appId;
            const working = app.pendingRequest || ACTIVE_PHASES.has(phase ?? "");
            const liveUrl = app.status?.url ?? app.expectedUrl;
            return (
              <div key={app.appId} className="rounded-lg border p-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{app.appId}</span>
                  {app.manifest && (
                    <span className="text-[10px] uppercase tracking-wide rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                      {app.manifest.runtime}
                      {app.manifest.database !== "none" ? " + db" : ""}
                    </span>
                  )}
                  <span
                    className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${phaseBadgeClass(phase)}`}
                  >
                    {working && !ACTIVE_PHASES.has(phase ?? "") ? "queued" : (phase ?? "new")}
                  </span>
                  {working && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
                  <div className="flex-1" />
                  {phase === "running" && liveUrl && (
                    <a
                      href={liveUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Open
                    </a>
                  )}
                </div>

                {!app.managed && (
                  <p className="text-xs text-muted-foreground">
                    No valid <code>rivr-app.json</code>
                    {app.manifestErrors?.length
                      ? `: ${app.manifestErrors[0]}`
                      : " — add one to manage this workspace as an app."}
                  </p>
                )}

                {app.status?.error && (
                  <p className="text-xs text-destructive break-words">
                    {app.status.error}
                  </p>
                )}

                {app.status?.customDomains && app.status.customDomains.length > 0 && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Globe className="h-3 w-3" />
                    {app.status.customDomains.join(", ")}
                  </p>
                )}

                {app.managed && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => void queueAction(app.appId, "deploy")}
                      disabled={busy || working}
                    >
                      <Rocket className="h-3 w-3" />
                      Deploy
                    </Button>
                    {phase === "running" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => void queueAction(app.appId, "stop")}
                        disabled={busy || working}
                      >
                        <Square className="h-3 w-3" />
                        Stop
                      </Button>
                    )}
                    {phase === "stopped" && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => void queueAction(app.appId, "start")}
                        disabled={busy || working}
                      >
                        <Play className="h-3 w-3" />
                        Start
                      </Button>
                    )}
                    {(phase === "running" || phase === "stopped") && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => void queueAction(app.appId, "rollback")}
                        disabled={busy || working}
                      >
                        <RotateCcw className="h-3 w-3" />
                        Rollback
                      </Button>
                    )}
                    {phase !== "archived" && phase !== undefined && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => void queueAction(app.appId, "archive")}
                        disabled={busy || working}
                      >
                        <Archive className="h-3 w-3" />
                        Archive
                      </Button>
                    )}
                    {phase === "archived" &&
                      (confirmDeleteId === app.appId ? (
                        <>
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={() =>
                              void queueAction(app.appId, "delete", app.appId)
                            }
                            disabled={busy}
                          >
                            <Trash2 className="h-3 w-3" />
                            Confirm delete
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs gap-1 text-destructive"
                          onClick={() => setConfirmDeleteId(app.appId)}
                          disabled={busy}
                        >
                          <Trash2 className="h-3 w-3" />
                          Delete
                        </Button>
                      ))}
                  </div>
                )}

                {app.managed && (
                  <div className="flex items-center gap-1.5 pt-1">
                    <Input
                      value={domainDrafts[app.appId] ?? ""}
                      onChange={(event) =>
                        setDomainDrafts((drafts) => ({
                          ...drafts,
                          [app.appId]: event.target.value,
                        }))
                      }
                      placeholder="custom-domain.com"
                      className="h-7 text-xs w-44"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => void bindDomain(app.appId)}
                      disabled={busy || !(domainDrafts[app.appId] ?? "").trim()}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      Bind domain
                    </Button>
                    {dnsProviders.map((provider) => (
                      <Button
                        key={provider}
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => void setDomainDns(app.appId, provider)}
                        disabled={busy || !(domainDrafts[app.appId] ?? "").trim()}
                      >
                        <Globe className="h-3 w-3" />
                        Set DNS ({provider})
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
