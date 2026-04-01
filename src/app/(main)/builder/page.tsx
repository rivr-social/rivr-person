"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Database,
  Eye,
  FileCode2,
  FolderOpen,
  Globe,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Rocket,
  Send,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useMyProfileModule } from "@/lib/hooks/use-myprofile-module";
import type { SiteFiles } from "@/lib/bespoke/site-files";
import {
  parseLLMResponse,
  mergeSiteFiles,
  listFileNames,
  getFileLanguage,
} from "@/lib/bespoke/site-files";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type DeployStatus = "idle" | "deploying" | "success" | "error";

const DEPLOY_STATUS_IDLE: DeployStatus = "idle";
const DEPLOY_STATUS_DEPLOYING: DeployStatus = "deploying";
const DEPLOY_STATUS_SUCCESS: DeployStatus = "success";
const DEPLOY_STATUS_ERROR: DeployStatus = "error";

const DEPLOY_STATUS_RESET_DELAY_MS = 5000;

const WELCOME_MESSAGE =
  "I'm your AI site builder. I have your Rivr profile data and can build anything you describe.\n\n" +
  "Try something like:\n" +
  '- "Build me a dark, modern portfolio"\n' +
  '- "Make it rainbow bright with gradients"\n' +
  '- "Create a minimalist Japanese aesthetic"\n' +
  '- "Add a section for my events with a timeline layout"\n' +
  '- "Change the font to something playful"\n\n' +
  "I'll generate complete HTML, CSS, and JS files that you can preview and deploy.";

// ---------------------------------------------------------------------------
// Chat message types
// ---------------------------------------------------------------------------

type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: Date;
  /** Code files extracted from this message (assistant only) */
  files?: SiteFiles;
  /** Whether files from this message have been applied */
  applied?: boolean;
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

type RightPanelView = "preview" | "files" | "data";

// ---------------------------------------------------------------------------
// Markdown-lite renderer for chat messages
// ---------------------------------------------------------------------------

function renderMessageContent(content: string): React.ReactNode {
  // Split by lines, apply basic markdown
  const lines = content.split("\n");
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Bold
    line = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Inline code
    line = line.replace(/`([^`]+)`/g, '<code class="bg-muted px-1 py-0.5 rounded text-xs font-mono">$1</code>');
    // List items
    if (line.startsWith("- ")) {
      line = "  \u2022 " + line.slice(2);
    }

    elements.push(
      <span
        key={i}
        dangerouslySetInnerHTML={{ __html: line }}
      />,
    );
    if (i < lines.length - 1) {
      elements.push(<br key={`br-${i}`} />);
    }
  }

  return <>{elements}</>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function BuilderPage() {
  const {
    bundle,
    manifest,
    state: moduleState,
    error: moduleError,
  } = useMyProfileModule(true);

  // Site files state
  const [siteFiles, setSiteFiles] = useState<SiteFiles>({});
  const [activePreviewFile, setActivePreviewFile] = useState<string>("index.html");
  const [selectedSourceFile, setSelectedSourceFile] = useState<string | null>(null);
  const [sourceEditorValue, setSourceEditorValue] = useState<string>("");

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content: WELCOME_MESSAGE,
      timestamp: new Date(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");

  // Deploy state
  const [deployStatus, setDeployStatus] = useState<DeployStatus>(DEPLOY_STATUS_IDLE);
  const [deployMessage, setDeployMessage] = useState("");

  // Panel state
  const [rightPanelView, setRightPanelView] = useState<RightPanelView>("preview");
  const [showFileExplorer, setShowFileExplorer] = useState(false);
  const [dataExpanded, setDataExpanded] = useState(false);

  // Refs
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  // Auto-resize textarea
  const handleTextareaInput = useCallback(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 120) + "px";
    }
  }, []);

  // Generate initial site from template when profile loads
  useEffect(() => {
    if (moduleState !== "loaded" || !bundle || !manifest) return;
    if (Object.keys(siteFiles).length > 0) return; // Already have files

    async function generateInitial() {
      try {
        const response = await fetch("/api/bespoke/generate", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            manifest,
            bundle,
            preferences: {
              preset: "default",
              visibleSections: [
                "hero",
                "about",
                "persona-insights",
                "posts",
                "events",
                "groups",
                "offerings",
                "connections",
              ],
            },
          }),
        });

        const data = (await response.json()) as {
          success: boolean;
          html?: string;
          files?: SiteFiles;
          error?: string;
        };

        if (data.success && data.files && Object.keys(data.files).length > 0) {
          setSiteFiles(data.files);
          setActivePreviewFile(data.files["index.html"] ? "index.html" : Object.keys(data.files)[0] ?? "index.html");
          setSelectedSourceFile("index.html" in data.files ? "index.html" : Object.keys(data.files)[0] ?? null);
          setSourceEditorValue(("index.html" in data.files ? data.files["index.html"] : data.files[Object.keys(data.files)[0]]) ?? "");
        } else if (data.success && data.html) {
          setSiteFiles({ "index.html": data.html });
        }
      } catch {
        // Template fallback failed -- user can still use AI chat
      }
    }

    void generateInitial();
  }, [moduleState, bundle, manifest, siteFiles]);

  // -------------------------------------------------------------------------
  // Chat send handler — streams from AI endpoint
  // -------------------------------------------------------------------------

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);
    setStreamingText("");

    // Reset textarea height
    if (inputRef.current) {
      inputRef.current.style.height = "auto";
    }

    // Build conversation history for the API
    const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const msg of messages) {
      if (msg.id === "welcome") continue;
      conversationHistory.push({ role: msg.role, content: msg.content });
    }
    conversationHistory.push({ role: "user", content: trimmed });

    const controller = new AbortController();
    abortRef.current = controller;

    let fullText = "";

    try {
      const response = await fetch("/api/builder/chat", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: conversationHistory,
          profileBundle: bundle ?? {},
          currentFiles: siteFiles,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(errorData.error || `Request failed (${response.status})`);
      }

      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const parsed = JSON.parse(data) as { text?: string; error?: string };
            if (parsed.error) {
              fullText += `\n\n**Error**: ${parsed.error}`;
              setStreamingText(fullText);
            } else if (parsed.text) {
              fullText += parsed.text;
              setStreamingText(fullText);
            }
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        fullText += "\n\n*(Generation cancelled)*";
      } else {
        fullText =
          fullText ||
          `Sorry, I encountered an error: ${err instanceof Error ? err.message : "Unknown error"}. Please try again.`;
      }
    }

    // Parse the complete response for code blocks
    const parsed = parseLLMResponse(fullText);

    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now()}`,
      role: "assistant",
      content: fullText,
      timestamp: new Date(),
      files: Object.keys(parsed.files).length > 0 ? parsed.files : undefined,
    };

    setMessages((prev) => [...prev, assistantMsg]);
    setStreamingText("");
    setIsStreaming(false);
    abortRef.current = null;

    // Auto-apply files if any were generated
    if (Object.keys(parsed.files).length > 0) {
      setSiteFiles((prev) => mergeSiteFiles(prev, parsed.files));
      assistantMsg.applied = true;

      // Switch to preview if we got new files
      setRightPanelView("preview");
      // Set preview to index.html if it exists in new files
      if (parsed.files["index.html"]) {
        setActivePreviewFile("index.html");
      }
    }
  }, [input, isStreaming, messages, bundle, siteFiles]);

  // Cancel streaming
  const handleCancelStream = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Apply files from a specific message
  const handleApplyFiles = useCallback((msgId: string) => {
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.id === msgId && msg.files) {
          setSiteFiles((prevFiles) => mergeSiteFiles(prevFiles, msg.files!));
          return { ...msg, applied: true };
        }
        return msg;
      }),
    );
    setRightPanelView("preview");
  }, []);

  // Keyboard handler
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // -------------------------------------------------------------------------
  // Deploy handler
  // -------------------------------------------------------------------------

  const handleDeploy = useCallback(async () => {
    if (Object.keys(siteFiles).length === 0) return;

    setDeployStatus(DEPLOY_STATUS_DEPLOYING);
    setDeployMessage("Deploying site files...");

    try {
      const response = await fetch("/api/bespoke/deploy-files", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: siteFiles }),
      });

      const data = (await response.json()) as {
        success: boolean;
        deployedFiles?: string[];
        deployPath?: string;
        mode?: string;
        error?: string;
      };

      if (!response.ok || !data.success) {
        throw new Error(data.error || "Deploy failed");
      }

      setDeployStatus(DEPLOY_STATUS_SUCCESS);
      setDeployMessage(
        `Deployed ${data.deployedFiles?.length ?? 0} files to ${data.deployPath ?? "target"}`,
      );

      setMessages((prev) => [
        ...prev,
        {
          id: `deploy-${Date.now()}`,
          role: "assistant",
          content: `Site deployed successfully! ${data.deployedFiles?.length ?? 0} files written to ${data.deployPath ?? "the deploy directory"}.`,
          timestamp: new Date(),
        },
      ]);

      setTimeout(() => {
        setDeployStatus(DEPLOY_STATUS_IDLE);
        setDeployMessage("");
      }, DEPLOY_STATUS_RESET_DELAY_MS);
    } catch (err) {
      setDeployStatus(DEPLOY_STATUS_ERROR);
      setDeployMessage(err instanceof Error ? err.message : "Deploy failed");
      setTimeout(() => {
        setDeployStatus(DEPLOY_STATUS_IDLE);
        setDeployMessage("");
      }, DEPLOY_STATUS_RESET_DELAY_MS);
    }
  }, [siteFiles]);

  // -------------------------------------------------------------------------
  // File explorer actions
  // -------------------------------------------------------------------------

  const handleSelectFile = useCallback(
    (filename: string) => {
      setSelectedSourceFile(filename);
      setSourceEditorValue(siteFiles[filename] ?? "");
      setRightPanelView("files");
    },
    [siteFiles],
  );

  const handleSaveSourceEdit = useCallback(() => {
    if (!selectedSourceFile) return;
    setSiteFiles((prev) => ({
      ...prev,
      [selectedSourceFile]: sourceEditorValue,
    }));
  }, [selectedSourceFile, sourceEditorValue]);

  // Refresh profile data
  const handleRefreshData = useCallback(() => {
    // Force a re-mount of the hook by reloading
    window.location.reload();
  }, []);

  // Copy file content
  const handleCopyFile = useCallback(
    (filename: string) => {
      const content = siteFiles[filename];
      if (content) {
        navigator.clipboard.writeText(content);
      }
    },
    [siteFiles],
  );

  // -------------------------------------------------------------------------
  // Preview HTML assembly
  // -------------------------------------------------------------------------

  const previewHtml = (() => {
    const file = siteFiles[activePreviewFile];
    if (!file) return null;

    // If the file is HTML and already complete, use it directly
    if (activePreviewFile.endsWith(".html")) {
      // Inject linked CSS/JS if they exist and aren't already linked
      let html = file;
      if (siteFiles["style.css"] && !html.includes("style.css")) {
        html = html.replace(
          "</head>",
          `<style>${siteFiles["style.css"]}</style>\n</head>`,
        );
      }
      if (siteFiles["script.js"] && !html.includes("script.js")) {
        html = html.replace(
          "</body>",
          `<script>${siteFiles["script.js"]}</script>\n</body>`,
        );
      }
      const previewBridgeScript = `
<script>
  (function() {
    document.addEventListener('click', function(event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var anchor = target.closest('a[href]');
      if (!anchor) return;
      var href = anchor.getAttribute('href');
      if (!href) return;
      if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('mailto:') || href.startsWith('#')) {
        return;
      }
      if (href.endsWith('.html')) {
        event.preventDefault();
        window.parent.postMessage({ type: 'rivr-builder-preview-navigate', file: href }, '*');
      }
    }, true);
  })();
</script>`;
      html = html.replace("</body>", `${previewBridgeScript}\n</body>`);
      return html;
    }

    return null;
  })();

  // File list
  const fileNames = listFileNames(siteFiles);
  const htmlFiles = fileNames.filter((f) => f.endsWith(".html"));

  useEffect(() => {
    function handlePreviewNavigation(event: MessageEvent) {
      const data = event.data as { type?: string; file?: string } | null;
      if (!data || data.type !== "rivr-builder-preview-navigate" || !data.file) return;
      if (siteFiles[data.file]) {
        setActivePreviewFile(data.file);
      }
    }

    window.addEventListener("message", handlePreviewNavigation);
    return () => window.removeEventListener("message", handlePreviewNavigation);
  }, [siteFiles]);

  // Profile summary for data panel
  const profileSummary = (() => {
    if (!bundle) return null;
    const b = bundle as unknown as Record<string, unknown>;
    const profile = b.profile as Record<string, unknown> | undefined;
    const agent = (profile?.agent ?? {}) as Record<string, unknown>;
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;

    return {
      name: agent.name as string | undefined,
      username: meta.username as string | undefined,
      bio: meta.bio as string | undefined,
      skills: Array.isArray(meta.skills) ? (meta.skills as string[]) : [],
      location: meta.location as string | undefined,
      postCount: ((b.posts as Record<string, unknown>)?.posts as unknown[] | undefined)?.length ?? 0,
      eventCount: Array.isArray(b.events) ? b.events.length : 0,
      groupCount: Array.isArray(b.groups) ? b.groups.length : 0,
      offeringCount: Array.isArray(b.marketplaceListings) ? b.marketplaceListings.length : 0,
      connectionCount: Array.isArray(b.connections) ? b.connections.length : 0,
    };
  })();

  // -------------------------------------------------------------------------
  // Loading / Error states
  // -------------------------------------------------------------------------

  if (moduleState === "loading" || moduleState === "idle") {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading your profile data...</p>
        </div>
      </div>
    );
  }

  if (moduleState === "error") {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-4rem)]">
        <Card className="max-w-md">
          <CardContent className="py-8 text-center">
            <XCircle className="h-8 w-8 text-destructive mx-auto mb-3" />
            <p className="text-sm text-destructive">
              {moduleError || "Failed to load profile data. Please sign in and try again."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Main layout
  // -------------------------------------------------------------------------

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-background/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-primary/10 p-1.5">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h1 className="text-sm font-semibold">AI Site Builder</h1>
            <p className="text-xs text-muted-foreground">
              Describe your site and watch it come to life
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* File count */}
          {fileNames.length > 0 && (
            <Badge variant="outline" className="text-xs gap-1">
              <FileCode2 className="h-3 w-3" />
              {fileNames.length} files
            </Badge>
          )}

          {/* Deploy status badges */}
          {deployStatus === DEPLOY_STATUS_SUCCESS && (
            <Badge variant="outline" className="gap-1 text-green-500 border-green-500/40">
              <CheckCircle className="h-3 w-3" />
              Deployed
            </Badge>
          )}
          {deployStatus === DEPLOY_STATUS_ERROR && (
            <Badge variant="outline" className="gap-1 text-destructive border-destructive/40">
              <XCircle className="h-3 w-3" />
              Failed
            </Badge>
          )}

          {/* Deploy button */}
          <Button
            variant="default"
            size="sm"
            className="gap-1.5"
            onClick={handleDeploy}
            disabled={
              deployStatus === DEPLOY_STATUS_DEPLOYING || Object.keys(siteFiles).length === 0
            }
          >
            {deployStatus === DEPLOY_STATUS_DEPLOYING ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="h-3.5 w-3.5" />
            )}
            {deployStatus === DEPLOY_STATUS_DEPLOYING ? "Deploying..." : "Deploy"}
          </Button>
        </div>
      </div>

      {/* Deploy message bar */}
      {deployMessage && deployStatus !== DEPLOY_STATUS_IDLE && (
        <div
          className={`text-xs px-4 py-1.5 ${
            deployStatus === DEPLOY_STATUS_SUCCESS
              ? "bg-green-500/10 text-green-500"
              : deployStatus === DEPLOY_STATUS_ERROR
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {deployMessage}
        </div>
      )}

      {/* Main content: Chat (left) | Preview/Files/Data (right) */}
      <div className="flex-1 flex min-h-0">
        {/* ----------------------------------------------------------------- */}
        {/* LEFT: Chat Panel                                                   */}
        {/* ----------------------------------------------------------------- */}
        <div className="w-full lg:w-[420px] xl:w-[480px] flex flex-col border-r bg-background min-h-0">
          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-foreground"
                  }`}
                >
                  <div className="whitespace-pre-wrap break-words leading-relaxed">
                    {renderMessageContent(
                      msg.files
                        ? parseLLMResponse(msg.content).message || msg.content
                        : msg.content,
                    )}
                  </div>

                  {/* File badges for messages with code */}
                  {msg.files && Object.keys(msg.files).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-border/30 space-y-1.5">
                      <div className="flex flex-wrap gap-1">
                        {Object.keys(msg.files).map((filename) => (
                          <Badge
                            key={filename}
                            variant="outline"
                            className="text-[10px] gap-1 cursor-pointer hover:bg-background/50"
                            onClick={() => handleSelectFile(filename)}
                          >
                            <Code2 className="h-2.5 w-2.5" />
                            {filename}
                          </Badge>
                        ))}
                      </div>
                      {msg.applied ? (
                        <div className="flex items-center gap-1 text-[10px] text-green-500">
                          <CheckCircle className="h-3 w-3" />
                          Applied to preview
                        </div>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[10px] gap-1"
                          onClick={() => handleApplyFiles(msg.id)}
                        >
                          <Play className="h-2.5 w-2.5" />
                          Apply changes
                        </Button>
                      )}
                    </div>
                  )}

                  <time className="block text-[10px] mt-1 opacity-40">
                    {msg.timestamp.toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
              </div>
            ))}

            {/* Streaming indicator */}
            {isStreaming && (
              <div className="flex justify-start">
                <div className="max-w-[90%] rounded-lg px-3 py-2 text-sm bg-muted text-foreground">
                  {streamingText ? (
                    <div className="whitespace-pre-wrap break-words leading-relaxed">
                      {renderMessageContent(parseLLMResponse(streamingText).message || streamingText)}
                      <span className="inline-block w-1.5 h-4 bg-primary/60 animate-pulse ml-0.5 align-text-bottom" />
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      <span className="text-muted-foreground">Thinking...</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Input area */}
          <div className="border-t px-3 py-2.5 bg-background">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  handleTextareaInput();
                }}
                onKeyDown={handleKeyDown}
                placeholder="Describe your site or request changes..."
                className="flex-1 bg-muted/50 rounded-lg px-3 py-2 text-sm outline-none resize-none placeholder:text-muted-foreground border border-border/50 focus:border-primary/50 transition-colors"
                rows={1}
                style={{ maxHeight: "120px" }}
                disabled={isStreaming}
              />
              {isStreaming ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCancelStream}
                  className="shrink-0 h-9"
                >
                  Stop
                </Button>
              ) : (
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSend}
                  disabled={!input.trim()}
                  className="shrink-0 h-9"
                >
                  <Send className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* RIGHT: Preview / Files / Data panels                              */}
        {/* ----------------------------------------------------------------- */}
        <div className="hidden lg:flex flex-1 flex-col min-h-0">
          {/* Panel tabs */}
          <div className="flex items-center gap-1 px-3 py-1.5 border-b bg-muted/30">
            <button
              onClick={() => setRightPanelView("preview")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                rightPanelView === "preview"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
              Preview
            </button>
            <button
              onClick={() => setRightPanelView("files")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                rightPanelView === "files"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              <FileCode2 className="h-3.5 w-3.5" />
              Files
            </button>
            <button
              onClick={() => setRightPanelView("data")}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                rightPanelView === "data"
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              <Database className="h-3.5 w-3.5" />
              Data
            </button>

            <div className="flex-1" />

            {/* File explorer toggle */}
            <button
              onClick={() => setShowFileExplorer(!showFileExplorer)}
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title={showFileExplorer ? "Hide file explorer" : "Show file explorer"}
            >
              {showFileExplorer ? (
                <PanelLeftClose className="h-3.5 w-3.5" />
              ) : (
                <PanelLeftOpen className="h-3.5 w-3.5" />
              )}
            </button>
          </div>

          <div className="flex-1 flex min-h-0">
            {/* File explorer sidebar */}
            {showFileExplorer && (
              <div className="w-48 border-r bg-muted/20 overflow-y-auto py-2">
                <div className="flex items-center gap-1.5 px-3 pb-2 text-xs font-medium text-muted-foreground">
                  <FolderOpen className="h-3 w-3" />
                  Files
                </div>
                {fileNames.length === 0 ? (
                  <p className="px-3 text-xs text-muted-foreground italic">No files yet</p>
                ) : (
                  fileNames.map((filename) => (
                    <button
                      key={filename}
                      onClick={() => handleSelectFile(filename)}
                      className={`w-full text-left px-3 py-1 text-xs font-mono truncate transition-colors ${
                        selectedSourceFile === filename && rightPanelView === "files"
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      }`}
                    >
                      {filename}
                    </button>
                  ))
                )}
              </div>
            )}

            {/* Main content area */}
            <div className="flex-1 flex flex-col min-h-0">
              {/* ----- PREVIEW PANEL ----- */}
              {rightPanelView === "preview" && (
                <>
                  {/* Page tabs for HTML files */}
                  {htmlFiles.length > 1 && (
                    <div className="flex items-center gap-1 px-3 py-1.5 border-b overflow-x-auto">
                      {htmlFiles.map((file) => (
                        <button
                          key={file}
                          onClick={() => setActivePreviewFile(file)}
                          className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                            activePreviewFile === file
                              ? "bg-primary/10 text-primary"
                              : "text-muted-foreground hover:text-foreground hover:bg-muted"
                          }`}
                        >
                          {file.replace(".html", "") || "index"}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="flex-1 min-h-0">
                    {previewHtml ? (
                      <iframe
                        srcDoc={previewHtml}
                        title="Site Preview"
                        className="w-full h-full border-0"
                        sandbox="allow-same-origin allow-scripts"
                      />
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 p-8">
                        <Globe className="h-12 w-12 opacity-20" />
                        <div className="text-center">
                          <p className="text-sm font-medium">No preview yet</p>
                          <p className="text-xs mt-1">
                            Start a conversation to generate your site
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ----- FILES PANEL ----- */}
              {rightPanelView === "files" && (
                <div className="flex-1 flex flex-col min-h-0">
                  {/* File tabs */}
                  <div className="flex items-center gap-1 px-3 py-1.5 border-b overflow-x-auto">
                    {fileNames.map((filename) => (
                      <button
                        key={filename}
                        onClick={() => handleSelectFile(filename)}
                        className={`px-2.5 py-1 text-xs font-mono rounded-md transition-colors whitespace-nowrap ${
                          selectedSourceFile === filename
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        }`}
                      >
                        {filename}
                      </button>
                    ))}
                  </div>

                  {selectedSourceFile ? (
                    <div className="flex-1 flex flex-col min-h-0">
                      <div className="flex items-center justify-between px-3 py-1.5 border-b bg-muted/20">
                        <div className="flex items-center gap-2">
                          <Code2 className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-xs font-mono text-muted-foreground">
                            {selectedSourceFile}
                          </span>
                          <Badge variant="outline" className="text-[10px]">
                            {getFileLanguage(selectedSourceFile)}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs gap-1"
                            onClick={() => handleCopyFile(selectedSourceFile)}
                          >
                            <Copy className="h-3 w-3" />
                            Copy
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs gap-1"
                            onClick={handleSaveSourceEdit}
                          >
                            <CheckCircle className="h-3 w-3" />
                            Save
                          </Button>
                        </div>
                      </div>
                      <textarea
                        value={sourceEditorValue}
                        onChange={(e) => setSourceEditorValue(e.target.value)}
                        className="flex-1 w-full p-3 font-mono text-xs bg-[#0d1117] text-[#c9d1d9] resize-none outline-none border-0"
                        spellCheck={false}
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 p-8">
                      <FileCode2 className="h-12 w-12 opacity-20" />
                      <p className="text-sm">Select a file to view its source</p>
                    </div>
                  )}
                </div>
              )}

              {/* ----- DATA PANEL ----- */}
              {rightPanelView === "data" && (
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium">Available Profile Data</h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={handleRefreshData}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Refresh
                    </Button>
                  </div>

                  {profileSummary ? (
                    <div className="space-y-3">
                      {/* Profile card */}
                      <Card>
                        <CardContent className="py-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium">Profile</span>
                            <Badge variant="outline" className="text-[10px]">
                              {profileSummary.name || "Unknown"}
                            </Badge>
                          </div>
                          {profileSummary.username && (
                            <div className="text-xs text-muted-foreground">
                              @{profileSummary.username}
                            </div>
                          )}
                          {profileSummary.bio && (
                            <p className="text-xs text-muted-foreground line-clamp-3">
                              {profileSummary.bio}
                            </p>
                          )}
                          {profileSummary.skills.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {profileSummary.skills.slice(0, 8).map((skill) => (
                                <Badge key={skill} variant="secondary" className="text-[10px]">
                                  {skill}
                                </Badge>
                              ))}
                            </div>
                          )}
                          {profileSummary.location && (
                            <div className="text-xs text-muted-foreground">
                              {profileSummary.location}
                            </div>
                          )}
                        </CardContent>
                      </Card>

                      {/* Content counts */}
                      <Card>
                        <CardContent className="py-3">
                          <button
                            onClick={() => setDataExpanded(!dataExpanded)}
                            className="flex items-center gap-2 w-full text-left"
                          >
                            {dataExpanded ? (
                              <ChevronDown className="h-3 w-3 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3 w-3 text-muted-foreground" />
                            )}
                            <span className="text-xs font-medium">Content Summary</span>
                          </button>
                          {dataExpanded && (
                            <div className="mt-2 space-y-1.5 pl-5">
                              <DataCountRow label="Posts" count={profileSummary.postCount} />
                              <DataCountRow label="Events" count={profileSummary.eventCount} />
                              <DataCountRow label="Groups" count={profileSummary.groupCount} />
                              <DataCountRow
                                label="Offerings"
                                count={profileSummary.offeringCount}
                              />
                              <DataCountRow
                                label="Connections"
                                count={profileSummary.connectionCount}
                              />
                            </div>
                          )}
                        </CardContent>
                      </Card>

                      <p className="text-[10px] text-muted-foreground px-1">
                        The AI has access to all of this data when generating your site. It will
                        use your real name, bio, skills, posts, events, groups, offerings, and
                        connections to populate content.
                      </p>
                    </div>
                  ) : (
                    <Skeleton className="h-32" />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function DataCountRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <Badge variant="outline" className="text-[10px] h-5 min-w-[28px] justify-center">
        {count}
      </Badge>
    </div>
  );
}
