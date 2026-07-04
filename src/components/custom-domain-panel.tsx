"use client";

/**
 * CustomDomainPanel — publish the current builder workspace and serve it on the
 * owner's own domain (host-dispatch).
 *
 * Flow:
 *   1. Publish  — snapshots the workspace files + writes them to storage.
 *   2. Enter a domain — shows the exact DNS record to add (A -> same IP as the
 *      app host, or a CNAME alternative).
 *   3. Verify   — server checks (via node:dns) the domain resolves to the app.
 *   4. Bind     — persists the domain so it serves the published site.
 *   5. (optional) Set DNS for me — one-click DNS write via a connected
 *      Cloudflare/Namecheap connector (owner-only; creds stay server-side).
 *
 * All identity/credentials are enforced server-side; this panel only calls the
 * owner-gated `/api/builder/publish` and `/api/builder/domain` routes.
 */

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import type { SiteFiles } from "@/lib/bespoke/site-files";

const API_PUBLISH = "/api/builder/publish";
const API_DOMAIN = "/api/builder/domain";

interface PublicationState {
  agentId: string;
  publishedVersionNumber: number | null;
  customDomain: string | null;
  domainProvider: string | null;
  domainStatus: string;
  domainError: string | null;
  fileCount: number;
  publishedAt: string | null;
}

interface DnsRecord {
  type: string;
  name: string;
  value: string;
  purpose: string;
}

interface VerificationResult {
  verified: boolean;
  detail: string;
  matched: string[];
  appAddresses: string[];
  domainAddresses: string[];
}

type Busy = "idle" | "publishing" | "verifying" | "binding" | "dns" | "unbinding";

const STATUS_LABEL: Record<string, string> = {
  unbound: "Not connected",
  pending: "Pending DNS",
  bound: "Live",
  error: "Error",
  manual: "Manual DNS needed",
};

/** Props: the builder's current workspace files (published as-is). */
export function CustomDomainPanel({ siteFiles }: { siteFiles: SiteFiles }) {
  const [publication, setPublication] = useState<PublicationState | null>(null);
  const [appHostname, setAppHostname] = useState<string | null>(null);
  const [dnsProviders, setDnsProviders] = useState<string[]>([]);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [domainInput, setDomainInput] = useState("");
  const [verification, setVerification] = useState<VerificationResult | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");

  const fileCount = Object.keys(siteFiles ?? {}).length;

  const loadState = useCallback(async () => {
    try {
      const res = await fetch(API_DOMAIN, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setPublication(data.publication ?? null);
      setAppHostname(data.appHostname ?? null);
      setDnsProviders(Array.isArray(data.dnsProviders) ? data.dnsProviders : []);
      setDnsRecords(Array.isArray(data.dnsRecords) ? data.dnsRecords : []);
      if (data.publication?.customDomain && !domainInput) {
        setDomainInput(data.publication.customDomain);
      }
    } catch {
      // non-fatal: panel still renders with defaults
    }
  }, [domainInput]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const publish = useCallback(async () => {
    setError("");
    setMessage("");
    if (fileCount === 0) {
      setError("Nothing to publish yet — generate or load site files first.");
      return;
    }
    setBusy("publishing");
    try {
      const res = await fetch(API_PUBLISH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: siteFiles, commitMessage: "Published from builder" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Publish failed");
      setMessage(`Published ${data.fileCount} file(s) as version ${data.versionNumber}.`);
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Publish failed");
    } finally {
      setBusy("idle");
    }
  }, [fileCount, siteFiles, loadState]);

  const postDomain = useCallback(
    async (payload: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      const res = await fetch(API_DOMAIN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    },
    [],
  );

  const verify = useCallback(async () => {
    setError("");
    setMessage("");
    setVerification(null);
    setBusy("verifying");
    try {
      const data = await postDomain({ action: "verify", domain: domainInput });
      const result = (data?.verification ?? null) as VerificationResult | null;
      setVerification(result);
      if (result?.verified) setMessage("Domain resolves to this instance — ready to connect.");
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy("idle");
    }
  }, [domainInput, postDomain, loadState]);

  const bind = useCallback(async () => {
    setError("");
    setMessage("");
    setBusy("binding");
    try {
      await postDomain({ action: "bind", domain: domainInput });
      setMessage(`${domainInput} is now serving your published site.`);
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setBusy("idle");
    }
  }, [domainInput, postDomain, loadState]);

  const setDnsForMe = useCallback(
    async (provider: string) => {
      setError("");
      setMessage("");
      setBusy("dns");
      try {
        const data = await postDomain({ action: "set-dns", domain: domainInput, provider });
        const apply = data?.apply as { ok?: boolean; detail?: string } | undefined;
        setMessage(apply?.detail || "DNS records submitted.");
        await loadState();
      } catch (err) {
        setError(err instanceof Error ? err.message : "DNS write failed");
      } finally {
        setBusy("idle");
      }
    },
    [domainInput, postDomain, loadState],
  );

  const unbind = useCallback(async () => {
    setError("");
    setMessage("");
    setBusy("unbinding");
    try {
      const res = await fetch(API_DOMAIN, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Disconnect failed");
      }
      setMessage("Custom domain disconnected.");
      setVerification(null);
      await loadState();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Disconnect failed");
    } finally {
      setBusy("idle");
    }
  }, [loadState]);

  const status = publication?.domainStatus ?? "unbound";
  const isPublished = (publication?.publishedVersionNumber ?? null) !== null;
  const disabled = busy !== "idle";

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Custom domain</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Publish your site and serve it on your own domain.
        </p>
      </div>

      {/* Publish */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs">
            <div className="font-medium">Published site</div>
            <div className="text-muted-foreground">
              {isPublished
                ? `Version ${publication?.publishedVersionNumber} · ${publication?.fileCount ?? 0} file(s)`
                : "Not published yet"}
            </div>
          </div>
          <Button size="sm" onClick={publish} disabled={disabled || fileCount === 0}>
            {busy === "publishing" ? "Publishing…" : isPublished ? "Re-publish" : "Publish"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {fileCount} file(s) in the current workspace.
        </p>
      </div>

      <Separator />

      {/* Domain binding */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">Status</span>
          <Badge variant={status === "bound" ? "default" : "outline"}>
            {STATUS_LABEL[status] ?? status}
          </Badge>
          {publication?.customDomain && (
            <span className="text-xs text-muted-foreground">{publication.customDomain}</span>
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="custom-domain" className="text-xs">
            Your domain
          </Label>
          <Input
            id="custom-domain"
            placeholder="example.com or www.example.com"
            value={domainInput}
            onChange={(e) => setDomainInput(e.target.value.trim())}
            disabled={disabled}
          />
        </div>

        {appHostname && (
          <div className="rounded-md bg-muted/50 p-2 text-[11px] space-y-1">
            <div className="font-medium">DNS records to add</div>
            {(dnsRecords.length > 0
              ? dnsRecords
              : [
                  {
                    type: "A",
                    name: domainInput || "your-domain.com",
                    value: `<same IP as ${appHostname}>`,
                    purpose: `Point an A record at the same IP that ${appHostname} resolves to.`,
                  },
                  {
                    type: "CNAME",
                    name: domainInput || "www.your-domain.com",
                    value: appHostname,
                    purpose: `Or CNAME to ${appHostname} (subdomains).`,
                  },
                ]
            ).map((rec, i) => (
              <div key={i} className="font-mono">
                <span className="font-semibold">{rec.type}</span> {rec.name} →{" "}
                {rec.value}
                <div className="font-sans text-muted-foreground">{rec.purpose}</div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={verify}
            disabled={disabled || !domainInput || !isPublished}
          >
            {busy === "verifying" ? "Verifying…" : "Verify DNS"}
          </Button>
          <Button
            size="sm"
            onClick={bind}
            disabled={disabled || !domainInput || !isPublished}
          >
            {busy === "binding" ? "Connecting…" : "Connect domain"}
          </Button>
          {(status === "bound" || status === "pending" || status === "manual") && (
            <Button size="sm" variant="ghost" onClick={unbind} disabled={disabled}>
              {busy === "unbinding" ? "Disconnecting…" : "Disconnect"}
            </Button>
          )}
        </div>

        {/* One-click DNS via a connected provider */}
        {dnsProviders.length > 0 && (
          <div className="rounded-md border p-2 space-y-2">
            <div className="text-[11px] font-medium">Set DNS for me</div>
            <div className="flex flex-wrap gap-2">
              {dnsProviders.map((provider) => (
                <Button
                  key={provider}
                  size="sm"
                  variant="secondary"
                  onClick={() => setDnsForMe(provider)}
                  disabled={disabled || !domainInput || !isPublished}
                >
                  {busy === "dns" ? "Writing…" : `Via ${provider}`}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Uses your connected DNS connector — credentials never leave the server.
            </p>
          </div>
        )}

        {verification && (
          <div
            className={`rounded-md p-2 text-[11px] ${
              verification.verified
                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}
          >
            {verification.detail}
          </div>
        )}
        {message && <div className="text-[11px] text-emerald-600 dark:text-emerald-400">{message}</div>}
        {error && <div className="text-[11px] text-red-600 dark:text-red-400">{error}</div>}
        {publication?.domainError && !error && (
          <div className="text-[11px] text-amber-600 dark:text-amber-400">
            {publication.domainError}
          </div>
        )}
      </div>
    </div>
  );
}
