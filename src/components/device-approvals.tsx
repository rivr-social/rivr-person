"use client";

/**
 * DeviceApprovals — in-app widget for RFC 8628 MCP device code approvals.
 *
 * Polls GET /api/mcp/device/approve for pending device codes and renders
 * them as approve/deny cards. Replaces the old paste-a-code workflow.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Clock, KeyRound } from "lucide-react";

interface PendingDeviceCode {
  id: string;
  userCode: string;
  clientName: string | null;
  scopes: string[];
  issuedAt: string;
  expiresAt: string;
}

const POLL_INTERVAL_MS = 10_000; // Poll every 10s for new codes

export function DeviceApprovals() {
  const [pending, setPending] = useState<PendingDeviceCode[]>([]);
  const [resolving, setResolving] = useState<Set<string>>(new Set());
  const [resolved, setResolved] = useState<Map<string, "approved" | "denied">>(new Map());

  const fetchPending = useCallback(async () => {
    try {
      const res = await fetch("/api/mcp/device/approve");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.pending)) {
        setPending(data.pending);
      }
    } catch {
      // Silently fail — widget is non-critical
    }
  }, []);

  useEffect(() => {
    fetchPending();
    const interval = setInterval(fetchPending, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchPending]);

  const handleResolve = useCallback(
    async (userCode: string, action: "approve" | "deny") => {
      setResolving((prev) => new Set(prev).add(userCode));
      try {
        const res = await fetch("/api/mcp/device/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userCode, action }),
        });
        if (res.ok) {
          setResolved((prev) => new Map(prev).set(userCode, action === "approve" ? "approved" : "denied"));
          // Remove from pending after brief delay so user sees the result
          setTimeout(() => {
            setPending((prev) => prev.filter((c) => c.userCode !== userCode));
            setResolved((prev) => {
              const next = new Map(prev);
              next.delete(userCode);
              return next;
            });
          }, 2000);
        }
      } catch {
        // Failed — will retry on next poll
      } finally {
        setResolving((prev) => {
          const next = new Set(prev);
          next.delete(userCode);
          return next;
        });
      }
    },
    [],
  );

  if (pending.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <KeyRound className="h-4 w-4 text-amber-500" />
        <span>Pending Device Authorizations</span>
        <Badge variant="outline" className="text-amber-600 border-amber-500/30">
          {pending.length}
        </Badge>
      </div>

      {pending.map((code) => {
        const isResolving = resolving.has(code.userCode);
        const resolution = resolved.get(code.userCode);
        const expiresAt = new Date(code.expiresAt);
        const minutesLeft = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 60_000));

        return (
          <div
            key={code.id}
            className={`rounded-lg border p-4 space-y-3 transition-colors ${
              resolution === "approved"
                ? "border-green-500/30 bg-green-500/5"
                : resolution === "denied"
                  ? "border-red-500/30 bg-red-500/5"
                  : "border-amber-500/30 bg-amber-500/5"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <code className="text-lg font-bold tracking-wider">{code.userCode}</code>
                {code.clientName && (
                  <span className="text-sm text-muted-foreground">
                    from {code.clientName}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="h-3 w-3" />
                {minutesLeft > 0 ? `${minutesLeft}m left` : "expiring"}
              </div>
            </div>

            {code.scopes.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {code.scopes.map((scope) => (
                  <Badge key={scope} variant="secondary" className="text-xs">
                    {scope}
                  </Badge>
                ))}
              </div>
            )}

            {resolution ? (
              <div className={`flex items-center gap-2 text-sm font-medium ${
                resolution === "approved" ? "text-green-600" : "text-red-600"
              }`}>
                {resolution === "approved" ? (
                  <><CheckCircle className="h-4 w-4" /> Approved — token issued</>
                ) : (
                  <><XCircle className="h-4 w-4" /> Denied</>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={() => handleResolve(code.userCode, "approve")}
                  disabled={isResolving}
                  className="gap-1.5"
                >
                  <CheckCircle className="h-3.5 w-3.5" />
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleResolve(code.userCode, "deny")}
                  disabled={isResolving}
                  className="gap-1.5"
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Deny
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
