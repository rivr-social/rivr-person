"use client";

/**
 * BuilderAssistantPanel — the tool-loop assistant in the builder Deploy view.
 *
 * Complements the streaming generator chat (which drafts whole files): this
 * panel sends the CURRENT workspace to `/api/builder/assistant`, where the
 * model makes surgical, jailed edits (read/write/delete) and — only when
 * explicitly asked — publishes through the same service path as the Deploy
 * button. The returned file map is applied back onto the workspace so edits
 * are previewable before anything goes live.
 */

import { useCallback, useRef, useState } from "react";
import { Bot, Loader2, Send, Sparkles } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { SiteFiles } from "@/lib/bespoke/site-files";

const API_ASSISTANT = "/api/builder/assistant";

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  changedPaths?: string[];
  publishedVersion?: number | null;
  deployment?: {
    status: string;
    url?: string;
    error?: string;
  } | null;
}

export function BuilderAssistantPanel({
  siteFiles,
  onFiles,
  onPublished,
  target,
}: {
  /** The builder page's current workspace (source of truth for edits). */
  siteFiles: SiteFiles;
  /** Applies the assistant's edited workspace back onto the page state. */
  onFiles: (files: SiteFiles) => void;
  /** Called after the assistant publishes, so the page refreshes state. */
  onPublished?: (result: unknown) => void;
  /** Validated by the API; binds assistant publish actions to this workspace. */
  target?: {
    workspaceId: string;
    basePath?: string;
    label: string;
    liveSubdomain?: string | null;
  };
}) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || busy) return;
    setError("");
    setInput("");
    setBusy(true);
    const history = entries.map(({ role, content }) => ({ role, content }));
    setEntries((prev) => [...prev, { role: "user", content: message }]);
    try {
      const res = await fetch(API_ASSISTANT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history,
          files: siteFiles,
          target: target
            ? { workspaceId: target.workspaceId, basePath: target.basePath }
            : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Assistant request failed");
      if (data.files && typeof data.files === "object") onFiles(data.files as SiteFiles);
      const publication = data.publication as { publishedVersionNumber?: number | null } | null;
      const workspaceDeployment = data.workspaceDeployment as {
        request?: { requestId?: string };
        result?: { status?: string; url?: string; error?: string } | null;
      } | null;
      const deploymentUrl =
        workspaceDeployment?.result?.url ??
        (target?.liveSubdomain ? `https://${target.liveSubdomain}/` : undefined);
      const deployment = workspaceDeployment
        ? {
            status: workspaceDeployment.result?.status ?? "queued",
            url: deploymentUrl,
            error: workspaceDeployment.result?.error,
          }
        : null;
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          content: typeof data.reply === "string" ? data.reply : "(no reply)",
          changedPaths: Array.isArray(data.changedPaths) ? data.changedPaths : [],
          publishedVersion: data.published
            ? (publication?.publishedVersionNumber ?? null)
            : null,
          deployment,
        },
      ]);
      if (data.published && onPublished) onPublished(data);
      queueMicrotask(() =>
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Assistant request failed");
    } finally {
      setBusy(false);
    }
  }, [busy, entries, input, siteFiles, onFiles, onPublished, target]);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4" /> Assistant
          {target ? <Badge variant="secondary">{target.label}</Badge> : null}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Ask for surgical changes to the current workspace — it edits the files and, when you
          say so, {target ? "deploys this selected app/site" : "publishes the sovereign site"}.
        </p>
      </div>

      {entries.length > 0 && (
        <div ref={scrollRef} className="max-h-72 space-y-3 overflow-y-auto pr-1">
          {entries.map((entry, i) => (
            <div key={i} className="text-sm">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                {entry.role === "assistant" ? <Bot className="h-3 w-3" /> : null}
                {entry.role === "assistant" ? "Assistant" : "You"}
              </div>
              <div className="whitespace-pre-wrap">{entry.content}</div>
              {entry.changedPaths && entry.changedPaths.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {[...new Set(entry.changedPaths)].map((path) => (
                    <Badge key={path} variant="outline" className="text-[10px] font-mono">
                      ✎ {path}
                    </Badge>
                  ))}
                </div>
              )}
              {entry.publishedVersion != null && (
                <Badge className="mt-1 text-[10px]">Published v{entry.publishedVersion}</Badge>
              )}
              {entry.deployment && (
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  <Badge
                    variant={entry.deployment.status === "failed" ? "destructive" : "default"}
                    className="text-[10px]"
                  >
                    {entry.deployment.status === "deployed"
                      ? "Deployed"
                      : entry.deployment.status === "failed"
                        ? "Deploy failed"
                        : "Deploy queued"}
                  </Badge>
                  {entry.deployment.url ? (
                    <a
                      href={entry.deployment.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-primary underline"
                    >
                      Open site
                    </a>
                  ) : null}
                  {entry.deployment.error ? (
                    <span className="text-[10px] text-destructive">{entry.deployment.error}</span>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder='e.g. "Tighten the hero copy and publish."'
          rows={2}
          disabled={busy}
          className="text-sm"
        />
        <Button size="icon" onClick={send} disabled={busy || !input.trim()} aria-label="Send">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      {error && <div className="text-[11px] text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
