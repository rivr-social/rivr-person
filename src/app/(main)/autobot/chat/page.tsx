"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  Cpu,
  Loader2,
  MessageSquarePlus,
  Mic,
  MicOff,
  Play,
  Plus,
  Send,
  Settings2,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { VoiceRecorder } from "@/components/voice-recorder";
import { VoiceCloneUpload } from "@/components/voice-clone-upload";
import Link from "next/link";
import type {
  DigitalTwinAssetKind,
  DigitalTwinJobMode,
  DigitalTwinProfile,
  VoiceSample,
} from "@/lib/autobot-user-settings";

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognition;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHAT_API_ENDPOINT = "/api/autobot/chat";
const TTS_API_ENDPOINT = "/api/autobot/tts";
const GPU_API_ENDPOINT = "/api/autobot/gpu";
const SETTINGS_API_ENDPOINT = "/api/autobot/settings";
const DIGITAL_TWIN_API_ENDPOINT = "/api/autobot/digital-twin";
const DIGITAL_TWIN_UPLOAD_ENDPOINT = "/api/autobot/digital-twin/upload";
const DIGITAL_TWIN_JOBS_ENDPOINT = "/api/autobot/digital-twin/jobs";
const DIGITAL_TWIN_RUN_ENDPOINT = "/api/autobot/digital-twin/run";
const MAX_MESSAGE_LENGTH = 4000;
const MAX_DISPLAY_HISTORY = 40;
const THREADS_STORAGE_KEY = "rivr_autobot_threads";
const ACTIVE_THREAD_KEY = "rivr_autobot_active_thread";
const MODEL_STORAGE_KEY = "rivr_autobot_model";
const TTS_ENABLED_KEY = "rivr_autobot_tts_enabled";
const VOICE_MODE_KEY = "rivr_autobot_voice_mode";
const GPU_PROVIDER_KEY = "rivr_autobot_gpu_provider";
const GPU_PROVIDER_API_KEY = "rivr_autobot_gpu_provider_api_key";
const GPU_PROVIDER_ENDPOINT = "rivr_autobot_gpu_provider_endpoint";

const MCP_API_ENDPOINT = "/api/mcp";

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  "rivr.posts.create": "Create Post",
  "rivr.posts.create_live_invite": "Create Live Invite",
  "rivr.profile.update_basic": "Update Profile",
  "rivr.profile.get_my_profile": "Get My Profile",
  "rivr.groups.join": "Toggle Group Membership",
  "rivr.events.rsvp": "RSVP to Event",
  "rivr.events.append_transcript": "Append Transcript",
  "rivr.thanks.send": "Send Thanks",
  "rivr.personas.list": "List Personas",
  "rivr.instance.get_context": "Get Instance Context",
  "rivr.audit.recent": "Recent Audit Log",
};

const TOOL_PARAM_LABELS: Record<string, Record<string, string>> = {
  "rivr.posts.create": {
    title: "Title",
    content: "Content",
    postType: "Post type",
    groupId: "Group",
    localeId: "Locale",
    imageUrl: "Image URL",
    isGlobal: "Global",
  },
  "rivr.posts.create_live_invite": {
    title: "Title",
    content: "Content",
    groupId: "Group",
    localeId: "Locale",
    isGlobal: "Global",
    liveLocation: "Location",
  },
  "rivr.profile.update_basic": {
    name: "Name",
    bio: "Bio",
    skills: "Skills",
    location: "Location",
  },
  "rivr.groups.join": {
    groupId: "Group",
    type: "Type",
  },
  "rivr.events.rsvp": {
    eventId: "Event",
    status: "Status",
  },
  "rivr.thanks.send": {
    recipientId: "Recipient",
    count: "Amount",
    message: "Message",
    contextId: "Context",
  },
};

// ---------------------------------------------------------------------------
// Tool Preview Types & Parsing
// ---------------------------------------------------------------------------

type ToolPreviewSegment = {
  type: "tool-preview";
  toolName: string;
  params: Record<string, unknown>;
  rawJson: string;
  index: number;
};

type MarkdownSegment = {
  type: "markdown";
  content: string;
};

type MessageSegment = ToolPreviewSegment | MarkdownSegment;

type ToolPreviewState = "pending" | "executing" | "success" | "error" | "cancelled";

type ToolPreviewStatus = {
  state: ToolPreviewState;
  result?: unknown;
  error?: string;
};

const TOOL_PREVIEW_REGEX = /```tool-preview:([a-zA-Z0-9_.]+)\n([\s\S]*?)```/g;

function parseMessageSegments(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let lastIndex = 0;
  let toolIndex = 0;
  let match: RegExpExecArray | null;

  const regex = new RegExp(TOOL_PREVIEW_REGEX.source, "g");

  while ((match = regex.exec(content)) !== null) {
    // Add any markdown content before this tool-preview block
    if (match.index > lastIndex) {
      const mdContent = content.slice(lastIndex, match.index).trim();
      if (mdContent) {
        segments.push({ type: "markdown", content: mdContent });
      }
    }

    const toolName = match[1];
    const rawJson = match[2].trim();
    let params: Record<string, unknown> = {};

    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        params = parsed as Record<string, unknown>;
      }
    } catch {
      // Malformed JSON — show raw content as params with parse error
      params = { _parseError: true, _raw: rawJson } as Record<string, unknown>;
    }

    segments.push({
      type: "tool-preview",
      toolName,
      params,
      rawJson,
      index: toolIndex++,
    });

    lastIndex = match.index + match[0].length;
  }

  // Add any remaining markdown content after the last tool-preview block
  if (lastIndex < content.length) {
    const mdContent = content.slice(lastIndex).trim();
    if (mdContent) {
      segments.push({ type: "markdown", content: mdContent });
    }
  }

  // If no tool-preview blocks were found, return the whole content as markdown
  if (segments.length === 0) {
    segments.push({ type: "markdown", content });
  }

  return segments;
}

function formatParamValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function getToolDisplayName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] || toolName.split(".").pop() || toolName;
}

function getParamLabel(toolName: string, paramKey: string): string {
  return TOOL_PARAM_LABELS[toolName]?.[paramKey] || paramKey.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const MODEL_OPTIONS = [
  { value: "openai/gpt-4o-mini", label: "GPT-4o Mini", provider: "OpenAI" },
  { value: "openai/gpt-4o", label: "GPT-4o", provider: "OpenAI" },
  { value: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet", provider: "Anthropic" },
  { value: "local/ollama", label: "Ollama (Local)", provider: "Local" },
] as const;

const DEFAULT_MODEL = "openai/gpt-4o-mini";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  model?: string;
}

interface ChatResponse {
  reply: string;
  model?: string;
  sessionKey?: string;
  error?: string;
}

interface Thread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

type ProcessingState = "idle" | "sending" | "responding";
type GpuStatus = "stopped" | "running" | "provisioning" | "gpu_starting" | "no_gpu" | "unknown";
type VoiceMode = "browser" | "clone";
type GpuProvider = "vast" | "local" | "custom";

const DEFAULT_DIGITAL_TWIN: DigitalTwinProfile = {
  pipeline: "retalk",
  model: "edityourself",
  hostFraming: "medium",
  backgroundMode: "captured",
  notes: "",
  assets: [],
  jobs: [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createThread(title?: string): Thread {
  const now = new Date().toISOString();
  return {
    id: `thread_${generateId()}`,
    title: title || "New conversation",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

function generateThreadTitle(firstMessage: string): string {
  const cleaned = firstMessage.replace(/\n/g, " ").trim();
  if (cleaned.length <= 50) return cleaned;
  return `${cleaned.slice(0, 47)}...`;
}

function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(
      /`([^`]+)`/g,
      '<code class="px-1 py-0.5 rounded bg-muted text-xs font-mono">$1</code>',
    )
    .replace(
      /```(\w+)?\n([\s\S]*?)```/g,
      '<pre class="mt-2 mb-2 p-3 rounded-md bg-muted overflow-x-auto text-xs"><code>$2</code></pre>',
    )
    .replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>')
    .replace(/\n/g, "<br />");
}

function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/#{1,6}\s*/g, "")
    .replace(/```[^`]*```/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .trim();
}

function chunkTextForSpeech(text: string, maxChars = 220): string[] {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [normalized];
  const chunks: string[] = [];
  let current = "";

  for (const rawSentence of sentences) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    if (!current) {
      current = sentence;
      continue;
    }
    if ((current + " " + sentence).length <= maxChars) {
      current += " " + sentence;
    } else {
      chunks.push(current);
      current = sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------------------
// LocalStorage thread persistence
// ---------------------------------------------------------------------------

function loadThreads(): Thread[] {
  try {
    const raw = localStorage.getItem(THREADS_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Thread[];
  } catch {
    return [];
  }
}

function saveThreads(threads: Thread[]) {
  try {
    localStorage.setItem(THREADS_STORAGE_KEY, JSON.stringify(threads));
  } catch {
    // Storage full or unavailable
  }
}

function loadActiveThreadId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_THREAD_KEY);
  } catch {
    return null;
  }
}

function saveActiveThreadId(id: string) {
  try {
    localStorage.setItem(ACTIVE_THREAD_KEY, id);
  } catch {
    // Storage unavailable
  }
}

function loadStoredModel(): string {
  try {
    return localStorage.getItem(MODEL_STORAGE_KEY) || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

function saveStoredModel(model: string) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, model);
  } catch {
    // Storage unavailable
  }
}

function loadTtsEnabled(): boolean {
  try {
    return localStorage.getItem(TTS_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function saveTtsEnabled(enabled: boolean) {
  try {
    localStorage.setItem(TTS_ENABLED_KEY, String(enabled));
  } catch {
    // Storage unavailable
  }
}

function loadVoiceMode(): VoiceMode {
  try {
    const value = localStorage.getItem(VOICE_MODE_KEY);
    return value === "clone" ? "clone" : "browser";
  } catch {
    return "browser";
  }
}

function saveVoiceMode(mode: VoiceMode) {
  try {
    localStorage.setItem(VOICE_MODE_KEY, mode);
  } catch {
    // Storage unavailable
  }
}

function loadGpuProvider(): GpuProvider {
  try {
    const value = localStorage.getItem(GPU_PROVIDER_KEY);
    if (value === "vast" || value === "local" || value === "custom") return value;
    return "vast";
  } catch {
    return "vast";
  }
}

function saveGpuProvider(provider: GpuProvider) {
  try {
    localStorage.setItem(GPU_PROVIDER_KEY, provider);
  } catch {
    // Storage unavailable
  }
}

function loadStoredGpuProviderApiKey(): string {
  try {
    return localStorage.getItem(GPU_PROVIDER_API_KEY) || "";
  } catch {
    return "";
  }
}

function saveStoredGpuProviderApiKey(value: string) {
  try {
    localStorage.setItem(GPU_PROVIDER_API_KEY, value);
  } catch {
    // Storage unavailable
  }
}

function loadStoredGpuProviderEndpoint(): string {
  try {
    return localStorage.getItem(GPU_PROVIDER_ENDPOINT) || "";
  } catch {
    return "";
  }
}

function saveStoredGpuProviderEndpoint(value: string) {
  try {
    localStorage.setItem(GPU_PROVIDER_ENDPOINT, value);
  } catch {
    // Storage unavailable
  }
}

// ---------------------------------------------------------------------------
// Tool Preview Card
// ---------------------------------------------------------------------------

function ToolPreviewCard({
  segment,
  messageId,
  status,
  onConfirm,
  onCancel,
}: {
  segment: ToolPreviewSegment;
  messageId: string;
  status: ToolPreviewStatus;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const displayName = getToolDisplayName(segment.toolName);
  const hasParseError = Boolean(segment.params._parseError);
  const isPending = status.state === "pending";
  const isExecuting = status.state === "executing";
  const isSuccess = status.state === "success";
  const isError = status.state === "error";
  const isCancelled = status.state === "cancelled";

  return (
    <Card className={cn(
      "my-2 overflow-hidden border",
      isSuccess && "border-emerald-500/30",
      isError && "border-destructive/30",
      isCancelled && "border-muted-foreground/20 opacity-60",
    )}>
      {/* Header */}
      <div className={cn(
        "flex items-center gap-2 px-3 py-2 border-b",
        isSuccess ? "bg-emerald-500/5" : isError ? "bg-destructive/5" : "bg-primary/5",
      )}>
        <Play className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-semibold flex-1">{displayName}</span>
        <Badge variant="outline" className="text-[9px] font-mono py-0 h-4">
          {segment.toolName}
        </Badge>
      </div>

      <CardContent className="px-3 py-2 space-y-2">
        {/* Parameter summary */}
        {hasParseError ? (
          <div className="space-y-1">
            <div className="flex items-center gap-1 text-destructive">
              <AlertCircle className="h-3 w-3" />
              <span className="text-[10px] font-medium">Malformed JSON parameters</span>
            </div>
            <pre className="text-[10px] font-mono bg-muted rounded p-2 overflow-x-auto whitespace-pre-wrap">
              {segment.rawJson}
            </pre>
          </div>
        ) : (
          <div className="space-y-1">
            {Object.entries(segment.params).map(([key, value]) => {
              const formatted = formatParamValue(value);
              const label = getParamLabel(segment.toolName, key);
              const isLongValue = formatted.length > 80;

              return (
                <div key={key} className={isLongValue ? "space-y-0.5" : "flex items-start gap-2"}>
                  <span className="text-[10px] font-medium text-muted-foreground shrink-0 min-w-[80px]">
                    {label}
                  </span>
                  <span className={cn(
                    "text-[11px]",
                    isLongValue && "block bg-muted/50 rounded px-2 py-1 whitespace-pre-wrap",
                  )}>
                    {formatted}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Action buttons */}
        {isPending && !hasParseError && (
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={onConfirm}
            >
              <Check className="h-3 w-3" />
              Confirm
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs gap-1 text-muted-foreground"
              onClick={onCancel}
            >
              <X className="h-3 w-3" />
              Cancel
            </Button>
          </div>
        )}

        {/* Executing state */}
        {isExecuting && (
          <div className="flex items-center gap-2 pt-1 text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-[11px]">Executing...</span>
          </div>
        )}

        {/* Success result */}
        {isSuccess && (
          <div className="pt-1 space-y-1">
            <div className="flex items-center gap-1 text-emerald-600">
              <Check className="h-3 w-3" />
              <span className="text-[10px] font-medium">Action completed</span>
            </div>
            {status.result !== undefined && (
              <pre className="text-[10px] font-mono bg-muted rounded p-2 overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap">
                {typeof status.result === "string"
                  ? status.result
                  : JSON.stringify(status.result, null, 2)}
              </pre>
            )}
          </div>
        )}

        {/* Error result */}
        {isError && (
          <div className="pt-1 space-y-1">
            <div className="flex items-center gap-1 text-destructive">
              <AlertCircle className="h-3 w-3" />
              <span className="text-[10px] font-medium">Action failed</span>
            </div>
            {status.error && (
              <p className="text-[10px] text-destructive/80 bg-destructive/5 rounded px-2 py-1">
                {status.error}
              </p>
            )}
          </div>
        )}

        {/* Cancelled */}
        {isCancelled && (
          <div className="flex items-center gap-1 pt-1 text-muted-foreground">
            <X className="h-3 w-3" />
            <span className="text-[10px]">Cancelled</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Message Bubble
// ---------------------------------------------------------------------------

function MessageBubble({
  message,
  toolPreviewStatuses,
  onToolConfirm,
  onToolCancel,
}: {
  message: ChatMessage;
  toolPreviewStatuses: Record<string, ToolPreviewStatus>;
  onToolConfirm: (messageId: string, toolIndex: number, toolName: string, params: Record<string, unknown>) => void;
  onToolCancel: (messageId: string, toolIndex: number) => void;
}) {
  const isUser = message.role === "user";
  const timestamp = new Date(message.timestamp);

  // Parse message into segments for assistant messages
  const segments: MessageSegment[] = isUser
    ? [{ type: "markdown", content: message.content }]
    : parseMessageSegments(message.content);

  return (
    <div
      className={cn(
        "flex gap-3 max-w-[85%]",
        isUser ? "ml-auto flex-row-reverse" : "mr-auto",
      )}
    >
      {!isUser && (
        <div className="shrink-0 mt-1">
          <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center">
            <Bot className="h-4 w-4 text-primary" />
          </div>
        </div>
      )}

      <div className="space-y-1.5 min-w-0 flex-1">
        {/* Model badge for assistant messages */}
        {!isUser && message.model && (
          <Badge variant="outline" className="text-[9px] font-mono py-0 h-4">
            {message.model}
          </Badge>
        )}

        {/* Message segments */}
        {segments.map((segment, idx) => {
          if (segment.type === "markdown") {
            return (
              <div
                key={`md-${idx}`}
                className={cn(
                  "rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                  isUser
                    ? "bg-primary text-primary-foreground rounded-br-md"
                    : "bg-muted rounded-bl-md",
                )}
              >
                <div
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(segment.content),
                  }}
                />
              </div>
            );
          }

          // Tool preview segment
          const statusKey = `${message.id}:${segment.index}`;
          const status = toolPreviewStatuses[statusKey] || { state: "pending" as ToolPreviewState };

          return (
            <ToolPreviewCard
              key={`tool-${idx}`}
              segment={segment}
              messageId={message.id}
              status={status}
              onConfirm={() => onToolConfirm(message.id, segment.index, segment.toolName, segment.params)}
              onCancel={() => onToolCancel(message.id, segment.index)}
            />
          );
        })}

        {/* Timestamp */}
        <p
          className={cn(
            "text-[10px] text-muted-foreground/60 px-1",
            isUser ? "text-right" : "text-left",
          )}
        >
          {timestamp.toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typing Indicator
// ---------------------------------------------------------------------------

function TypingIndicator({ state }: { state: ProcessingState }) {
  if (state === "idle") return null;

  const label = state === "sending" ? "Sending..." : "Thinking...";

  return (
    <div className="flex items-center gap-3 mr-auto max-w-[85%]">
      <div className="shrink-0">
        <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center">
          <Bot className="h-4 w-4 text-primary" />
        </div>
      </div>
      <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-4 py-2.5">
        <div className="flex gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:300ms]" />
        </div>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Thread Sidebar Item
// ---------------------------------------------------------------------------

function ThreadItem({
  thread,
  isActive,
  onSelect,
  onDelete,
}: {
  thread: Thread;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const messageCount = thread.messages.length;
  const updatedAt = new Date(thread.updatedAt);

  return (
    <div
      className={cn(
        "group flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors",
        isActive ? "bg-primary/10 border border-primary/20" : "hover:bg-muted/50",
      )}
      onClick={onSelect}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{thread.title}</p>
        <p className="text-[10px] text-muted-foreground">
          {messageCount} messages &middot;{" "}
          {updatedAt.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 opacity-0 group-hover:opacity-100 shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Trash2 className="h-3 w-3 text-muted-foreground" />
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// GPU Status Indicator
// ---------------------------------------------------------------------------

function GpuStatusBadge({ status }: { status: GpuStatus }) {
  const colorMap: Record<GpuStatus, string> = {
    running: "bg-emerald-500",
    provisioning: "bg-yellow-500 animate-pulse",
    gpu_starting: "bg-yellow-500 animate-pulse",
    stopped: "bg-zinc-500",
    no_gpu: "bg-zinc-500",
    unknown: "bg-zinc-500",
  };

  const labelMap: Record<GpuStatus, string> = {
    running: "Voice GPU active",
    provisioning: "GPU provisioning...",
    gpu_starting: "GPU waking up...",
    stopped: "Voice GPU off",
    no_gpu: "No GPU configured",
    unknown: "GPU status unknown",
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", colorMap[status])} />
      <span className="text-[10px] text-muted-foreground">{labelMap[status]}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat Page
// ---------------------------------------------------------------------------

export default function AutobotChatPage() {
  const searchParams = useSearchParams();
  // Thread state
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [showThreadList, setShowThreadList] = useState(false);

  // Chat state
  const [inputValue, setInputValue] = useState("");
  const [processingState, setProcessingState] = useState<ProcessingState>("idle");

  // Settings state
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [voiceCloneConfigured, setVoiceCloneConfigured] = useState(false);
  const [voiceSample, setVoiceSample] = useState<VoiceSample | null>(null);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("browser");
  const [gpuProvider, setGpuProvider] = useState<GpuProvider>("vast");
  const [gpuProviderApiKey, setGpuProviderApiKey] = useState("");
  const [gpuProviderEndpoint, setGpuProviderEndpoint] = useState("");
  const [digitalTwin, setDigitalTwin] = useState<DigitalTwinProfile>(DEFAULT_DIGITAL_TWIN);
  const [digitalTwinUploadKind, setDigitalTwinUploadKind] = useState<DigitalTwinAssetKind>("host-video");
  const [digitalTwinUploading, setDigitalTwinUploading] = useState(false);
  const [digitalTwinJobMode, setDigitalTwinJobMode] = useState<DigitalTwinJobMode>("host-update");
  const [digitalTwinJobText, setDigitalTwinJobText] = useState("");
  const [digitalTwinQueueing, setDigitalTwinQueueing] = useState(false);
  const [digitalTwinRunningJobId, setDigitalTwinRunningJobId] = useState<string | null>(null);

  // Tool preview state — keyed by "messageId:toolIndex"
  const [toolPreviewStatuses, setToolPreviewStatuses] = useState<Record<string, ToolPreviewStatus>>({});

  // GPU/Voice state
  const [gpuStatus, setGpuStatus] = useState<GpuStatus>("unknown");
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  // Refs
  const scrollEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);
  const gpuHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---------------------------------------------------------------------------
  // Derived state
  // ---------------------------------------------------------------------------

  const activeThread = threads.find((t) => t.id === activeThreadId) || null;
  const messages = activeThread?.messages || [];

  // ---------------------------------------------------------------------------
  // Load persisted state on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const storedThreads = loadThreads();
    const storedActiveId = loadActiveThreadId();
    const storedModel = loadStoredModel();
    const storedTts = loadTtsEnabled();
    const storedVoiceMode = loadVoiceMode();
    const storedGpuProvider = loadGpuProvider();
    const storedGpuProviderApiKey = loadStoredGpuProviderApiKey();
    const storedGpuProviderEndpoint = loadStoredGpuProviderEndpoint();

    setSelectedModel(storedModel);
    setTtsEnabled(storedTts);
    setVoiceMode(storedVoiceMode);
    setGpuProvider(storedGpuProvider);
    setGpuProviderApiKey(storedGpuProviderApiKey);
    setGpuProviderEndpoint(storedGpuProviderEndpoint);

    if (storedThreads.length > 0) {
      setThreads(storedThreads);
      if (storedActiveId && storedThreads.some((t) => t.id === storedActiveId)) {
        setActiveThreadId(storedActiveId);
      } else {
        setActiveThreadId(storedThreads[0].id);
      }
    } else {
      const firstThread = createThread();
      setThreads([firstThread]);
      setActiveThreadId(firstThread.id);
    }

    // Check voice clone sample
    try {
      const storedVoiceSample = localStorage.getItem("rivr_voice_clone_sample");
      if (storedVoiceSample) {
        setVoiceSample(JSON.parse(storedVoiceSample) as VoiceSample);
        setVoiceCloneConfigured(true);
      }
    } catch {
      // localStorage unavailable
    }

    // Initialize GPU status
    fetchGpuStatus();

    return () => {
      stopGpuHeartbeat();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadServerSettings() {
      try {
        const res = await fetch(SETTINGS_API_ENDPOINT, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const settings = data?.settings;
        if (cancelled || !settings) return;

        if (typeof settings.selectedModel === "string" && settings.selectedModel) {
          setSelectedModel(settings.selectedModel);
          saveStoredModel(settings.selectedModel);
        }
        if (typeof settings.ttsEnabled === "boolean") {
          setTtsEnabled(settings.ttsEnabled);
          saveTtsEnabled(settings.ttsEnabled);
        }
        if (settings.voiceMode === "browser" || settings.voiceMode === "clone") {
          setVoiceMode(settings.voiceMode);
          saveVoiceMode(settings.voiceMode);
        }
        if (
          settings.gpuProvider === "vast" ||
          settings.gpuProvider === "local" ||
          settings.gpuProvider === "custom"
        ) {
          setGpuProvider(settings.gpuProvider);
          saveGpuProvider(settings.gpuProvider);
        }
        if (typeof settings.gpuProviderApiKey === "string") {
          setGpuProviderApiKey(settings.gpuProviderApiKey);
          saveStoredGpuProviderApiKey(settings.gpuProviderApiKey);
        }
        if (typeof settings.gpuProviderEndpoint === "string") {
          setGpuProviderEndpoint(settings.gpuProviderEndpoint);
          saveStoredGpuProviderEndpoint(settings.gpuProviderEndpoint);
        }
        if (settings.voiceSample && typeof settings.voiceSample === "object") {
          const persistedVoiceSample = settings.voiceSample as VoiceSample;
          setVoiceSample(persistedVoiceSample);
          setVoiceCloneConfigured(true);
          localStorage.setItem(
            "rivr_voice_clone_sample",
            JSON.stringify(persistedVoiceSample),
          );
        } else if (settings.voiceSample === null) {
          setVoiceSample(null);
          setVoiceCloneConfigured(false);
          localStorage.removeItem("rivr_voice_clone_sample");
        }
        if (settings.digitalTwin && typeof settings.digitalTwin === "object") {
          setDigitalTwin(settings.digitalTwin as DigitalTwinProfile);
        }
      } catch {
        // Leave local defaults in place if server settings are unavailable.
      } finally {
        // no-op; local settings already cover first paint if the server is slow
      }
    }

    loadServerSettings();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (searchParams.get("settings") === "voice") {
      setShowSettings(true);
    }
  }, [searchParams]);

  // Persist threads whenever they change
  useEffect(() => {
    if (threads.length > 0) {
      saveThreads(threads);
    }
  }, [threads]);

  // Persist active thread
  useEffect(() => {
    if (activeThreadId) {
      saveActiveThreadId(activeThreadId);
    }
  }, [activeThreadId]);

  // ---------------------------------------------------------------------------
  // Auto-scroll
  // ---------------------------------------------------------------------------

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, processingState, scrollToBottom]);

  // ---------------------------------------------------------------------------
  // GPU lifecycle
  // ---------------------------------------------------------------------------

  const fetchGpuStatus = useCallback(async () => {
    try {
      const res = await fetch(GPU_API_ENDPOINT);
      if (res.ok) {
        const data = await res.json();
        setGpuStatus(data.status || "unknown");
      }
    } catch {
      setGpuStatus("unknown");
    }
  }, []);

  const startGpu = useCallback(async () => {
    try {
      const res = await fetch(GPU_API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      if (res.ok) {
        const data = await res.json();
        setGpuStatus(data.status || "unknown");
      }
    } catch {
      setGpuStatus("unknown");
    }
  }, []);

  const startGpuHeartbeat = useCallback(() => {
    stopGpuHeartbeat();
    gpuHeartbeatRef.current = setInterval(() => {
      fetch(GPU_API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "heartbeat" }),
      }).catch(() => {});
    }, 60000);
  }, []);

  function stopGpuHeartbeat() {
    if (gpuHeartbeatRef.current) {
      clearInterval(gpuHeartbeatRef.current);
      gpuHeartbeatRef.current = null;
    }
  }

  // Start GPU and heartbeat when TTS is enabled
  useEffect(() => {
    if (ttsEnabled) {
      startGpu();
      startGpuHeartbeat();
    } else {
      stopGpuHeartbeat();
    }
    return () => stopGpuHeartbeat();
  }, [ttsEnabled, startGpu, startGpuHeartbeat]);

  // ---------------------------------------------------------------------------
  // TTS (Chatterbox with browser fallback)
  // ---------------------------------------------------------------------------

  const cleanupCurrentAudio = useCallback(() => {
    if (currentAudioRef.current) {
      try {
        currentAudioRef.current.pause();
      } catch {
        // ignore
      }
      currentAudioRef.current.onended = null;
      currentAudioRef.current.onerror = null;
      currentAudioRef.current.src = "";
      currentAudioRef.current.load();
      currentAudioRef.current = null;
    }
    if (currentAudioUrlRef.current) {
      URL.revokeObjectURL(currentAudioUrlRef.current);
      currentAudioUrlRef.current = null;
    }
  }, []);

  const playRemoteAudio = useCallback(
    async (audioBlob: Blob): Promise<void> => {
      cleanupCurrentAudio();
      const url = URL.createObjectURL(audioBlob);
      currentAudioUrlRef.current = url;
      const audio = new Audio(url);
      currentAudioRef.current = audio;

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => {
          cleanupCurrentAudio();
          resolve();
        };
        audio.onerror = () => {
          cleanupCurrentAudio();
          reject(new Error("audio playback failed"));
        };
        audio.play().catch(reject);
      });
    },
    [cleanupCurrentAudio],
  );

  const speakBrowserFallback = useCallback((text: string) => {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(
      stripMarkdownForSpeech(text),
    );
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    const voices = synth.getVoices();
    const preferred =
      voices.find(
        (v) =>
          v.name.includes("Daniel") ||
          v.name.includes("Alex") ||
          v.name.includes("Aaron") ||
          (v.lang.startsWith("en") &&
            v.name.toLowerCase().includes("male")),
      ) || voices.find((v) => v.lang.startsWith("en-US"));
    if (preferred) utterance.voice = preferred;
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    synth.speak(utterance);
  }, []);

  const speakText = useCallback(
    async (text: string) => {
      if (!ttsEnabled) return;
      setIsSpeaking(true);

      try {
        if (voiceMode === "browser") {
          speakBrowserFallback(text);
          return;
        }

        const chunks = chunkTextForSpeech(stripMarkdownForSpeech(text));
        let remoteSucceeded = false;

        for (const chunk of chunks) {
          const res = await fetch(TTS_API_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: chunk }),
          });

          if (!res.ok) break;

          const contentType = res.headers.get("content-type") || "";
          if (!contentType.startsWith("audio/")) {
            const data = await res.json();
            if (data.fallback) break;
            break;
          }

          const audioBlob = await res.blob();
          await playRemoteAudio(audioBlob);
          remoteSucceeded = true;
        }

        if (!remoteSucceeded) {
          speakBrowserFallback(text);
        } else {
          setIsSpeaking(false);
        }
      } catch {
        speakBrowserFallback(text);
      }
    },
    [ttsEnabled, voiceMode, playRemoteAudio, speakBrowserFallback],
  );

  // ---------------------------------------------------------------------------
  // Speech recognition (Web Speech API)
  // ---------------------------------------------------------------------------

  const stopListening = useCallback(() => {
    setIsListening(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore
    }
  }, []);

  const startListening = useCallback(() => {
    const SpeechRecognitionCtor =
      (window as unknown as { SpeechRecognition?: BrowserSpeechRecognitionCtor })
        .SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: BrowserSpeechRecognitionCtor })
        .webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) return;

    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
    }

    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;

    recognition.onresult = (event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript?.trim()) {
        setIsListening(false);
        // We call sendMessage indirectly by setting inputValue and triggering send
        setInputValue(transcript.trim());
        // Auto-send after a brief frame
        requestAnimationFrame(() => {
          document
            .getElementById("autobot-send-btn")
            ?.click();
        });
      }
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    try {
      recognition.start();
      setIsListening(true);
    } catch {
      setIsListening(false);
    }
  }, []);

  const toggleListening = useCallback(() => {
    if (isSpeaking) {
      window.speechSynthesis?.cancel();
      cleanupCurrentAudio();
      setIsSpeaking(false);
    }
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  }, [isListening, isSpeaking, startListening, stopListening, cleanupCurrentAudio]);

  // ---------------------------------------------------------------------------
  // Thread management
  // ---------------------------------------------------------------------------

  const createNewThread = useCallback(() => {
    const newThread = createThread();
    setThreads((prev) => [newThread, ...prev]);
    setActiveThreadId(newThread.id);
    setShowThreadList(false);
    inputRef.current?.focus();
  }, []);

  const switchThread = useCallback((threadId: string) => {
    setActiveThreadId(threadId);
    setShowThreadList(false);
  }, []);

  const deleteThread = useCallback(
    (threadId: string) => {
      setThreads((prev) => {
        const remaining = prev.filter((t) => t.id !== threadId);
        if (remaining.length === 0) {
          const newThread = createThread();
          setActiveThreadId(newThread.id);
          return [newThread];
        }
        if (threadId === activeThreadId) {
          setActiveThreadId(remaining[0].id);
        }
        return remaining;
      });
    },
    [activeThreadId],
  );

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || processingState !== "idle" || !activeThreadId) return;

      const userMessage: ChatMessage = {
        id: `msg_${generateId()}`,
        role: "user",
        content: trimmed,
        timestamp: new Date().toISOString(),
      };

      // Update thread with user message
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== activeThreadId) return t;
          const isFirstMessage = t.messages.length === 0;
          return {
            ...t,
            title: isFirstMessage ? generateThreadTitle(trimmed) : t.title,
            updatedAt: new Date().toISOString(),
            messages: [...t.messages, userMessage],
          };
        }),
      );

      setInputValue("");
      setProcessingState("sending");

      try {
        // Build history from thread messages
        const threadMessages =
          threads.find((t) => t.id === activeThreadId)?.messages || [];
        const history = threadMessages
          .slice(-MAX_DISPLAY_HISTORY)
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

        const response = await fetch(CHAT_API_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            history,
            model: selectedModel,
            threadId: activeThreadId,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error || `Chat request failed (${response.status})`,
          );
        }

        const data = (await response.json()) as ChatResponse;
        const reply = data.reply || "...";

        const assistantMessage: ChatMessage = {
          id: `msg_${generateId()}`,
          role: "assistant",
          content: reply,
          timestamp: new Date().toISOString(),
          model: data.model || selectedModel,
        };

        setThreads((prev) =>
          prev.map((t) => {
            if (t.id !== activeThreadId) return t;
            return {
              ...t,
              updatedAt: new Date().toISOString(),
              messages: [...t.messages, assistantMessage],
            };
          }),
        );

        speakText(reply);
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "Something went wrong. Please try again.";

        const errorMsg: ChatMessage = {
          id: `msg_${generateId()}`,
          role: "assistant",
          content: `An error occurred: ${errorMessage}`,
          timestamp: new Date().toISOString(),
        };

        setThreads((prev) =>
          prev.map((t) => {
            if (t.id !== activeThreadId) return t;
            return {
              ...t,
              updatedAt: new Date().toISOString(),
              messages: [...t.messages, errorMsg],
            };
          }),
        );
      } finally {
        setProcessingState("idle");
      }
    },
    [activeThreadId, threads, processingState, selectedModel, speakText],
  );

  // Handle keyboard input
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(inputValue);
      }
    },
    [inputValue, sendMessage],
  );

  // Voice transcription callback (from VoiceRecorder component)
  const handleTranscription = useCallback(
    (text: string) => {
      sendMessage(text);
    },
    [sendMessage],
  );

  const handleTranscriptionError = useCallback(
    (error: string) => {
      if (!activeThreadId) return;
      const errorMsg: ChatMessage = {
        id: `msg_${generateId()}`,
        role: "assistant",
        content: `Voice transcription error: ${error}`,
        timestamp: new Date().toISOString(),
      };
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== activeThreadId) return t;
          return {
            ...t,
            messages: [...t.messages, errorMsg],
          };
        }),
      );
    },
    [activeThreadId],
  );

  // ---------------------------------------------------------------------------
  // Settings handlers
  // ---------------------------------------------------------------------------

  const handleModelChange = useCallback((value: string) => {
    setSelectedModel(value);
    saveStoredModel(value);
    fetch(SETTINGS_API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedModel: value }),
    }).catch(() => {});
  }, []);

  const handleTtsToggle = useCallback(
    (checked: boolean) => {
      if (!checked) {
        window.speechSynthesis?.cancel();
        cleanupCurrentAudio();
        setIsSpeaking(false);
      }
      setTtsEnabled(checked);
      saveTtsEnabled(checked);
      fetch(SETTINGS_API_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttsEnabled: checked }),
      }).catch(() => {});
    },
    [cleanupCurrentAudio],
  );

  const handleVoiceModeChange = useCallback((value: VoiceMode) => {
    setVoiceMode(value);
    saveVoiceMode(value);
    fetch(SETTINGS_API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voiceMode: value, ttsEnabled: value === "clone" ? true : ttsEnabled }),
    }).catch(() => {});
    if (value === "clone") {
      setTtsEnabled(true);
      saveTtsEnabled(true);
    }
  }, [ttsEnabled]);

  const handleGpuProviderChange = useCallback((value: GpuProvider) => {
    setGpuProvider(value);
    saveGpuProvider(value);
    fetch(SETTINGS_API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gpuProvider: value }),
    }).catch(() => {});
  }, []);

  const handleDigitalTwinPatch = useCallback((patch: Partial<DigitalTwinProfile>) => {
    setDigitalTwin((prev) => ({ ...prev, ...patch }));
    fetch(DIGITAL_TWIN_API_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => {});
  }, []);

  const handleDigitalTwinUpload = useCallback(
    async (file: File | null) => {
      if (!file) return;
      setDigitalTwinUploading(true);
      try {
        const formData = new FormData();
        formData.append("kind", digitalTwinUploadKind);
        formData.append("file", file);
        const response = await fetch(DIGITAL_TWIN_UPLOAD_ENDPOINT, {
          method: "POST",
          body: formData,
        });
        const data = await response.json();
        if (response.ok && data?.digitalTwin) {
          setDigitalTwin(data.digitalTwin as DigitalTwinProfile);
        }
      } finally {
        setDigitalTwinUploading(false);
      }
    },
    [digitalTwinUploadKind],
  );

  const handleQueueDigitalTwinJob = useCallback(async () => {
    const sourceText = digitalTwinJobText.trim();
    if (!sourceText) return;
    setDigitalTwinQueueing(true);
    try {
      const response = await fetch(DIGITAL_TWIN_JOBS_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: digitalTwinJobMode,
          sourceType: "script",
          sourceText,
        }),
      });
      const data = await response.json();
      if (response.ok && Array.isArray(data?.jobs)) {
        setDigitalTwin((prev) => ({ ...prev, jobs: data.jobs }));
        setDigitalTwinJobText("");
      }
    } finally {
      setDigitalTwinQueueing(false);
    }
  }, [digitalTwinJobMode, digitalTwinJobText]);

  const handleRunDigitalTwinJob = useCallback(async (jobId: string, sourceText: string, mode: DigitalTwinJobMode) => {
    setDigitalTwinRunningJobId(jobId);
    try {
      await fetch(DIGITAL_TWIN_RUN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, sourceText, mode }),
      });
    } finally {
      setDigitalTwinRunningJobId(null);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Tool preview confirm / cancel handlers
  // ---------------------------------------------------------------------------

  const handleToolConfirm = useCallback(
    async (messageId: string, toolIndex: number, toolName: string, params: Record<string, unknown>) => {
      const statusKey = `${messageId}:${toolIndex}`;

      // Skip if already past pending
      const current = toolPreviewStatuses[statusKey];
      if (current && current.state !== "pending") return;

      setToolPreviewStatuses((prev) => ({
        ...prev,
        [statusKey]: { state: "executing" },
      }));

      try {
        const response = await fetch(MCP_API_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: statusKey,
            method: "tools/call",
            params: {
              name: toolName,
              arguments: params,
            },
          }),
        });

        const data = await response.json();

        if (data.error) {
          setToolPreviewStatuses((prev) => ({
            ...prev,
            [statusKey]: {
              state: "error",
              error: data.error.message || "Tool execution failed",
            },
          }));
          return;
        }

        // Extract structured content from MCP response
        const resultContent = data.result?.structuredContent ?? data.result?.content ?? data.result;

        setToolPreviewStatuses((prev) => ({
          ...prev,
          [statusKey]: {
            state: "success",
            result: resultContent,
          },
        }));
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Network error executing tool";
        setToolPreviewStatuses((prev) => ({
          ...prev,
          [statusKey]: {
            state: "error",
            error: errorMessage,
          },
        }));
      }
    },
    [toolPreviewStatuses],
  );

  const handleToolCancel = useCallback(
    (messageId: string, toolIndex: number) => {
      const statusKey = `${messageId}:${toolIndex}`;
      setToolPreviewStatuses((prev) => ({
        ...prev,
        [statusKey]: { state: "cancelled" },
      }));
    },
    [],
  );

  const isInputDisabled = processingState !== "idle";
  const canSend = inputValue.trim().length > 0 && !isInputDisabled;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] max-w-3xl mx-auto">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/autobot">
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h1 className="text-sm font-semibold leading-none">
                Autobot Chat
              </h1>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                {processingState !== "idle"
                  ? "Processing..."
                  : `OpenClaw - ${MODEL_OPTIONS.find((m) => m.value === selectedModel)?.label || selectedModel}`}
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* Thread selector */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowThreadList(!showThreadList)}
            aria-label="Thread list"
          >
            <MessageSquarePlus
              className={cn(
                "h-4 w-4",
                showThreadList ? "text-primary" : "text-muted-foreground",
              )}
            />
          </Button>

          {/* New thread */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={createNewThread}
            aria-label="New thread"
          >
            <Plus className="h-4 w-4 text-muted-foreground" />
          </Button>

          {/* Mic toggle (Web Speech API) */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={toggleListening}
            aria-label={isListening ? "Stop listening" : "Start listening"}
          >
            {isListening ? (
              <MicOff className="h-4 w-4 text-destructive" />
            ) : (
              <Mic className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>

          {/* TTS toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => handleTtsToggle(!ttsEnabled)}
            aria-label={ttsEnabled ? "Disable voice output" : "Enable voice output"}
          >
            {ttsEnabled ? (
              <Volume2 className="h-4 w-4" />
            ) : (
              <VolumeX className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>

          {/* Settings */}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setShowSettings(!showSettings)}
            aria-label="Chat settings"
          >
            <Settings2
              className={cn(
                "h-4 w-4",
                showSettings ? "text-primary" : "text-muted-foreground",
              )}
            />
          </Button>
        </div>
      </div>

      {/* Thread list panel */}
      {showThreadList && (
        <div className="shrink-0 border-b bg-muted/20 max-h-64 overflow-y-auto">
          <div className="p-3 space-y-1">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-muted-foreground">
                Conversations ({threads.length})
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs gap-1"
                onClick={createNewThread}
              >
                <Plus className="h-3 w-3" />
                New
              </Button>
            </div>
            {threads.map((thread) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                isActive={thread.id === activeThreadId}
                onSelect={() => switchThread(thread.id)}
                onDelete={() => deleteThread(thread.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Settings panel */}
      {showSettings && (
        <div className="shrink-0 px-4 py-3 border-b space-y-3 bg-muted/30">
          {/* Model selector */}
          <div className="space-y-1.5">
            <Label className="text-xs">Model</Label>
            <Select value={selectedModel} onValueChange={handleModelChange}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <div className="flex items-center gap-2">
                      <span>{option.label}</span>
                      <Badge variant="outline" className="text-[9px] py-0 h-4">
                        {option.provider}
                      </Badge>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-[10px] text-muted-foreground">
            This chat uses the colocated OpenClaw runtime on Camalot. Each saved Rivr thread is
            bound to a stable OpenClaw session key so follow-up messages keep their full context.
          </p>

          <Separator />

          <div className="space-y-1.5">
            <Label className="text-xs">Voice response</Label>
            <Select value={voiceMode} onValueChange={(value) => handleVoiceModeChange(value as VoiceMode)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="browser">Default local voice response</SelectItem>
                <SelectItem value="clone">Uploaded voice + GPU provider</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">
              Use local/browser speech for immediate voice playback, or switch to your uploaded voice and a GPU-backed provider.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <Label htmlFor="tts-toggle" className="text-xs cursor-pointer">
              Enable voice response
            </Label>
            <Switch
              id="tts-toggle"
              checked={ttsEnabled}
              onCheckedChange={handleTtsToggle}
            />
          </div>

          {ttsEnabled && (
            <p className="text-[10px] text-muted-foreground">
              {voiceMode === "browser"
                ? "Voice replies will use local browser TTS."
                : "Voice replies will try your cloned voice first, then fall back to local browser TTS if no GPU runtime is available."}
            </p>
          )}

          {voiceMode === "clone" && <GpuStatusBadge status={gpuStatus} />}

          <Separator />

          {voiceMode === "clone" && (
            <>
              <div className="space-y-1.5">
                <Label className="text-xs">GPU provider</Label>
                <Select value={gpuProvider} onValueChange={(value) => handleGpuProviderChange(value as GpuProvider)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vast">Vast.ai</SelectItem>
                    <SelectItem value="local">Local PM Core endpoint</SelectItem>
                    <SelectItem value="custom">Custom remote endpoint</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {(gpuProvider === "vast" || gpuProvider === "custom") && (
                <div className="space-y-1.5">
                  <Label htmlFor="gpu-provider-api-key" className="text-xs">
                    {gpuProvider === "vast" ? "Vast API key" : "Provider API key"}
                  </Label>
                  <Input
                    id="gpu-provider-api-key"
                    type="password"
                    value={gpuProviderApiKey}
                    onChange={(event) => {
                      setGpuProviderApiKey(event.target.value);
                      saveStoredGpuProviderApiKey(event.target.value);
                    }}
                    onBlur={() => {
                      fetch(SETTINGS_API_ENDPOINT, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ gpuProviderApiKey }),
                      }).catch(() => {});
                    }}
                    placeholder={gpuProvider === "vast" ? "Paste your Vast API key" : "Paste your provider API key"}
                    className="h-8 text-xs"
                  />
                </div>
              )}

              {(gpuProvider === "local" || gpuProvider === "custom") && (
                <div className="space-y-1.5">
                  <Label htmlFor="gpu-provider-endpoint" className="text-xs">
                    {gpuProvider === "local" ? "Local endpoint" : "Custom endpoint"}
                  </Label>
                  <Input
                    id="gpu-provider-endpoint"
                    type="url"
                    value={gpuProviderEndpoint}
                    onChange={(event) => {
                      setGpuProviderEndpoint(event.target.value);
                      saveStoredGpuProviderEndpoint(event.target.value);
                    }}
                    onBlur={() => {
                      fetch(SETTINGS_API_ENDPOINT, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ gpuProviderEndpoint }),
                      }).catch(() => {});
                    }}
                    placeholder={gpuProvider === "local" ? "http://pm-core.local:8001/v1" : "https://voice.example.com/v1"}
                    className="h-8 text-xs"
                  />
                </div>
              )}

              <p className="text-[10px] text-muted-foreground">
                Provider preferences are saved to your Rivr profile settings and mirrored locally for fast startup. Your Vast.ai API key is used for GPU provisioning and discovery; the Chatterbox TTS auth token is managed by the deployment.
              </p>

              <VoiceCloneUpload
                initialSample={voiceSample}
                onVoiceSampleChange={(sample) => {
                  setVoiceSample(sample);
                  setVoiceCloneConfigured(sample !== null);
                }}
              />
              {voiceCloneConfigured && (
                <p className="text-[10px] text-muted-foreground">
                  Voice sample uploaded. Your cloned voice can be applied to the active GPU-backed runtime.
                </p>
              )}
            </>
          )}

          <Separator />

          <div className="space-y-3">
            <div>
              <Label className="text-xs">Digital twin pipeline</Label>
              <p className="text-[10px] text-muted-foreground">
                Local-first host video profile for a self-hosted Cameron clone on Vast. This stores your preferred pipeline, reference assets, and queued generation jobs.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Pipeline</Label>
                <Select
                  value={digitalTwin.pipeline}
                  onValueChange={(value) => handleDigitalTwinPatch({ pipeline: value as DigitalTwinProfile["pipeline"] })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="retalk">Retalk real footage</SelectItem>
                    <SelectItem value="portrait">Portrait animation</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Model</Label>
                <Select
                  value={digitalTwin.model}
                  onValueChange={(value) => handleDigitalTwinPatch({ model: value as DigitalTwinProfile["model"] })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="edityourself">EditYourself</SelectItem>
                    <SelectItem value="liveportrait">LivePortrait</SelectItem>
                    <SelectItem value="skyreels">SkyReels</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Host framing</Label>
                <Select
                  value={digitalTwin.hostFraming}
                  onValueChange={(value) => handleDigitalTwinPatch({ hostFraming: value as DigitalTwinProfile["hostFraming"] })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tight-medium">Tight medium</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="wide">Wide</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Background mode</Label>
                <Select
                  value={digitalTwin.backgroundMode}
                  onValueChange={(value) => handleDigitalTwinPatch({ backgroundMode: value as DigitalTwinProfile["backgroundMode"] })}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="captured">Captured</SelectItem>
                    <SelectItem value="clean">Clean keyed</SelectItem>
                    <SelectItem value="generated">Generated composite</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Reference asset kind</Label>
              <Select
                value={digitalTwinUploadKind}
                onValueChange={(value) => setDigitalTwinUploadKind(value as DigitalTwinAssetKind)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="host-video">Host video</SelectItem>
                  <SelectItem value="reference-portrait">Reference portrait</SelectItem>
                  <SelectItem value="idle-video">Idle video</SelectItem>
                  <SelectItem value="background-plate">Background plate</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="file"
                accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime"
                className="h-8 text-xs"
                disabled={digitalTwinUploading}
                onChange={(event) => {
                  void handleDigitalTwinUpload(event.target.files?.[0] ?? null);
                  event.currentTarget.value = "";
                }}
              />
              <p className="text-[10px] text-muted-foreground">
                Upload canonical host footage, portrait stills, idle clips, and clean background plates. Assets are stored in your own Rivr-controlled object storage.
              </p>
            </div>

            <div className="grid gap-2">
              {digitalTwin.assets.slice(0, 4).map((asset) => (
                <Card key={asset.id} className="bg-muted/30">
                  <CardContent className="px-3 py-2 text-[10px]">
                    <div className="font-medium">{asset.fileName}</div>
                    <div className="text-muted-foreground">
                      {asset.kind} · {Math.round(asset.size / 1024)} KB
                    </div>
                  </CardContent>
                </Card>
              ))}
              {digitalTwin.assets.length === 0 && (
                <p className="text-[10px] text-muted-foreground">
                  No digital twin assets uploaded yet.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Queue host video job</Label>
              <Select
                value={digitalTwinJobMode}
                onValueChange={(value) => setDigitalTwinJobMode(value as DigitalTwinJobMode)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="host-update">Host update</SelectItem>
                  <SelectItem value="event-recap">Event recap</SelectItem>
                  <SelectItem value="marketplace-promo">Marketplace promo</SelectItem>
                </SelectContent>
              </Select>
              <textarea
                value={digitalTwinJobText}
                onChange={(event) => setDigitalTwinJobText(event.target.value)}
                placeholder="Write the script or transcript excerpt for the host clip..."
                className="w-full min-h-[84px] rounded-md border bg-background px-3 py-2 text-xs"
              />
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={digitalTwinQueueing || !digitalTwinJobText.trim()}
                onClick={() => void handleQueueDigitalTwinJob()}
              >
                Queue digital twin job
              </Button>
            </div>

            <div className="grid gap-2">
              {digitalTwin.jobs.slice(0, 4).map((job) => (
                <Card key={job.id} className="bg-muted/30">
                  <CardContent className="px-3 py-2 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{job.mode}</span>
                      <Badge variant="outline" className="text-[9px] py-0 h-4">
                        {job.status}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground line-clamp-2">{job.sourceText}</div>
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[10px]"
                        disabled={digitalTwinRunningJobId === job.id}
                        onClick={() => void handleRunDigitalTwinJob(job.id, job.sourceText, job.mode)}
                      >
                        {digitalTwinRunningJobId === job.id ? "Running..." : "Run on worker"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
              {digitalTwin.jobs.length === 0 && (
                <p className="text-[10px] text-muted-foreground">
                  No digital twin jobs queued yet.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Listening indicator */}
      {isListening && (
        <div className="shrink-0 px-4 py-2 bg-destructive/10 border-b border-destructive/20 flex items-center justify-center gap-2">
          <span className="h-2 w-2 rounded-full bg-destructive animate-pulse" />
          <span className="text-xs text-destructive font-medium">
            Listening... speak now
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 text-[10px] px-2"
            onClick={stopListening}
          >
            Cancel
          </Button>
        </div>
      )}

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="px-4 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <Bot className="h-6 w-6 text-primary" />
              </div>
              <h2 className="text-sm font-semibold mb-1">
                Start a conversation
              </h2>
              <p className="text-xs text-muted-foreground max-w-sm">
                Autobot is powered by OpenClaw. Ask it anything, or use it to
                create posts, manage your profile, and interact with the Rivr
                platform through natural conversation.
              </p>
            </div>
          )}

          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              toolPreviewStatuses={toolPreviewStatuses}
              onToolConfirm={handleToolConfirm}
              onToolCancel={handleToolCancel}
            />
          ))}
          <TypingIndicator state={processingState} />
          <div ref={scrollEndRef} />
        </div>
      </ScrollArea>

      {/* Scroll to bottom */}
      {messages.length > 6 && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-10">
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full shadow-lg h-7 text-xs gap-1 opacity-0 hover:opacity-100 transition-opacity"
            onClick={scrollToBottom}
          >
            <ChevronDown className="h-3 w-3" />
            Latest
          </Button>
        </div>
      )}

      {/* Input area */}
      <div className="shrink-0 border-t bg-background px-4 py-3 mb-14">
        <div className="flex items-end gap-2">
          <VoiceRecorder
            onTranscription={handleTranscription}
            onError={handleTranscriptionError}
            disabled={isInputDisabled}
          />

          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={inputValue}
              onChange={(e) => {
                if (e.target.value.length <= MAX_MESSAGE_LENGTH) {
                  setInputValue(e.target.value);
                }
              }}
              onKeyDown={handleKeyDown}
              placeholder="Message Autobot..."
              disabled={isInputDisabled}
              rows={1}
              className={cn(
                "w-full resize-none rounded-xl border border-input bg-background px-4 py-2.5 pr-12",
                "text-sm leading-relaxed placeholder:text-muted-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:cursor-not-allowed disabled:opacity-50",
                "min-h-[42px] max-h-[120px]",
              )}
              style={{
                height: "auto",
                minHeight: "42px",
              }}
              onInput={(e) => {
                const target = e.target as HTMLTextAreaElement;
                target.style.height = "auto";
                target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
              }}
            />

            {inputValue.length > MAX_MESSAGE_LENGTH * 0.9 && (
              <span className="absolute right-14 bottom-2.5 text-[10px] text-muted-foreground">
                {inputValue.length}/{MAX_MESSAGE_LENGTH}
              </span>
            )}
          </div>

          <Button
            id="autobot-send-btn"
            size="icon"
            onClick={() => sendMessage(inputValue)}
            disabled={!canSend}
            className="shrink-0 rounded-xl h-[42px] w-[42px]"
            aria-label="Send message"
          >
            {processingState === "sending" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
