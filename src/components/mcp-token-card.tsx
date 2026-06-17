"use client";

/**
 * McpTokenCard — displays the auto-provisioned MCP token for the current actor.
 * Shown in the connections tab so users can copy it for external tools.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Check, KeyRound, RefreshCw } from "lucide-react";

interface McpTokenInfo {
  token: string;
  expiresAt: string;
  scopes: string[];
}

export function McpTokenCard() {
  const [tokenInfo, setTokenInfo] = useState<McpTokenInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchToken = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp/token", { method: "POST" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.token) {
        setTokenInfo({
          token: data.token,
          expiresAt: data.expiresAt,
          scopes: data.scopes || [],
        });
      }
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchToken();
  }, [fetchToken]);

  const handleCopy = useCallback(() => {
    if (!tokenInfo) return;
    navigator.clipboard.writeText(tokenInfo.token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [tokenInfo]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchToken();
    setRefreshing(false);
  }, [fetchToken]);

  if (!tokenInfo) return null;

  const expiresDate = new Date(tokenInfo.expiresAt);
  const daysLeft = Math.max(0, Math.round((expiresDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="h-4 w-4" />
          MCP Access Token
        </div>
        <Badge variant="outline" className="text-xs">
          {daysLeft}d remaining
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        Use this token to connect external tools (Claude Code, Prism, custom agents)
        to your instance. It was auto-provisioned and refreshes when it expires.
      </p>

      <div className="flex items-center gap-2">
        <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono truncate select-all">
          {showToken ? tokenInfo.token : `${tokenInfo.token.slice(0, 20)}${"•".repeat(30)}`}
        </code>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowToken(!showToken)}
          className="text-xs shrink-0"
        >
          {showToken ? "Hide" : "Show"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopy}
          className="gap-1.5 shrink-0"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Issue new token"
          className="shrink-0"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>
    </div>
  );
}
