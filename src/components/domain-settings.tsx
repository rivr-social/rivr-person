"use client";

/**
 * Domain settings component for configuring a custom domain on a sovereign Rivr instance.
 *
 * Provides:
 * - Form to enter/update a custom domain
 * - Display of required DNS records (A record + TXT verification)
 * - "Verify" button that checks DNS propagation via the API
 * - Status indicator: pending / verified / active
 * - "Remove" button to disconnect the domain
 *
 * Integration note: This component manages the application-level domain lifecycle.
 * Actual Traefik router/certificate configuration must be applied separately
 * on the host when the domain reaches "active" status.
 *
 * @module components/domain-settings
 */
import { useState, useEffect, useCallback } from "react";
import {
  Globe,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  Trash2,
  RefreshCw,
  Copy,
  Check,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";

/** Shape returned by the GET/POST/DELETE domain API. */
interface DomainConfigResponse {
  configured: boolean;
  domain: string | null;
  verificationStatus: "pending" | "verified" | "active" | null;
  verificationToken: string | null;
  verifiedAt: string | null;
  dnsRecords: DnsRecord[];
  verification?: VerificationResult;
}

interface DnsRecord {
  type: string;
  name: string;
  value: string;
  purpose: string;
}

interface VerificationCheck {
  id: string;
  label: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

interface VerificationResult {
  txtVerified: boolean;
  dnsPointingCorrectly: boolean;
  checks: VerificationCheck[];
  computedStatus: "pending" | "verified" | "active";
}

/** Status badge variant mapping. */
const STATUS_BADGE_VARIANT: Record<string, "secondary" | "outline" | "destructive"> = {
  active: "secondary",
  verified: "secondary",
  pending: "outline",
};

/** Status display labels. */
const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  verified: "Verified",
  pending: "Pending Verification",
};

/** Status icons. */
function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "active":
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "verified":
      return <CheckCircle2 className="h-4 w-4 text-blue-500" />;
    default:
      return <Clock className="h-4 w-4 text-yellow-500" />;
  }
}

/** Small copy-to-clipboard button for DNS record values. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may not be available in all contexts
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ml-2 inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

export function DomainSettings() {
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [domainInput, setDomainInput] = useState("");
  const [config, setConfig] = useState<DomainConfigResponse | null>(null);
  const [verificationChecks, setVerificationChecks] = useState<VerificationCheck[]>([]);

  /** Fetch the current domain config on mount. */
  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/domain");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data: DomainConfigResponse = await res.json();
      setConfig(data);
      if (data.configured && data.domain) {
        setDomainInput(data.domain);
      }
    } catch (error) {
      console.error("[domain-settings] Failed to load config:", error);
      toast({
        title: "Failed to load domain settings",
        description: "Could not retrieve your domain configuration.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  /** Set or update the custom domain. */
  async function handleSetDomain() {
    const trimmed = domainInput.trim().toLowerCase();
    if (!trimmed) {
      toast({
        title: "Domain required",
        description: "Please enter a domain name.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/settings/domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title: "Failed to set domain",
          description: data.error || "An error occurred.",
          variant: "destructive",
        });
        return;
      }
      setConfig(data);
      setDomainInput(data.domain || trimmed);
      setVerificationChecks([]);
      toast({
        title: "Domain configured",
        description: `Custom domain set to ${data.domain}. Add the DNS records below to verify ownership.`,
      });
    } catch {
      toast({
        title: "Failed to set domain",
        description: "Network error. Please try again.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  /** Trigger DNS verification. */
  async function handleVerify() {
    setVerifying(true);
    setVerificationChecks([]);
    try {
      const res = await fetch("/api/settings/domain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify" }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title: "Verification failed",
          description: data.error || "An error occurred during verification.",
          variant: "destructive",
        });
        return;
      }
      setConfig(data);
      if (data.verification?.checks) {
        setVerificationChecks(data.verification.checks);
      }
      if (data.verificationStatus === "active") {
        toast({
          title: "Domain verified and active",
          description: "Your custom domain is fully verified and DNS is pointing correctly.",
        });
      } else if (data.verificationStatus === "verified") {
        toast({
          title: "Ownership verified",
          description: "TXT record found. Update your A record to point to the instance IP to activate.",
        });
      } else {
        toast({
          title: "Verification incomplete",
          description: "DNS records not yet detected. This can take up to 48 hours to propagate.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Verification failed",
        description: "Network error. Please try again.",
        variant: "destructive",
      });
    } finally {
      setVerifying(false);
    }
  }

  /** Remove the custom domain. */
  async function handleRemove() {
    setRemoving(true);
    try {
      const res = await fetch("/api/settings/domain", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        toast({
          title: "Failed to remove domain",
          description: data.error || "An error occurred.",
          variant: "destructive",
        });
        return;
      }
      setConfig(data);
      setDomainInput("");
      setVerificationChecks([]);
      toast({
        title: "Domain removed",
        description: "Custom domain configuration has been removed.",
      });
    } catch {
      toast({
        title: "Failed to remove domain",
        description: "Network error. Please try again.",
        variant: "destructive",
      });
    } finally {
      setRemoving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading domain settings...
        </CardContent>
      </Card>
    );
  }

  const isConfigured = config?.configured === true;
  const currentStatus = config?.verificationStatus ?? "pending";
  const dnsRecords = config?.dnsRecords ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          Custom Domain
        </CardTitle>
        <CardDescription>
          Configure a custom domain for your sovereign Rivr instance. Your domain
          needs an A record pointing to the instance server and a TXT record for
          ownership verification.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Domain input */}
        <div className="grid gap-2">
          <Label htmlFor="custom-domain-input">Domain</Label>
          <div className="flex gap-2">
            <input
              id="custom-domain-input"
              type="text"
              className="flex-1 p-2 border rounded-md bg-background text-foreground"
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="rivr.yourdomain.com"
              disabled={saving}
            />
            <Button
              onClick={handleSetDomain}
              disabled={saving || !domainInput.trim()}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : isConfigured ? (
                "Update"
              ) : (
                "Set Domain"
              )}
            </Button>
          </div>
        </div>

        {/* Status and actions (only shown when a domain is configured) */}
        {isConfigured && config?.domain && (
          <>
            {/* Current status */}
            <div className="flex items-center gap-2 text-sm">
              <StatusIcon status={currentStatus} />
              <Badge variant={STATUS_BADGE_VARIANT[currentStatus] ?? "outline"}>
                {STATUS_LABELS[currentStatus] ?? currentStatus}
              </Badge>
              <span className="text-muted-foreground">
                {config.domain}
              </span>
              {config.verifiedAt && (
                <span className="text-xs text-muted-foreground">
                  Verified {new Date(config.verifiedAt).toLocaleDateString()}
                </span>
              )}
            </div>

            {/* Required DNS records */}
            {dnsRecords.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-medium">Required DNS Records</p>
                <div className="space-y-2">
                  {dnsRecords.map((record) => (
                    <div
                      key={`${record.type}-${record.name}`}
                      className="rounded-lg border p-3 text-sm"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="font-mono text-xs">
                          {record.type}
                        </Badge>
                        <span className="text-muted-foreground">{record.purpose}</span>
                      </div>
                      <div className="grid gap-1 mt-2">
                        <div className="flex items-center">
                          <span className="text-xs text-muted-foreground w-14 shrink-0">Name:</span>
                          <code className="text-xs font-mono break-all">{record.name}</code>
                          <CopyButton text={record.name} />
                        </div>
                        <div className="flex items-center">
                          <span className="text-xs text-muted-foreground w-14 shrink-0">Value:</span>
                          <code className="text-xs font-mono break-all">{record.value}</code>
                          <CopyButton text={record.value} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Verification checks (shown after verify action) */}
            {verificationChecks.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium">Verification Results</p>
                <div className="space-y-2">
                  {verificationChecks.map((check) => (
                    <div key={check.id} className="rounded-lg border p-3 text-sm">
                      <div className="flex items-center gap-2">
                        {check.status === "ok" ? (
                          <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        ) : (
                          <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />
                        )}
                        <span className="font-medium">{check.label}</span>
                        <Badge
                          variant={
                            check.status === "ok"
                              ? "secondary"
                              : check.status === "warning"
                                ? "outline"
                                : "destructive"
                          }
                          className="text-xs"
                        >
                          {check.status}
                        </Badge>
                      </div>
                      <p className="mt-1.5 text-muted-foreground break-all">
                        {check.detail}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex flex-wrap gap-3">
              <Button
                variant="outline"
                onClick={handleVerify}
                disabled={verifying || saving || removing}
              >
                {verifying ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Checking DNS...
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Verify DNS
                  </>
                )}
              </Button>
              <Button
                variant="destructive"
                onClick={handleRemove}
                disabled={removing || saving || verifying}
              >
                {removing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Removing...
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove Domain
                  </>
                )}
              </Button>
            </div>

            {/* Traefik integration note */}
            {currentStatus === "active" && (
              <div className="rounded-lg border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950 p-3 text-sm">
                <p className="font-medium text-green-800 dark:text-green-200">
                  Domain is active
                </p>
                <p className="mt-1 text-green-700 dark:text-green-300">
                  DNS is verified and pointing correctly. If Traefik has not yet been
                  configured for this domain, contact your deploy agent or update the
                  Traefik dynamic configuration on the host to enable HTTPS routing.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
