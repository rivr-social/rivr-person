"use client";

/**
 * SMS Gateway configuration component for group settings.
 *
 * Purpose:
 * - Allows group admins to configure, test, and remove TextBee SMS gateways.
 * - Displays gateway connection status with visual indicators.
 * - Follows existing Card/Form patterns from the settings-form.
 *
 * Dependencies:
 * - `@/app/actions/sms` for server action calls.
 * - shadcn UI components (Card, Button, Input, Label, Badge).
 * - `@/components/ui/use-toast` for user feedback.
 */

import { useState, useCallback, type FormEvent } from "react";
import {
  Loader2,
  Smartphone,
  Wifi,
  WifiOff,
  Trash2,
  Send,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/components/ui/use-toast";
import {
  configureGroupSmsGateway,
  removeGroupSmsGateway,
  testGroupSmsGateway,
  getGroupSmsStatus,
} from "@/app/actions/sms";

// =============================================================================
// Types
// =============================================================================

type GatewayStatus = {
  configured: boolean;
  textbeeUrl?: string;
  deviceOnline?: boolean;
  deviceId?: string;
  lastSeen?: string;
  lastTestAt?: string;
  lastTestResult?: "success" | "failure";
};

type SmsGatewayConfigProps = {
  /** UUID of the group being configured. */
  groupId: string;
  /** Initial gateway status loaded server-side. */
  initialStatus?: GatewayStatus;
};

type FormState = "idle" | "saving" | "testing" | "removing";

// =============================================================================
// Component
// =============================================================================

export function SmsGatewayConfig({ groupId, initialStatus }: SmsGatewayConfigProps) {
  const { toast } = useToast();

  const [formState, setFormState] = useState<FormState>("idle");
  const [status, setStatus] = useState<GatewayStatus>(
    initialStatus ?? { configured: false }
  );
  const [textbeeUrl, setTextbeeUrl] = useState(status.textbeeUrl ?? "");
  const [textbeeApiKey, setTextbeeApiKey] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleSaveConfig = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setFormState("saving");

      try {
        const result = await configureGroupSmsGateway(
          groupId,
          textbeeUrl,
          textbeeApiKey
        );

        if (result.success) {
          toast({
            title: "SMS Gateway Configured",
            description: "TextBee gateway settings saved. Run a connection test to verify.",
          });
          setStatus((prev) => ({
            ...prev,
            configured: true,
            textbeeUrl: textbeeUrl.replace(/\/+$/, ""),
          }));
          setTextbeeApiKey("");
          setShowApiKey(false);
        } else {
          toast({
            title: "Configuration Failed",
            description: result.error ?? "Failed to save gateway settings.",
            variant: "destructive",
          });
        }
      } catch {
        toast({
          title: "Error",
          description: "An unexpected error occurred.",
          variant: "destructive",
        });
      } finally {
        setFormState("idle");
      }
    },
    [groupId, textbeeUrl, textbeeApiKey, toast]
  );

  const handleTestConnection = useCallback(async () => {
    setFormState("testing");

    try {
      const result = await testGroupSmsGateway(groupId);

      if (result.success) {
        toast({
          title: "Connection Successful",
          description: `Gateway device is online${result.deviceId ? ` (${result.deviceId})` : ""}.`,
        });
        setStatus((prev) => ({
          ...prev,
          deviceOnline: true,
          deviceId: result.deviceId,
          lastTestAt: new Date().toISOString(),
          lastTestResult: "success",
        }));
      } else {
        toast({
          title: "Connection Failed",
          description: result.error ?? "Could not reach the gateway device.",
          variant: "destructive",
        });
        setStatus((prev) => ({
          ...prev,
          deviceOnline: false,
          lastTestAt: new Date().toISOString(),
          lastTestResult: "failure",
        }));
      }
    } catch {
      toast({
        title: "Test Failed",
        description: "An unexpected error occurred during the connection test.",
        variant: "destructive",
      });
    } finally {
      setFormState("idle");
    }
  }, [groupId, toast]);

  const handleRemoveGateway = useCallback(async () => {
    setFormState("removing");

    try {
      const result = await removeGroupSmsGateway(groupId);

      if (result.success) {
        toast({
          title: "Gateway Removed",
          description: "SMS gateway configuration has been removed.",
        });
        setStatus({ configured: false });
        setTextbeeUrl("");
        setTextbeeApiKey("");
      } else {
        toast({
          title: "Removal Failed",
          description: result.error ?? "Failed to remove gateway settings.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Error",
        description: "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setFormState("idle");
    }
  }, [groupId, toast]);

  const refreshStatus = useCallback(async () => {
    try {
      const result = await getGroupSmsStatus(groupId);
      if (result.success && result.status) {
        setStatus(result.status);
      }
    } catch {
      // Silently fail on status refresh.
    }
  }, [groupId]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const isProcessing = formState !== "idle";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Smartphone className="h-5 w-5 text-muted-foreground" />
          <CardTitle className="text-lg">SMS Gateway</CardTitle>
          {status.configured && (
            <StatusBadge
              online={status.lastTestResult === "success"}
              lastTestAt={status.lastTestAt}
            />
          )}
        </div>
        <CardDescription>
          Connect an Android phone running{" "}
          <a
            href="https://github.com/vernu/textbee"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4 inline-flex items-center gap-1"
          >
            TextBee
            <ExternalLink className="h-3 w-3" />
          </a>{" "}
          as your group&apos;s SMS gateway. Members who opt in with their phone
          number will receive group announcements and event invites via SMS.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Configuration Form */}
        <form onSubmit={handleSaveConfig} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="textbee-url">TextBee Server URL</Label>
            <Input
              id="textbee-url"
              type="url"
              placeholder="https://api.textbee.dev"
              value={textbeeUrl}
              onChange={(e) => setTextbeeUrl(e.target.value)}
              disabled={isProcessing}
              required
            />
            <p className="text-xs text-muted-foreground">
              The URL of your TextBee server instance.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="textbee-api-key">API Key</Label>
            <div className="flex gap-2">
              <Input
                id="textbee-api-key"
                type={showApiKey ? "text" : "password"}
                placeholder={status.configured ? "Enter new key to update" : "Your TextBee API key"}
                value={textbeeApiKey}
                onChange={(e) => setTextbeeApiKey(e.target.value)}
                disabled={isProcessing}
                required={!status.configured}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowApiKey(!showApiKey)}
                disabled={isProcessing}
                className="shrink-0"
              >
                {showApiKey ? "Hide" : "Show"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Found in your TextBee dashboard under API settings.
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              type="submit"
              disabled={isProcessing || !textbeeUrl || (!status.configured && !textbeeApiKey)}
              className="gap-2"
            >
              {formState === "saving" && <Loader2 className="h-4 w-4 animate-spin" />}
              {status.configured ? "Update Configuration" : "Save Configuration"}
            </Button>

            {status.configured && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={isProcessing}
                  className="gap-2"
                >
                  {formState === "testing" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                  Test Connection
                </Button>

                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleRemoveGateway}
                  disabled={isProcessing}
                  className="gap-2"
                >
                  {formState === "removing" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  Remove
                </Button>
              </>
            )}
          </div>
        </form>

        {/* Device Status Section */}
        {status.configured && (
          <>
            <Separator />
            <div className="space-y-3">
              <h4 className="text-sm font-medium">Device Status</h4>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Server URL</span>
                  <p className="font-mono text-xs mt-1 truncate">
                    {status.textbeeUrl ?? "Not set"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Device ID</span>
                  <p className="font-mono text-xs mt-1">
                    {status.deviceId ?? "Unknown"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Last Test</span>
                  <p className="text-xs mt-1">
                    {status.lastTestAt
                      ? new Date(status.lastTestAt).toLocaleString()
                      : "Never tested"}
                  </p>
                </div>
                <div>
                  <span className="text-muted-foreground">Webhook URL</span>
                  <p className="font-mono text-xs mt-1 truncate">
                    /api/groups/{groupId}/sms-inbound
                  </p>
                </div>
              </div>
            </div>

            <Separator />

            {/* Setup Instructions */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Inbound SMS Setup</h4>
              <p className="text-xs text-muted-foreground">
                To receive SMS replies (e.g. RSVP responses), configure TextBee to
                forward incoming messages to your webhook URL. In the TextBee app,
                set the webhook endpoint to:
              </p>
              <code className="block bg-muted p-2 rounded text-xs font-mono break-all">
                POST {typeof window !== "undefined" ? window.location.origin : ""}/api/groups/{groupId}/sms-inbound
              </code>
              <p className="text-xs text-muted-foreground">
                Include the API key in the <code className="bg-muted px-1 rounded">x-api-key</code> header.
                Members can reply with &quot;yes&quot; / &quot;going&quot; / &quot;no&quot; / &quot;cancel&quot; to RSVP to events.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function StatusBadge({
  online,
  lastTestAt,
}: {
  online?: boolean;
  lastTestAt?: string;
}) {
  if (!lastTestAt) {
    return (
      <Badge variant="outline" className="gap-1 text-xs">
        <AlertCircle className="h-3 w-3" />
        Not tested
      </Badge>
    );
  }

  if (online) {
    return (
      <Badge variant="outline" className="gap-1 text-xs text-green-600 border-green-200 bg-green-50">
        <Wifi className="h-3 w-3" />
        Connected
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className="gap-1 text-xs text-red-600 border-red-200 bg-red-50">
      <WifiOff className="h-3 w-3" />
      Disconnected
    </Badge>
  );
}
