"use client";

/**
 * AutobotControlPane — expandable per-persona autobot control surface.
 *
 * Renders inside each persona card in the PersonaManager:
 * 1. Autobot enable/disable toggle
 * 2. Control mode selector (direct-only | approval-required | delegated)
 * 3. Connection health indicator (pings /api/autobot/settings)
 * 4. Voice profile selector (current sample display + link to voice upload)
 * 5. Recent actions log (last 10 provenance entries for the persona actorId)
 * 6. Instruction channel (inline chat that sends to /api/autobot/chat with persona context)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/use-toast";
import {
  Activity,
  Mic,
  Send,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { updatePersonaAutobotSettings } from "@/app/actions/personas";
import type { AutobotControlMode } from "@/app/actions/personas";
import type { SerializedAgent } from "@/lib/graph-serializers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVENANCE_FETCH_LIMIT = 10;
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const MAX_INSTRUCTION_LENGTH = 2000;

const CONTROL_MODE_LABELS: Record<AutobotControlMode, string> = {
  "direct-only": "Direct Only",
  "approval-required": "Approval Required",
  delegated: "Delegated",
};

const CONTROL_MODE_DESCRIPTIONS: Record<AutobotControlMode, string> = {
  "direct-only": "Autobot only acts when explicitly commanded",
  "approval-required": "Autobot proposes actions, you approve before execution",
  delegated: "Autobot acts autonomously within its configured scope",
};

type ConnectionStatus = "unknown" | "checking" | "connected" | "error";

// ---------------------------------------------------------------------------
// Types for provenance entries
// ---------------------------------------------------------------------------

interface ProvenanceEntry {
  id: string;
  toolName: string;
  actorId: string;
  actorType: string;
  resultStatus: string;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
  argsSummary: Record<string, unknown>;
}

interface InstructionMessage {
  role: "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

interface AutobotControlPaneProps {
  persona: SerializedAgent;
  onSettingsChanged?: () => void;
}

export function AutobotControlPane({
  persona,
  onSettingsChanged,
}: AutobotControlPaneProps) {
  const { toast } = useToast();
  const metadata = (persona.metadata ?? {}) as Record<string, unknown>;

  // Autobot toggle state
  const [autobotEnabled, setAutobotEnabled] = useState<boolean>(
    metadata.autobotEnabled === true
  );
  const [controlMode, setControlMode] = useState<AutobotControlMode>(
    isValidControlMode(metadata.autobotControlMode)
      ? (metadata.autobotControlMode as AutobotControlMode)
      : "direct-only"
  );

  // Connection health
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("unknown");

  // Voice info
  const [voiceSample, setVoiceSample] = useState<{
    fileName: string;
    uploadedAt: string;
  } | null>(null);
  const [voiceLoading, setVoiceLoading] = useState(false);

  // Provenance log
  const [provenanceEntries, setProvenanceEntries] = useState<
    ProvenanceEntry[]
  >([]);
  const [provenanceLoading, setProvenanceLoading] = useState(false);

  // Instruction channel
  const [instructionInput, setInstructionInput] = useState("");
  const [instructionHistory, setInstructionHistory] = useState<
    InstructionMessage[]
  >([]);
  const [instructionSending, setInstructionSending] = useState(false);
  const instructionEndRef = useRef<HTMLDivElement>(null);

  // Saving state
  const [saving, setSaving] = useState(false);

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------

  const checkConnection = useCallback(async () => {
    setConnectionStatus("checking");
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        HEALTH_CHECK_TIMEOUT_MS
      );

      const response = await fetch("/api/autobot/settings", {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      setConnectionStatus(response.ok ? "connected" : "error");
    } catch {
      setConnectionStatus("error");
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Fetch voice info from settings
  // ---------------------------------------------------------------------------

  const fetchVoiceInfo = useCallback(async () => {
    setVoiceLoading(true);
    try {
      const response = await fetch("/api/autobot/settings");
      if (response.ok) {
        const data = await response.json();
        const sample = data?.settings?.voiceSample;
        if (
          sample &&
          typeof sample.fileName === "string" &&
          typeof sample.uploadedAt === "string"
        ) {
          setVoiceSample({
            fileName: sample.fileName,
            uploadedAt: sample.uploadedAt,
          });
        } else {
          setVoiceSample(null);
        }
      }
    } catch {
      // Non-critical — voice info is informational
    } finally {
      setVoiceLoading(false);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Fetch provenance
  // ---------------------------------------------------------------------------

  const fetchProvenance = useCallback(async () => {
    setProvenanceLoading(true);
    try {
      const params = new URLSearchParams({
        actorId: persona.id,
        limit: String(PROVENANCE_FETCH_LIMIT),
      });
      const response = await fetch(`/api/autobot/provenance?${params}`);
      if (response.ok) {
        const data = await response.json();
        setProvenanceEntries(Array.isArray(data.entries) ? data.entries : []);
      }
    } catch {
      // Non-critical
    } finally {
      setProvenanceLoading(false);
    }
  }, [persona.id]);

  // ---------------------------------------------------------------------------
  // Initial data load when pane opens
  // ---------------------------------------------------------------------------

  useEffect(() => {
    checkConnection();
    fetchVoiceInfo();
    fetchProvenance();
  }, [checkConnection, fetchVoiceInfo, fetchProvenance]);

  // ---------------------------------------------------------------------------
  // Scroll instruction history to bottom
  // ---------------------------------------------------------------------------

  useEffect(() => {
    instructionEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [instructionHistory]);

  // ---------------------------------------------------------------------------
  // Persist autobot toggle
  // ---------------------------------------------------------------------------

  const handleToggleAutobot = async (checked: boolean) => {
    setAutobotEnabled(checked);
    setSaving(true);
    try {
      const result = await updatePersonaAutobotSettings({
        personaId: persona.id,
        autobotEnabled: checked,
      });
      if (!result.success) {
        setAutobotEnabled(!checked);
        toast({
          title: result.error ?? "Failed to update autobot setting",
          variant: "destructive",
        });
      } else {
        toast({
          title: checked ? "Autobot enabled" : "Autobot disabled",
        });
        onSettingsChanged?.();
      }
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Persist control mode
  // ---------------------------------------------------------------------------

  const handleControlModeChange = async (value: string) => {
    if (!isValidControlMode(value)) return;
    const previousMode = controlMode;
    const newMode = value as AutobotControlMode;
    setControlMode(newMode);
    setSaving(true);
    try {
      const result = await updatePersonaAutobotSettings({
        personaId: persona.id,
        autobotControlMode: newMode,
      });
      if (!result.success) {
        setControlMode(previousMode);
        toast({
          title: result.error ?? "Failed to update control mode",
          variant: "destructive",
        });
      } else {
        toast({ title: `Control mode set to ${CONTROL_MODE_LABELS[newMode]}` });
        onSettingsChanged?.();
      }
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Send instruction
  // ---------------------------------------------------------------------------

  const handleSendInstruction = async () => {
    const message = instructionInput.trim();
    if (!message || instructionSending) return;

    if (message.length > MAX_INSTRUCTION_LENGTH) {
      toast({
        title: `Message exceeds maximum length of ${MAX_INSTRUCTION_LENGTH} characters`,
        variant: "destructive",
      });
      return;
    }

    const userMessage: InstructionMessage = { role: "user", content: message };
    setInstructionHistory((prev) => [...prev, userMessage]);
    setInstructionInput("");
    setInstructionSending(true);

    try {
      const response = await fetch("/api/autobot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `[Persona: ${persona.name} (${persona.id})] ${message}`,
          history: instructionHistory.slice(-20),
        }),
      });

      if (response.ok) {
        const data = await response.json();
        const assistantMessage: InstructionMessage = {
          role: "assistant",
          content: data.reply || "...",
        };
        setInstructionHistory((prev) => [...prev, assistantMessage]);
      } else {
        const errorData = await response.json().catch(() => ({}));
        setInstructionHistory((prev) => [
          ...prev,
          {
            role: "assistant",
            content: `Error: ${errorData.error || `Request failed (${response.status})`}`,
          },
        ]);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Network error";
      setInstructionHistory((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${errorMessage}` },
      ]);
    } finally {
      setInstructionSending(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="space-y-4 pt-3">
      <Separator />

      {/* ── Row 1: Enable toggle + Connection health ── */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Switch
            id={`autobot-toggle-${persona.id}`}
            checked={autobotEnabled}
            onCheckedChange={handleToggleAutobot}
            disabled={saving}
            aria-label="Enable autobot for this persona"
          />
          <Label
            htmlFor={`autobot-toggle-${persona.id}`}
            className="text-sm font-medium cursor-pointer"
          >
            Autobot {autobotEnabled ? "Enabled" : "Disabled"}
          </Label>
        </div>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={checkConnection}
                className="flex items-center gap-1.5 text-xs"
                aria-label="Check autobot connection"
              >
                <ConnectionStatusIcon status={connectionStatus} />
                <span className={connectionStatusColor(connectionStatus)}>
                  {connectionStatusLabel(connectionStatus)}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>Click to re-check autobot connection</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {/* ── Row 2: Control mode selector ── */}
      {autobotEnabled && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Control Mode</Label>
          <Select
            value={controlMode}
            onValueChange={handleControlModeChange}
            disabled={saving}
          >
            <SelectTrigger className="h-9 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CONTROL_MODE_LABELS) as AutobotControlMode[]).map(
                (mode) => (
                  <SelectItem key={mode} value={mode}>
                    {CONTROL_MODE_LABELS[mode]}
                  </SelectItem>
                )
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {CONTROL_MODE_DESCRIPTIONS[controlMode]}
          </p>
        </div>
      )}

      {/* ── Row 3: Voice profile ── */}
      {autobotEnabled && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Mic className="h-3.5 w-3.5" />
            Voice Profile
          </Label>
          {voiceLoading ? (
            <p className="text-xs text-muted-foreground">Loading voice info...</p>
          ) : voiceSample ? (
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">
                  {voiceSample.fileName}
                </p>
                <p className="text-xs text-muted-foreground">
                  Uploaded{" "}
                  {new Date(voiceSample.uploadedAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                asChild
              >
                <a href="/autobot/chat">Change Voice</a>
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-md border border-dashed px-3 py-2">
              <p className="text-xs text-muted-foreground">
                No voice sample uploaded
              </p>
              <Button
                variant="outline"
                size="sm"
                asChild
              >
                <a href="/autobot/chat">Upload Voice</a>
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Row 4: Recent actions log ── */}
      {autobotEnabled && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" />
              Recent Actions
            </Label>
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchProvenance}
              disabled={provenanceLoading}
              className="h-6 px-2 text-xs"
            >
              {provenanceLoading ? "Loading..." : "Refresh"}
            </Button>
          </div>
          {provenanceEntries.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              {provenanceLoading
                ? "Loading provenance entries..."
                : "No recent actions for this persona."}
            </p>
          ) : (
            <ScrollArea className="h-40 rounded-md border">
              <div className="p-2 space-y-1.5">
                {provenanceEntries.map((entry) => (
                  <ProvenanceEntryRow key={entry.id} entry={entry} />
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      )}

      {/* ── Row 5: Instruction channel ── */}
      {autobotEnabled && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5" />
            Instruction Channel
          </Label>
          {instructionHistory.length > 0 && (
            <ScrollArea className="h-32 rounded-md border">
              <div className="p-2 space-y-2">
                {instructionHistory.map((msg, i) => (
                  <div
                    key={i}
                    className={`text-xs rounded-md px-2 py-1.5 ${
                      msg.role === "user"
                        ? "bg-primary/10 text-foreground ml-4"
                        : "bg-muted text-muted-foreground mr-4"
                    }`}
                  >
                    <span className="font-medium">
                      {msg.role === "user" ? "You" : "Autobot"}:
                    </span>{" "}
                    {msg.content}
                  </div>
                ))}
                <div ref={instructionEndRef} />
              </div>
            </ScrollArea>
          )}
          <div className="flex gap-2">
            <Input
              placeholder="Send instruction to autobot..."
              value={instructionInput}
              onChange={(e) => setInstructionInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendInstruction();
                }
              }}
              disabled={instructionSending}
              maxLength={MAX_INSTRUCTION_LENGTH}
              className="h-9 text-sm"
            />
            <Button
              size="sm"
              onClick={handleSendInstruction}
              disabled={instructionSending || !instructionInput.trim()}
              className="h-9 px-3"
              aria-label="Send instruction"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProvenanceEntryRow({ entry }: { entry: ProvenanceEntry }) {
  const isError = entry.resultStatus === "error";
  const timestamp = new Date(entry.createdAt);
  const timeString = timestamp.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateString = timestamp.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });

  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono font-medium truncate">
            {entry.toolName}
          </span>
          <Badge
            variant={isError ? "destructive" : "secondary"}
            className="text-[10px] px-1 py-0 h-4"
          >
            {entry.resultStatus}
          </Badge>
        </div>
        {isError && entry.errorMessage && (
          <p className="text-destructive/80 truncate mt-0.5">
            {entry.errorMessage}
          </p>
        )}
      </div>
      <div className="text-muted-foreground whitespace-nowrap text-right">
        <div>{timeString}</div>
        <div>{dateString}</div>
      </div>
    </div>
  );
}

function ConnectionStatusIcon({ status }: { status: ConnectionStatus }) {
  switch (status) {
    case "connected":
      return <Wifi className="h-3.5 w-3.5 text-green-500" />;
    case "error":
      return <WifiOff className="h-3.5 w-3.5 text-destructive" />;
    case "checking":
      return (
        <Wifi className="h-3.5 w-3.5 text-muted-foreground animate-pulse" />
      );
    default:
      return <Wifi className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function connectionStatusColor(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return "text-green-500";
    case "error":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function connectionStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "error":
      return "Disconnected";
    case "checking":
      return "Checking...";
    default:
      return "Unknown";
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function isValidControlMode(value: unknown): value is AutobotControlMode {
  return (
    value === "direct-only" ||
    value === "approval-required" ||
    value === "delegated"
  );
}
