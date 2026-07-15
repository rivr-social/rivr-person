"use client";

/**
 * SiteEnvironmentPanel — deploy the current site workspace as its OWN
 * ENVIRONMENT: a static app on the broker lane (own container + own
 * hostname), instead of / in addition to the instance-served publish.
 * Status + the live URL surface in the Apps tab (the broker owns them).
 */

import { useCallback, useState } from "react";
import { Boxes, Loader2, Rocket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SiteFiles } from "@/lib/bespoke/site-files";

const API_SITE_APP = "/api/builder/site-app";
const APP_ID_HINT_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;

export function SiteEnvironmentPanel({
  siteFiles,
  onDeployed,
}: {
  siteFiles: SiteFiles;
  /** Called with the appId after a deploy is queued (e.g. to open the Apps tab). */
  onDeployed?: (appId: string) => void;
}) {
  const [appId, setAppId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const fileCount = Object.keys(siteFiles ?? {}).length;
  const validId = APP_ID_HINT_RE.test(appId);

  const deploy = useCallback(async () => {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const res = await fetch(API_SITE_APP, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, files: siteFiles }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Deploy failed");
      setMessage(
        `Deploy queued (${data.fileCount} files). The broker is building "${data.appId}" — watch the Apps tab for the live URL.`,
      );
      if (onDeployed) onDeployed(data.appId as string);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deploy failed");
    } finally {
      setBusy(false);
    }
  }, [appId, siteFiles, onDeployed]);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Boxes className="h-4 w-4" /> Own environment
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Ship this site as its own app — a dedicated container on its own hostname, deployed
          through the app broker.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="site-env-appid" className="text-xs">
          App id (becomes the subdomain)
        </Label>
        <Input
          id="site-env-appid"
          placeholder="my-site"
          value={appId}
          onChange={(e) => setAppId(e.target.value.trim().toLowerCase())}
          disabled={busy}
        />
      </div>
      <Button size="sm" onClick={deploy} disabled={busy || !validId || fileCount === 0}>
        {busy ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Rocket className="mr-2 h-4 w-4" />
        )}
        Deploy as own environment
      </Button>
      {!validId && appId.length > 0 && (
        <p className="text-[11px] text-muted-foreground">
          2–32 chars: lowercase letters, digits, dashes (no leading/trailing dash).
        </p>
      )}
      {message && (
        <div className="text-[11px] text-emerald-600 dark:text-emerald-400">{message}</div>
      )}
      {error && <div className="text-[11px] text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
