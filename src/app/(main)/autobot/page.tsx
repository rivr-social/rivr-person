"use client";

import { useCallback, useEffect, useState } from "react";
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
  Activity,
  Bot,
  CheckCircle2,
  CircleDot,
  Clock,
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
// Activity Tab
// ---------------------------------------------------------------------------

function ActivityTab() {
  const [entries, setEntries] = useState<ProvenanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("actorType", filter);
      params.set("limit", "50");
      const res = await fetch(`/api/autobot/provenance?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries ?? []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actors</SelectItem>
              <SelectItem value="autobot">Autobot</SelectItem>
              <SelectItem value="human">Human</SelectItem>
              <SelectItem value="persona">Persona</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchEntries}
          disabled={loading}
          className="gap-1"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

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
                <TableHead className="w-[180px]">Tool</TableHead>
                <TableHead className="w-[80px]">Actor</TableHead>
                <TableHead className="w-[70px]">Auth</TableHead>
                <TableHead className="w-[70px]">Status</TableHead>
                <TableHead className="w-[60px] text-right">ms</TableHead>
                <TableHead className="w-[140px]">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
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
                    {entry.durationMs ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(entry.createdAt).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
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
