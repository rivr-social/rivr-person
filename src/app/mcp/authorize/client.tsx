"use client";

/**
 * Client component for the /mcp/authorize page.
 * Handles the approve/deny interaction for a specific user_code.
 */

import { useState } from "react";
import Link from "next/link";

interface Props {
  userCode: string;
}

export function DeviceAuthorizeClient({ userCode }: Props) {
  const [status, setStatus] = useState<"idle" | "approving" | "denying" | "approved" | "denied" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleAction(action: "approve" | "deny") {
    if (!userCode) return;
    setStatus(action === "approve" ? "approving" : "denying");
    setError(null);

    try {
      const res = await fetch("/api/mcp/device/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCode, action }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to resolve device code");
        setStatus("error");
        return;
      }

      setStatus(action === "approve" ? "approved" : "denied");
    } catch {
      setError("Network error — please try again");
      setStatus("error");
    }
  }

  if (!userCode) {
    return (
      <div className="mt-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          No request code was provided. Your CLI should send you here with a
          code like <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">WDJB-MJHT</code>.
        </p>
        <p className="text-sm text-muted-foreground">
          You can also approve pending device codes from the{" "}
          <Link href="/autobot" className="underline hover:text-foreground">
            Agent HQ dashboard
          </Link>.
        </p>
      </div>
    );
  }

  if (status === "approved") {
    return (
      <div className="mt-4 rounded-lg border border-green-500/30 bg-green-500/10 p-4 text-sm">
        <p className="font-medium text-green-700">Device authorized</p>
        <p className="mt-1 text-muted-foreground">
          Code <code className="font-mono">{userCode}</code> has been approved.
          The requesting application will receive its MCP token automatically.
        </p>
      </div>
    );
  }

  if (status === "denied") {
    return (
      <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm">
        <p className="font-medium text-red-700">Access denied</p>
        <p className="mt-1 text-muted-foreground">
          Code <code className="font-mono">{userCode}</code> has been denied.
          The requesting application will not receive a token.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
        <p className="text-sm">
          An application is requesting MCP access with code:
        </p>
        <p className="mt-2 text-center">
          <code className="text-2xl font-bold tracking-wider">{userCode}</code>
        </p>
      </div>

      <p className="text-sm text-muted-foreground">
        Approving will grant this application access to your MCP tools
        (posts, events, profile, etc.) for 30 days.
      </p>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => handleAction("approve")}
          disabled={status === "approving" || status === "denying"}
          className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {status === "approving" ? "Approving..." : "Approve"}
        </button>
        <button
          onClick={() => handleAction("deny")}
          disabled={status === "approving" || status === "denying"}
          className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {status === "denying" ? "Denying..." : "Deny"}
        </button>
      </div>
    </div>
  );
}
