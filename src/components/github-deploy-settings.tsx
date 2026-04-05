"use client";

/**
 * GitHubDeploySettings — settings panel for connecting a GitHub repository
 * for site deployment on shared instances.
 *
 * On sovereign instances, this panel shows a message that direct deploy is
 * available and no GitHub connection is needed.
 *
 * On shared instances, it provides:
 * 1. GitHub repo URL input
 * 2. Branch selector
 * 3. Personal access token input
 * 4. Optional base path for site files within the repo
 * 5. Test connection button
 * 6. Disconnect button (when connected)
 * 7. Connection status and last deploy info
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_GITHUB_CONNECTION = "/api/builder/github-connection";
const API_DEPLOY_STATUS = "/api/builder/deploy";

const STATUS_CONNECTED = "connected";
const STATUS_DISCONNECTED = "disconnected";
const STATUS_CONNECTING = "connecting";
const STATUS_ERROR = "error";

type ConnectionStatus =
  | typeof STATUS_CONNECTED
  | typeof STATUS_DISCONNECTED
  | typeof STATUS_CONNECTING
  | typeof STATUS_ERROR;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ConnectionInfo {
  connected: boolean;
  deployMethod: string;
  repo?: string;
  branch?: string;
  basePath?: string;
  connectedAt?: string;
  valid?: boolean;
  validationError?: string | null;
  message?: string;
}

interface DeployInfo {
  deployMethod: string;
  isolationTier?: string;
  connected?: boolean;
  repo?: string;
  branch?: string;
  status?: {
    latestCommitSha: string | null;
    latestCommitMessage: string | null;
    latestCommitDate: string | null;
    workflowRuns: Array<{
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      createdAt: string;
      htmlUrl: string;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GitHubDeploySettings() {
  const [connectionInfo, setConnectionInfo] = useState<ConnectionInfo | null>(null);
  const [deployInfo, setDeployInfo] = useState<DeployInfo | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>(STATUS_DISCONNECTED);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Form state
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [token, setToken] = useState("");
  const [basePath, setBasePath] = useState("");
  const [loading, setLoading] = useState(false);

  // ---------------------------------------------------------------------------
  // Fetch current connection
  // ---------------------------------------------------------------------------

  const fetchConnection = useCallback(async () => {
    try {
      const res = await fetch(API_GITHUB_CONNECTION);
      if (!res.ok) return;
      const data: ConnectionInfo = await res.json();
      setConnectionInfo(data);

      if (data.connected) {
        setStatus(data.valid === false ? STATUS_ERROR : STATUS_CONNECTED);
        if (data.valid === false && data.validationError) {
          setErrorMessage(data.validationError);
        }
      } else {
        setStatus(STATUS_DISCONNECTED);
      }
    } catch {
      // Silently fail — will show disconnected state
    }
  }, []);

  const fetchDeployStatus = useCallback(async () => {
    try {
      const res = await fetch(API_DEPLOY_STATUS);
      if (!res.ok) return;
      const data: DeployInfo = await res.json();
      setDeployInfo(data);
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchConnection();
    fetchDeployStatus();
  }, [fetchConnection, fetchDeployStatus]);

  // ---------------------------------------------------------------------------
  // Connect
  // ---------------------------------------------------------------------------

  const handleConnect = async () => {
    if (!repoUrl.trim() || !token.trim()) {
      setErrorMessage("Repository URL and token are required.");
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    setStatus(STATUS_CONNECTING);

    try {
      const res = await fetch(API_GITHUB_CONNECTION, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: repoUrl.trim(),
          branch: branch.trim() || "main",
          token: token.trim(),
          basePath: basePath.trim() || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok || data.error) {
        setStatus(STATUS_ERROR);
        setErrorMessage(data.error || "Failed to connect.");
        return;
      }

      setStatus(STATUS_CONNECTED);
      setToken(""); // Clear token from form after successful connection
      await fetchConnection();
      await fetchDeployStatus();
    } catch (err) {
      setStatus(STATUS_ERROR);
      setErrorMessage(err instanceof Error ? err.message : "Connection failed.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Disconnect
  // ---------------------------------------------------------------------------

  const handleDisconnect = async () => {
    setLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch(API_GITHUB_CONNECTION, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        setErrorMessage(data.error || "Failed to disconnect.");
        return;
      }

      setStatus(STATUS_DISCONNECTED);
      setConnectionInfo(null);
      setDeployInfo(null);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Disconnect failed.");
    } finally {
      setLoading(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Sovereign instance — no GitHub needed
  // ---------------------------------------------------------------------------

  if (connectionInfo?.deployMethod === "direct") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">Site Deployment</h3>
          <Badge variant="outline" className="text-emerald-400 border-emerald-400/30">
            Sovereign
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          This is a sovereign instance with direct deploy access. Site files are
          written directly to the server. No GitHub connection is needed.
        </p>
        {connectionInfo.message && (
          <p className="text-xs text-muted-foreground">{connectionInfo.message}</p>
        )}
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Shared instance — GitHub deploy UI
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">GitHub Deploy Connection</h3>
        <Badge
          variant="outline"
          className={
            status === STATUS_CONNECTED
              ? "text-emerald-400 border-emerald-400/30"
              : status === STATUS_ERROR
                ? "text-red-400 border-red-400/30"
                : "text-zinc-400 border-zinc-400/30"
          }
        >
          {status === STATUS_CONNECTED
            ? "Connected"
            : status === STATUS_ERROR
              ? "Error"
              : status === STATUS_CONNECTING
                ? "Connecting..."
                : "Not Connected"}
        </Badge>
      </div>

      <p className="text-sm text-muted-foreground">
        Connect a GitHub repository where your site builder output will be pushed.
        Your CI/CD pipeline (GitHub Actions, Vercel, Netlify, etc.) handles
        deployment from there to your custom URL.
      </p>

      {/* Error display */}
      {errorMessage && (
        <div className="rounded-md border border-red-400/30 bg-red-400/5 px-3 py-2">
          <p className="text-sm text-red-400">{errorMessage}</p>
        </div>
      )}

      {/* Connected state */}
      {status === STATUS_CONNECTED && connectionInfo?.connected && (
        <>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/50 p-4 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Repository</span>
              <a
                href={`https://github.com/${connectionInfo.repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-violet-400 hover:underline"
              >
                {connectionInfo.repo}
              </a>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Branch</span>
              <span className="text-sm">{connectionInfo.branch}</span>
            </div>
            {connectionInfo.basePath && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Base Path</span>
                <span className="text-sm font-mono">{connectionInfo.basePath}</span>
              </div>
            )}
            {connectionInfo.connectedAt && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Connected</span>
                <span className="text-sm">
                  {new Date(connectionInfo.connectedAt).toLocaleDateString()}
                </span>
              </div>
            )}
          </div>

          {/* Recent deploy info */}
          {deployInfo?.status && (
            <>
              <Separator />
              <div className="space-y-2">
                <h4 className="text-xs font-medium uppercase text-muted-foreground">
                  Latest Commit
                </h4>
                {deployInfo.status.latestCommitSha ? (
                  <div className="text-sm space-y-1">
                    <p className="font-mono text-xs text-zinc-400">
                      {deployInfo.status.latestCommitSha.slice(0, 8)}
                    </p>
                    <p className="text-zinc-300">{deployInfo.status.latestCommitMessage}</p>
                    {deployInfo.status.latestCommitDate && (
                      <p className="text-xs text-muted-foreground">
                        {new Date(deployInfo.status.latestCommitDate).toLocaleString()}
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No commits yet.</p>
                )}
              </div>

              {deployInfo.status.workflowRuns.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-medium uppercase text-muted-foreground">
                    Workflow Runs
                  </h4>
                  <div className="space-y-1">
                    {deployInfo.status.workflowRuns.map((run) => (
                      <a
                        key={run.id}
                        href={run.htmlUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-between rounded px-2 py-1 text-sm hover:bg-zinc-800/50"
                      >
                        <span className="text-zinc-300">{run.name}</span>
                        <Badge
                          variant="outline"
                          className={
                            run.conclusion === "success"
                              ? "text-emerald-400 border-emerald-400/30"
                              : run.conclusion === "failure"
                                ? "text-red-400 border-red-400/30"
                                : "text-yellow-400 border-yellow-400/30"
                          }
                        >
                          {run.conclusion || run.status}
                        </Badge>
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          <Button
            variant="destructive"
            size="sm"
            onClick={handleDisconnect}
            disabled={loading}
          >
            {loading ? "Disconnecting..." : "Disconnect Repository"}
          </Button>
        </>
      )}

      {/* Disconnected state — connection form */}
      {(status === STATUS_DISCONNECTED || status === STATUS_ERROR || status === STATUS_CONNECTING) && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="github-repo-url">Repository URL</Label>
            <Input
              id="github-repo-url"
              placeholder="https://github.com/username/my-site"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              Accepts: https://github.com/owner/repo or owner/repo
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="github-branch">Branch</Label>
              <Input
                id="github-branch"
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="github-base-path">Base Path (optional)</Label>
              <Input
                id="github-base-path"
                placeholder="public/ or docs/"
                value={basePath}
                onChange={(e) => setBasePath(e.target.value)}
                disabled={loading}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="github-token">Personal Access Token</Label>
            <Input
              id="github-token"
              type="password"
              placeholder="ghp_..."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={loading}
            />
            <p className="text-xs text-muted-foreground">
              Needs <code className="text-xs">repo</code> scope. Create one at{" "}
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=Rivr+Site+Builder"
                target="_blank"
                rel="noopener noreferrer"
                className="text-violet-400 hover:underline"
              >
                GitHub Settings
              </a>
              .
            </p>
          </div>

          <Button
            onClick={handleConnect}
            disabled={loading || !repoUrl.trim() || !token.trim()}
            className="w-full"
          >
            {loading ? "Connecting..." : "Connect Repository"}
          </Button>
        </div>
      )}
    </div>
  );
}
