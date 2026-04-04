"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  Activity,
  Bot,
  Calendar as CalendarIcon,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  Download,
  Drama,
  ExternalLink,
  MessageSquare,
  RefreshCw,
  Shield,
  Terminal,
  XCircle,
} from "lucide-react";
import { PersonaManager } from "@/components/persona-manager";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AutobotStatus {
  instance: {
    instanceId: string;
    instanceType: string;
    instanceSlug: string;
    baseUrl: string;
    isGlobal: boolean;
  };
  autobot: {
    primaryAgentId: string | null;
    primaryAgent: {
      id: string;
      name: string;
      image: string | null;
      metadata: Record<string, unknown> | null;
    } | null;
    mcpTokenConfigured: boolean;
    mcpEndpoint: string;
    discoveryEndpoint: string;
  };
}

interface ProvenanceEntry {
  id: string;
  toolName: string;
  actorId: string;
  actorType: string;
  authMode: string;
  controllerId: string | null;
  argsSummary: Record<string, unknown>;
  resultStatus: string;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Status Tab
// ---------------------------------------------------------------------------

function StatusTab({ status }: { status: AutobotStatus | null; }) {
  if (!status) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const { instance, autobot } = status;

  return (
    <div className="space-y-4">
      {/* Instance Identity */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <CircleDot className="h-4 w-4" />
            Instance Identity
          </CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Type</dt>
            <dd>
              <Badge variant="outline" className="font-mono">
                {instance.instanceType}
              </Badge>
            </dd>
            <dt className="text-muted-foreground">Slug</dt>
            <dd className="font-mono text-xs">{instance.instanceSlug}</dd>
            <dt className="text-muted-foreground">Instance ID</dt>
            <dd className="font-mono text-xs truncate" title={instance.instanceId}>
              {instance.instanceId.slice(0, 8)}…
            </dd>
            <dt className="text-muted-foreground">Base URL</dt>
            <dd className="font-mono text-xs truncate">
              <a
                href={instance.baseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                {instance.baseUrl}
                <ExternalLink className="h-3 w-3" />
              </a>
            </dd>
          </dl>
        </CardContent>
      </Card>

      {/* Primary Agent */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Bot className="h-4 w-4" />
            Primary Agent
          </CardTitle>
        </CardHeader>
        <CardContent>
          {autobot.primaryAgent ? (
            <div className="flex items-center gap-3">
              <Avatar className="h-10 w-10">
                <AvatarImage
                  src={autobot.primaryAgent.image ?? undefined}
                  alt={autobot.primaryAgent.name}
                />
                <AvatarFallback>
                  {autobot.primaryAgent.name.substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div>
                <p className="font-medium text-sm">{autobot.primaryAgent.name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {autobot.primaryAgentId?.slice(0, 8)}…
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {autobot.primaryAgentId
                ? `Agent ${autobot.primaryAgentId.slice(0, 8)}… (not found in local DB)`
                : "No PRIMARY_AGENT_ID configured"}
            </p>
          )}
        </CardContent>
      </Card>

      {/* MCP Endpoint Health */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Terminal className="h-4 w-4" />
            MCP Endpoints
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Discovery</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">
              {autobot.discoveryEndpoint}
            </code>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">RPC Transport</span>
            <code className="text-xs bg-muted px-2 py-0.5 rounded">
              {autobot.mcpEndpoint}
            </code>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Token Auth</span>
            {autobot.mcpTokenConfigured ? (
              <Badge variant="default" className="gap-1">
                <Shield className="h-3 w-3" />
                Configured
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1">
                <XCircle className="h-3 w-3" />
                Not Set
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Tab — helpers
// ---------------------------------------------------------------------------

/** Well-known ID-like keys in args that can be cross-linked to app resources. */
const ENTITY_LINK_KEYS = new Set([
  "id",
  "entityId",
  "docId",
  "documentId",
  "groupId",
  "personId",
  "userId",
  "profileId",
  "postId",
  "listingId",
  "ringId",
  "localeId",
  "personaId",
]);

/** Heuristic: looks like a UUID or cuid. */
const ID_PATTERN = /^[a-f0-9-]{36}$|^c[a-z0-9]{24,}$/i;

/**
 * Map an ID-bearing key to a best-effort in-app route.
 * Returns null when no meaningful route can be inferred.
 */
function resourceLinkForKey(
  key: string,
  value: string
): { href: string; label: string } | null {
  if (!ID_PATTERN.test(value)) return null;

  const shortId = value.slice(0, 8);

  switch (key) {
    case "personaId":
      return { href: `/autobot`, label: `Persona ${shortId}...` };
    case "postId":
      return { href: `/post/${value}`, label: `Post ${shortId}...` };
    case "docId":
    case "documentId":
      return { href: `/doc/${value}`, label: `Doc ${shortId}...` };
    case "groupId":
      return { href: `/group/${value}`, label: `Group ${shortId}...` };
    case "profileId":
    case "personId":
    case "userId":
      return { href: `/profile/${value}`, label: `Profile ${shortId}...` };
    case "listingId":
      return { href: `/listing/${value}`, label: `Listing ${shortId}...` };
    case "ringId":
      return { href: `/ring/${value}`, label: `Ring ${shortId}...` };
    case "localeId":
      return { href: `/locale/${value}`, label: `Locale ${shortId}...` };
    case "entityId":
    case "id":
      return { href: `#`, label: `Entity ${shortId}...` };
    default:
      return null;
  }
}

/** Render a single JSON value, cross-linking IDs when possible. */
function ArgValue({ keyName, value }: { keyName: string; value: unknown }) {
  if (
    typeof value === "string" &&
    ENTITY_LINK_KEYS.has(keyName) &&
    ID_PATTERN.test(value)
  ) {
    const link = resourceLinkForKey(keyName, value);
    if (link) {
      return (
        <Link
          href={link.href}
          className="text-primary underline underline-offset-2 hover:text-primary/80 inline-flex items-center gap-0.5"
        >
          {link.label}
          <ExternalLink className="h-3 w-3" />
        </Link>
      );
    }
  }
  return <span>{JSON.stringify(value)}</span>;
}

/** Format a Date as YYYY-MM-DD for display. */
function formatDateShort(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Activity Tab — expanded row detail
// ---------------------------------------------------------------------------

function ProvenanceRowDetail({ entry }: { entry: ProvenanceEntry }) {
  const argsEntries = Object.entries(entry.argsSummary ?? {});
  const hasError =
    entry.resultStatus !== "success" && entry.errorMessage;

  return (
    <div className="px-4 py-3 bg-muted/40 border-t space-y-3 text-xs">
      {/* Args summary */}
      <div>
        <p className="font-medium text-muted-foreground mb-1">Arguments</p>
        {argsEntries.length === 0 ? (
          <p className="text-muted-foreground italic">No arguments recorded.</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {argsEntries.map(([key, val]) => (
              <div key={key} className="contents">
                <dt className="font-mono text-muted-foreground">{key}</dt>
                <dd className="font-mono break-all">
                  <ArgValue keyName={key} value={val} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {/* Error detail */}
      {hasError && (
        <div>
          <p className="font-medium text-destructive mb-1">Error</p>
          <pre className="whitespace-pre-wrap break-all text-destructive/90 bg-destructive/5 rounded p-2">
            {entry.errorMessage}
          </pre>
        </div>
      )}

      {/* Metadata row */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
        <span>
          <strong>Actor ID:</strong>{" "}
          <code className="font-mono">{entry.actorId.slice(0, 12)}...</code>
        </span>
        {entry.controllerId && (
          <span>
            <strong>Controller:</strong>{" "}
            <code className="font-mono">
              {entry.controllerId.slice(0, 12)}...
            </code>
          </span>
        )}
        <span>
          <strong>Entry ID:</strong>{" "}
          <code className="font-mono">{entry.id.slice(0, 12)}...</code>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Tab — date range picker
// ---------------------------------------------------------------------------

function DateRangePicker({
  startDate,
  endDate,
  onStartChange,
  onEndChange,
}: {
  startDate: Date | undefined;
  endDate: Date | undefined;
  onStartChange: (d: Date | undefined) => void;
  onEndChange: (d: Date | undefined) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5">
          <CalendarIcon className="h-3 w-3" />
          {startDate || endDate
            ? `${startDate ? formatDateShort(startDate) : "..."} — ${endDate ? formatDateShort(endDate) : "..."}`
            : "Date range"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex flex-col sm:flex-row gap-2 p-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground px-1">
              From
            </p>
            <Calendar
              mode="single"
              selected={startDate}
              onSelect={onStartChange}
              disabled={(date) =>
                endDate ? date > endDate : date > new Date()
              }
              initialFocus
            />
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground px-1">
              To
            </p>
            <Calendar
              mode="single"
              selected={endDate}
              onSelect={onEndChange}
              disabled={(date) =>
                startDate
                  ? date < startDate || date > new Date()
                  : date > new Date()
              }
            />
          </div>
        </div>
        {(startDate || endDate) && (
          <div className="border-t px-3 py-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs"
              onClick={() => {
                onStartChange(undefined);
                onEndChange(undefined);
              }}
            >
              Clear dates
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Activity Tab
// ---------------------------------------------------------------------------

function ActivityTab() {
  const [entries, setEntries] = useState<ProvenanceEntry[]>([]);
  const [distinctToolNames, setDistinctToolNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [toolFilter, setToolFilter] = useState<string>("all");
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (actorFilter !== "all") params.set("actorType", actorFilter);
      if (toolFilter !== "all") params.set("toolName", toolFilter);
      if (startDate) params.set("startDate", startDate.toISOString());
      if (endDate) {
        // Include the full end day
        const endOfDay = new Date(endDate);
        endOfDay.setHours(23, 59, 59, 999);
        params.set("endDate", endOfDay.toISOString());
      }
      params.set("limit", "100");
      const res = await fetch(`/api/autobot/provenance?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries ?? []);
        // Only update tool names from unfiltered fetches so the dropdown
        // always shows the full set of available tools.
        if (toolFilter === "all" && data.distinctToolNames) {
          setDistinctToolNames(data.distinctToolNames);
        }
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [actorFilter, toolFilter, startDate, endDate]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  // Also fetch unfiltered tool names on mount so the dropdown is populated
  // even when a tool filter is active.
  useEffect(() => {
    async function fetchToolNames() {
      try {
        const res = await fetch("/api/autobot/provenance?limit=200");
        if (res.ok) {
          const data = await res.json();
          if (data.distinctToolNames) {
            setDistinctToolNames(data.distinctToolNames);
          }
        }
      } catch {
        // silent
      }
    }
    fetchToolNames();
  }, []);

  const handleToggleRow = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(entries, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `provenance-log-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [entries]);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (actorFilter !== "all") count++;
    if (toolFilter !== "all") count++;
    if (startDate || endDate) count++;
    return count;
  }, [actorFilter, toolFilter, startDate, endDate]);

  return (
    <div className="space-y-4">
      {/* Filters row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Actor type filter */}
        <Select value={actorFilter} onValueChange={setActorFilter}>
          <SelectTrigger className="w-[130px] h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actors</SelectItem>
            <SelectItem value="autobot">Autobot</SelectItem>
            <SelectItem value="human">Human</SelectItem>
            <SelectItem value="persona">Persona</SelectItem>
          </SelectContent>
        </Select>

        {/* Tool name filter */}
        <Select value={toolFilter} onValueChange={setToolFilter}>
          <SelectTrigger className="w-[180px] h-8 text-xs">
            <SelectValue placeholder="All tools" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tools</SelectItem>
            {distinctToolNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Date range picker */}
        <DateRangePicker
          startDate={startDate}
          endDate={endDate}
          onStartChange={setStartDate}
          onEndChange={setEndDate}
        />

        {/* Active filter indicator */}
        {activeFilterCount > 0 && (
          <Badge variant="secondary" className="text-xs">
            {activeFilterCount} filter{activeFilterCount > 1 ? "s" : ""}
          </Badge>
        )}

        {/* Right-aligned actions */}
        <div className="flex items-center gap-1 ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={entries.length === 0}
            className="h-8 text-xs gap-1"
          >
            <Download className="h-3 w-3" />
            Export
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={fetchEntries}
            disabled={loading}
            className="h-8 gap-1"
          >
            <RefreshCw
              className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Table */}
      {loading && entries.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No MCP activity recorded yet.
          </CardContent>
        </Card>
      ) : (
        <div className="rounded-md border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28px]" />
                <TableHead className="w-[180px]">Tool</TableHead>
                <TableHead className="w-[80px]">Actor</TableHead>
                <TableHead className="w-[70px]">Auth</TableHead>
                <TableHead className="w-[70px]">Status</TableHead>
                <TableHead className="w-[60px] text-right">ms</TableHead>
                <TableHead className="w-[140px]">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => {
                const isExpanded = expandedId === entry.id;
                return (
                  <Collapsible
                    key={entry.id}
                    open={isExpanded}
                    onOpenChange={() => handleToggleRow(entry.id)}
                    asChild
                  >
                    <>
                      <CollapsibleTrigger asChild>
                        <TableRow
                          className="cursor-pointer hover:bg-muted/50 transition-colors"
                          data-state={isExpanded ? "open" : "closed"}
                        >
                          <TableCell className="w-[28px] px-2">
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {entry.toolName}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={
                                entry.actorType === "autobot"
                                  ? "default"
                                  : entry.actorType === "persona"
                                    ? "secondary"
                                    : "outline"
                              }
                              className="text-xs"
                            >
                              {entry.actorType === "autobot" && (
                                <Bot className="h-3 w-3 mr-1" />
                              )}
                              {entry.actorType === "persona" && (
                                <Drama className="h-3 w-3 mr-1" />
                              )}
                              {entry.actorType}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <span className="text-xs text-muted-foreground">
                              {entry.authMode}
                            </span>
                          </TableCell>
                          <TableCell>
                            {entry.resultStatus === "success" ? (
                              <CheckCircle2 className="h-4 w-4 text-green-500" />
                            ) : (
                              <XCircle className="h-4 w-4 text-destructive" />
                            )}
                          </TableCell>
                          <TableCell className="text-right text-xs text-muted-foreground font-mono">
                            {entry.durationMs ?? "\u2014"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {new Date(entry.createdAt).toLocaleString(
                                undefined,
                                {
                                  month: "short",
                                  day: "numeric",
                                  hour: "2-digit",
                                  minute: "2-digit",
                                  second: "2-digit",
                                }
                              )}
                            </span>
                          </TableCell>
                        </TableRow>
                      </CollapsibleTrigger>
                      <CollapsibleContent asChild>
                        <tr>
                          <td colSpan={7} className="p-0">
                            <ProvenanceRowDetail entry={entry} />
                          </td>
                        </tr>
                      </CollapsibleContent>
                    </>
                  </Collapsible>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function AutobotPage() {
  const [status, setStatus] = useState<AutobotStatus | null>(null);

  useEffect(() => {
    fetch("/api/autobot/status")
      .then((r) => (r.ok ? r.json() : null))
      .then(setStatus)
      .catch(() => {});
  }, []);

  return (
    <div className="container max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="rounded-full bg-primary/10 p-2">
          <Bot className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Autobot Control Plane</h1>
          <p className="text-sm text-muted-foreground">
            MCP status, personas, activity log, and chat
          </p>
        </div>
      </div>

      <Tabs defaultValue="status">
        <TabsList className="w-full">
          <TabsTrigger value="status" className="flex-1 gap-1">
            <CircleDot className="h-3.5 w-3.5" />
            Status
          </TabsTrigger>
          <TabsTrigger value="personas" className="flex-1 gap-1">
            <Drama className="h-3.5 w-3.5" />
            Personas
          </TabsTrigger>
          <TabsTrigger value="activity" className="flex-1 gap-1">
            <Activity className="h-3.5 w-3.5" />
            Activity
          </TabsTrigger>
          <TabsTrigger value="chat" className="flex-1 gap-1">
            <MessageSquare className="h-3.5 w-3.5" />
            Chat
          </TabsTrigger>
        </TabsList>

        <TabsContent value="status" className="mt-4">
          <StatusTab status={status} />
        </TabsContent>

        <TabsContent value="personas" className="mt-4">
          <PersonaManager />
        </TabsContent>

        <TabsContent value="activity" className="mt-4">
          <ActivityTab />
        </TabsContent>

        <TabsContent value="chat" className="mt-4">
          <Card>
            <CardContent className="py-8 flex flex-col items-center gap-4">
              <div className="rounded-full bg-primary/10 p-4">
                <MessageSquare className="h-8 w-8 text-primary" />
              </div>
              <div className="text-center space-y-1">
                <h3 className="font-medium">Chat with your Autobot</h3>
                <p className="text-sm text-muted-foreground max-w-sm">
                  Talk to your autobot via text or voice. It can create posts,
                  update your profile, manage personas, and more.
                </p>
              </div>
              <Link href="/autobot/chat">
                <Button className="gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Open Chat
                </Button>
              </Link>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
